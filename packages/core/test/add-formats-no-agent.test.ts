import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FORMATS, formatHistory, manifestSchema, type Brief, type VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { CreativeTurnService, type CreativeRef } from '../src/creatives/creative-turns.ts';
import { exportPicks } from '../src/creatives/export.ts';
import { formatSummaries } from '../src/creatives/format-summary.ts';
import { parseStudioBlock } from '../src/creatives/prompt.ts';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { setLocale } from '../src/i18n.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';
import { testLauncher } from './helpers/launcher.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const REEL = 'instagram-reel-9x16';
const POST = 'instagram-post-1x1';
const TIKTOK = 'tiktok-9x16';
const SHORTS = 'youtube-shorts-9x16';
const YT = 'youtube-16x9';
const brief: Brief = { goal: 'Lancio app', message: '', formats: [REEL, POST], durationSec: 10, assets: [], notes: '' };

let ref: CreativeRef;
let store: CreativeStore;
let queue: JobQueue;
let service: CreativeTurnService;
let promptFile: string;
let launcher: ReturnType<typeof testLauncher>;
let warn: ReturnType<typeof vi.spyOn>;
/** Every `claude` process the fake runner started, counted by the fake itself. */
let usageFile: string;

async function setup(b: Brief) {
  const base = await mkdtemp(join(tmpdir(), 'ms-add-'));
  const git = new Git();
  const ws = await WorkspaceStore.open(join(base, 'ws'), git);
  const { slug } = await ws.createProject({ name: 'Acme' });
  const projectDir = ws.projectDir(slug);
  store = new CreativeStore(projectDir);
  const created = await store.create({ title: 'Lancio', brief: b });
  ref = { root: ws.root, projectSlug: slug, projectDir, creativeSlug: created.slug };
  queue = new JobQueue({ concurrency: 2 });
  launcher = testLauncher(new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }));
  service = new CreativeTurnService({
    queue, git, media: NoMediaTools, vault: new MemoryVault(),
    launcher,
    presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {},
  });
  promptFile = join(base, 'prompts.jsonl');
  usageFile = join(base, 'runs.json');
  process.env.FAKE_CLAUDE_PROMPT_FILE = promptFile;
  process.env.FAKE_CLAUDE_USAGE_FILE = usageFile;
}

beforeEach(() => {
  process.env.FAKE_CLAUDE_SCENARIO = 'render';
  process.env.FAKE_CLAUDE_NO_FFMPEG = '1';
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ['FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_PROMPT_FILE', 'FAKE_CLAUDE_NO_FFMPEG', 'FAKE_CLAUDE_USAGE_FILE', 'FAKE_CLAUDE_MANIFEST_PATCH']) delete process.env[k];
  setLocale('it');
  // No copy was refused and no hash skipped in these flows.
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});

const claudeRuns = async () => { try { return (JSON.parse(await readFile(usageFile, 'utf8')) as { runs: number }).runs; } catch { return 0; } };
const prompts = async () => (await readFile(promptFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { prompt: string });
const run = async (job: Promise<{ id: string }>) => { const { id } = await job; await queue.whenIdle(); return queue.list().find((j) => j.id === id)!.state; };
const versions = () => store.readVersions(ref.creativeSlug);
const out = (v: VersionEntry, format: string) => v.outputs.find((o) => o.format === format);

describe('formats added without the agent (spec §2.4)', { timeout: 30_000 }, () => {
  it('links the formats a brief save adds against the existing primaries, duration unknown', async () => {
    await setup(brief);
    const updated = await service.updateBrief(ref, { brief: { ...brief, formats: [REEL, POST, TIKTOK, SHORTS, YT], links: { [YT]: POST } } });
    // The links sent with the save are ignored; YouTube 16:9 can follow nothing.
    expect(updated.brief.links).toEqual({ [TIKTOK]: REEL, [SHORTS]: REEL });
    // A save that adds nothing keeps the stored links as they are.
    expect((await service.updateBrief(ref, { brief: { ...brief, formats: [REEL, POST, TIKTOK, SHORTS, YT] } })).brief.links).toEqual({ [TIKTOK]: REEL, [SHORTS]: REEL });
  });

  it('adds TikTok and Shorts as v(N+1) with zero claude runs: copies, followers, request, chat, commit, no usage', async () => {
    setLocale('en');
    await setup(brief);
    expect(await run(service.start(ref))).toBe('succeeded');
    expect(await claudeRuns()).toBe(1);
    await service.updateBrief(ref, { brief: { ...brief, formats: [REEL, POST, TIKTOK, SHORTS] } });
    const start = vi.spyOn(launcher, 'start');
    expect(await run(service.start(ref))).toBe('succeeded');
    expect(start).not.toHaveBeenCalled();
    expect(await claudeRuns()).toBe(1);
    expect(await prompts()).toHaveLength(1);

    const [v1, v2] = await versions();
    const request = 'Added TikTok · Video 9:16 and YouTube · Shorts 9:16 using the Instagram · Story/Reel 9:16 (v1)';
    expect(v2).toMatchObject({ n: 2, status: 'complete', problems: [], request, basedOn: 1, sessionId: v1!.sessionId, tools: v1!.tools, renderCommand: v1!.renderCommand });
    expect(v2!.usage).toBeUndefined();
    expect(v2!.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(v2!.outputs.map((o) => o.format)).toEqual([REEL, POST, TIKTOK, SHORTS]);
    for (const f of [REEL, POST]) expect(out(v2!, f)!.sha256).toBe(out(v1!, f)!.sha256);
    for (const f of [TIKTOK, SHORTS]) {
      expect(out(v2!, f)!.sha256).toBe(out(v1!, REEL)!.sha256);
      expect((await stat(join(store.outputsDir(ref.creativeSlug, 2), `${f}.mp4`))).nlink).toBe(1);
    }
    expect(formatHistory([v1!, v2!], REEL)).toEqual([1]);
    const m = manifestSchema.parse(JSON.parse(await readFile(join(store.outputsDir(ref.creativeSlug, 2), 'manifest.json'), 'utf8')));
    expect(Object.fromEntries(m.files.map((f) => [f.format, f.followsFormat ?? null]))).toEqual({ [REEL]: null, [POST]: null, [TIKTOK]: REEL, [SHORTS]: REEL });
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.some((e) => e.type === 'system' && e.text === `${request} · no agent needed`)).toBe(true);
    expect(conv.at(-1)).toMatchObject({ type: 'version', n: 2, status: 'complete' });
    const log = await execCommand('git', ['log', '--format=%s'], { cwd: ref.projectDir });
    expect(log.stdout).toContain('Lancio: v2');
    expect((await store.get(ref.creativeSlug)).status).toBe('ready');
  });

  it('names the primary by its own history entry, and the followers export with the primary ★ (decisions log 140)', async () => {
    setLocale('en');
    await setup(brief);
    await run(service.start(ref));
    // v2 changes the post only: the Reel is carried (identical), so its history stays [1].
    expect(await run(service.start(ref, { text: 'post only', pins: [] }, { formats: [POST] }))).toBe('succeeded');
    await service.updateBrief(ref, { brief: { ...brief, formats: [REEL, POST, TIKTOK, SHORTS] } });
    expect(await run(service.start(ref))).toBe('succeeded');
    const vs = await versions();
    expect(formatHistory(vs, REEL)).toEqual([1]);
    // The copy came from v2, but the Reel the user knows is v1.
    expect(vs[2]!.request).toBe('Added TikTok · Video 9:16 and YouTube · Shorts 9:16 using the Instagram · Story/Reel 9:16 (v1)');
    const creative = await store.get(ref.creativeSlug);
    const summaries = await formatSummaries(store.dir(ref.creativeSlug), creative, vs, DEFAULT_FORMATS);
    const of = (id: string) => summaries.find((x) => x.id === id)!;
    expect(of(REEL)).toMatchObject({ star: { version: 1 }, exportVersion: 1, starFileMissing: false });
    for (const f of [TIKTOK, SHORTS]) expect(of(f)).toMatchObject({ star: { version: null, follows: REEL }, exportVersion: 3, starFileMissing: false });
    const dest = join(await mkdtemp(join(tmpdir(), 'ms-add-exp-')), 'out');
    const r = await exportPicks({ creativeDir: store.dir(ref.creativeSlug), destination: dest, slug: ref.creativeSlug, title: 'Lancio', presets: DEFAULT_FORMATS,
      pattern: '{format}-v{v}', versions: vs, picks: { [REEL]: 1 }, follow: { [TIKTOK]: 3, [SHORTS]: 3 }, links: creative.brief.links, storedPicks: creative.exportPicks });
    expect(r.files.map((f) => f.to.split('/').pop())).toEqual([`${REEL}-v1.mp4`, `${TIKTOK}-v1.mp4`, `${SHORTS}-v1.mp4`]);
    expect(r.files.map((f) => f.from.split('/').slice(-2).join('/'))).toEqual([`v1/${REEL}.mp4`, `v3/${TIKTOK}.mp4`, `v3/${SHORTS}.mp4`]);
  });

  it('runs the agent for the 16:9 only and materializes TikTok when TikTok and a 16:9 are added', async () => {
    await setup(brief);
    await run(service.start(ref));
    await service.updateBrief(ref, { brief: { ...brief, formats: [REEL, POST, TIKTOK, YT] } });
    expect(await run(service.start(ref))).toBe('succeeded');
    expect(await claudeRuns()).toBe(2);
    const last = (await prompts()).at(-1)!.prompt;
    expect(parseStudioBlock(last)!.formats.map((f) => f.id)).toEqual([YT]);
    expect(last).toContain(`Aggiungi i formati ${YT} riusando`);
    const [v1, v2] = await versions();
    expect(v2!.request).toMatch(new RegExp(`^Aggiungi i formati ${YT} `));
    for (const f of [REEL, POST]) expect(out(v2!, f)!.sha256).toBe(out(v1!, f)!.sha256);
    expect(out(v2!, TIKTOK)!.sha256).toBe(out(v1!, REEL)!.sha256);
    expect(out(v2!, YT)).toBeDefined();
    expect(v2!.usage).toBeDefined();
  });

  it('a new follower that cannot follow the real duration of the base is unlinked and given to the agent', async () => {
    setLocale('en');
    // A 70 s reel (no target duration): fine for the reel, over the Shorts' 60 s.
    const open = { ...brief, durationSec: null, formats: [REEL] };
    await setup(open);
    process.env.FAKE_CLAUDE_MANIFEST_PATCH = JSON.stringify({ durationSec: 70 });
    await run(service.start(ref));
    delete process.env.FAKE_CLAUDE_MANIFEST_PATCH;
    expect((await versions())[0]!.status).toBe('complete');
    await service.updateBrief(ref, { brief: { ...open, formats: [REEL, SHORTS] } });
    expect((await store.get(ref.creativeSlug)).brief.links).toEqual({ [SHORTS]: REEL });
    await run(service.start(ref));
    expect(await claudeRuns()).toBe(2);
    expect(parseStudioBlock((await prompts()).at(-1)!.prompt)!.formats.map((f) => f.id)).toEqual([SHORTS]);
    expect((await store.get(ref.creativeSlug)).brief.links).toEqual({});
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.some((e) => e.type === 'system' && e.level === 'warning' && e.text.startsWith('YouTube · Shorts 9:16 can no longer follow Instagram · Story/Reel 9:16'))).toBe(true);
    const [v1, v2] = await versions();
    expect(v2!.status).toBe('complete');
    expect(out(v2!, REEL)!.sha256).toBe(out(v1!, REEL)!.sha256);
  });

  it('still asks the agent when the user sends a message, even if the added formats are all linkable', async () => {
    await setup(brief);
    await run(service.start(ref));
    await service.updateBrief(ref, { brief: { ...brief, formats: [REEL, POST, TIKTOK] } });
    await run(service.start(ref, { text: 'e aggiungi TikTok', pins: [] }));
    expect(await claudeRuns()).toBe(2);
    expect(parseStudioBlock((await prompts()).at(-1)!.prompt)!.formats.map((f) => f.id)).toEqual([REEL, POST]);
    const v2 = (await versions())[1]!;
    expect(out(v2, TIKTOK)!.sha256).toBe(out(v2, REEL)!.sha256);
  });

  it('keeps the fork after a restore followed by a version made without the agent', async () => {
    await setup(brief);
    await run(service.start(ref));
    await run(service.start(ref, { text: 'cambia', pins: [] }));
    await service.restore(ref, 1);
    await service.updateBrief(ref, { brief: { ...brief, formats: [REEL, POST, TIKTOK] } });
    expect(await run(service.start(ref))).toBe('succeeded');
    expect(await claudeRuns()).toBe(2);
    const v3 = (await versions())[2]!;
    expect(v3).toMatchObject({ n: 3, basedOn: 1, sessionId: 'fake-session-1' });
    expect((await store.get(ref.creativeSlug)).resumeFrom).toEqual({ version: 3, sessionId: 'fake-session-1' });
    await run(service.start(ref, { text: 'da qui', pins: [] }));
    const args = (JSON.parse((await readFile(promptFile, 'utf8')).trim().split('\n').at(-1)!) as { args: string[] }).args;
    expect(args).toContain('--fork-session');
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', 'fake-session-1']);
    const v4 = (await versions())[3]!;
    expect(v4.basedOn).toBe(3);
    expect(out(v4, TIKTOK)!.sha256).toBe(out(v4, REEL)!.sha256);
    expect((await store.get(ref.creativeSlug)).resumeFrom).toBeNull();
  });
});

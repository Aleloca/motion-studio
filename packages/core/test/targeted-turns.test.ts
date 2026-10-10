import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FORMATS, formatHistory, manifestSchema, type Brief, type VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { CreativeTurnService, type CreativeRef } from '../src/creatives/creative-turns.ts';
import { hashTesting } from '../src/creatives/output-hashes.ts';
import { hashConfinedFile } from '../src/brand/agent-guard.ts';
import { parseStudioBlock } from '../src/creatives/prompt.ts';
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
const baseBrief: Brief = { goal: 'Lancio app', message: '', formats: [REEL, POST], durationSec: 10, assets: [], notes: '' };

let ref: CreativeRef;
let store: CreativeStore;
let queue: JobQueue;
let service: CreativeTurnService;
let promptFile: string;
let launcher: ReturnType<typeof testLauncher>;
/** console.warn of the core (copies refused, hashes skipped): silenced, and asserted where a test expects one. */
let warn: ReturnType<typeof vi.spyOn>;

async function setup(brief: Brief) {
  const base = await mkdtemp(join(tmpdir(), 'ms-target-'));
  const git = new Git();
  const ws = await WorkspaceStore.open(join(base, 'ws'), git);
  const { slug } = await ws.createProject({ name: 'Acme' });
  const projectDir = ws.projectDir(slug);
  store = new CreativeStore(projectDir);
  const created = await store.create({ title: 'Lancio', brief });
  ref = { root: ws.root, projectSlug: slug, projectDir, creativeSlug: created.slug };
  queue = new JobQueue({ concurrency: 2 });
  launcher = testLauncher(new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }));
  service = new CreativeTurnService({
    queue, git, media: NoMediaTools, vault: new MemoryVault(),
    launcher,
    presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {},
  });
  promptFile = join(base, 'prompts.jsonl');
  process.env.FAKE_CLAUDE_PROMPT_FILE = promptFile;
}

beforeEach(() => {
  process.env.FAKE_CLAUDE_SCENARIO = 'render';
  process.env.FAKE_CLAUDE_NO_FFMPEG = '1';
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ['FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_PROMPT_FILE', 'FAKE_CLAUDE_NO_FFMPEG', 'FAKE_CLAUDE_EXTRA_FILES', 'FAKE_CLAUDE_MANIFEST_PATCH',
    'FAKE_CLAUDE_TOUCH', 'FAKE_CLAUDE_HARDLINK', 'FAKE_CLAUDE_SYMLINK_AT', 'FAKE_CLAUDE_BG_WRITE']) delete process.env[k];
  hashTesting.setHasher(null);
  warn.mockRestore();
  setLocale('it');
});

const prompts = async () => (await readFile(promptFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { prompt: string; args: string[] });
const blockFormats = (prompt: string) => parseStudioBlock(prompt)!.formats.map((f) => f.id);
const run = async (job: Promise<{ id: string }>) => {
  const { id } = await job;
  await queue.whenIdle();
  return queue.list().find((j) => j.id === id)!.state;
};
const versions = () => store.readVersions(ref.creativeSlug);
const out = (v: VersionEntry, format: string) => v.outputs.find((o) => o.format === format);
const fileOf = (n: number, file: string) => join(store.outputsDir(ref.creativeSlug, n), file);
const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const manifestOf = async (n: number) => manifestSchema.parse(JSON.parse(await readFile(fileOf(n, 'manifest.json'), 'utf8')));

describe('targeted turns (spec §2.5)', { timeout: 30_000 }, () => {
  it('formats: [reel] delivers only the reel; the post is carried with the same sha256 and its history does not grow', async () => {
    await setup(baseBrief);
    expect(await run(service.start(ref))).toBe('succeeded');
    expect(await run(service.start(ref, { text: 'Logo più grande', pins: [] }, { formats: [REEL] }))).toBe('succeeded');
    const all = await prompts();
    expect(all).toHaveLength(2);
    const last = all[1]!.prompt;
    expect(blockFormats(last)).toEqual([REEL]);
    const required = last.slice(last.indexOf('## Required formats'), last.indexOf('## Encoding'));
    expect(required).toContain(REEL);
    expect(required).not.toContain(POST);
    expect(last).not.toContain(POST);
    expect(last).toContain('Deliver only the formats listed above');

    const [v1, v2] = await versions();
    expect(v2).toMatchObject({ n: 2, status: 'complete', problems: [], request: 'Logo più grande', basedOn: 1 });
    expect(out(v2!, POST)!.sha256).toBe(out(v1!, POST)!.sha256);
    expect(await sha(fileOf(2, `${POST}.mp4`))).toBe(out(v1!, POST)!.sha256);
    expect(out(v2!, REEL)!.sha256).not.toBe(out(v1!, REEL)!.sha256);
    expect(formatHistory([v1!, v2!], POST)).toEqual([1]);
    expect(formatHistory([v1!, v2!], REEL)).toEqual([1, 2]);
    expect(out(v2!, POST)!.problems).toEqual([]);
    expect((await stat(fileOf(2, `${POST}.mp4`))).nlink).toBe(1);
    expect((await manifestOf(2)).files.map((f) => f.format)).toEqual([REEL, POST]);
    expect(v2!.tools).toEqual(['fake']);
  });

  it('a follower in formats stands for its primary', async () => {
    await setup({ ...baseBrief, formats: [REEL, POST, TIKTOK], links: { [TIKTOK]: REEL } });
    await run(service.start(ref));
    const started = await service.start(ref, { text: 'più veloce', pins: [] }, { formats: [TIKTOK] });
    // The job says what it targets (followers resolved to their primaries), for the web's per-board "Rendering…".
    expect(started.formats).toEqual([REEL]);
    await run(Promise.resolve(started));
    expect(blockFormats((await prompts()).at(-1)!.prompt)).toEqual([REEL]);
    const [v1, v2] = await versions();
    expect(out(v2!, POST)!.sha256).toBe(out(v1!, POST)!.sha256);
    expect(out(v2!, TIKTOK)!.sha256).toBe(out(v2!, REEL)!.sha256);
  });

  it('an untargeted job carries no formats (every board renders)', async () => {
    await setup(baseBrief);
    const started = await service.start(ref);
    expect(started.formats).toBeUndefined();
    await run(Promise.resolve(started));
  });

  it('keeps the carried post when the agent overwrites it, with a note (the agent file is discarded)', async () => {
    await setup(baseBrief);
    await run(service.start(ref));
    process.env.FAKE_CLAUDE_EXTRA_FILES = JSON.stringify([{ format: POST, file: `${POST}.mp4`, width: 1080, height: 1080, durationSec: 10 }]);
    await run(service.start(ref, { text: 'ritocca', pins: [] }, { formats: [REEL] }));
    const [v1, v2] = await versions();
    expect(await readFile(fileOf(2, `${POST}.mp4`), 'utf8')).not.toContain('agent:');
    expect(out(v2!, POST)!.sha256).toBe(out(v1!, POST)!.sha256);
    expect(out(v2!, POST)!.warnings).toEqual([{ key: 'outputs.keptUnchanged', params: { format: POST } }]);
    expect(out(v2!, REEL)!.warnings).toBeUndefined();
    expect(v2!.status).toBe('complete');
  });

  it('a follower the agent overwrote is a fresh copy of the new primary: its own note, never "kept unchanged" (I2)', async () => {
    await setup({ ...baseBrief, formats: [REEL, POST, TIKTOK], links: { [TIKTOK]: REEL } });
    await run(service.start(ref));
    process.env.FAKE_CLAUDE_EXTRA_FILES = JSON.stringify([{ format: TIKTOK, file: `${TIKTOK}.mp4`, width: 1080, height: 1920, durationSec: 10 }]);
    await run(service.start(ref, { text: 'ritocca', pins: [] }, { formats: [REEL] }));
    const [, v2] = await versions();
    expect(out(v2!, TIKTOK)!.sha256).toBe(out(v2!, REEL)!.sha256);
    expect(out(v2!, TIKTOK)!.warnings).toEqual([{ key: 'outputs.followerReplaced', params: { format: TIKTOK, primary: REEL } }]);
    expect(out(v2!, REEL)!.warnings).toBeUndefined();
  });

  it('"overwrote" also means a file at the carried name the manifest does not list, or a manifest entry under another name', async () => {
    await setup(baseBrief);
    await run(service.start(ref));
    // Unlisted file at the carried name.
    process.env.FAKE_CLAUDE_EXTRA_FILES = JSON.stringify([{ file: `${POST}.mp4` }]);
    await run(service.start(ref, { text: 'uno', pins: [] }, { formats: [REEL] }));
    // Listed under another name: that file is removed too.
    process.env.FAKE_CLAUDE_EXTRA_FILES = JSON.stringify([{ format: POST, file: 'altro.webm', width: 1080, height: 1080, durationSec: 10 }]);
    await run(service.start(ref, { text: 'due', pins: [] }, { formats: [REEL] }));
    const [v1, v2, v3] = await versions();
    for (const v of [v2!, v3!]) {
      expect(out(v, POST)!.sha256).toBe(out(v1!, POST)!.sha256);
      expect(out(v, POST)!.warnings).toEqual([{ key: 'outputs.keptUnchanged', params: { format: POST } }]);
    }
    await expect(stat(fileOf(3, 'altro.webm'))).rejects.toThrow();
    expect(formatHistory([v1!, v2!, v3!], POST)).toEqual([1]);
  });

  it('runs the fix loop on the targets only', async () => {
    await setup(baseBrief);
    await run(service.start(ref));
    process.env.FAKE_CLAUDE_SCENARIO = 'render_missing_once';
    await run(service.start(ref, { text: 'solo il reel', pins: [] }, { formats: [REEL] }));
    const all = await prompts();
    expect(all).toHaveLength(3);
    const fix = all[2]!.prompt;
    expect(fix).toContain('do not meet the contract');
    expect(fix).toContain(`(${REEL})`);
    expect(fix).not.toContain(POST);
    expect(blockFormats(fix)).toEqual([REEL]);
    const [v1, v2] = await versions();
    expect(v2!.status).toBe('complete');
    expect(out(v2!, POST)!.sha256).toBe(out(v1!, POST)!.sha256);
  });

  it('never trusts followsFormat or sha256 from the agent manifest', async () => {
    await setup(baseBrief);
    process.env.FAKE_CLAUDE_MANIFEST_PATCH = JSON.stringify({ followsFormat: REEL, sha256: '0'.repeat(64) });
    await run(service.start(ref));
    expect((await manifestOf(1)).files.every((f) => f.followsFormat === undefined)).toBe(true);
    const [v1] = await versions();
    expect(out(v1!, POST)!.sha256).toBe(await sha(fileOf(1, `${POST}.mp4`)));
    // Also when the core assembles the version (carried formats).
    await run(service.start(ref, { text: 'ancora', pins: [] }, { formats: [POST] }));
    expect((await manifestOf(2)).files.every((f) => f.followsFormat === undefined)).toBe(true);
  });
});

describe('linked formats (spec §2.3)', { timeout: 30_000 }, () => {
  it('materializes a follower as a copy of its primary, with followsFormat in the manifest', async () => {
    await setup({ ...baseBrief, formats: [REEL, POST, TIKTOK], links: { [TIKTOK]: REEL } });
    process.env.FAKE_CLAUDE_MANIFEST_PATCH = JSON.stringify({ followsFormat: POST });
    expect(await run(service.start(ref))).toBe('succeeded');
    expect(blockFormats((await prompts())[0]!.prompt)).toEqual([REEL, POST]);
    const [v1] = await versions();
    expect(v1!.status).toBe('complete');
    expect(v1!.outputs.map((o) => o.format)).toEqual([REEL, POST, TIKTOK]);
    expect(out(v1!, TIKTOK)).toMatchObject({ file: `${TIKTOK}.mp4`, problems: [] });
    expect(out(v1!, TIKTOK)!.sha256).toBe(out(v1!, REEL)!.sha256);
    expect((await stat(fileOf(1, `${TIKTOK}.mp4`))).nlink).toBe(1);
    const m = await manifestOf(1);
    expect(m.files.find((f) => f.format === TIKTOK)).toMatchObject({ file: `${TIKTOK}.mp4`, followsFormat: REEL });
    expect(m.files.filter((f) => f.followsFormat !== undefined).map((f) => f.format)).toEqual([TIKTOK]);
  });

  it('copies the primary problems to its follower', async () => {
    await setup({ ...baseBrief, formats: [REEL, TIKTOK], links: { [TIKTOK]: REEL } });
    // A 100 s reel: over the reel's 90 s and off the 10 s target, still within TikTok's 180 s, so TikTok follows it.
    process.env.FAKE_CLAUDE_MANIFEST_PATCH = JSON.stringify({ durationSec: 100 });
    await run(service.start(ref));
    const [v1] = await versions();
    expect(out(v1!, REEL)!.problems).toHaveLength(2);
    expect(out(v1!, TIKTOK)!.problems).toEqual(out(v1!, REEL)!.problems);
    expect(v1!.problems).toEqual(out(v1!, REEL)!.problems);
    expect(v1!.status).toBe('incomplete');
  });

  it('does not materialize a link broken by the real duration: message, problem, unlinked; the next turn makes it', async () => {
    setLocale('en');
    await setup({ ...baseBrief, durationSec: 70, formats: [REEL, SHORTS], links: { [SHORTS]: REEL } });
    await run(service.start(ref));
    const [v1] = await versions();
    expect(v1!.outputs.map((o) => o.format)).toEqual([REEL]);
    expect(v1!.status).toBe('incomplete');
    const text = 'YouTube · Shorts 9:16 was not delivered: it cannot follow Instagram · Story/Reel 9:16 (the main format is longer than its maximum duration). It is no longer linked, so the next turn makes a dedicated version.';
    expect(v1!.problems).toEqual([text]);
    expect((await store.readConversation(ref.creativeSlug)).some((e) => e.type === 'system' && e.text === text)).toBe(true);
    expect((await store.get(ref.creativeSlug)).brief.links).toEqual({});
    // Next turn: the shorts is its own primary, missing from v1, so the agent delivers it; the reel is carried.
    process.env.FAKE_CLAUDE_EXTRA_FILES = '[]';
    await run(service.start(ref));
    expect(blockFormats((await prompts()).at(-1)!.prompt)).toEqual([SHORTS]);
    const v2 = (await versions())[1]!;
    expect(out(v2, REEL)!.sha256).toBe(out(v1!, REEL)!.sha256);
    expect(out(v2, SHORTS)).toBeDefined();
  });

  it('accepts the turn request formats through the route body', async () => {
    const { turnBodySchema } = await import('../src/server/creative-routes.ts');
    expect(turnBodySchema.parse({ text: 'x', formats: [REEL] })).toEqual({ text: 'x', formats: [REEL] });
    expect(turnBodySchema.safeParse({ formats: [''] }).success).toBe(false);
  });
});

describe('carry-over safety (review fixes)', { timeout: 30_000 }, () => {
  it('protects every earlier outputs/v* folder of the creative, never the new one', async () => {
    await setup(baseBrief);
    await run(service.start(ref));
    await run(service.start(ref, { text: 'uno', pins: [] }));
    const start = vi.spyOn(launcher, 'start');
    await run(service.start(ref, { text: 'due', pins: [] }, { formats: [REEL] }));
    const dirs = start.mock.calls[0]![0].protectedDirs!;
    expect(dirs).toEqual([1, 2].map((k) => store.outputsDir(ref.creativeSlug, k)));
    expect(dirs).not.toContain(store.outputsDir(ref.creativeSlug, 3));
  });

  it('never carries a base file changed during the turn: problem, warning, the format is left out', async () => {
    setLocale('en');
    await setup(baseBrief);
    await run(service.start(ref));
    process.env.FAKE_CLAUDE_SCENARIO = 'render_touch';
    process.env.FAKE_CLAUDE_TOUCH = fileOf(1, `${POST}.mp4`);
    await run(service.start(ref, { text: 'solo reel', pins: [] }, { formats: [REEL] }));
    const v2 = (await versions())[1]!;
    expect(out(v2, POST)).toBeUndefined();
    expect(v2.status).toBe('incomplete');
    expect(v2.problems).toContain('Instagram · Post 1:1: the file of v1 is not the one recorded for that version, so it could not be kept unchanged');
    await expect(stat(fileOf(2, `${POST}.mp4`))).rejects.toThrow();
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.some((e) => e.type === 'system' && e.level === 'warning' && e.text.startsWith('Warning: files of earlier versions changed during this turn (outputs/v1/instagram-post-1x1.mp4)'))).toBe(true);
  });

  it('a base file already changed before the turn is not carried: the agent remakes it', async () => {
    await setup(baseBrief);
    await run(service.start(ref));
    await writeFile(fileOf(1, `${POST}.mp4`), 'manomesso');
    const started = await service.start(ref, { text: 'solo reel', pins: [] }, { formats: [REEL] });
    expect(started.formats).toEqual([REEL]);
    await run(Promise.resolve(started));
    expect(blockFormats((await prompts()).at(-1)!.prompt)).toEqual([REEL, POST]);
    // The job's summary follows the plan: the post is a target too, so every board renders (no formats).
    expect(queue.list().find((j) => j.id === started.id)!.formats).toBeUndefined();
    expect((await versions())[1]!.status).toBe('complete');
  });

  it('kills what the agent left running before touching the version', async () => {
    await setup(baseBrief);
    const late = join(store.workDir(ref.creativeSlug), 'late.txt');
    process.env.FAKE_CLAUDE_BG_WRITE = late;
    await run(service.start(ref));
    await new Promise((r) => setTimeout(r, 1800));
    await expect(stat(late)).rejects.toThrow();
  });

  it('a target named like a carried file is a problem for the agent to fix; the carried copy fails honestly, never "kept"', async () => {
    setLocale('en');
    await setup(baseBrief);
    await run(service.start(ref));
    process.env.FAKE_CLAUDE_MANIFEST_PATCH = JSON.stringify({ file: `${POST}.mp4`, width: 1080, height: 1920 });
    process.env.FAKE_CLAUDE_EXTRA_FILES = JSON.stringify([{ file: `${POST}.mp4` }]);
    await run(service.start(ref, { text: 'reel', pins: [] }, { formats: [REEL] }));
    const all = await prompts();
    const reserved = `${POST}.mp4: this name belongs to ${POST}, which Motion Studio delivers itself in this version; rename your file`;
    expect(all).toHaveLength(4);
    expect(all[2]!.prompt).toContain(reserved);
    const v2 = (await versions())[1]!;
    expect(v2.problems).toEqual(expect.arrayContaining([reserved, 'Instagram · Post 1:1: Motion Studio could not put its file in this version']));
    expect(out(v2, POST)).toBeUndefined();
    expect(v2.outputs.some((o) => o.warnings?.some((w) => w.key === 'outputs.keptUnchanged'))).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('a follower whose copy fails is a version problem, not silently missing', async () => {
    setLocale('en');
    await setup({ ...baseBrief, formats: [REEL, TIKTOK], links: { [TIKTOK]: REEL } });
    process.env.FAKE_CLAUDE_HARDLINK = `${REEL}.mp4`;
    await run(service.start(ref));
    const [v1] = await versions();
    expect(out(v1!, TIKTOK)).toBeUndefined();
    expect(v1!.problems).toContain('TikTok · Video 9:16: Motion Studio could not put its file in this version');
    expect(v1!.status).toBe('incomplete');
  });

  it('removes a symlink the agent planted at a carried name and carries the real file', async () => {
    await setup(baseBrief);
    await run(service.start(ref));
    const outside = join(await mkdtemp(join(tmpdir(), 'ms-outside-')), 'secret.mp4');
    await writeFile(outside, 'segreto');
    process.env.FAKE_CLAUDE_SYMLINK_AT = `${POST}.mp4=${outside}`;
    await run(service.start(ref, { text: 'reel', pins: [] }, { formats: [REEL] }));
    const [v1, v2] = await versions();
    expect((await lstat(fileOf(2, `${POST}.mp4`))).isSymbolicLink()).toBe(false);
    expect(out(v2!, POST)!.sha256).toBe(out(v1!, POST)!.sha256);
    expect(out(v2!, POST)!.warnings).toEqual([{ key: 'outputs.keptUnchanged', params: { format: POST } }]);
    expect(await readFile(outside, 'utf8')).toBe('segreto');
  });

  it('cross-checks the version hashes with the verified copies', async () => {
    setLocale('en');
    await setup(baseBrief);
    await run(service.start(ref));
    hashTesting.setHasher(async (base, rel) => (rel === `outputs/v2/${POST}.mp4` ? { sha256: 'f'.repeat(64), size: 1, mtimeMs: 1 } : hashConfinedFile(base, rel)));
    await run(service.start(ref, { text: 'reel', pins: [] }, { formats: [REEL] }));
    const v2 = (await versions())[1]!;
    expect(v2.problems).toEqual(['Instagram · Post 1:1: the file changed after Motion Studio copied it']);
    expect(out(v2, POST)!.problems).toEqual(['Instagram · Post 1:1: the file changed after Motion Studio copied it']);
  });

  it('a carried format keeps the problems of its base file, never sent to the agent', async () => {
    await setup(baseBrief);
    process.env.FAKE_CLAUDE_MANIFEST_PATCH = JSON.stringify({ durationSec: 100 });
    await run(service.start(ref));
    delete process.env.FAKE_CLAUDE_MANIFEST_PATCH;
    const before = (await prompts()).length;
    await run(service.start(ref, { text: 'reel', pins: [] }, { formats: [REEL] }));
    expect((await prompts()).length - before).toBe(1);
    expect((await prompts()).at(-1)!.prompt).not.toContain(POST);
    const [v1, v2] = await versions();
    expect(out(v1!, POST)!.problems!.length).toBeGreaterThan(0);
    expect(out(v2!, POST)!.problems).toEqual(out(v1!, POST)!.problems);
    expect(out(v2!, REEL)!.problems).toEqual([]);
    expect(v2!.problems).toEqual(out(v1!, POST)!.problems);
    expect(v2!.status).toBe('incomplete');
  });

  it('refuses formats none of which is in the brief, with a stable code', async () => {
    await setup(baseBrief);
    await expect(service.start(ref, { text: 'x', pins: [] }, { formats: ['ghost'] })).rejects.toMatchObject({ status: 400, apiCode: 'formats-not-in-brief' });
    expect(await store.readConversation(ref.creativeSlug)).toEqual([]);
  });

  it('points the render-command hint at the new version folder and forbids earlier ones', async () => {
    await setup(baseBrief);
    await run(service.start(ref));
    const vs = await versions();
    vs[0]!.renderCommand = 'npx remotion render Main ../outputs/v1/instagram-reel-9x16.mp4 --dir=outputs/v1 && cp a "outputs/v1" && ls outputs/v12x outputs/v1';
    await writeFile(join(store.dir(ref.creativeSlug), 'versions.json'), JSON.stringify({ schemaVersion: 1, versions: vs }));
    await store.update(ref.creativeSlug, { brief: { ...baseBrief, formats: [REEL, POST, 'youtube-16x9'] } });
    await run(service.start(ref));
    const last = (await prompts()).at(-1)!.prompt;
    // Followed by a slash, nothing, a quote or the end; never part of a longer name.
    expect(last).toContain('npx remotion render Main ../outputs/v2/instagram-reel-9x16.mp4 --dir=outputs/v2 && cp a "outputs/v2" && ls outputs/v12x outputs/v2');
    expect(last).not.toContain('outputs/v1/');
    expect(last).toContain(`Never write into the other \`creatives/${ref.creativeSlug}/outputs/v*\` folders`);
  });

  it('a carried file whose copy cannot be hashed is "could not be verified", not "changed"', async () => {
    setLocale('en');
    await setup(baseBrief);
    await run(service.start(ref));
    hashTesting.setHasher(async (base, rel) => (rel === `outputs/v2/${POST}.mp4` ? { skipped: 'unreadable', code: 'EACCES' } : hashConfinedFile(base, rel)));
    await run(service.start(ref, { text: 'reel', pins: [] }, { formats: [REEL] }));
    const v2 = (await versions())[1]!;
    expect(v2.problems).toEqual(['Instagram · Post 1:1: the file Motion Studio copied could not be verified (it cannot be read as a regular file)']);
  });

  it('a legacy version (no per-file problems) passes on only the problems that name the carried format', async () => {
    await setup(baseBrief);
    await run(service.start(ref));
    const vs = await versions();
    const reelProblem = `${REEL}.mp4: durata 99.0s, richiesta circa 10s`;
    vs[0]!.outputs = vs[0]!.outputs.map(({ problems: _p, ...o }) => o);
    vs[0]!.problems = [reelProblem];
    vs[0]!.status = 'incomplete';
    await writeFile(join(store.dir(ref.creativeSlug), 'versions.json'), JSON.stringify({ schemaVersion: 1, versions: vs }));
    // The reel (the format named by the problem) is redone; the post is carried and inherits nothing.
    await run(service.start(ref, { text: 'reel', pins: [] }, { formats: [REEL] }));
    const v2 = (await versions())[1]!;
    expect(out(v2, POST)!.problems).toEqual([]);
    expect(v2.status).toBe('complete');
    // Carrying the reel instead: it inherits its own problem.
    await run(service.start(ref, { text: 'post', pins: [] }, { formats: [POST] }));
    await service.restore(ref, 1);
    await run(service.start(ref, { text: 'post da v1', pins: [] }, { formats: [POST] }));
    const v4 = (await versions())[3]!;
    expect(v4.basedOn).toBe(1);
    expect(out(v4, REEL)!.problems).toEqual([reelProblem]);
    expect(v4.status).toBe('incomplete');
  });
});


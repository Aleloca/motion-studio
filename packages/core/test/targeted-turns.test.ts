import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FORMATS, formatHistory, manifestSchema, type Brief, type VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { CreativeTurnService, type CreativeRef } from '../src/creatives/creative-turns.ts';
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
  service = new CreativeTurnService({
    queue, git, media: NoMediaTools, vault: new MemoryVault(),
    launcher: testLauncher(new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 })),
    presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {},
  });
  promptFile = join(base, 'prompts.jsonl');
  process.env.FAKE_CLAUDE_PROMPT_FILE = promptFile;
}

beforeEach(() => {
  process.env.FAKE_CLAUDE_SCENARIO = 'render';
  process.env.FAKE_CLAUDE_NO_FFMPEG = '1';
});
afterEach(() => {
  for (const k of ['FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_PROMPT_FILE', 'FAKE_CLAUDE_NO_FFMPEG', 'FAKE_CLAUDE_EXTRA_FILES', 'FAKE_CLAUDE_MANIFEST_PATCH']) delete process.env[k];
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
    await run(service.start(ref, { text: 'più veloce', pins: [] }, { formats: [TIKTOK] }));
    expect(blockFormats((await prompts()).at(-1)!.prompt)).toEqual([REEL]);
    const [v1, v2] = await versions();
    expect(out(v2!, POST)!.sha256).toBe(out(v1!, POST)!.sha256);
    expect(out(v2!, TIKTOK)!.sha256).toBe(out(v2!, REEL)!.sha256);
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

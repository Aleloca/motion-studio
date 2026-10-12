// @vitest-environment node
/**
 * Task 6 (spec §7): a legacy creative (v1 manifest, rendered media) is converted to compositions on its next change turn.
 * Reference frames of the old media go to the protected core cache (never the agent-writable work folder), the prompt asks
 * for a faithful rebuild plus the request, the chat says it costs more tokens once. Review Focus 5: per-format history,
 * the star and export across the legacy / v2 boundary, restart from a legacy version.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages, renderState, type CreativeDetail, type FormatPreset, type JobSummary, type VersionEntry } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { isLegacyVersion, referenceTimes } from '../src/creatives/legacy-conversion.ts';
import { noteCoreTemp } from '../src/core-temps.ts';
import { Git } from '../src/git.ts';
import { createFfmpegTools, type MediaTools } from '../src/media/media-tools.ts';
import { frameTime, type RenderFramesOptions, type RenderFramesResult } from '../src/render/frames.ts';
import type { RenderCompositionOptions, RenderEngine, RenderResult } from '../src/render/renderer.ts';
import { setLocale } from '../src/i18n.ts';
import { buildServer } from '../src/server/app.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const TOKEN = 'ab'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const PRESETS: FormatPreset[] = [
  { id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 },
  { id: 'test-tall', channel: 'Test', name: 'Tall', width: 180, height: 320, kind: 'video', extensions: ['mp4'] },
  { id: 'test-still', channel: 'Test', name: 'Still', width: 320, height: 180, kind: 'image', extensions: ['png', 'jpg'] },
];

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}

interface FakeEngine { engine: RenderEngine; renders: RenderCompositionOptions[] }
function fakeEngine(): FakeEngine {
  const f: FakeEngine = { renders: [], engine: null as unknown as RenderEngine };
  f.engine = {
    info: async () => ({ kind: 'injected' }),
    provider: async () => { throw new Error('not used'); },
    frames: async (o: Omit<RenderFramesOptions, 'provider'>): Promise<RenderFramesResult> => {
      const c = o.composition;
      const height = Math.round((o.width * c.height) / c.width);
      return { frames: o.times.map((t) => ({ t: frameTime(c, t), data: png(o.width, height), width: o.width, height })), errors: [] };
    },
    render: async (o: Omit<RenderCompositionOptions, 'provider'>): Promise<RenderResult> => {
      f.renders.push(o as RenderCompositionOptions);
      const still = !(o.composition.duration > 0);
      const temp = join(dirname(o.out), `.${basename(o.out)}.render-${randomBytes(6).toString('hex')}.tmp`);
      noteCoreTemp(temp);
      const body = `render of ${o.format.id} ${randomBytes(4).toString('hex')}`;
      await writeFile(temp, body);
      await o.beforeRename?.(temp);
      await rename(temp, o.out);
      return { file: o.out, sha256: createHash('sha256').update(body).digest('hex'), width: o.composition.width, height: o.composition.height,
        durationSec: still ? null : o.composition.duration, frames: 1, encoder: still ? null : 'libx264', audio: false, warnings: [] };
    },
  } as unknown as RenderEngine;
  return f;
}

/** Records every frame request and writes a small JPEG-ish file. */
interface FakeMedia extends MediaTools { calls: Array<{ video: string; atSec: number; width: number | undefined; out: string }> }
function fakeMedia(): FakeMedia {
  const m: FakeMedia = {
    calls: [], available: true,
    probe: async () => null, poster: async () => false,
    frame: async (video, out, atSec, opts) => {
      m.calls.push({ video, atSec, width: opts?.width, out });
      writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { flag: 'wx' });
      return true;
    },
  };
  return m;
}

let base: string;
let app: FastifyInstance;
let fake: FakeEngine;
let media: MediaTools;
let fm: FakeMedia;
let ws: string;
let promptFile: string;

async function boot(mediaTools: MediaTools) {
  media = mediaTools;
  app = await buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [],
    render: fake.engine, uiOrigins: () => ['http://127.0.0.1:5999'], bridge: new AgentBridge(), mcpCommand: [process.execPath, '-e', ''],
    media: mediaTools,
  });
  ws = join(base, 'ws');
  await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: ws } });
  await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } });
  expect((await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: PRESETS } })).statusCode).toBe(200);
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'ms-test-legacy-conv-'));
  fake = fakeEngine();
  fm = fakeMedia();
  await boot(fm);
  setLocale('en'); // after boot: the app config must not override it
  promptFile = join(base, 'prompts.jsonl');
  process.env.FAKE_CLAUDE_PROMPT_FILE = promptFile;
  process.env.FAKE_CLAUDE_SCENARIO = 'composition';
});
afterEach(async () => {
  setLocale('it');
  delete process.env.FAKE_CLAUDE_PROMPT_FILE;
  delete process.env.FAKE_CLAUDE_SCENARIO;
  await app?.close();
  rmSync(base, { recursive: true, force: true });
});

const projectDir = () => join(ws, 'acme');
const store = () => new CreativeStore(projectDir());
const prompts = () => (existsSync(promptFile) ? readFileSync(promptFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { prompt: string }) : []);
async function waitJob(id: string): Promise<JobSummary> {
  for (let i = 0; i < 3000; i++) {
    const j = ((await app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id);
    if (j && j.state !== 'queued' && j.state !== 'running') return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for the job');
}
async function turn(slug: string, payload: object = {}): Promise<JobSummary> {
  const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/turns`, headers: H, payload });
  expect(r.statusCode, r.body).toBe(202);
  const done = await waitJob((r.json() as JobSummary).id);
  expect(done.state, done.error).toBe('succeeded');
  return done;
}
const detail = async (slug: string) => (await app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H })).json() as CreativeDetail;
const versionOf = async (slug: string, n: number): Promise<VersionEntry> => (await store().readVersions(slug)).find((v) => v.n === n)!;
const systemTexts = async (slug: string) => (await store().readConversation(slug)).filter((e) => e.type === 'system').map((e) => (e as { text: string }).text);
const CONVERTING = messages('en').jobs.convertingLegacy;
const hasConverting = (texts: string[]) => texts.filter((t) => t === CONVERTING).length;
it('the chat entry is the specified text (en and it)', () => {
  expect(CONVERTING).toBe('Converting to the editable format · costs more tokens this once');
  expect(messages('it').jobs.convertingLegacy).toBe('Conversione al formato modificabile · costa più token questa volta');
});

/** A creative without versions, then legacy versions written straight to disk (a v1 manifest, rendered files). */
async function legacy(formats: string[], versions: Array<Record<string, string>> = [{ 'test-wide': 'a', 'test-tall': 'a', 'test-still': 'a' }], durationSec = 4, restorable = false): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
    title: 'Old', generate: false, brief: { goal: 'g', message: '', formats, durationSec: 4, assets: [], notes: '' } } });
  const slug = r.json().slug as string;
  for (const [i, shas] of versions.entries()) {
    const n = i + 1;
    const dir = join(store().dir(slug), 'outputs', `v${n}`);
    mkdirSync(dir, { recursive: true });
    const outputs = formats.map((format) => {
      const still = format === 'test-still';
      const file = `${format}.${still ? 'png' : 'mp4'}`;
      writeFileSync(join(dir, file), `legacy ${format} ${shas[format]} v${n}`);
      return { format, file, width: 320, height: 180, durationSec: still ? null : durationSec, verified: true, preview: null, sha256: createHash('sha256').update(`${format}-${shas[format]}`).digest('hex'), problems: [] as string[] };
    });
    await store().appendVersion(slug, { n, commit: restorable ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir(), encoding: 'utf8' }).trim() : null, sessionId: restorable ? 'legacy-session' : null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', problems: [], tools: ['remotion'], renderCommand: 'npx remotion render', basedOn: n > 1 ? n - 1 : null, outputs });
  }
  return slug;
}
const refDir = (slug: string, n: number, format: string) => join(projectDir(), '.studio', 'cache', 'reference-frames', slug, `v${n}`, format);

describe('legacy conversion', { timeout: 60_000 }, () => {
  it('a legacy base converts on the next change: reference frames in the protected cache, conversion prompt, chat entry', async () => {
    const slug = await legacy(['test-wide', 'test-still']);
    await turn(slug, { text: 'make the title bigger' });
    // 4 s video: one frame per second; the still: one frame. All 540 px wide, from the old media.
    expect(fm.calls.filter((c) => c.video.endsWith('test-wide.mp4')).map((c) => c.atSec)).toEqual([0, 1, 2, 3]);
    expect(fm.calls.filter((c) => c.video.endsWith('test-still.png')).map((c) => c.atSec)).toEqual([0]);
    expect(fm.calls.every((c) => c.width === 540)).toBe(true);
    expect(readdirSync(refDir(slug, 2, 'test-wide')).sort()).toEqual(['01.jpg', '02.jpg', '03.jpg', '04.jpg']);
    expect(readdirSync(refDir(slug, 2, 'test-still'))).toEqual(['01.jpg']);
    // Never in the agent-writable work folder.
    expect(existsSync(join(store().dir(slug), 'work', 'reference'))).toBe(false);
    const p = prompts()[0]!.prompt;
    expect(p).toContain('## Convert the earlier media first');
    expect(p).toContain('rebuild EACH of them faithfully as a composition');
    expect(p).toContain(`.studio/cache/reference-frames/${slug}/v2/test-wide/01.jpg (t=0s)`);
    expect(p).toContain(`.studio/cache/reference-frames/${slug}/v2/test-still/01.jpg`);
    expect(p).toContain(`creatives/${slug}/outputs/v1/test-wide.mp4`);
    expect(p).toContain('make the title bigger');
    expect(p).not.toMatch(/npx remotion|renderCommand/i);
    expect(hasConverting(await systemTexts(slug))).toBe(1);
    // The result is a v2 version with a composition for every format.
    const v2 = await versionOf(slug, 2);
    expect(v2.compositions!.map((c) => c.format)).toEqual(['test-wide', 'test-still']);
    expect(isLegacyVersion(v2)).toBe(false);
  });

  it('a conversion without a message (regenerate) still converts', async () => {
    const slug = await legacy(['test-wide']);
    await turn(slug, {});
    expect(prompts()[0]!.prompt).toContain('## Convert the earlier media first');
    expect(hasConverting(await systemTexts(slug))).toBe(1);
  });

  it('a v2 base does not convert: no conversion prompt, no chat entry, no reference frames', async () => {
    const slug = await legacy(['test-wide']);
    await turn(slug, { text: 'first change' });
    fm.calls.length = 0;
    await turn(slug, { text: 'second change' });
    expect(prompts()[1]!.prompt).not.toContain('Convert the earlier version');
    expect(hasConverting(await systemTexts(slug))).toBe(1);
    expect(fm.calls).toEqual([]);
    expect(existsSync(join(projectDir(), '.studio', 'cache', 'reference-frames', slug, 'v3'))).toBe(false);
  });

  it('a first version (no base) does not convert', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
      title: 'New', generate: true, brief: { goal: 'g', message: '', formats: ['test-wide'], durationSec: 4, assets: [], notes: '' } } });
    await waitJob(r.json().job.id);
    expect(prompts()[0]!.prompt).not.toContain('Convert the earlier version');
    expect(fm.calls).toEqual([]);
  });

  it('a long video gets at most 12 frames, spread over the clip', async () => {
    const slug = await legacy(['test-wide'], [{ 'test-wide': 'a' }], 30);
    await turn(slug, { text: 'go' });
    expect(fm.calls).toHaveLength(12);
    expect(fm.calls[0]!.atSec).toBe(0);
    expect(fm.calls[11]!.atSec).toBeLessThan(30);
    expect(fm.calls.map((c) => c.atSec)).toEqual([...fm.calls.map((c) => c.atSec)].sort((a, b) => a - b));
  });

  it('restart from a legacy version: the next turn converts that version', async () => {
    const slug = await legacy(['test-wide'], [{ 'test-wide': 'a' }], 4, true);
    await turn(slug, { text: 'to compositions' }); // v2 (a composition)
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/restore`, headers: H });
    expect(r.statusCode, r.body).toBe(200);
    fm.calls.length = 0;
    await turn(slug, { text: 'from the old one' });
    expect(prompts()[1]!.prompt).toContain('## Convert the earlier media first');
    expect(prompts()[1]!.prompt).toContain(`creatives/${slug}/outputs/v1/test-wide.mp4`);
    expect(fm.calls.every((c) => c.video.includes(join('outputs', 'v1')))).toBe(true);
    expect(fm.calls.length).toBeGreaterThan(0);
    expect(hasConverting(await systemTexts(slug))).toBe(2);
  });

  it('and restarting from a v2 version after a conversion does not convert', async () => {
    const slug = await legacy(['test-wide']);
    await turn(slug, { text: 'one' });
    await turn(slug, { text: 'two' });
    await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/2/restore`, headers: H });
    await turn(slug, { text: 'three' });
    expect(prompts()[2]!.prompt).not.toContain('Convert the earlier version');
  });

  it('media that is a link, a hard link or reached through a linked folder gets no frames; nothing is written outside', async () => {
    const slug = await legacy(['test-wide', 'test-tall', 'test-still']);
    const v1 = join(store().dir(slug), 'outputs', 'v1');
    const outside = mkdtempSync(join(tmpdir(), 'ms-test-outside-'));
    try {
      writeFileSync(join(outside, 'secret.mp4'), 'secret');
      rmSync(join(v1, 'test-wide.mp4'));
      symlinkSync(join(outside, 'secret.mp4'), join(v1, 'test-wide.mp4'));
      linkSync(join(v1, 'test-tall.mp4'), join(outside, 'twin.mp4'));
      // The cache folder of the new version is a link to somewhere else: no frames for the still either.
      mkdirSync(join(projectDir(), '.studio', 'cache', 'reference-frames', slug), { recursive: true });
      symlinkSync(outside, join(projectDir(), '.studio', 'cache', 'reference-frames', slug, 'v2'));
      await turn(slug, { text: 'go' });
      // The planted folder link is removed as an entry (never followed); the safe media still gets its frame, in a real folder.
      expect(fm.calls.map((c) => basename(c.video))).toEqual(['test-still.png']);
      expect(readdirSync(outside).sort()).toEqual(['secret.mp4', 'twin.mp4']);
      expect(lstatSync(join(projectDir(), '.studio', 'cache', 'reference-frames', slug, 'v2')).isDirectory()).toBe(true);
      const p = prompts()[0]!.prompt;
      expect(p).toContain('test-wide: rebuild from version 1');
      expect(p.match(/no reference frames could be extracted/g)).toHaveLength(2);
      expect(p).toContain('reference-frames/' + slug + '/v2/test-still/01.jpg');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a link planted at a frame name is replaced as an entry; its target is untouched; leftovers of a former try are removed', async () => {
    const slug = await legacy(['test-wide']);
    const outside = mkdtempSync(join(tmpdir(), 'ms-test-outside-'));
    try {
      writeFileSync(join(outside, 'victim.txt'), 'keep');
      const dir = refDir(slug, 2, 'test-wide');
      mkdirSync(dir, { recursive: true });
      symlinkSync(join(outside, 'victim.txt'), join(dir, '01.jpg'));
      writeFileSync(join(dir, '09.jpg'), 'old');
      await turn(slug, { text: 'go' });
      expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('keep');
      expect(lstatSync(join(dir, '01.jpg')).isFile()).toBe(true);
      expect(readdirSync(dir).sort()).toEqual(['01.jpg', '02.jpg', '03.jpg', '04.jpg']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('without ffmpeg the conversion still happens, with the originals as the reference', async () => {
    await app.close();
    fake = fakeEngine();
    rmSync(join(base, 'ws'), { recursive: true, force: true });
    await boot(NoMediaTools);
    const slug = await legacy(['test-wide']);
    await turn(slug, { text: 'go' });
    expect(prompts()[0]!.prompt).toContain('no reference frames could be extracted');
    expect(hasConverting(await systemTexts(slug))).toBe(1);
  });
});

describe('conversion per format (review of Task 6)', { timeout: 90_000 }, () => {
  const v2With = (compositions: Array<{ format: string }>) => async (slug: string) => {
    await store().appendVersion(slug, { n: 2, commit: null, sessionId: null, status: 'incomplete', createdAt: new Date(Date.now() + 1000).toISOString(), request: 'r', problems: ['x'], tools: [], renderCommand: null, basedOn: 1,
      outputs: [], compositions: compositions.map((c) => ({ format: c.format, dir: `compositions/${c.format}`, hash: 'f'.repeat(64), problems: [] })) });
  };

  it('(a) an incomplete v2 with no compositions: the next turn converts from v1', async () => {
    const slug = await legacy(['test-wide']);
    await v2With([])(slug);
    await turn(slug, { text: 'again' });
    const p = prompts()[0]!.prompt;
    expect(p).toContain('## Convert the earlier media first');
    expect(p).toContain('test-wide: rebuild from version 1');
    expect(p).toContain(`creatives/${slug}/outputs/v1/test-wide.mp4`);
    expect(fm.calls.length).toBeGreaterThan(0);
    expect(hasConverting(await systemTexts(slug))).toBe(1);
  });

  it('(b) a partial conversion: only the missing format gets frames from v1', async () => {
    const slug = await legacy(['test-wide', 'test-tall']);
    await v2With([{ format: 'test-wide' }])(slug);
    await turn(slug, { text: 'again', formats: ['test-tall'] });
    const p = prompts()[0]!.prompt;
    expect(p).toContain('test-tall: rebuild from version 1');
    expect(p).not.toContain('test-wide: rebuild');
    expect(fm.calls.every((c) => c.video.endsWith('test-tall.mp4'))).toBe(true);
    expect(existsSync(refDir(slug, 3, 'test-wide'))).toBe(false);
  });

  it('a format added since gets a plain create line, and stale folders of this version are removed', async () => {
    const slug = await legacy(['test-wide']);
    const c = (await detail(slug)).creative;
    await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, headers: H, payload: { brief: { ...c.brief, formats: ['test-wide', 'test-tall'] } } });
    mkdirSync(join(refDir(slug, 2, 'test-gone')), { recursive: true });
    writeFileSync(join(refDir(slug, 2, 'test-gone'), '01.jpg'), 'stale');
    await turn(slug, { text: 'add tall' });
    const p = prompts()[0]!.prompt;
    expect(p).toContain('test-wide: rebuild from version 1');
    expect(p).toContain('test-tall: create it from scratch');
    expect(existsSync(refDir(slug, 2, 'test-gone'))).toBe(false);
    expect(existsSync(refDir(slug, 2, 'test-wide'))).toBe(true);
  });

  it('a failed turn that is retried does not repeat the chat entry', async () => {
    const slug = await legacy(['test-wide']);
    process.env.FAKE_CLAUDE_ALWAYS_INVALID = '1';
    await turn(slug, { text: 'a' }); // saves an incomplete version: a new one follows
    delete process.env.FAKE_CLAUDE_ALWAYS_INVALID;
    expect(hasConverting(await systemTexts(slug))).toBe(1);
  });

  it('the Italian entry', async () => {
    setLocale('it');
    const slug = await legacy(['test-wide']);
    await turn(slug, { text: 'a' });
    expect((await systemTexts(slug)).filter((t) => t === 'Conversione al formato modificabile · costa più token questa volta')).toHaveLength(1);
  });
});

describe('Review Focus 5: legacy v1-v3 then a composition v4', { timeout: 120_000 }, () => {
  async function boundary(): Promise<string> {
    // wide: a, a (unchanged), b ; tall: a, b, b
    const slug = await legacy(['test-wide', 'test-tall'], [
      { 'test-wide': 'a', 'test-tall': 'a' }, { 'test-wide': 'a', 'test-tall': 'b' }, { 'test-wide': 'b', 'test-tall': 'b' },
    ]);
    await turn(slug, { text: 'go on' }); // v4: compositions
    return slug;
  }

  it('per-format history across the boundary: the first composition always counts as changed', async () => {
    const slug = await boundary();
    const formats = (await detail(slug)).formats!;
    expect(formats.find((f) => f.id === 'test-wide')!.history).toEqual([1, 3, 4]);
    expect(formats.find((f) => f.id === 'test-tall')!.history).toEqual([1, 2, 4]);
  });

  it('a star on a legacy version exports its file with no render', async () => {
    const slug = await boundary();
    const pick = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/export-picks`, headers: H, payload: { format: 'test-wide', version: 3 } });
    expect(pick.statusCode, pick.body).toBe(200);
    const f = (await detail(slug)).formats!.find((x) => x.id === 'test-wide')!;
    expect(f).toMatchObject({ exportVersion: 3, starFileMissing: false, starRender: 'rendered' });
    const dest = join(base, 'out');
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: { destination: dest, picks: { 'test-wide': 3 } } });
    expect(r.statusCode, r.body).toBe(200);
    expect(fake.renders).toEqual([]);
    expect((r.json() as { rendered?: unknown[] }).rendered ?? []).toEqual([]);
    const files = (r.json() as { files: Array<{ to: string }> }).files;
    expect(files).toHaveLength(1);
    expect(readFileSync(files[0]!.to, 'utf8')).toBe('legacy test-wide b v3');
  });

  it('a star on the composition v4 renders it automatically on export', async () => {
    const slug = await boundary();
    const f = (await detail(slug)).formats!.find((x) => x.id === 'test-wide')!;
    expect(f).toMatchObject({ exportVersion: 4, starRender: 'notRendered', starFileMissing: false });
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: { destination: join(base, 'out'), picks: { 'test-wide': 4 } } });
    expect(r.statusCode, r.body).toBe(200);
    expect(fake.renders.map((x) => x.format.id)).toEqual(['test-wide']);
    expect((await detail(slug)).formats!.find((x) => x.id === 'test-wide')!.starRender).toBe('rendered');
  });

  it('compare data: legacy v3 has its files, v4 its compositions and a preview session, both in one detail', async () => {
    const slug = await boundary();
    const { versions } = await detail(slug);
    const v3 = versions.find((v) => v.n === 3)!;
    const v4 = versions.find((v) => v.n === 4)!;
    expect(v3.compositions).toBeUndefined();
    expect(v3.outputs.map((o) => o.file)).toEqual(['test-wide.mp4', 'test-tall.mp4']);
    expect(renderState(v3, 'test-wide')).toBe('rendered');
    expect(v4.compositions!.map((c) => c.format)).toEqual(['test-wide', 'test-tall']);
    expect(renderState(v4, 'test-wide')).toBe('none');
    // The legacy file is served by the files route (token); the v4 composition by a preview session.
    const file = await app.inject({ url: `/api/projects/acme/creatives/${slug}/files/outputs/v3/test-wide.mp4`, headers: H });
    expect(file.statusCode, file.body).toBe(200);
    const session = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/4/preview-session`, headers: H, payload: { format: 'test-wide', parentOrigin: 'http://127.0.0.1:5999' } });
    expect(session.statusCode, session.body).toBe(200);
    // A preview session of a legacy version does not exist: the web shows its media.
    const none = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/3/preview-session`, headers: H, payload: { format: 'test-wide', parentOrigin: 'http://127.0.0.1:5999' } });
    expect(none.statusCode).toBe(404);
  });
});

describe('units', () => {
  it('reference times: one per second, at most 12, a still has one', () => {
    expect(referenceTimes('video', 4)).toEqual([0, 1, 2, 3]);
    expect(referenceTimes('video', 0.4)).toEqual([0]);
    expect(referenceTimes('video', 12)).toHaveLength(12);
    expect(referenceTimes('video', 120)).toHaveLength(12);
    expect(Math.max(...referenceTimes('video', 120))).toBeLessThan(120);
    expect(referenceTimes('video', null)).toEqual([0]);
    expect(referenceTimes('image', 5)).toEqual([0]);
  });

  it('legacy means rendered media without compositions', () => {
    const v = { n: 1, outputs: [{ format: 'a' }] } as unknown as VersionEntry;
    expect(isLegacyVersion(v)).toBe(true);
    expect(isLegacyVersion({ ...v, compositions: [] } as VersionEntry)).toBe(false);
    expect(isLegacyVersion({ ...v, outputs: [] } as VersionEntry)).toBe(false);
    expect(isLegacyVersion(undefined)).toBe(false);
  });

  it('real ffmpeg: frames are shrunk to 540 px wide and never enlarged', async () => {
    const tools = await createFfmpegTools();
    if (!tools.available) return; // the app runs without ffmpeg too
    const dir = mkdtempSync(join(tmpdir(), 'ms-test-ffmpeg-'));
    try {
      const mk = (name: string, size: string) => spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10:duration=2`, '-pix_fmt', 'yuv420p', join(dir, name)]);
      expect(mk('big.mp4', '1080x1920').status).toBe(0);
      expect(mk('small.mp4', '320x180').status).toBe(0);
      expect(await tools.frame(join(dir, 'big.mp4'), join(dir, 'big.jpg'), 1, { width: 540 })).toBe(true);
      expect(await tools.frame(join(dir, 'small.mp4'), join(dir, 'small.jpg'), 1, { width: 540 })).toBe(true);
      const probe = async (f: string) => (await tools.probe(f))!;
      expect(await probe(join(dir, 'big.jpg'))).toMatchObject({ width: 540, height: 960 });
      expect(await probe(join(dir, 'small.jpg'))).toMatchObject({ width: 320, height: 180 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

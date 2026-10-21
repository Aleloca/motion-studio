// @vitest-environment node
/**
 * The editor's staging overlay (Phase 10b, Task 3): library assets and brand fonts a draft uses are copied, confined, into
 * the staging folder of a live preview session and served under its token; staged videos are normalised and join the
 * session's media; the folder goes when the session ends and by the sweep. A hand-made project (no agent), the real
 * composition server and, where ffmpeg is installed (required on CI), the real probe and normaliser.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FormatPreset, StagedAsset, VersionEntry } from '@motion-studio/shared';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { startCompositionServer } from '../src/compositions/composition-server.ts';
import { sweepEditorStaging } from '../src/creatives/cache-sweep.ts';
import { editorFonts, STAGING_MAX_FILES, stagingDirOf, stagingIdOf } from '../src/creatives/editor-staging.ts';
import { PreviewService, stagingEncodeLimitMs } from '../src/creatives/previews.ts';
import { createFfmpegTools, NoMediaTools, type MediaTools } from '../src/media/media-tools.ts';
import { findFfmpeg, type FfmpegInfo } from '../src/render/encode.ts';
import { RenderError } from '../src/render/errors.ts';
import { MediaNormalizer } from '../src/render/media-normalize.ts';
import { CodedError } from '../src/workspace-store.ts';
import { FONT } from './helpers/render-env.ts';

const ffmpeg = await findFfmpeg();
const REQUIRED = process.env.MS_REQUIRE_CHROME === '1';
if (!ffmpeg && REQUIRED) it('editor staging: ffmpeg is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing ffmpeg'); });
const withFfmpeg = ffmpeg && ffmpeg.encoders.has('libx264') ? it : it.skip;

const UI = 'http://127.0.0.1:5997';
const PRESET: FormatPreset = { id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'] };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#f00"/></svg>';
/** A 1×1 PNG. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1d5b2c50000000049454e44ae426082', 'hex');

const ff = (f: FfmpegInfo, args: string[]) => execFileSync(f.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

let root: string;
let projectDir: string;
let creativeDir: string;
let compDir: string;
let version: VersionEntry;
let previews: PreviewService;
let normalizer: MediaNormalizer;
let media: MediaTools;
const outside = () => join(root, 'outside');

function register(files: string[]) {
  const assets = files.map((file) => ({
    file, kind: /\.svg$/.test(file) ? 'svg' : /\.(mp4|mov)$/.test(file) ? 'video' : /\.(m4a|mp3|wav)$/.test(file) ? 'audio' : /\.(woff2?|ttf|otf)$/.test(file) ? 'font' : /\.(png|jpg)$/.test(file) ? 'image' : 'other',
    origin: 'upload', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: new Date().toISOString(), attribution: null,
  }));
  writeFileSync(join(projectDir, 'assets', 'assets.json'), JSON.stringify({ schemaVersion: 1, assets }));
}
function brand(fonts: Array<{ id: string; family: string; file: string | null; weights?: number[] }>) {
  mkdirSync(join(projectDir, 'brand'), { recursive: true });
  writeFileSync(join(projectDir, 'brand', 'brand-kit.json'), JSON.stringify({
    schemaVersion: 1, colors: [], logos: [], tone: null, dos: [], donts: [], photoStyle: null,
    fonts: fonts.map((f) => ({ id: f.id, family: f.family, role: 'heading', weights: f.weights ?? [400], file: f.file, source: { kind: 'manual', ref: null } })),
  }));
}

/** `graceMs`: how long an ended session's staging waits for a renewal; 0 here unless a test checks the grace itself. */
async function makeService(o: { ttlMs?: number; media?: MediaTools; normalizer?: MediaNormalizer; graceMs?: number; waitMs?: number; encodeLimitMs?: number } = {}) {
  normalizer = o.normalizer ?? new MediaNormalizer({ ffmpeg: async () => ffmpeg });
  previews = new PreviewService({
    engine: undefined, normalizer, presets: async () => [PRESET], uiOrigins: () => [UI], media: o.media ?? media,
    ...(o.ttlMs ? { sessionTtlMs: o.ttlMs } : {}), stagingGraceMs: o.graceMs ?? 0,
    ...(o.waitMs !== undefined ? { stagingWaitMs: o.waitMs } : {}),
    ...(o.encodeLimitMs !== undefined ? { stagingEncodeLimitMs: () => o.encodeLimitMs! } : {}),
  });
}
const ref = (c = 'launch') => ({ projectDir, creativeDir: join(projectDir, 'creatives', c), creativeSlug: c, n: 1 });
const mint = () => previews.mintPreview(ref(), version, 'test-wide', UI, 'en');
const stage = (token: string, from: { kind: 'library'; file: string } | { kind: 'brandFont'; id: string }, c = 'launch') => previews.stage(ref(c), token, from, 'en');
async function refused(p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, 'expected a refusal').toBeInstanceOf(CodedError);
  return { status: (e as CodedError).status, code: (e as CodedError).apiCode, message: (e as Error).message };
}
/** Polls `f` until true (at most `ms`). */
async function until(f: () => boolean, ms = 5000): Promise<boolean> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 20))) if (f()) return true;
  return f();
}
/**
 * A normaliser whose staged-video encodes never finish on their own: each holds a slot until its signal aborts. A session's
 * own composition (no staged video) is prepared at once, with nothing to normalise.
 */
function hangingNormalizer() {
  const slots = { active: 0, started: 0, cancelled: 0 };
  const n = {
    inUse: () => false,
    close: async () => {},
    prepare: (p: { compDir: string; signal: AbortSignal }) => {
      if (!p.compDir.includes(join('.studio', 'cache', 'editor-staging'))) return Promise.resolve({ media: { dir: '', clips: new Map() }, warnings: [], made: 0, cached: 0, release: () => {} });
      slots.started++; slots.active++;
      return new Promise((_, reject) => {
        const stop = () => { slots.active--; slots.cancelled++; reject(new RenderError('cancelled', 'cancelled')); };
        if (p.signal.aborted) stop(); else p.signal.addEventListener('abort', stop, { once: true });
      });
    },
  };
  return { normalizer: n as unknown as MediaNormalizer, slots };
}
/** A file of the session, through its URL on the composition server. */
const served = (url: string, path: string, init?: RequestInit) => fetch(`${url.split('/runtime/')[0]}/outputs/v1/compositions/test-wide/${path}`, init);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ms-test-editor-staging-'));
  projectDir = join(root, 'acme');
  creativeDir = join(projectDir, 'creatives', 'launch');
  compDir = join(creativeDir, 'outputs', 'v1', 'compositions', 'test-wide');
  mkdirSync(compDir, { recursive: true });
  mkdirSync(join(projectDir, 'creatives', 'other', 'outputs', 'v1', 'compositions', 'test-wide'), { recursive: true });
  mkdirSync(join(projectDir, 'assets'), { recursive: true });
  mkdirSync(outside(), { recursive: true });
  const composition = {
    $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 2, background: '#101010', fonts: [],
    scenes: [{ id: 'one', start: 0, duration: 2 }],
    tracks: [{ id: 'visual', kind: 'visual', clips: [{ id: 'bg', type: 'shape', start: 0, duration: 2, props: { x: 0, y: 0, width: 320, height: 180, fill: '#2060c0' } }] }],
  };
  for (const c of ['launch', 'other']) writeFileSync(join(projectDir, 'creatives', c, 'outputs', 'v1', 'compositions', 'test-wide', 'composition.json'), JSON.stringify(composition));
  const hash = (await readCompositionFolder(compDir)).hash;
  version = { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', problems: [], tools: [], renderCommand: null, basedOn: null, outputs: [],
    compositions: [{ format: 'test-wide', dir: 'compositions/test-wide', hash, problems: [] }] } as unknown as VersionEntry;
  writeFileSync(join(projectDir, 'assets', 'pic.png'), PNG);
  writeFileSync(join(projectDir, 'assets', 'logo.svg'), SVG);
  writeFileSync(join(projectDir, 'assets', 'Mono.woff2'), readFileSync(FONT));
  media = ffmpeg ? await createFfmpegTools() : NoMediaTools;
  await makeService();
});
afterEach(async () => {
  await previews?.close();
  await normalizer?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('staging from the library and the brand kit', () => {
  it('copies a registered image, SVG and font into the session\'s staging folder, named by content, with their probe data', async () => {
    register(['pic.png', 'logo.svg', 'Mono.woff2']);
    const s = await mint();
    const sha8 = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 8);
    const svg = await stage(s.token, { kind: 'library', file: 'logo.svg' });
    expect(svg).toEqual({ path: `assets/lib/${sha8(Buffer.from(SVG))}-logo.svg`, size: SVG.length, kind: 'svg', width: 40, height: 20 });
    const font = await stage(s.token, { kind: 'library', file: 'Mono.woff2' });
    // The probe reads the static font's OS/2 weight (decisions log 261).
    expect(font).toMatchObject({ path: `assets/lib/${sha8(readFileSync(FONT))}-Mono.woff2`, kind: 'font', fontWeights: { min: 400, max: 400 } });
    const dir = stagingDirOf(projectDir, 'launch', s.token);
    // The folder is named by a digest of the token, never the token itself.
    expect(dir.endsWith(stagingIdOf(s.token))).toBe(true);
    expect(dir).not.toContain(s.token);
    expect(readFileSync(join(dir, svg.path), 'utf8')).toBe(SVG);
    // Staging the same file again gives the same path (not counted twice).
    expect(await stage(s.token, { kind: 'library', file: 'logo.svg' })).toEqual(svg);
    expect(readdirSync(join(dir, 'assets', 'lib')).sort()).toEqual([font.path, svg.path].map((p) => p.slice('assets/lib/'.length)).sort());
  });

  withFfmpeg('probes a PNG and an audio file with the ffprobe helper; a file that is not what its name says is refused and not kept', async () => {
    ff(ffmpeg!, ['-f', 'lavfi', '-i', 'sine=d=1.5', '-c:a', 'aac', join(projectDir, 'assets', 'beep.m4a')]);
    writeFileSync(join(projectDir, 'assets', 'fake.png'), 'not an image');
    register(['pic.png', 'beep.m4a', 'fake.png']);
    const s = await mint();
    expect(await stage(s.token, { kind: 'library', file: 'pic.png' })).toMatchObject({ kind: 'image', width: 1, height: 1, size: PNG.length });
    const audio = await stage(s.token, { kind: 'library', file: 'beep.m4a' });
    expect(audio.kind).toBe('audio');
    expect(audio.durationSec).toBeGreaterThan(1.4);
    expect(audio.durationSec).toBeLessThan(1.7);
    const r = await refused(stage(s.token, { kind: 'library', file: 'fake.png' }));
    expect(r).toMatchObject({ status: 400, code: 'editor-not-media' });
    expect(readdirSync(join(stagingDirOf(projectDir, 'launch', s.token), 'assets', 'lib')).filter((n) => n.endsWith('fake.png'))).toEqual([]);
  });

  withFfmpeg('normalises a staged video for the session and serves it as the session\'s media, with its probe data', async () => {
    ff(ffmpeg!, ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest',
      join(projectDir, 'assets', 'clip.mp4')]);
    register(['clip.mp4']);
    const s = await mint();
    const v = await stage(s.token, { kind: 'library', file: 'clip.mp4' });
    expect(v).toMatchObject({ kind: 'video', width: 160, height: 90 });
    expect(v.durationSec).toBeGreaterThan(1.9);
    expect(v.media).toMatchObject({ index: 0, sourceFps: 30, sourceStart: 0 });
    expect(v.media!.sourceVideoEnd).toBeGreaterThan(1.9);
    expect(v.media!.audioStart).toBeGreaterThanOrEqual(0); // the original has sound: it plays from the staged file
    // The normalised file is served as media/0.mp4 under the token, with the composition files' headers.
    const r = await served(s.url, 'media/0.mp4', { headers: { range: 'bytes=0-7' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect(r.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect((await r.arrayBuffer()).byteLength).toBe(8);
    // And the staged original too (its sound).
    expect((await served(s.url, v.path, { method: 'HEAD' })).status).toBe(200);
    // The normalised file is leased while the session lives.
    const cached = readdirSync(join(projectDir, '.studio', 'cache', 'media')).filter((n) => n.endsWith('.mp4'));
    expect(cached).toHaveLength(1);
    expect(normalizer.inUse(join(projectDir, '.studio', 'cache', 'media', cached[0]!))).toBe(true);
    previews.revokePreview(ref(), s.token);
    await new Promise((r2) => setTimeout(r2, 50));
    expect(normalizer.inUse(join(projectDir, '.studio', 'cache', 'media', cached[0]!))).toBe(false);
  }, 60_000);

  it('stages a brand font\'s file; refuses an unknown brand font and one without a file', async () => {
    brand([{ id: 'heading', family: 'Mono', file: 'assets/Mono.woff2', weights: [400, 700] }, { id: 'nofile', family: 'Ghost', file: null }, { id: 'outside', family: 'Out', file: 'references/x.woff2' }]);
    const s = await mint();
    expect(await stage(s.token, { kind: 'brandFont', id: 'heading' })).toMatchObject({ kind: 'font', path: expect.stringMatching(/^assets\/lib\/[0-9a-f]{8}-Mono\.woff2$/) });
    expect(await refused(stage(s.token, { kind: 'brandFont', id: 'nope' }))).toMatchObject({ status: 404, code: 'editor-unknown-brand-font', message: 'This font is not in the brand kit' });
    expect(await refused(stage(s.token, { kind: 'brandFont', id: 'nofile' }))).toMatchObject({ status: 400, code: 'editor-brand-font-no-file', message: 'Ghost has no font file in the brand kit' });
    expect(await refused(stage(s.token, { kind: 'brandFont', id: 'outside' }))).toMatchObject({ status: 400, code: 'editor-unreadable' });
  });

  it('refuses an unregistered file, a path out of the library, links and special files: nothing is copied', async () => {
    writeFileSync(join(outside(), 'secret.png'), PNG);
    symlinkSync(join(outside(), 'secret.png'), join(projectDir, 'assets', 'link.png'));
    symlinkSync(outside(), join(projectDir, 'assets', 'dir'));
    linkSync(join(projectDir, 'assets', 'pic.png'), join(projectDir, 'assets', 'hard.png'));
    writeFileSync(join(projectDir, 'assets', 'notes.txt'), 'x');
    register(['link.png', 'dir/secret.png', 'hard.png', 'notes.txt', 'gone.png']);
    const s = await mint();
    for (const file of ['pic.png' /* not registered */, '../acme/assets/pic.png', '/etc/hosts', 'assets/../pic.png', './pic.png', 'a\\b.png', '']) {
      expect(await refused(stage(s.token, { kind: 'library', file })), file).toMatchObject({ status: 400, code: 'editor-not-registered' });
    }
    for (const file of ['link.png', 'dir/secret.png', 'hard.png', 'gone.png']) {
      expect(await refused(stage(s.token, { kind: 'library', file })), file).toMatchObject({ status: 400, code: 'editor-unreadable' });
    }
    expect(await refused(stage(s.token, { kind: 'library', file: 'notes.txt' }))).toMatchObject({ status: 400, code: 'editor-unsupported' });
    const lib = join(stagingDirOf(projectDir, 'launch', s.token), 'assets', 'lib');
    expect(existsSync(lib) ? readdirSync(lib) : []).toEqual([]);
  });

  it('needs a live session of the same creative: another creative\'s token, a revoked, an expired or an unknown one is refused', async () => {
    register(['pic.png']);
    const s = await mint();
    expect(await refused(stage(s.token, { kind: 'library', file: 'pic.png' }, 'other'))).toMatchObject({ status: 404, code: 'editor-no-session', message: 'This preview has ended: open the editor again' });
    expect(await refused(stage('A'.repeat(43), { kind: 'library', file: 'pic.png' }))).toMatchObject({ code: 'editor-no-session' });
    expect(existsSync(stagingDirOf(projectDir, 'other', s.token))).toBe(false);
    previews.revokePreview(ref(), s.token);
    expect(await refused(stage(s.token, { kind: 'library', file: 'pic.png' }))).toMatchObject({ code: 'editor-no-session' });
    // Expired (a short session lifetime): refused even before the core's own timer ended it.
    await previews.close();
    await normalizer.close();
    await makeService({ ttlMs: 300 });
    const short = await mint();
    await new Promise((r) => setTimeout(r, 400));
    expect(await refused(stage(short.token, { kind: 'library', file: 'pic.png' }))).toMatchObject({ code: 'editor-no-session' });
  });

  it('limits: 500 MB per file and 20 files per session, translated', async () => {
    truncateSync(join(projectDir, 'assets', 'pic.png'), 0);
    writeFileSync(join(projectDir, 'assets', 'huge.png'), '');
    truncateSync(join(projectDir, 'assets', 'huge.png'), 500 * 1024 * 1024 + 1); // sparse: no disk used
    const many = Array.from({ length: STAGING_MAX_FILES + 1 }, (_, i) => `s${i}.svg`);
    for (const [i, f] of many.entries()) writeFileSync(join(projectDir, 'assets', f), SVG.replace('#f00', `#${String(i).padStart(3, '0')}`));
    register(['huge.png', ...many]);
    const s = await mint();
    expect(await refused(stage(s.token, { kind: 'library', file: 'huge.png' }))).toMatchObject({ status: 413, code: 'editor-too-large', message: 'huge.png is larger than 500 MB' });
    const done: StagedAsset[] = [];
    for (const f of many.slice(0, STAGING_MAX_FILES)) done.push(await stage(s.token, { kind: 'library', file: f }));
    expect(new Set(done.map((d) => d.path)).size).toBe(STAGING_MAX_FILES);
    expect(await refused(stage(s.token, { kind: 'library', file: many.at(-1)! }))).toMatchObject({ status: 409, code: 'editor-too-many', message: 'At most 20 files can be added to one draft: save it as a new version first' });
    // A file already staged still answers.
    expect(await stage(s.token, { kind: 'library', file: many[0]! })).toEqual(done[0]);
    expect(readdirSync(join(stagingDirOf(projectDir, 'launch', s.token), 'assets', 'lib')).filter((n) => !n.startsWith('.'))).toHaveLength(STAGING_MAX_FILES);
  });
});

describe('serving the overlay', () => {
  it('serves a staged file under the session token with the composition files\' headers; the base folder wins; other tokens and paths get nothing', async () => {
    register(['logo.svg', 'Mono.woff2']);
    const s = await mint();
    const svg = await stage(s.token, { kind: 'library', file: 'logo.svg' });
    const font = await stage(s.token, { kind: 'library', file: 'Mono.woff2' });
    const r = await served(s.url, svg.path);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(SVG);
    expect(r.headers.get('content-type')).toBe('image/svg+xml');
    expect(r.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    // A font requested by an opaque document (CORS mode): ACAO null, as for the composition's own fonts.
    const f = await served(s.url, font.path, { headers: { origin: 'null' } });
    expect(f.status).toBe(200);
    expect(f.headers.get('access-control-allow-origin')).toBe('null');
    // Byte ranges.
    const part = await served(s.url, svg.path, { headers: { range: 'bytes=0-3' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('<svg');
    // Only `assets/lib/…` comes from the staging folder; never another session's.
    expect((await served(s.url, `assets/${svg.path.slice('assets/lib/'.length)}`)).status).toBe(404);
    const other = await mint();
    expect((await served(other.url, svg.path)).status).toBe(404);
    // The base folder wins: a file the composition has under that name is the one served.
    mkdirSync(join(compDir, 'assets', 'lib'), { recursive: true });
    writeFileSync(join(compDir, svg.path), '<svg>base</svg>');
    expect(await (await served(s.url, svg.path)).text()).toBe('<svg>base</svg>');
  });

  it('a staged name that the composition folder already has with other content takes the next free name', async () => {
    register(['logo.svg']);
    const name = `${createHash('sha256').update(SVG).digest('hex').slice(0, 8)}-logo.svg`;
    const s = await mint();
    mkdirSync(join(compDir, 'assets', 'lib'), { recursive: true });
    writeFileSync(join(compDir, 'assets', 'lib', name), 'other content');
    const svg = await stage(s.token, { kind: 'library', file: 'logo.svg' });
    expect(svg.path).toBe(`assets/lib/${name.replace('.svg', '-2.svg')}`);
    expect(await (await served(s.url, svg.path)).text()).toBe(SVG);
  });

  it('a staging folder replaced by a link, or a staged file replaced by one, is not served', async () => {
    register(['logo.svg']);
    const s = await mint();
    const svg = await stage(s.token, { kind: 'library', file: 'logo.svg' });
    const dir = stagingDirOf(projectDir, 'launch', s.token);
    const file = join(dir, svg.path);
    rmSync(file);
    writeFileSync(join(outside(), 'x.svg'), SVG);
    symlinkSync(join(outside(), 'x.svg'), file);
    expect((await served(s.url, svg.path)).status).toBe(404);
    rmSync(dir, { recursive: true });
    symlinkSync(outside(), dir);
    expect((await served(s.url, svg.path)).status).toBe(404);
  });
});

describe('attaching a staging folder (composition server)', () => {
  it('takes only the session\'s own folder (named after its token), never another session\'s', async () => {
    const server = await startCompositionServer({ uiOrigins: [UI] });
    try {
      const s = await server.mintSession({ creativeDir, versionDir: 'outputs/v1', format: 'test-wide', composition: {}, mode: 'preview', parentOrigin: UI });
      const other = stagingDirOf(projectDir, 'launch', 'B'.repeat(43));
      const own = stagingDirOf(projectDir, 'launch', s.token);
      mkdirSync(other, { recursive: true });
      mkdirSync(own, { recursive: true });
      await expect(s.attachStaging(other)).rejects.toThrow(/staging folder/);
      await expect(s.attachStaging(own)).resolves.toBeUndefined();
      const render = await server.mintSession({ creativeDir, versionDir: 'outputs/v1', format: 'test-wide', composition: {}, mode: 'render' });
      mkdirSync(stagingDirOf(projectDir, 'launch', render.token), { recursive: true });
      await expect(render.attachStaging(stagingDirOf(projectDir, 'launch', render.token))).rejects.toThrow(/preview/);
    } finally {
      await server.close();
    }
  });
});

describe('cleanup', () => {

  it('the staging folder goes when the session is revoked, evicted or expires', async () => {
    register(['logo.svg']);
    const s = await mint();
    await stage(s.token, { kind: 'library', file: 'logo.svg' });
    const dir = stagingDirOf(projectDir, 'launch', s.token);
    expect(existsSync(dir)).toBe(true);
    expect(previews.stagingInUse(dir)).toBe(true);
    expect(previews.revokePreview(ref(), s.token)).toBe(true);
    expect(await until(() => !existsSync(dir))).toBe(true);
    expect(previews.stagingInUse(dir)).toBe(false);
    // Evicted: the oldest of more than 8 sessions.
    const first = await mint();
    await stage(first.token, { kind: 'library', file: 'logo.svg' });
    for (let i = 0; i < 8; i++) await mint();
    expect(await until(() => !existsSync(stagingDirOf(projectDir, 'launch', first.token)))).toBe(true);
    // Expired.
    await previews.close();
    await normalizer.close();
    await makeService({ ttlMs: 200 });
    const short = await mint();
    await stage(short.token, { kind: 'library', file: 'logo.svg' });
    expect(existsSync(stagingDirOf(projectDir, 'launch', short.token))).toBe(true);
    expect(await until(() => !existsSync(stagingDirOf(projectDir, 'launch', short.token)))).toBe(true);
  });

  for (const how of ['revoked', 'expired'] as const) {
    it(`a staged video's encode is cancelled when its session is ${how}: the slot is free, the request answers, the folder goes`, async () => {
      writeFileSync(join(projectDir, 'assets', 'slow.mp4'), 'a video the double never finishes');
      register(['slow.mp4']);
      await previews.close();
      await normalizer.close();
      const { normalizer: hanging, slots } = hangingNormalizer();
      await makeService({ media: NoMediaTools, normalizer: hanging, ...(how === 'expired' ? { ttlMs: 400 } : {}) });
      const s = await mint();
      const dir = stagingDirOf(projectDir, 'launch', s.token);
      const pending = stage(s.token, { kind: 'library', file: 'slow.mp4' });
      const answer = refused(pending);
      expect(await until(() => slots.active === 1)).toBe(true);
      expect(existsSync(dir)).toBe(true);
      const t0 = Date.now();
      if (how === 'revoked') expect(previews.revokePreview(ref(), s.token)).toBe(true);
      expect(await answer).toMatchObject({ status: 404, code: 'editor-no-session' });
      // Revoked: at once; expired: at the core's timer (TTL + 1 s), never after a full encode.
      expect(Date.now() - t0).toBeLessThan(how === 'revoked' ? 1000 : 3000);
      expect(slots).toEqual({ active: 0, started: 1, cancelled: 1 });
      expect(await until(() => !existsSync(dir))).toBe(true);
      expect(previews.stagingInUse(dir)).toBe(false);
    });
  }

  it('the sweep removes staging folders older than 24 h, never a live session\'s, and follows no link', async () => {
    register(['logo.svg']);
    const s = await mint();
    await stage(s.token, { kind: 'library', file: 'logo.svg' });
    const live = stagingDirOf(projectDir, 'launch', s.token);
    const base = join(projectDir, '.studio', 'cache', 'editor-staging', 'launch');
    const old = join(base, 'a'.repeat(32));
    const fresh = join(base, 'b'.repeat(32));
    const linked = join(base, 'c'.repeat(32));
    mkdirSync(join(old, 'assets', 'lib'), { recursive: true });
    writeFileSync(join(old, 'assets', 'lib', 'x.svg'), SVG);
    mkdirSync(fresh);
    writeFileSync(join(outside(), 'keep.txt'), 'keep');
    symlinkSync(outside(), linked);
    const day = Date.now() / 1000 - 25 * 3600;
    for (const p of [join(old, 'assets', 'lib', 'x.svg'), join(old, 'assets', 'lib'), join(old, 'assets'), old, join(live, 'assets', 'lib'), live]) utimesSync(p, day, day);
    for (const n of readdirSync(join(live, 'assets', 'lib'))) utimesSync(join(live, 'assets', 'lib', n), day, day);
    const removed = await sweepEditorStaging(projectDir, { inUse: previews.stagingInUse });
    expect(removed).toContain(old);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(live)).toBe(true);
    expect(readFileSync(join(outside(), 'keep.txt'), 'utf8')).toBe('keep');
    // Without a live session using it (the call gives no `inUse`), an old folder goes too; a link goes as an entry only.
    expect(await sweepEditorStaging(projectDir, { now: Date.now() + 2 * 24 * 3600_000 })).toEqual(expect.arrayContaining([fresh, live, linked]));
    expect(existsSync(linked)).toBe(false);
    expect(readFileSync(join(outside(), 'keep.txt'), 'utf8')).toBe('keep');
  });
});

describe('a renewed session takes over the staging (Phase 10b, Task 4)', () => {
  const renew = (from: string, o: { n?: number; version?: VersionEntry; format?: string } = {}) =>
    previews.mintPreview({ ...ref(), n: o.n ?? 1 }, o.version ?? version, o.format ?? 'test-wide', UI, 'en', { renewFrom: from });

  it('moves the staged files to the new session: served under the new token, no longer under the old one, and staged no more there', async () => {
    register(['logo.svg', 'Mono.woff2']);
    const a = await mint();
    const svg = await stage(a.token, { kind: 'library', file: 'logo.svg' });
    const font = await stage(a.token, { kind: 'library', file: 'Mono.woff2' });
    const oldDir = stagingDirOf(projectDir, 'launch', a.token);
    const ino = (await import('node:fs')).statSync(oldDir).ino;
    const b = await renew(a.token);
    expect(b.staged).toEqual([svg, font]);
    const newDir = stagingDirOf(projectDir, 'launch', b.token);
    // One rename: the same folder (inode), now under the new token's name.
    expect(existsSync(oldDir)).toBe(false);
    expect((await import('node:fs')).statSync(newDir).ino).toBe(ino);
    expect(previews.stagingInUse(newDir)).toBe(true);
    const r = await served(b.url, svg.path);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(SVG);
    // The old token reaches nothing staged any more, and cannot stage again.
    expect((await served(a.url, svg.path)).status).toBe(404);
    expect((await served(a.url, font.path)).status).toBe(404);
    expect(await refused(stage(a.token, { kind: 'library', file: 'logo.svg' }))).toMatchObject({ status: 404, code: 'editor-no-session' });
    // The new one stages on top of what it took over (the same file: the same path, not counted twice).
    expect(await stage(b.token, { kind: 'library', file: 'logo.svg' })).toEqual(svg);
    // Ending the old session never removes the moved folder; ending the new one does.
    expect(previews.revokePreview(ref(), a.token)).toBe(true);
    await new Promise((res) => setTimeout(res, 100));
    expect(existsSync(join(newDir, svg.path))).toBe(true);
    expect(previews.revokePreview(ref(), b.token)).toBe(true);
    expect(await until(() => !existsSync(newDir))).toBe(true);
  });

  it('a session of another version or another format, or of nothing staged, inherits nothing', async () => {
    register(['logo.svg']);
    // Version 2 (the same composition) and a second format of version 1.
    const v2Dir = join(creativeDir, 'outputs', 'v2', 'compositions', 'test-wide');
    mkdirSync(v2Dir, { recursive: true });
    writeFileSync(join(v2Dir, 'composition.json'), readFileSync(join(compDir, 'composition.json')));
    const version2 = { ...version, n: 2 } as VersionEntry;
    const bDir = join(creativeDir, 'outputs', 'v1', 'compositions', 'test-wide-b');
    mkdirSync(bDir, { recursive: true });
    writeFileSync(join(bDir, 'composition.json'), readFileSync(join(compDir, 'composition.json')));
    const versionB = { ...version, compositions: [...version.compositions!, { ...version.compositions![0]!, format: 'test-wide-b', dir: 'compositions/test-wide-b' }] } as VersionEntry;
    await previews.close();
    await normalizer.close();
    normalizer = new MediaNormalizer({ ffmpeg: async () => ffmpeg });
    previews = new PreviewService({ engine: undefined, normalizer, presets: async () => [PRESET, { ...PRESET, id: 'test-wide-b' }], uiOrigins: () => [UI], media, stagingGraceMs: 0 });
    const a = await previews.mintPreview(ref(), versionB, 'test-wide', UI, 'en');
    const svg = await stage(a.token, { kind: 'library', file: 'logo.svg' });
    const oldDir = stagingDirOf(projectDir, 'launch', a.token);
    const other = await renew(a.token, { n: 2, version: version2 });
    expect(other.staged).toBeUndefined();
    expect((await fetch(`${other.url.split('/runtime/')[0]}/outputs/v2/compositions/test-wide/${svg.path}`)).status).toBe(404);
    expect(existsSync(stagingDirOf(projectDir, 'launch', other.token))).toBe(false);
    const otherFormat = await previews.mintPreview(ref(), versionB, 'test-wide-b', UI, 'en', { renewFrom: a.token });
    expect(otherFormat.staged).toBeUndefined();
    expect(existsSync(stagingDirOf(projectDir, 'launch', otherFormat.token))).toBe(false);
    // The old session keeps its staging all along.
    expect(existsSync(join(oldDir, svg.path))).toBe(true);
    expect((await served(a.url, svg.path)).status).toBe(200);
    // Nothing staged: nothing to move. An unknown or ended token: nothing either.
    const empty = await previews.mintPreview(ref(), versionB, 'test-wide', UI, 'en');
    expect((await previews.mintPreview(ref(), versionB, 'test-wide', UI, 'en', { renewFrom: empty.token })).staged).toBeUndefined();
    expect(previews.revokePreview(ref(), a.token)).toBe(true);
    expect(await until(() => !existsSync(oldDir))).toBe(true); // no grace in this service: gone
    expect((await previews.mintPreview(ref(), versionB, 'test-wide', UI, 'en', { renewFrom: a.token })).staged).toBeUndefined();
  });

  withFfmpeg('a staged video keeps its normalised file: it joins the new session\'s media with its lease, never encoded again', async () => {
    ff(ffmpeg!, ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', join(projectDir, 'assets', 'clip.mp4')]);
    register(['clip.mp4']);
    const a = await mint();
    const v = await stage(a.token, { kind: 'library', file: 'clip.mp4' });
    expect(v.media).toBeDefined();
    const cached = readdirSync(join(projectDir, '.studio', 'cache', 'media')).filter((n) => n.endsWith('.mp4'));
    expect(cached).toHaveLength(1);
    const file = join(projectDir, '.studio', 'cache', 'media', cached[0]!);
    const mtime = (await import('node:fs')).statSync(file).mtimeMs;
    const b = await renew(a.token);
    expect(b.staged).toEqual([{ ...v, media: { ...v.media!, index: expect.any(Number) } }]);
    const index = b.staged![0]!.media!.index;
    const r = await served(b.url, `media/${index}.mp4`, { headers: { range: 'bytes=0-7' } });
    expect(r.status).toBe(206);
    expect((await served(b.url, v.path, { method: 'HEAD' })).status).toBe(200);
    // Not encoded again: still the one cached file, untouched; leased by the new session even once the old one ends.
    expect(readdirSync(join(projectDir, '.studio', 'cache', 'media')).filter((n) => n.endsWith('.mp4'))).toEqual(cached);
    expect((await import('node:fs')).statSync(file).mtimeMs).toBe(mtime);
    expect(previews.revokePreview(ref(), a.token)).toBe(true);
    await new Promise((res) => setTimeout(res, 50));
    expect(normalizer.inUse(file)).toBe(true);
    previews.revokePreview(ref(), b.token);
    await new Promise((res) => setTimeout(res, 50));
    expect(normalizer.inUse(file)).toBe(false);
  }, 60_000);
});

describe('a late renewal adopts an ended session\'s staging (decisions log 264)', () => {
  it('expired: a renewal naming it within the grace takes the staged files, served under the new token only', async () => {
    await previews.close();
    await normalizer.close();
    await makeService({ ttlMs: 200, graceMs: 60_000 });
    register(['logo.svg']);
    const a = await mint();
    const svg = await stage(a.token, { kind: 'library', file: 'logo.svg' });
    const oldDir = stagingDirOf(projectDir, 'launch', a.token);
    // The session expires (TTL + 1 s): its token stops working, its staging waits.
    await new Promise((r) => setTimeout(r, 1700));
    expect(previews.revokePreview(ref(), a.token)).toBe(false); // already ended (not a live session any more)
    expect(existsSync(oldDir)).toBe(true);
    expect(previews.stagingInUse(oldDir)).toBe(true);
    expect((await served(a.url, svg.path)).status).not.toBe(200);
    const b = await previews.mintPreview(ref(), version, 'test-wide', UI, 'en', { renewFrom: a.token });
    expect(b.staged).toEqual([svg]);
    expect(existsSync(oldDir)).toBe(false);
    expect((await served(b.url, svg.path)).status).toBe(200);
    // Adopted once: the same old token adopts nothing again.
    const c = await previews.mintPreview(ref(), version, 'test-wide', UI, 'en', { renewFrom: a.token });
    expect(c.staged).toBeUndefined();
  });

  it('evicted or revoked: adopted by a renewal of the same creative, version and format only', async () => {
    await previews.close();
    await normalizer.close();
    await makeService({ graceMs: 60_000 });
    register(['logo.svg']);
    const a = await mint();
    const svg = await stage(a.token, { kind: 'library', file: 'logo.svg' });
    for (let i = 0; i < 8; i++) await mint(); // the oldest of more than 8 ends
    expect(previews.revokePreview(ref(), a.token)).toBe(false);
    // Another creative never adopts it.
    const other = await previews.mintPreview(ref('other'), version, 'test-wide', UI, 'en', { renewFrom: a.token }).catch(() => null);
    expect(other?.staged).toBeUndefined();
    const b = await previews.mintPreview(ref(), version, 'test-wide', UI, 'en', { renewFrom: a.token });
    expect(b.staged).toEqual([svg]);
    // Revoked: the same.
    const svg2 = await stage(b.token, { kind: 'library', file: 'logo.svg' });
    expect(previews.revokePreview(ref(), b.token)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    const c = await previews.mintPreview(ref(), version, 'test-wide', UI, 'en', { renewFrom: b.token });
    expect(c.staged).toEqual([svg2]);
  });

  it('an ended session\'s staging is never adopted by a renewal of another version or another format (it keeps waiting for the right one)', async () => {
    const v2Dir = join(creativeDir, 'outputs', 'v2', 'compositions', 'test-wide');
    mkdirSync(v2Dir, { recursive: true });
    writeFileSync(join(v2Dir, 'composition.json'), readFileSync(join(compDir, 'composition.json')));
    const version2 = { ...version, n: 2 } as VersionEntry;
    const bDir = join(creativeDir, 'outputs', 'v1', 'compositions', 'test-wide-b');
    mkdirSync(bDir, { recursive: true });
    writeFileSync(join(bDir, 'composition.json'), readFileSync(join(compDir, 'composition.json')));
    const versionB = { ...version, compositions: [...version.compositions!, { ...version.compositions![0]!, format: 'test-wide-b', dir: 'compositions/test-wide-b' }] } as VersionEntry;
    await previews.close();
    await normalizer.close();
    normalizer = new MediaNormalizer({ ffmpeg: async () => ffmpeg });
    previews = new PreviewService({ engine: undefined, normalizer, presets: async () => [PRESET, { ...PRESET, id: 'test-wide-b' }], uiOrigins: () => [UI], media, stagingGraceMs: 60_000 });
    register(['logo.svg']);
    const a = await previews.mintPreview(ref(), versionB, 'test-wide', UI, 'en');
    const svg = await stage(a.token, { kind: 'library', file: 'logo.svg' });
    const oldDir = stagingDirOf(projectDir, 'launch', a.token);
    expect(previews.revokePreview(ref(), a.token)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    // Another version of the same format.
    const otherVersion = await previews.mintPreview({ ...ref(), n: 2 }, version2, 'test-wide', UI, 'en', { renewFrom: a.token });
    expect(otherVersion.staged).toBeUndefined();
    expect(existsSync(stagingDirOf(projectDir, 'launch', otherVersion.token))).toBe(false);
    // Another format of the same version.
    const otherFormat = await previews.mintPreview(ref(), versionB, 'test-wide-b', UI, 'en', { renewFrom: a.token });
    expect(otherFormat.staged).toBeUndefined();
    expect(existsSync(stagingDirOf(projectDir, 'launch', otherFormat.token))).toBe(false);
    expect(existsSync(join(oldDir, svg.path))).toBe(true);
    // The right renewal still adopts it.
    const right = await previews.mintPreview(ref(), versionB, 'test-wide', UI, 'en', { renewFrom: a.token });
    expect(right.staged).toEqual([svg]);
  });

  it('after the grace, nothing is adopted and the folder is gone; app close removes waiting stagings', async () => {
    await previews.close();
    await normalizer.close();
    await makeService({ graceMs: 300 });
    register(['logo.svg']);
    const a = await mint();
    await stage(a.token, { kind: 'library', file: 'logo.svg' });
    const oldDir = stagingDirOf(projectDir, 'launch', a.token);
    expect(previews.revokePreview(ref(), a.token)).toBe(true);
    expect(existsSync(oldDir)).toBe(true);
    expect(await until(() => !existsSync(oldDir))).toBe(true);
    expect(previews.stagingInUse(oldDir)).toBe(false);
    expect((await previews.mintPreview(ref(), version, 'test-wide', UI, 'en', { renewFrom: a.token })).staged).toBeUndefined();
    await previews.close();
    await normalizer.close();
    await makeService({ graceMs: 60_000 });
    const b = await mint();
    await stage(b.token, { kind: 'library', file: 'logo.svg' });
    const bDir = stagingDirOf(projectDir, 'launch', b.token);
    expect(previews.revokePreview(ref(), b.token)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(bDir)).toBe(true);
    await previews.close();
    expect(existsSync(bDir)).toBe(false);
  });

  withFfmpeg('a staged video keeps its lease through the grace and moves to the renewal, never encoded again', async () => {
    await previews.close();
    await normalizer.close();
    await makeService({ graceMs: 60_000 });
    ff(ffmpeg!, ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', join(projectDir, 'assets', 'clip.mp4')]);
    register(['clip.mp4']);
    const a = await mint();
    const v = await stage(a.token, { kind: 'library', file: 'clip.mp4' });
    const cached = readdirSync(join(projectDir, '.studio', 'cache', 'media')).filter((n) => n.endsWith('.mp4'));
    const file = join(projectDir, '.studio', 'cache', 'media', cached[0]!);
    expect(previews.revokePreview(ref(), a.token)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(normalizer.inUse(file)).toBe(true);
    const b = await previews.mintPreview(ref(), version, 'test-wide', UI, 'en', { renewFrom: a.token });
    expect(b.staged).toEqual([{ ...v, media: { ...v.media!, index: expect.any(Number) } }]);
    expect((await served(b.url, `media/${b.staged![0]!.media!.index}.mp4`, { headers: { range: 'bytes=0-7' } })).status).toBe(206);
    expect(readdirSync(join(projectDir, '.studio', 'cache', 'media')).filter((n) => n.endsWith('.mp4'))).toEqual(cached);
  }, 60_000);
});

describe('a staged video never holds a save for long (decisions log 265)', () => {
  it('stagingEncodeLimitMs: one minute plus ten times the duration, at most 20 minutes; unknown: the cap', () => {
    expect(stagingEncodeLimitMs(6)).toBe(120_000);
    expect(stagingEncodeLimitMs(3600)).toBe(20 * 60_000);
    expect(stagingEncodeLimitMs(null)).toBe(20 * 60_000);
    expect(stagingEncodeLimitMs(undefined)).toBe(20 * 60_000);
    // Whole milliseconds (decision 1560): AbortSignal.timeout throws on a fractional delay (a 149.315938 s video).
    expect(stagingEncodeLimitMs(14.9315938)).toBe(209_316);
    expect(() => AbortSignal.timeout(stagingEncodeLimitMs(14.9315938))).not.toThrow();
  });

  it('an encode past its time limit is stopped: translated 422, its slot free, nothing staged', async () => {
    writeFileSync(join(projectDir, 'assets', 'slow.mp4'), 'a video the double never finishes');
    register(['slow.mp4']);
    await previews.close();
    await normalizer.close();
    const { normalizer: hanging, slots } = hangingNormalizer();
    await makeService({ media: NoMediaTools, normalizer: hanging, encodeLimitMs: 300 });
    const s = await mint();
    const t0 = Date.now();
    const r = await refused(stage(s.token, { kind: 'library', file: 'slow.mp4' }));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r).toMatchObject({ status: 422, code: 'editor-stage-timeout', message: 'Preparing slow.mp4 took too long (more than 1 min): try a shorter or smaller video.' });
    expect(slots).toMatchObject({ active: 0, started: 1, cancelled: 1 });
    // The session lives on and stages other files.
    register(['slow.mp4', 'logo.svg']);
    expect(await stage(s.token, { kind: 'library', file: 'logo.svg' })).toMatchObject({ kind: 'svg' });
  });

  it('a save waits a few seconds at most for a staging in progress, then 409 editor-staging-busy (the encode goes on)', async () => {
    writeFileSync(join(projectDir, 'assets', 'slow.mp4'), 'a video the double never finishes');
    register(['slow.mp4']);
    await previews.close();
    await normalizer.close();
    const { normalizer: hanging, slots } = hangingNormalizer();
    await makeService({ media: NoMediaTools, normalizer: hanging, waitMs: 200 });
    const s = await mint();
    const pending = refused(stage(s.token, { kind: 'library', file: 'slow.mp4' }));
    expect(await until(() => slots.active === 1)).toBe(true);
    let ran = false;
    const t0 = Date.now();
    const r = await refused(previews.withStaging(ref(), s.token, 'test-wide', async () => { ran = true; return 1; }, 'en'));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r).toMatchObject({ status: 409, code: 'editor-staging-busy', message: 'A file is still being prepared for this draft: save again when it is ready.' });
    expect(slots.active).toBe(1);
    previews.revokePreview(ref(), s.token);
    await pending;
    // The abandoned call never runs later.
    await new Promise((res) => setTimeout(res, 50));
    expect(ran).toBe(false);
  });

  it('with no staging in progress the save runs at once', async () => {
    register(['logo.svg']);
    const s = await mint();
    await stage(s.token, { kind: 'library', file: 'logo.svg' });
    expect(await previews.withStaging(ref(), s.token, 'test-wide', async (st) => st?.assets.size ?? -1, 'en')).toBe(1);
  });
});

describe('editor fonts', () => {
  it('lists the composition\'s families with their weights, then brand fonts not already declared', () => {
    const fonts = editorFonts({ fonts: [
      { family: 'Inter', src: 'assets/Inter-700.woff2', weight: 700 }, { family: 'Inter', src: 'assets/Inter.woff2' }, { family: 'Mono', src: 'assets/m.woff2', weight: 'bold' },
    ] }, [{ id: 'h', family: 'inter', weights: [400] }, { id: 'b', family: 'Lora', weights: [700, 400] }]);
    expect(fonts).toEqual([
      { family: 'Inter', weights: [400, 700], source: 'composition', staged: false },
      { family: 'Mono', weights: [700], source: 'composition', staged: false },
      { family: 'Lora', weights: [400, 700], source: 'brand', brandFontId: 'b', staged: false },
    ]);
  });
});

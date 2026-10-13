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
import { sweepEditorStaging } from '../src/creatives/cache-sweep.ts';
import { editorFonts, STAGING_MAX_FILES, stagingDirOf, stagingIdOf } from '../src/creatives/editor-staging.ts';
import { PreviewService } from '../src/creatives/previews.ts';
import { createFfmpegTools, NoMediaTools, type MediaTools } from '../src/media/media-tools.ts';
import { findFfmpeg, type FfmpegInfo } from '../src/render/encode.ts';
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

async function makeService(o: { ttlMs?: number; media?: MediaTools } = {}) {
  normalizer = new MediaNormalizer({ ffmpeg: async () => ffmpeg });
  previews = new PreviewService({
    engine: undefined, normalizer, presets: async () => [PRESET], uiOrigins: () => [UI], media: o.media ?? media,
    ...(o.ttlMs ? { sessionTtlMs: o.ttlMs } : {}),
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
    expect(font).toMatchObject({ path: `assets/lib/${sha8(readFileSync(FONT))}-Mono.woff2`, kind: 'font' });
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

describe('cleanup', () => {
  const settle = () => new Promise((r) => setTimeout(r, 100));

  it('the staging folder goes when the session is revoked, evicted or expires', async () => {
    register(['logo.svg']);
    const s = await mint();
    await stage(s.token, { kind: 'library', file: 'logo.svg' });
    const dir = stagingDirOf(projectDir, 'launch', s.token);
    expect(existsSync(dir)).toBe(true);
    expect(previews.stagingInUse(dir)).toBe(true);
    expect(previews.revokePreview(ref(), s.token)).toBe(true);
    await settle();
    expect(existsSync(dir)).toBe(false);
    expect(previews.stagingInUse(dir)).toBe(false);
    // Evicted: the oldest of more than 8 sessions.
    const first = await mint();
    await stage(first.token, { kind: 'library', file: 'logo.svg' });
    for (let i = 0; i < 8; i++) await mint();
    await settle();
    expect(existsSync(stagingDirOf(projectDir, 'launch', first.token))).toBe(false);
    // Expired.
    await previews.close();
    await normalizer.close();
    await makeService({ ttlMs: 200 });
    const short = await mint();
    await stage(short.token, { kind: 'library', file: 'logo.svg' });
    expect(existsSync(stagingDirOf(projectDir, 'launch', short.token))).toBe(true);
    for (let i = 0; i < 40 && existsSync(stagingDirOf(projectDir, 'launch', short.token)); i++) await settle();
    expect(existsSync(stagingDirOf(projectDir, 'launch', short.token))).toBe(false);
  });

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
    // Once the session ended, an old folder goes too.
    expect(await sweepEditorStaging(projectDir, { now: Date.now() + 2 * 24 * 3600_000 })).toEqual(expect.arrayContaining([fresh, live]));
    expect(readFileSync(join(outside(), 'keep.txt'), 'utf8')).toBe('keep');
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

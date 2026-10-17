// @vitest-environment node
/**
 * Render jobs end to end in real Chrome and ffmpeg (Task 5):
 * - a v2 version with a 25 fps frame-coded video (first frame at 0.1 s, audio longer than the video) in a 30 fps
 *   composition: the job normalises it, renders through the trusted (strict) path with no warning, every output frame shows
 *   the source frame on screen at its time, the audio comes from the original source, and the records say `rendered`;
 *   the agent's composition.json is untouched and still has the recorded hash;
 * - an app quit during a render: the browser group and every ffmpeg are gone (`ps`), no partial output or temp file is
 *   left, and a retry on a new server starts clean and succeeds.
 * Skipped without Chrome or ffmpeg, unless MS_REQUIRE_CHROME=1 (CI).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_SETS, renderState, type FormatPreset, type JobSummary, type ManifestV2 } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { Git } from '../src/git.ts';
import { createFfmpegTools } from '../src/media/media-tools.ts';
import { ChromeProvider } from '../src/render/chromium-provider.ts';
import { countVideoFrames } from '../src/render/encode.ts';
import { createRenderEngine } from '../src/render/renderer.ts';
import { liveGroupCount } from '../src/render/watchdog.ts';
import { buildServer } from '../src/server/app.ts';
import { readIco } from '../src/identity/ico.ts';
import { decodePng } from '../src/identity/png.ts';
import { buildRuntime, decodeStrips, frameCodedVideo, framePts, leftovers, readCode, renderTools } from './helpers/render-env.ts';

const tools = await renderTools('render job tests');
const TOKEN = 'cd'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const PRESET: FormatPreset = { id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 };
const BOX_A = { x: 0, y: 0, width: 128, height: 64 };
const BOX_B = { x: 160, y: 0, width: 128, height: 64 };
const BOX_C = { x: 0, y: 70, width: 128, height: 40 };

function composition(duration: number, legacy = false) {
  return {
    $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration, background: '#000000', fonts: [],
    scenes: [{ id: 's', start: 0, duration }],
    tracks: [
      { id: 'bg', kind: 'visual', clips: [{ id: 'bar', type: 'shape', start: 0, duration, props: { x: 0, y: 120, width: 320, height: 60, fill: '#2060c0' } }] },
      { id: 'v', kind: 'video', clips: [
        { id: 'a', type: 'video', src: 'assets/code25.mp4', start: 0, duration: Math.min(duration, 2), props: BOX_A },
        { id: 'b', type: 'video', src: 'assets/code25.mp4', start: 0.5, duration: 1.5, trimStart: 0.4, props: BOX_B },
        // MPEG-4 Part 2, which Chrome cannot decode: only its normalised version can be shown.
        ...(legacy ? [{ id: 'c', type: 'video', src: 'assets/legacy.mp4', start: 0, duration: Math.min(duration, 2), props: BOX_C }] : []),
      ] },
    ],
  };
}

describe.skipIf(!tools.ok)('render jobs in real Chrome', () => {
  let work: string;
  let dist: string;
  let renderTemp: string;
  let ws: string;
  let app: FastifyInstance;
  const providers: ChromeProvider[] = [];

  const build = async () => buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(work, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, '-e', ''], { killGraceMs: 200 }), doctor: async () => [],
    media: await createFfmpegTools(),
    render: createRenderEngine({ provider: async () => { const p = new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 30 * 60_000 } }); providers.push(p); return p; } }),
    renderOptions: { distDir: dist, tempDir: renderTemp, parallel: 2, encoder: 'libx264' },
  });

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ms-test-render-jobs-chrome-'));
    dist = join(work, 'dist');
    renderTemp = join(work, 'render-tmp');
    mkdirSync(renderTemp);
    await buildRuntime(dist);
    ws = join(work, 'ws');
    app = await build();
    await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: ws } });
    await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } });
    await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: [PRESET] } });
  }, 600_000);
  afterAll(async () => { await app?.close(); if (work) rmSync(work, { recursive: true, force: true }); });

  async function v2Creative(title: string, duration: number, legacy = false, format = 'test-wide') {
    const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
      title, generate: false, brief: { goal: 'g', message: '', formats: [format], durationSec: Math.ceil(duration), assets: [], notes: '' },
    } });
    expect(r.statusCode, r.body).toBe(201);
    const slug = r.json().slug as string;
    const store = new CreativeStore(join(ws, 'acme'));
    const vdir = store.outputsDir(slug, 1);
    const dir = join(vdir, 'compositions', format);
    // 25 fps, 50 frames (2 s), first frame at 0.1 s, a 2.5 s audio track: audio longer than the video.
    frameCodedVideo(tools.ffmpeg!, join(dir, 'assets', 'code25.mp4'), { fps: 25, frames: 50, offset: 0.1, audioSeconds: 2.5 });
    if (legacy) {
      // `-fps_mode passthrough`: one output frame per source frame, on every ffmpeg. The source starts at 0.078 s (the AAC
      // priming of its audio) and its first video frame at 0.1 s; the default mode for MP4 differs between ffmpeg versions:
      // 6.1 (Ubuntu 24.04) picks `cfr`, which fills the 0.022 s gap by duplicating the first frame (51 frames, code 1 twice),
      // a newer one keeps the 50 frames. The expected codes below assume the 50 frames, checked right here.
      execFileSync(tools.ffmpeg!.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', join(dir, 'assets', 'code25.mp4'), '-map', '0:v', '-c:v', 'mpeg4', '-q:v', '1', '-fps_mode', 'passthrough', join(dir, 'assets', 'legacy.mp4')]);
      const pts = framePts(tools.ffmpeg!, join(dir, 'assets', 'legacy.mp4'));
      expect(pts.length, 'MPEG-4 fixture: one frame per source frame').toBe(50);
      pts.forEach((p, i) => expect(p - pts[0]!, `MPEG-4 fixture, frame ${i}`).toBeCloseTo(i / 25, 3));
    }
    writeFileSync(join(dir, 'composition.json'), JSON.stringify(composition(duration, legacy)));
    const hash = (await readCompositionFolder(dir)).hash;
    const compositions = [{ format, dir: `compositions/${format}`, hash, problems: [] }];
    writeFileSync(join(vdir, 'manifest.json'), JSON.stringify({ schemaVersion: 2, compositions, renders: [] } satisfies ManifestV2));
    await store.appendVersion(slug, { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null, compositions });
    return { slug, store, vdir, dir, hash };
  }

  async function waitJob(id: string, until: (j: JobSummary) => boolean = (j) => j.state !== 'queued' && j.state !== 'running', ms = 600_000): Promise<JobSummary> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const j = ((await app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id);
      if (j && until(j)) return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timeout waiting for the job');
  }

  it('normalises the video, renders through the trusted path, and every frame shows the source frame on screen at its time', async () => {
    const { slug, store, vdir, dir, hash } = await v2Creative('Frames', 2, true);
    const before = readFileSync(join(dir, 'composition.json'));
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: {} });
    expect(r.statusCode, r.body).toBe(202);
    const job = await waitJob(r.json().id);
    expect(job.state, job.error).toBe('succeeded');
    // No warning: the media was normalised (no "not prepared" note) and no frame needed the lenient rule.
    expect(job.notes ?? []).toEqual([]);
    const out = join(vdir, 'test-wide.mp4');
    const count = await countVideoFrames(tools.ffmpeg!, out);
    expect(count).toEqual({ frames: 60, width: 320, height: 180, audio: true }); // the audio comes from the original source
    const a = decodeStrips(tools.ffmpeg!, out, BOX_A, 2).map(readCode);
    const b = decodeStrips(tools.ffmpeg!, out, BOX_B, 2).map(readCode);
    const c = decodeStrips(tools.ffmpeg!, out, BOX_C, 2).map(readCode);
    for (let i = 0; i < 60; i++) {
      const t = i / 30;
      expect(a[i], `clip a, frame ${i}`).toBe(Math.floor(t * 25 + 1e-9) + 1);
      expect(c[i], `clip c (MPEG-4 source), frame ${i}`).toBe(Math.floor(t * 25 + 1e-9) + 1);
      expect(b[i], `clip b, frame ${i}`).toBe(t < 0.5 - 1e-9 ? 0 : Math.floor((0.4 + t - 0.5) * 25 + 1e-9) + 1);
    }
    // The normalised file is in the media cache; the agent's folder is untouched and keeps its hash.
    const sha = createHash('sha256').update(readFileSync(join(dir, 'assets', 'code25.mp4'))).digest('hex');
    const legacySha = createHash('sha256').update(readFileSync(join(dir, 'assets', 'legacy.mp4'))).digest('hex');
    expect(readdirSync(join(ws, 'acme', '.studio', 'cache', 'media')).sort()).toEqual([`${sha}-30-64x32-n1.mp4`, `${legacySha}-30-64x32-n1.mp4`].sort());
    expect(readFileSync(join(dir, 'composition.json'))).toEqual(before);
    expect((await readCompositionFolder(dir)).hash).toBe(hash);
    const v = (await store.readVersions(slug))[0]!;
    expect(renderState(v, 'test-wide')).toBe('rendered');
    expect(v.outputs[0]).toMatchObject({ format: 'test-wide', file: 'test-wide.mp4', width: 320, height: 180, verified: true, preview: '.previews/test-wide.mp4.jpg', fromComposition: hash, problems: [] });
    expect(v.outputs[0]!.durationSec).toBeCloseTo(2, 1);
    expect(readdirSync(vdir).filter((f) => f.startsWith('.') && f !== '.previews')).toEqual([]);
    expect(readdirSync(renderTemp)).toEqual([]);
    expect(await leftovers({ pgids: providers.map((p) => p.pgid!).filter(Boolean), markers: [renderTemp] })).toEqual([]);
  }, 900_000);

  it('a format instance renders through the trusted path into outputs/vN/<instanceId>.mp4 (Phase 12)', async () => {
    const { slug, store, vdir, hash } = await v2Creative('Instance', 2, false, 'test-wide@2');
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: {} });
    expect(r.statusCode, r.body).toBe(202);
    const job = await waitJob(r.json().id);
    expect(job.state, job.error).toBe('succeeded');
    expect(await countVideoFrames(tools.ffmpeg!, join(vdir, 'test-wide@2.mp4'))).toMatchObject({ frames: 60, width: 320, height: 180 });
    const v = (await store.readVersions(slug))[0]!;
    expect(v.outputs[0]).toMatchObject({ format: 'test-wide@2', file: 'test-wide@2.mp4', preview: '.previews/test-wide@2.mp4.jpg', fromComposition: hash });
    expect(renderState(v, 'test-wide@2')).toBe('rendered');
  }, 900_000);

  it('an identity format renders its image and writes its file set into outputs/vN/<format>/ (Phase 14)', async () => {
    const ICON: FormatPreset = { id: 'test-favicon', channel: 'Test', name: 'Favicon', width: 64, height: 64, kind: 'image', extensions: ['png'], identity: 'favicon' };
    expect((await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: [PRESET, ICON] } })).statusCode).toBe(200);
    const c = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
      title: 'Icon', generate: false, brief: { goal: 'g', message: '', formats: [ICON.id], durationSec: null, assets: [], notes: '' },
    } });
    expect(c.statusCode, c.body).toBe(201);
    const slug = c.json().slug as string;
    const store = new CreativeStore(join(ws, 'acme'));
    const vdir = store.outputsDir(slug, 1);
    const dir = join(vdir, 'compositions', ICON.id);
    mkdirSync(join(dir, 'assets'), { recursive: true });
    // A wide mark (4:1): the main image must show it whole (fit contain), never cropped to the square (fix round 1).
    writeFileSync(join(dir, 'assets', 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect width="400" height="100" fill="#e01010"/></svg>');
    writeFileSync(join(dir, 'assets', 'small.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1030e0"/></svg>');
    writeFileSync(join(dir, 'composition.json'), JSON.stringify({
      $schema: 'motion-studio/composition@1', width: 64, height: 64, fps: 30, duration: 0, background: '#123456', fonts: [], scenes: [],
      tracks: [{ id: 't', kind: 'visual', clips: [
        { id: 'mark', type: 'svg', src: 'assets/mark.svg', start: 0, duration: 0, props: { fit: 'contain' } },
        { id: 'small', type: 'svg', src: 'assets/small.svg', start: 0, duration: 0, hidden: true, props: { fit: 'contain' } },
      ] }],
    }));
    const compositions = [{ format: ICON.id, dir: `compositions/${ICON.id}`, hash: (await readCompositionFolder(dir)).hash, problems: [] }];
    writeFileSync(join(vdir, 'manifest.json'), JSON.stringify({ schemaVersion: 2, compositions, renders: [] } satisfies ManifestV2));
    await store.appendVersion(slug, { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null, compositions });
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: {} });
    expect(r.statusCode, r.body).toBe(202);
    const job = await waitJob(r.json().id);
    expect(job.state, job.error).toBe('succeeded');
    const v = (await store.readVersions(slug))[0]!;
    expect(v.outputs[0]).toMatchObject({ format: ICON.id, file: `${ICON.id}.png`, width: 64, height: 64 });
    expect(v.outputs[0]!.identitySet?.dir).toBe(ICON.id);
    const main = decodePng(readFileSync(join(vdir, `${ICON.id}.png`)));
    const px = (x: number, y: number) => [...main.rgba.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)];
    expect(px(0, 0)).toEqual([0x12, 0x34, 0x56]); // above the band: the background, not cropped red
    expect(px(0, 32)).toEqual([0xe0, 0x10, 0x10]); // the band reaches both sides: the whole width is shown
    expect(px(63, 32)).toEqual([0xe0, 0x10, 0x10]);
    expect(v.outputs[0]!.identitySet!.files.map((f) => f.path)).toEqual(IDENTITY_SETS.favicon.files.map((f) => f.path));
    for (const f of IDENTITY_SETS.favicon.files) expect(readFileSync(join(vdir, ICON.id, f.path)).length, f.path).toBeGreaterThan(0);
    expect(readIco(readFileSync(join(vdir, ICON.id, 'favicon.ico'))).map((e) => e.width)).toEqual([16, 32, 48]);
    expect(JSON.parse(readFileSync(join(vdir, ICON.id, 'site.webmanifest'), 'utf8')).theme_color).toBe('#123456');
    expect(readdirSync(join(vdir, ICON.id)).filter((f) => f.startsWith('.'))).toEqual([]);
    expect(readdirSync(renderTemp)).toEqual([]);
    expect(await leftovers({ pgids: providers.map((p) => p.pgid!).filter(Boolean), markers: [renderTemp] })).toEqual([]);
  }, 900_000);

  it('a logo writes logo-dark.svg and logo-dark.png from its "dark" clip; an older logo without one still renders its set (note 9)', async () => {
    const LOGO: FormatPreset = { id: 'test-logo', channel: 'Test', name: 'Logo', width: 64, height: 64, kind: 'image', extensions: ['png'], identity: 'logo' };
    expect((await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: [PRESET, LOGO] } })).statusCode).toBe(200);
    const store = new CreativeStore(join(ws, 'acme'));
    const mark = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect x="50" y="25" width="100" height="50" fill="#101010"/></svg>';
    const negative = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect x="50" y="25" width="100" height="50" fill="#f0f0f0"/></svg>';
    const logoCreative = async (title: string, withDark: boolean) => {
      const c = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
        title, generate: false, brief: { goal: 'g', message: '', formats: [LOGO.id], durationSec: null, assets: [], notes: '' },
      } });
      expect(c.statusCode, c.body).toBe(201);
      const slug = c.json().slug as string;
      const vdir = store.outputsDir(slug, 1);
      const dir = join(vdir, 'compositions', LOGO.id);
      mkdirSync(join(dir, 'assets'), { recursive: true });
      writeFileSync(join(dir, 'assets', 'logo.svg'), mark);
      if (withDark) writeFileSync(join(dir, 'assets', 'logo-dark.svg'), negative);
      writeFileSync(join(dir, 'composition.json'), JSON.stringify({
        $schema: 'motion-studio/composition@1', width: 64, height: 64, fps: 30, duration: 0, background: '#00000000', fonts: [], scenes: [],
        tracks: [{ id: 't', kind: 'visual', clips: [
          { id: 'mark', type: 'svg', src: 'assets/logo.svg', start: 0, duration: 0, props: { fit: 'contain' } },
          ...(withDark ? [{ id: 'dark', type: 'svg', src: 'assets/logo-dark.svg', start: 0, duration: 0, hidden: true, props: { fit: 'contain' } }] : []),
        ] }],
      }));
      const compositions = [{ format: LOGO.id, dir: `compositions/${LOGO.id}`, hash: (await readCompositionFolder(dir)).hash, problems: [] }];
      writeFileSync(join(vdir, 'manifest.json'), JSON.stringify({ schemaVersion: 2, compositions, renders: [] } satisfies ManifestV2));
      await store.appendVersion(slug, { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null, compositions });
      const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: {} });
      expect(r.statusCode, r.body).toBe(202);
      const job = await waitJob(r.json().id);
      expect(job.state, job.error).toBe('succeeded');
      return { vdir, v: (await store.readVersions(slug))[0]! };
    };
    const centre = (file: string) => { const d = decodePng(readFileSync(file)); const i = (Math.floor(d.height / 2) * d.width + Math.floor(d.width / 2)) * 4; return [...d.rgba.subarray(i, i + 4)]; };

    const a = await logoCreative('Logo', true);
    expect(a.v.outputs[0]!.identitySet!.files.map((f) => f.path)).toEqual(['logo.svg', 'logo.png', 'logo-dark.svg', 'logo-dark.png']);
    expect(readFileSync(join(a.vdir, LOGO.id, 'logo-dark.svg'), 'utf8')).toBe(negative);
    expect(centre(join(a.vdir, LOGO.id, 'logo.png'))).toEqual([0x10, 0x10, 0x10, 255]);
    expect(centre(join(a.vdir, LOGO.id, 'logo-dark.png'))).toEqual([0xf0, 0xf0, 0xf0, 255]);
    const dims = (name: string) => { const d = decodePng(readFileSync(join(a.vdir, LOGO.id, name))); return [d.width, d.height]; };
    expect(dims('logo-dark.png')).toEqual(dims('logo.png'));
    expect(decodePng(readFileSync(join(a.vdir, LOGO.id, 'logo-dark.png'))).rgba[3]).toBe(0); // transparent outside the drawing

    const old = await logoCreative('Old logo', false);
    expect(old.v.outputs[0]!.identitySet!.files.map((f) => f.path)).toEqual(['logo.svg', 'logo.png']);
    expect(existsSync(join(old.vdir, LOGO.id, 'logo-dark.png'))).toBe(false);
  }, 900_000);

  it('an app quit during a render leaves no process and no partial output; a retry starts clean', async () => {
    const { slug, store, vdir } = await v2Creative('Quit', 4);
    providers.length = 0;
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: {} });
    const id = r.json().id as string;
    const running = await waitJob(id, (j) => j.progress?.phase === 'frames' && j.progress.done >= 10);
    expect(running.state).toBe('running');
    const p = providers.at(-1)!;
    const pgid = p.pgid!;
    const profile = p.profileDir!;
    expect(await leftovers({ pgids: [pgid] })).not.toEqual([]);
    // Quit: the app closes the server (the desktop app does this on quit), which cancels every job and waits for it.
    await app.close();
    // `close` has waited for every job; the process table lags it by the kernel's reaping, which a loaded machine stretches. So
    // the process checks get a short bounded grace (a leak never goes away, so a real one still fails); the files do not.
    const gone = async (check: () => Promise<boolean> | boolean) => { for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 100)); };
    const markers = [profile, renderTemp, join(ws, 'acme', '.studio', 'cache', 'media')];
    await gone(async () => (await leftovers({ pgids: [pgid], markers })).length === 0);
    expect(await leftovers({ pgids: [pgid], markers })).toEqual([]);
    expect(readdirSync(vdir).sort()).toEqual(['compositions', 'manifest.json']);
    expect(readdirSync(renderTemp)).toEqual([]);
    // Every ffmpeg and ffprobe the core started (they read their input by fd, so no path marker shows them) is gone.
    await gone(() => liveGroupCount() === 0);
    expect(liveGroupCount()).toBe(0);
    expect((await store.readVersions(slug))[0]!.outputs).toEqual([]);
    // A new server (the app restarted): the retry renders it.
    app = await build();
    const retry = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: {} });
    expect(retry.statusCode, retry.body).toBe(202);
    const done = await waitJob(retry.json().id);
    expect(done.state, done.error).toBe('succeeded');
    expect(await countVideoFrames(tools.ffmpeg!, join(vdir, 'test-wide.mp4'))).toMatchObject({ frames: 120 });
    expect(renderState((await store.readVersions(slug))[0]!, 'test-wide')).toBe('rendered');
    expect(await leftovers({ pgids: providers.map((x) => x.pgid!).filter(Boolean), markers: [renderTemp] })).toEqual([]);
  }, 900_000);
});

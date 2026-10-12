// @vitest-environment node
/**
 * The Electron render provider and the UI preview filter in **real Electron** (phase 10a Task 7). Each scenario bundles
 * test/electron/harness.ts and runs it with the Electron binary of the workspace, with a throwaway Electron data folder
 * (every `app.setPath` under the OS temp folder, the mock keychain) and the test's temp `MOTION_STUDIO_CONFIG_DIR`. A
 * canary server on loopback stands in for the core API (a hit is a leak), a UDP canary for WebRTC and WebTransport.
 *
 * - **window options:** a render window is hidden, offscreen, sandboxed, isolated, with no preload and no Node, on its own
 *   in-memory partition whose proxy sends everything but the composition server to the dead proxy; WebRTC policy set;
 *   closed windows are gone, and a fresh window loads right after a close (the destroy()/loadURL race);
 * - **session rules alone** (no CDP interception, no CSP): the hostile and self-navigating layers, workers and WebRTC reach
 *   nothing; a control window on a plain partition reaches the canary through the same page;
 * - **the provider renders** a spike-like composition (three scenes, shapes, text, an html canvas layer, a frame-coded
 *   video) in parallel windows: exact frame count, the video's frame codes on screen, no window left;
 * - **all layers in render:** the hostile and self-navigating layers through the real composition server reach nothing;
 * - **the preview filter:** a UI-like page framing the real preview AND every hostile layer directly (Task 3's residual):
 *   the control (no filter) reaches the canary; with the filter on the UI session nothing does, and the preview still loads;
 * - **lifecycle:** app quit closes every render window of every provider (their renderers end), cancel, the time limit,
 *   the window cap; **memory:** a 2 GB layer trips the watchdog (`memoryLimit`), no window left.
 *
 * Runs on macOS when the Electron binary is installed; elsewhere (a display is needed) only with MS_REQUIRE_ELECTRON=1,
 * which also makes a missing binary a failure. Needs ffmpeg for the renders.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Composition } from '../../../packages/shared/src/index.ts';
import { findFfmpeg, type FfmpegInfo } from '@motion-studio/core';
import { countVideoFrames } from '../../../packages/core/src/render/encode.ts';
import { startCompositionServer, type CompositionServer } from '../../../packages/core/src/compositions/composition-server.ts';
import {
  hostileLayer, hostileTrack, hostileWorkerScripts, OWN_FRAME_NAVIGATION_CASES, SELF_NAVIGATION_CASES, selfNavigationLayer,
  selfNavigationPath, selfNavigationTrack, workerTransportProbe, writeHostileLayers,
} from '../../../packages/core/test/helpers/hostile-layers.ts';
import { buildRuntime, decodeStrips, FONT, frameCodedVideo, put, readCode, startCanary, startUdpCanary, type Canary, type UdpCanary } from '../../../packages/core/test/helpers/render-env.ts';

const DESKTOP = join(import.meta.dirname, '..');
const required = process.env.MS_REQUIRE_ELECTRON === '1';
const electronPath = (() => { try { return createRequire(join(DESKTOP, 'package.json'))('electron') as string; } catch { return null; } })();
const hasElectron = !!electronPath && existsSync(electronPath);
const ffmpeg = await findFfmpeg();
const enabled = (required || process.platform === 'darwin') && hasElectron && !!ffmpeg;
if (!enabled) {
  const why = !hasElectron ? 'no Electron binary (pnpm install, or extract it from the local cache)' : !ffmpeg ? 'no ffmpeg' : 'not macOS (set MS_REQUIRE_ELECTRON=1 with a display)';
  if (required) it(`real Electron: ${why} (MS_REQUIRE_ELECTRON=1)`, () => { throw new Error(why); });
  else console.warn(`[desktop] real-Electron render tests SKIPPED: ${why}.`);
}

const TOKEN = 'naked-token-0123456789abcdef';
const W = 320, H = 180;
const VIDEO_BOX = { x: 0, y: 0, width: 64, height: 32 };

/** The spike's composition, small: three scenes, a background bar, text, an animated shape, a canvas layer, a coded video. */
function spikeComposition(duration = 2): Composition {
  return {
    $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration, background: '#101010',
    fonts: [{ family: 'Mono', src: 'assets/mono.woff2' }],
    scenes: [{ id: 'intro', start: 0, duration: 0.6 }, { id: 'body', start: 0.6, duration: 0.8 }, { id: 'outro', start: 1.4, duration: duration - 1.4 }],
    tracks: [
      { id: 'bg', kind: 'visual', clips: [{ id: 'bar', type: 'shape', start: 0, duration, props: { x: 0, y: 140, width: W, height: 40, fill: '#2060c0' } }] },
      { id: 'v', kind: 'video', clips: [{ id: 'v', type: 'video', src: 'assets/v.mp4', start: 0, duration, sourceFps: 30, props: { ...VIDEO_BOX } }] },
      { id: 'shapes', kind: 'visual', clips: [{ id: 'card', type: 'shape', start: 0.6, duration: 0.8, props: { x: 100, y: 40, width: 80, height: 60, fill: '#ff0000', radius: 8 }, animations: [{ preset: 'fadeIn', duration: 0.3 }] }] },
      { id: 'txt', kind: 'text', clips: [{ id: 'title', type: 'text', start: 0, duration: 0.6, props: { text: 'Motion Studio', x: 80, y: 60, width: 200, fontFamily: 'Mono' } }] },
      { id: 'layer', kind: 'visual', clips: [{ id: 'outro', type: 'html', src: 'layers/outro.html', start: 1.4, duration: duration - 1.4, props: { x: 200, y: 20, width: 100, height: 100 } }] },
    ],
  } as unknown as Composition;
}

const OUTRO_LAYER = `<!doctype html><html><body style="margin:0"><canvas id="c" width="100" height="100"></canvas><script>
const g = document.getElementById('c').getContext('2d');
window.msReady = Promise.resolve();
window.msSeek = (t) => { g.fillStyle = '#000'; g.fillRect(0, 0, 100, 100); g.fillStyle = '#ffcc00'; g.fillRect(0, 0, Math.round(100 * Math.min(1, t / 2)), 100); };
</script></body></html>`;

/** A layer that allocates 2 GB of ArrayBuffers once seeked past 0.1 s (as in the core's process test). */
const MEM_LAYER = `<!doctype html><html><body><script>
window.msReady = Promise.resolve();
const keep = [];
window.msSeek = (t) => { if (t >= 0.1 && keep.length === 0) { for (let i = 0; i < 32; i++) { const a = new Uint8Array(64 * 1024 * 1024); for (let j = 0; j < a.length; j += 4) a[j] = (j * 2654435761) & 255; keep.push(a); } } };
</script></body></html>`;

/** A server WITHOUT any CSP: `/<token>/page.html` starts workers and frames every hostile and self-navigating layer. */
async function nakedServer(canary: string, udpPort: number): Promise<{ origin: string; close(): Promise<void> }> {
  const layers: Record<string, string> = { hostile: hostileLayer(canary, udpPort) };
  for (const c of SELF_NAVIGATION_CASES) layers[`selfnav-${c}`] = selfNavigationLayer(canary, c);
  const scripts = hostileWorkerScripts(canary);
  const page = `<!doctype html><html><body>${Object.keys(layers).map((k) => `<iframe sandbox="allow-scripts" src="/${TOKEN}/layers/${k}.html"></iframe>`).join('')}
<script>
fetch(${JSON.stringify(`${canary}/top-fetch`)}).catch(() => {});
try { new WebSocket(${JSON.stringify(canary.replace('http:', 'ws:') + '/top-ws')}); } catch (e) {}
try { navigator.serviceWorker.register('/${TOKEN}/sw.js').catch(() => {}); } catch (e) {}
try { new SharedWorker('/${TOKEN}/shared.js'); } catch (e) {}
try { new Worker('/${TOKEN}/worker.js'); } catch (e) {}
try { new Worker(URL.createObjectURL(new Blob([${JSON.stringify(`fetch('${canary}/blob-worker-fetch').catch(() => {});`)}], { type: 'text/javascript' }))); } catch (e) {}
try { new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerTransportProbe(udpPort))}], { type: 'text/javascript' }))); } catch (e) {}
</script></body></html>`;
  const s: Server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0]!;
    const html = new RegExp(`^/${TOKEN}/layers/([\\w-]+)\\.html$`).exec(url);
    const js = new RegExp(`^/${TOKEN}/(?:layers/)?([\\w-]+\\.js)$`).exec(url);
    if (url === `/${TOKEN}/page.html` || (html && layers[html[1]!])) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(url === `/${TOKEN}/page.html` ? page : layers[html![1]!]);
    } else if (js && scripts[js[1]!]) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(scripts[js[1]!]);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { origin: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

/** A UI-like page server: `/<name>.html` frames that page's URLs (sandboxed, as the UI frames the preview). */
async function uiServer(): Promise<{ origin: string; setPage(name: string, urls: string[]): void; close(): Promise<void> }> {
  const pages = new Map<string, string[]>();
  const s: Server = createServer((req, res) => {
    const frames = pages.get((req.url ?? '').split('?')[0]!.replace(/^\/|\.html$/g, ''));
    if (frames) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>${frames.map((u) => `<iframe sandbox="allow-scripts" src="${u}" width="320" height="180"></iframe>`).join('')}</body></html>`);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return {
    origin: `http://127.0.0.1:${(s.address() as { port: number }).port}`,
    setPage: (name, urls) => { pages.set(name, urls); },
    close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }),
  };
}

/** SIGKILLs every process whose full command line mentions `marker` (`ps -ww`: Electron's helper paths are long). */
async function sweepHelpers(marker: string): Promise<number> {
  const out = await new Promise<string>((resolve) => execFile('ps', ['-A', '-ww', '-o', 'pid=,command='], { maxBuffer: 64 << 20 }, (_e, so) => resolve(so ?? '')));
  let n = 0;
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m && m[2]!.includes(marker) && Number(m[1]) !== process.pid) { n++; try { process.kill(Number(m[1]), 'SIGKILL'); } catch { /* gone */ } }
  }
  return n;
}

/** The real data folders an Electron run could touch (their mtimes must not change). */
const REAL_FOLDERS = (() => {
  // The account's real home (vitest replaces $HOME with a temp folder).
  const home = userInfo().homedir;
  return ['Library/Application Support/Motion Studio', 'MotionStudio', 'Library/Application Support/Electron', 'Library/Application Support/Motion Studio Electron', 'Library/Application Support/ms-electron-harness', 'Library/Caches/Electron', 'Library/Caches/ms-electron-harness']
    .map((p) => join(home, p));
})();
const mtimes = () => REAL_FOLDERS.map((p) => { try { return `${p} ${statSync(p).mtimeMs}`; } catch { return `${p} missing`; } });

describe.skipIf(!enabled)('Electron render provider and preview filter in real Electron', () => {
  let work: string;
  let dist: string;
  let harness: string;
  let canary: Canary;
  let udp: UdpCanary;
  let before: string[];

  beforeAll(async () => {
    before = mtimes();
    work = mkdtempSync(join(tmpdir(), 'ms-test-electron-render-'));
    dist = join(work, 'dist');
    await buildRuntime(dist);
    // The bundle goes under the desktop's node_modules so that its external native module resolves (never committed).
    const out = mkdtempSync(join(DESKTOP, 'node_modules', '.ms-electron-harness-'));
    const { build } = await import('tsup');
    await build({
      entry: { harness: join(DESKTOP, 'test', 'electron', 'harness.ts') }, outDir: out, format: ['cjs'], outExtension: () => ({ js: '.cjs' }),
      platform: 'node', target: 'node22', shims: true, splitting: false, sourcemap: false, clean: false, silent: true, config: false,
      noExternal: [/^@motion-studio\//], external: ['electron', '@napi-rs/keyring'],
    });
    harness = join(out, 'harness.cjs');
    canary = await startCanary();
    udp = await startUdpCanary();
  }, 900_000);

  afterAll(async () => {
    await canary?.close();
    await udp?.close();
    if (harness) rmSync(join(harness, '..'), { recursive: true, force: true });
    if (work) rmSync(work, { recursive: true, force: true });
    if (before) expect(mtimes()).toEqual(before);
  });

  /** Runs one scenario; `onLine` sees each report as it arrives (to cut canary hits between phases). */
  function runHarness(config: object, onLine?: (o: Record<string, unknown>) => void, timeoutMs = 600_000): Promise<{ ok: boolean; code: number | null; lines: Array<Record<string, unknown>>; output: string }> {
    const configDir = mkdtempSync(join(tmpdir(), 'ms-test-electron-config-'));
    const scratch = mkdtempSync(join(tmpdir(), 'ms-test-electron-data-'));
    // A minimal environment: the vitest worker's (NODE_OPTIONS and the like) hung Electron before it started. HOME is the
    // isolation setup's temp home; VITEST makes the bundled core refuse the real config folders (test isolation guard).
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8', VITEST: 'true',
      MS_HARNESS: JSON.stringify({ dist, scratch, ...config }), MOTION_STUDIO_CONFIG_DIR: configDir,
    };
    return new Promise((resolve) => {
      const child = spawn(electronPath!, ['--use-mock-keychain', '--password-store=basic', harness], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const lines: Array<Record<string, unknown>> = [];
      let killedAfterDone = false;
      let output = '';
      let buf = '';
      child.stdout.on('data', (d: Buffer) => {
        output += d.toString();
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          const m = /^HARNESS (.*)$/.exec(line);
          if (m) {
            const o = JSON.parse(m[1]!) as Record<string, unknown>;
            lines.push(o);
            onLine?.(o);
            // Finished. On this very loaded machine Electron's own shutdown took from seconds to minutes (its helpers
            // starved of CPU): after 2 minutes it is killed, and the run still counts as finished.
            if (o.done) setTimeout(() => { killedAfterDone = true; child.kill('SIGKILL'); }, 120_000).unref();
          }
        }
      });
      child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        // Its helpers (they carry --user-data-dir=<scratch>) end with it; any still alive (killed main, starved helper) go.
        void sweepHelpers(scratch).then((left) => {
          rmSync(configDir, { recursive: true, force: true });
          rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          const done = lines.some((l) => l.done === true);
          if (process.env.MS_RENDER_DEBUG) console.info(`[electron] exit ${String(code)}${killedAfterDone ? ' (killed 2 min after done)' : ''}, ${left} helper(s) swept`);
          resolve({ ok: done && (code === 0 || killedAfterDone), code, lines, output: output.slice(-4000) });
        });
      });
    });
  }

  const find = (lines: Array<Record<string, unknown>>, pred: (o: Record<string, unknown>) => boolean) => lines.find(pred) ?? {};

  it('window options: hidden, offscreen, sandboxed, no preload/Node, own in-memory partition with the dead proxy; closed windows are gone', async () => {
    const r = await runHarness({ scenario: 'options' });
    expect(r.ok, r.output).toBe(true);
    const o = r.lines[0]!;
    expect(o.prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, preload: null, webviewTag: false });
    expect(o).toMatchObject({ visible: false, offscreen: true, persistent: false, separate: true, webrtc: 'disable_non_proxied_udp', keptAwake: true, windowsOpen: 1 });
    expect(o.pageGlobals).toBe('undefined,undefined,undefined,undefined,undefined');
    if (process.platform !== 'linux') expect(o.processSandboxed).toBe(true);
    expect(o.pids).toBeGreaterThan(0);
    expect(o.proxy).toEqual({ internet: 'PROXY 127.0.0.1:9', server: 'DIRECT', otherLoopback: 'PROXY 127.0.0.1:9', localhost: 'PROXY 127.0.0.1:9' });
    expect(find(r.lines, (l) => 'windowsAfterClose' in l)).toEqual({ windowsAfterClose: 0, allWindows: 0, keptAwake: false });
    expect(find(r.lines, (l) => 'freshAfterClose' in l)).toEqual({ freshAfterClose: 'about:blank' });
  }, 900_000);

  it('session rules alone (no interception, no CSP): a control reaches the canary; a render window reaches nothing', async () => {
    const naked = await nakedServer(canary.origin, udp.port);
    const start = canary.hits.length;
    const udpStart = udp.packets.length;
    let cut = -1, udpCut = -1;
    try {
      const r = await runHarness({ scenario: 'session-rules', naked: { origin: naked.origin, token: TOKEN } }, (l) => {
        if (l.phase === 'control-done') { cut = canary.hits.length; udpCut = udp.packets.length; }
      });
      expect(r.ok, r.output).toBe(true);
      const control = canary.hits.slice(start, cut);
      for (const c of OWN_FRAME_NAVIGATION_CASES) expect(control, c).toContain(selfNavigationPath(c));
      for (const p of ['/top-fetch', '/fetch', '/worker-fetch', '/blob-worker-fetch']) expect(control, p).toContain(p);
      expect(udp.packets.slice(udpStart, udpCut).length, 'the control sends UDP (WebRTC / WebTransport)').toBeGreaterThan(0);
      const locked = find(r.lines, (l) => l.phase === 'locked-done');
      expect(locked.opened).toBe(`${naked.origin}/${TOKEN}/page.html`);
      expect(locked.frames).toBeGreaterThan(1); // the layers loaded (they are on the allowed prefix)
      // The control ran the page's service worker (on the same prefix); the locked session refused its script.
      expect(find(r.lines, (l) => l.phase === 'control-sw').serviceWorkers).toBeGreaterThan(0);
      expect(locked.serviceWorkers).toBe(0);
      expect(canary.hits.slice(cut)).toEqual([]);
      // Only a packet from a new source is the render window's (the control's QUIC Initial is retransmitted after it closed).
      const controlPorts = new Set(udp.packets.slice(udpStart, udpCut).map((p) => p.from));
      expect(udp.packets.slice(udpCut).filter((p) => !controlPorts.has(p.from))).toEqual([]);
    } finally { await naked.close(); }
  }, 900_000);

  it('the provider renders the spike composition in parallel windows: exact frames, video codes on screen, no window left', async () => {
    const creative = join(work, 'spike');
    const compDir = join(creative, 'outputs', 'v1', 'compositions', 'spike');
    frameCodedVideo(ffmpeg!, join(compDir, 'assets', 'v.mp4'), { fps: 30, frames: 95 });
    put(join(compDir, 'layers', 'outro.html'), OUTRO_LAYER);
    put(join(compDir, 'assets', 'mono.woff2'), readFileSync(FONT));
    const out = join(creative, 'outputs', 'v1', 'spike.mp4');
    const r = await runHarness({ scenario: 'render', creative, composition: spikeComposition(), format: 'spike', out, ffmpeg, parallel: 2 });
    expect(r.ok, r.output).toBe(true);
    const res = r.lines[0]!;
    expect(res).toMatchObject({ ok: true, frames: 60, width: W, height: H, windowsAfter: 0 });
    if (process.env.MS_RENDER_DEBUG) console.info(`[electron] spike: ${String(res.ms)} ms, peak ${JSON.stringify(res.peak)}`);
    expect(await countVideoFrames(ffmpeg!, out)).toMatchObject({ frames: 60, width: W, height: H });
    // The coded video shows its source frame at each frame time (with a tolerance: an untrusted source may be one off).
    const codes = decodeStrips(ffmpeg!, out, VIDEO_BOX, 2).map(readCode);
    const exact = codes.filter((c, i) => c === i + 1).length;
    expect(codes.every((c, i) => Math.abs(c - (i + 1)) <= 1), codes.join(',')).toBe(true);
    expect(exact, codes.join(',')).toBeGreaterThanOrEqual(54);
    // The canvas layer (outro, from 1.4 s) is painted: yellow at the last frame, absent before the outro.
    const layer = decodeStrips(ffmpeg!, out, { x: 200, y: 20, width: 20, height: 100 }, 1).map((s) => s[0]!);
    expect(layer[59]).toBeGreaterThan(120);
    expect(layer[10]).toBeLessThan(60);
  }, 900_000);

  it('all layers in render (composition server, CDP interception, session rules): the hostile and self-navigating layers reach nothing', async () => {
    const creative = join(work, 'hostile');
    const compDir = join(creative, 'outputs', 'v1', 'compositions', 'iso');
    mkdirSync(join(compDir, 'layers'), { recursive: true });
    writeHostileLayers(compDir, canary.origin, udp.port);
    const composition = {
      $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: 2, background: '#000000', fonts: [],
      scenes: [{ id: 'all', start: 0, duration: 2 }], tracks: [selfNavigationTrack(2), hostileTrack(2)],
    } as unknown as Composition;
    const start = canary.hits.length;
    const udpStart = udp.packets.length;
    const r = await runHarness({ scenario: 'hostile-render', creative, composition, format: 'iso' });
    expect(r.ok, r.output).toBe(true);
    expect(r.lines[0]).toMatchObject({ captured: true, failure: null });
    expect(find(r.lines, (l) => 'windowsAfter' in l)).toEqual({ windowsAfter: 0 });
    expect(canary.hits.slice(start)).toEqual([]);
    expect(udp.packets.slice(udpStart)).toEqual([]);
  }, 900_000);

  it('preview filter: the UI framing the preview and the layers directly (the residual); the control leaks, the UI window reaches nothing', async () => {
    const creative = join(work, 'preview');
    const compDir = join(creative, 'outputs', 'v1', 'compositions', 'iso');
    mkdirSync(join(compDir, 'layers'), { recursive: true });
    writeHostileLayers(compDir, canary.origin, udp.port);
    const composition = {
      $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: 2, background: '#000000', fonts: [],
      scenes: [{ id: 'all', start: 0, duration: 2 }], tracks: [selfNavigationTrack(2), hostileTrack(2)],
    } as unknown as Composition;
    const ui = await uiServer();
    const naked = await nakedServer(canary.origin, udp.port);
    let server: CompositionServer | null = null;
    try {
      server = await startCompositionServer({ uiOrigins: [ui.origin], distDir: dist });
      const preview = await server.mintSession({ creativeDir: creative, versionDir: 'outputs/v1', format: 'iso', composition, mode: 'preview', parentOrigin: ui.origin });
      const layer = (name: string) => `${server!.origin}/${preview.token}/outputs/v1/compositions/iso/layers/${name}.html`;
      const names = ['hostile', ...SELF_NAVIGATION_CASES.map((c) => `selfnav-${c}`)];
      // real: the real preview, and every layer of the real server framed directly (Task 3's residual: no runtime page
      // above them, only their own headers). naked: the same layers from a server without any CSP (the filter alone).
      const real = [preview.url, ...names.map(layer)];
      const nakedFrames = names.map((n) => `${naked.origin}/${TOKEN}/layers/${n}.html`);
      ui.setPage('all', [...real, ...nakedFrames]);
      ui.setPage('real', real);
      ui.setPage('naked', nakedFrames);
      const start = canary.hits.length;
      const udpStart = udp.packets.length;
      const cuts: Record<string, { hits: number; udp: number }> = {};
      const r = await runHarness({ scenario: 'preview', ui: { origin: ui.origin, all: `${ui.origin}/all.html`, real: `${ui.origin}/real.html`, naked: `${ui.origin}/naked.html` } }, (l) => {
        if (typeof l.phase === 'string') cuts[l.phase] = { hits: canary.hits.length, udp: udp.packets.length };
      });
      expect(r.ok, r.output).toBe(true);
      const c0 = cuts['control-done']!, c1 = cuts['real-done']!, c2 = cuts['naked-done']!;
      // Control (no filter): the directly framed layers navigate themselves to the canary, the CSP-less one fetches it.
      const control = canary.hits.slice(start, c0.hits);
      for (const c of OWN_FRAME_NAVIGATION_CASES) expect(control, `control ${c}`).toContain(selfNavigationPath(c));
      expect(control, 'control fetch').toContain('/fetch');
      expect(c0.udp - udpStart, 'the control sends UDP (WebRTC / WebTransport)').toBeGreaterThan(0);
      // The UI window: nothing over HTTP, from either page.
      expect(canary.hits.slice(c0.hits)).toEqual([]);
      // UDP: QUIC retransmits the control's WebTransport Initial after its window closed (same source port, its partition's
      // network context lives on), so only packets from new sources count.
      const seen = new Set(udp.packets.slice(udpStart, c0.udp).map((p) => p.from));
      const fresh = (from: number, to: number) => udp.packets.slice(from, to).filter((p) => !seen.has(p.from));
      // Real server (the production case): nothing at all; its layers' own CSP (connect-src 'none') stops WebTransport.
      expect(fresh(c0.udp, c1.udp)).toEqual([]);
      // CSP-less layers: no WebRTC (STUN/TURN, small packets: the UI window's WebRTC policy). WebTransport's QUIC is not
      // seen by the filter: recorded, a residual only for content without our CSP, which the composition server never
      // serves (preview-filter.ts).
      const naked2 = fresh(c1.udp, c2.udp);
      expect(naked2.filter((p) => p.bytes < 1200)).toEqual([]);
      if (process.env.MS_RENDER_DEBUG) console.info(`[electron] CSP-less layers in the UI window: ${naked2.length} QUIC packet(s); typeof WebTransport in the UI: ${String(find(r.lines, (l) => l.phase === 'real-done').webTransport)}`);
      // The filter does not break the preview: the runtime page and its layers loaded under it.
      const frames = (find(r.lines, (l) => l.phase === 'real-done').frames ?? []) as string[];
      expect(frames).toContain(preview.url);
      expect(frames.some((u) => u.startsWith(server!.origin) && u.includes('/layers/hostile.html'))).toBe(true);
      expect(find(r.lines, (l) => l.phase === 'naked-done').frames as string[]).toContain(`${naked.origin}/${TOKEN}/layers/hostile.html`);
    } finally {
      await server?.close();
      await naked.close();
      await ui.close();
    }
  }, 900_000);

  it('lifecycle: quit closes every render window (renderers end), cancel, time limit, window cap', async () => {
    const creative = join(work, 'life');
    const compDir = join(creative, 'outputs', 'v1', 'compositions', 'life');
    mkdirSync(compDir, { recursive: true });
    const composition = {
      $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: 2, background: '#000000', fonts: [],
      scenes: [{ id: 's', start: 0, duration: 2 }],
      tracks: [{ id: 'bg', kind: 'visual', clips: [{ id: 'bar', type: 'shape', start: 0, duration: 2, props: { x: 0, y: 0, width: 100, height: 100, fill: '#ffffff' } }] }],
    } as unknown as Composition;
    const r = await runHarness({ scenario: 'lifecycle', creative, composition, format: 'life' });
    expect(r.ok, r.output).toBe(true);
    expect(find(r.lines, (l) => l.phase === 'opened')).toMatchObject({ windows: 3, pages: 3, pids: 3 });
    expect(find(r.lines, (l) => l.phase === 'quit')).toEqual({ phase: 'quit', windows: 0, allWindows: 0, alive: 0 });
    expect(find(r.lines, (l) => l.phase === 'cancel')).toEqual({ phase: 'cancel', cancelled: 'cancelled', windows: 0 });
    expect(find(r.lines, (l) => l.phase === 'time')).toMatchObject({ phase: 'time', failure: 'timeLimit', windows: 0, alive: false });
    expect(find(r.lines, (l) => l.phase === 'time').seek).not.toBe('ok');
    expect(find(r.lines, (l) => l.phase === 'cap')).toEqual({ phase: 'cap', refused: 'render: at most 1 render windows at once', windows: 0 });
  }, 900_000);

  it('memory: a 2 GB layer trips the watchdog (memoryLimit) and no window is left', async () => {
    const creative = join(work, 'mem');
    const compDir = join(creative, 'outputs', 'v1', 'compositions', 'mem');
    put(join(compDir, 'layers', 'mem.html'), MEM_LAYER);
    const composition = {
      $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: 1, background: '#000000', fonts: [],
      scenes: [{ id: 's', start: 0, duration: 1 }],
      tracks: [{ id: 'l', kind: 'visual', clips: [{ id: 'l', type: 'html', src: 'layers/mem.html', start: 0, duration: 1, props: { x: 0, y: 0, width: 80, height: 80 } }] }],
    } as unknown as Composition;
    const out = join(creative, 'outputs', 'v1', 'mem.mp4');
    const r = await runHarness({ scenario: 'memory', creative, composition, format: 'mem', out, ffmpeg });
    expect(r.ok, r.output).toBe(true);
    expect(r.lines[0], JSON.stringify(r.lines)).toMatchObject({ result: 'memoryLimit', windowsAfter: 0 });
    expect(existsSync(out)).toBe(false);
  }, 900_000);
});

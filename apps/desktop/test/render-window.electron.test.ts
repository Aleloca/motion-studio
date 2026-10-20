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
 *   the window cap; **memory:** a 2 GB layer trips the watchdog (`memoryLimit`), no window left;
 * - **scale (report 51):** at scale 2 an html layer (out of process) sees devicePixelRatio 2 and its text is as sharp as
 *   the ground truth (the layer twice as large at scale 1), report 38's camera rig too; at 1 and below nothing changes.
 * - **no paint events (decision 1348):** a storyboard (renderFrames) and a parallel render of a layer with its own video, a
 *   CSS animation and a self-running rAF canvas show each frame's own time; the windows stay without paint events.
 *
 * - **raw frames (report 53):** a video's frames are read raw at 1x and 2x and give the same video, byte for byte, as PNG
 *   frames; at 0.5 the PNG frames stay. Measurements (`MS_UI_LOAD=1`): a dialog-like list scrolled while an export runs,
 *   raw against JPEG frames, the cost of each capture on the UI thread.
 * - **raw frames checked (report 56):** the provider's check of raw against PNG frames per scale; every frame of a render
 *   read raw and as PNG from the same state, and a change read raw at once (report 57); the same video under a forced
 *   Display P3 profile; a layer's CSS animation paused while it starts on the compositor shows the paused time.
 *
 * Runs on macOS when the Electron binary is installed; elsewhere (a display is needed) only with MS_REQUIRE_ELECTRON=1,
 * which also makes a missing binary a failure. Needs ffmpeg for the renders.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronDataOutside } from './electron/paths.ts';
import type { Composition } from '../../../packages/shared/src/index.ts';
import { findFfmpeg, type FfmpegInfo } from '@motion-studio/core';
import { countVideoFrames } from '../../../packages/core/src/render/encode.ts';
import { startCompositionServer, type CompositionServer } from '../../../packages/core/src/compositions/composition-server.ts';
import {
  hostileLayer, hostileTrack, hostileWorkerScripts, OWN_FRAME_NAVIGATION_CASES, SELF_NAVIGATION_CASES, selfNavigationLayer,
  selfNavigationPath, selfNavigationTrack, workerTransportProbe, writeHostileLayers,
} from '../../../packages/core/test/helpers/hostile-layers.ts';
import { buildRuntime, decodeStrips, FONT, frameCodedVideo, put, readCode, startCanary, startUdpCanary, type Canary, type UdpCanary } from '../../../packages/core/test/helpers/render-env.ts';
import { barDpr, gradientEnergy, scaleComposition, scaleLayer, TEXT_BOX } from '../../../packages/core/test/helpers/scale-layers.ts';
import { pauseAnimations, settleAnimations } from '../../../packages/composition-runtime/src/layer-agent.ts';

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

/**
 * Report 56: where two videos of the same size differ, frame by frame (decoded to RGB): the frames that differ, each with
 * its differing bytes, largest difference and the box of its differing pixels; at most the first 8.
 */
function videoDiff(a: string, b: string): string {
  const info = /, (\d+)x(\d+)/.exec(spawnSync(ffmpeg!.path, ['-hide_banner', '-i', a], { encoding: 'utf8' }).stderr);
  if (!info) return 'unreadable';
  const [w, h] = [Number(info[1]), Number(info[2])];
  const rgb = (f: string) => execFileSync(ffmpeg!.path, ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  const [x, y] = [rgb(a), rgb(b)];
  const size = w * h * 3;
  const frames: string[] = [];
  for (let i = 0; i * size < Math.min(x.length, y.length); i++) {
    let n = 0, max = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let k = i * size; k < (i + 1) * size; k++) {
      const d = Math.abs(x[k]! - y[k]!);
      if (!d) continue;
      n++; max = Math.max(max, d);
      const p = Math.floor((k - i * size) / 3);
      x0 = Math.min(x0, p % w); x1 = Math.max(x1, p % w); y0 = Math.min(y0, Math.floor(p / w)); y1 = Math.max(y1, Math.floor(p / w));
    }
    if (n) frames.push(`frame ${i}: ${n} bytes, max ${max}, box ${x0},${y0}-${x1},${y1}`);
  }
  return `${frames.length} frames differ (${x.length} / ${y.length} bytes); ${frames.slice(0, 8).join('; ')}`;
}

const OUTRO_LAYER = `<!doctype html><html><body style="margin:0"><canvas id="c" width="100" height="100"></canvas><script>
const g = document.getElementById('c').getContext('2d');
window.msReady = Promise.resolve();
window.msSeek = (t) => { g.fillStyle = '#000'; g.fillRect(0, 0, 100, 100); g.fillStyle = '#ffcc00'; g.fillRect(0, 0, Math.round(100 * Math.min(1, t / 2)), 100); };
</script></body></html>`;

/**
 * Decision 1348's checks: a layer with its own `<video>` (a frame-coded one, sought by the layer and drawn into a canvas on
 * `seeked`), a CSS animation (a box moving 100 px a second) and a self-running rAF canvas (a bar growing 100 px a
 * second, from the layer's virtual `performance.now`). Every frame must show its own time.
 */
const MOTION_LAYER = `<!doctype html><html><head><style>html,body{margin:0;background:#000;overflow:hidden}
#v{position:absolute;left:0;top:0;width:64px;height:32px;opacity:0}#vc{position:absolute;left:0;top:0}
#css{position:absolute;left:0;top:80px;width:20px;height:20px;background:#fff;animation:go 2s linear forwards}
@keyframes go{from{transform:translateX(0)}to{transform:translateX(200px)}}#raf{position:absolute;left:0;top:120px}
</style></head><body><video id="v" src="../assets/v.mp4" muted playsinline preload="auto"></video><canvas id="vc" width="64" height="32"></canvas>
<div id="css"></div><canvas id="raf" width="320" height="20"></canvas><script>
const v = document.getElementById('v'), vg = document.getElementById('vc').getContext('2d'), rg = document.getElementById('raf').getContext('2d');
const loop = () => { rg.clearRect(0, 0, 320, 20); rg.fillStyle = '#fff'; rg.fillRect(0, 0, Math.round(performance.now() / 10), 20); requestAnimationFrame(loop); };
requestAnimationFrame(loop);
window.msReady = new Promise((r) => { if (v.readyState >= 2) r(); else v.addEventListener('loadeddata', () => r(), { once: true }); });
window.msSeek = (t) => new Promise((resolve) => {
  const draw = () => { vg.drawImage(v, 0, 0, 64, 32); resolve(); };
  const at = (Math.round(t * 30) + 0.5) / 30;
  if (Math.abs(v.currentTime - at) < 1e-6 && !v.seeking) { draw(); return; }
  v.addEventListener('seeked', draw, { once: true });
  v.currentTime = at;
});
</script></body></html>`;

/** A layer that allocates 2 GB of ArrayBuffers once seeked past 0.1 s (as in the core's process test). */
const MEM_LAYER = `<!doctype html><html><body><script>
window.msReady = Promise.resolve();
const keep = [];
window.msSeek = (t) => { if (t >= 0.1 && keep.length === 0) { for (let i = 0; i < 32; i++) { const a = new Uint8Array(64 * 1024 * 1024); for (let j = 0; j < a.length; j += 4) a[j] = (j * 2654435761) & 255; keep.push(a); } } };
</script></body></html>`;

/** Report 53: a full-frame canvas of moving gradients and text, at the page's devicePixelRatio (large PNG frames). */
const HEAVY_LAYER = `<!doctype html><html><head><style>html,body{margin:0;background:#000;overflow:hidden}canvas{width:100vw;height:100vh;display:block}</style></head>
<body><canvas id="c"></canvas><script>
const c = document.getElementById('c'), g = c.getContext('2d');
window.msReady = Promise.resolve();
window.msSeek = (t) => {
  const w = c.width = Math.round(innerWidth * devicePixelRatio), h = c.height = Math.round(innerHeight * devicePixelRatio);
  for (let i = 0; i < 6; i++) {
    const x = w * (0.5 + 0.4 * Math.sin(t * (0.7 + i * 0.3) + i)), y = h * (0.5 + 0.4 * Math.cos(t * (0.5 + i * 0.2) + i * 2));
    const gr = g.createRadialGradient(x, y, 0, x, y, w * 0.6);
    gr.addColorStop(0, 'hsla(' + ((i * 60 + t * 40) % 360) + ',80%,60%,0.9)'); gr.addColorStop(1, 'hsla(' + ((i * 60 + 180) % 360) + ',70%,20%,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }
  g.fillStyle = '#fff'; g.font = (18 * devicePixelRatio) + 'px sans-serif';
  for (let l = 0; l < 40; l++) g.fillText('Motion Studio export ' + l + ' · t = ' + t.toFixed(3) + ' · the quick brown fox jumps over the lazy dog', 40 * devicePixelRatio + 30 * Math.sin(t + l), (30 + l * 26) * devicePixelRatio);
};
</script></body></html>`;

/** The opaque self-navigations (I1): a layer that navigates its own frame to a `data:` or a `blob:` document that fetches. */
const OPAQUE_NAVIGATION_CASES = ['data', 'blob'] as const;
const opaqueNavigationPath = (k: (typeof OPAQUE_NAVIGATION_CASES)[number]) => `/selfnav-${k}-fetch`;
function opaqueNavigationLayer(canary: string, k: (typeof OPAQUE_NAVIGATION_CASES)[number]): string {
  const inner = `<!doctype html><script>fetch(${JSON.stringify(canary + opaqueNavigationPath(k))}).catch(() => {});</script>`;
  const html = JSON.stringify(inner).replace(/<\//g, '<\\/');
  const go = k === 'data'
    ? `location.href = 'data:text/html,' + encodeURIComponent(${html});`
    : `location.href = URL.createObjectURL(new Blob([${html}], { type: 'text/html' }));`;
  return `<!doctype html><html><body><script>window.msReady = Promise.resolve(); setTimeout(() => { ${go} }, 100);</script></body></html>`;
}

/**
 * N4: two frames of the UI on the CSP-less server, NOT sandboxed (so not opaque). A navigates its sibling B
 * (`ms-inherit-b`) to about:blank: B's document inherits A's origin, so A can then call B's own fetch. B's frame chain is
 * then [about:blank, app]: the request must be charged to A's origin (the initiator), not to the app.
 */
const INHERIT_PATH = '/inherit-fetch';
const inheritLayerA = (canary: string) => `<!doctype html><html><body><script>
setTimeout(() => {
  try {
    const b = parent['ms-inherit-b'];
    b.location.href = 'about:blank';
    setTimeout(() => { try { b.fetch(${JSON.stringify(canary + INHERIT_PATH)}).catch(() => {}); } catch (e) {} }, 800);
  } catch (e) {}
}, 300);
</script></body></html>`;
const INHERIT_LAYER_B = '<!doctype html><html><body>b</body></html>';

/** A server WITHOUT any CSP: `/<token>/page.html` starts workers and frames every hostile and self-navigating layer. */
async function nakedServer(canary: string, udpPort: number): Promise<{ origin: string; close(): Promise<void> }> {
  const layers: Record<string, string> = { hostile: hostileLayer(canary, udpPort) };
  for (const c of SELF_NAVIGATION_CASES) layers[`selfnav-${c}`] = selfNavigationLayer(canary, c);
  for (const k of OPAQUE_NAVIGATION_CASES) layers[`selfnav-${k}`] = opaqueNavigationLayer(canary, k);
  const scripts = hostileWorkerScripts(canary);
  const framed = Object.keys(layers);
  layers['inherit-a'] = inheritLayerA(canary);
  layers['inherit-b'] = INHERIT_LAYER_B;
  const page = `<!doctype html><html><body>${framed.map((k) => `<iframe sandbox="allow-scripts" src="/${TOKEN}/layers/${k}.html"></iframe>`).join('')}
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
/** A frame of a UI-like page: sandboxed (`allow-scripts`, as the UI frames the preview) unless said otherwise. */
type UiFrame = string | { src: string; name?: string; sandbox?: boolean };

async function uiServer(): Promise<{ origin: string; setPage(name: string, urls: UiFrame[]): void; probeHits: string[]; close(): Promise<void> }> {
  const pages = new Map<string, UiFrame[]>();
  const probeHits: string[] = [];
  const s: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    // The app's own port framed by the UI (the core's port in the app): recorded, it must never load under the filter.
    if (path.startsWith('/probe-')) { probeHits.push(path); res.writeHead(200, { 'content-type': 'text/html' }); res.end('probe'); return; }
    const frames = pages.get(path.replace(/^\/|\.html$/g, ''));
    if (frames) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const tag = (f: UiFrame) => {
        const o = typeof f === 'string' ? { src: f } : f;
        return `<iframe ${o.sandbox === false ? '' : 'sandbox="allow-scripts" '}${o.name ? `name="${o.name}" ` : ''}src="${o.src}" width="320" height="180"></iframe>`;
      };
      res.end(`<!doctype html><html><body>${frames.map(tag).join('')}</body></html>`);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return {
    origin: `http://127.0.0.1:${(s.address() as { port: number }).port}`,
    setPage: (name, urls) => { pages.set(name, urls); }, probeHits,
    close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }),
  };
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
      // Its own process group (detached): the test kills only that group, which it created, never by pattern or marker.
      const child = spawn(electronPath!, ['--use-mock-keychain', '--password-store=basic', harness], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      const pgid = child.pid!;
      const groupAlive = () => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
      // Only while the group is known to be ours: its leader still runs (the timers below, cleared on exit), or members are
      // still alive (a live group's id cannot be reused). Never after it may be gone.
      const killGroup = () => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* the group is gone */ } };
      let doneTimer: NodeJS.Timeout | null = null;
      const lines: Array<Record<string, unknown>> = [];
      let killedAfterDone = false;
      let badPaths: string[] | null = null;
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
            // Final wave B2: the first report is the effective data folders. Logged; under the scratch folder, the harness
            // is told to go; anywhere else its own process group (this spawn's) is stopped before it does anything.
            if (o.phase === 'paths') {
              console.info(`[electron] pid ${String(o.pid)} userData ${String(o.userData)}`);
              const bad = electronDataOutside(o, scratch);
              if (bad.length === 0 && o.pid === child.pid) child.stdin.write('go\n');
              else { badPaths = bad.length ? bad : ['pid']; killGroup(); }
              continue;
            }
            lines.push(o);
            onLine?.(o);
            // Finished. On this very loaded machine Electron's own shutdown took from seconds to minutes (its helpers
            // starved of CPU): after 2 minutes it is killed, and the run still counts as finished.
            if (o.done && !doneTimer) doneTimer = setTimeout(() => { killedAfterDone = true; killGroup(); }, 120_000);
          }
        }
      });
      child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
      const timer = setTimeout(killGroup, timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (doneTimer) clearTimeout(doneTimer);
        // Helpers of that Electron still in its group (a starved renderer that has not noticed the exit yet) end now:
        // only when the group still has members (so its id is still ours).
        const left = groupAlive();
        if (left) killGroup();
        rmSync(configDir, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        const done = lines.some((l) => l.done === true);
        if (process.env.MS_RENDER_DEBUG) console.info(`[electron] exit ${String(code)}${killedAfterDone ? ' (group killed 2 min after done)' : ''}${left ? ', helpers left in its group: killed' : ''}`);
        if (badPaths) output += `\nElectron data outside the scratch folder: ${badPaths.join(', ')}`;
        resolve({ ok: !badPaths && done && (code === 0 || killedAfterDone), code, lines, output: output.slice(-4000) });
      });
    });
  }

  const find = (lines: Array<Record<string, unknown>>, pred: (o: Record<string, unknown>) => boolean) => lines.find(pred) ?? {};

  it('window options: hidden, offscreen, sandboxed, no preload/Node, own in-memory partition with the dead proxy; closed windows are gone', async () => {
    const r = await runHarness({ scenario: 'options' });
    expect(r.ok, r.output).toBe(true);
    const o = r.lines[0]!;
    expect(o.prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, preload: null, webviewTag: false });
    expect(o).toMatchObject({ visible: false, offscreen: true, painting: false, persistent: false, separate: true, webrtc: 'disable_non_proxied_udp', keptAwake: true, windowsOpen: 1 });
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
      // The control ran the page's service worker (on the same prefix); the locked session refused its script. Both counts are
      // the most running at once over the window's life; a failure shows the worker's registration and status timeline.
      const controlSw = find(r.lines, (l) => l.phase === 'control-sw');
      expect(controlSw.serviceWorkers, `control service workers: ${JSON.stringify(controlSw)}`).toBeGreaterThan(0);
      expect(locked.serviceWorkers, `render window service workers: ${JSON.stringify(locked)}`).toBe(0);
      expect(locked.swEvents, 'no service worker registered or started in the render window').toEqual([]);
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

  it('report 53: a video\'s frames are read raw (no encode on the UI thread) and give the same video as PNG frames (1x, 2x, 4/3, transparent background); not below 1', async () => {
    const creative = join(work, 'raw');
    const compDir = join(creative, 'outputs', 'v1', 'compositions', 'spike');
    frameCodedVideo(ffmpeg!, join(compDir, 'assets', 'v.mp4'), { fps: 30, frames: 95 });
    put(join(compDir, 'layers', 'outro.html'), OUTRO_LAYER);
    put(join(compDir, 'assets', 'mono.woff2'), readFileSync(FONT));
    // 1x, 2x (a layer at the window's scale, decision 1341) and 0.5 (the page's override only: no raw frames there).
    const rawRuns = [{ name: '1x-raw' }, { name: '1x-png', encoded: true }, { name: '2x-raw', short: 360 }, { name: '2x-png', short: 360, encoded: true }, { name: 'half', short: 90 },
      // A scale that is not an integer (4/3: the user's 2560 × 1440 of a 1080p composition), and a transparent background.
      { name: '43-raw', short: 240 }, { name: '43-png', short: 240, encoded: true },
      { name: 'clear-raw', background: '#00000000' }, { name: 'clear-png', background: '#00000000', encoded: true }];
    const out = join(work, 'raw-out');
    mkdirSync(out, { recursive: true });
    const r = await runHarness({ scenario: 'raw-render', creative, composition: spikeComposition(), format: 'spike', ffmpeg, rawRuns, out });
    expect(r.ok, r.output).toBe(true);
    // Report 56: the provider checked raw frames against PNG frames once per scale, before reading them.
    const checks = find(r.lines, (l) => 'rawChecks' in l).rawChecks as Record<string, { same: boolean }>;
    console.info(`[raw] checks: ${JSON.stringify(checks)}`);
    // 1x, 2x, and 4/3 (its page scale is 426 / 320: the even width it is captured at).
    expect(Object.keys(checks)).toHaveLength(3);
    for (const [k, c] of Object.entries(checks)) expect(c, `check at ${k}`).toMatchObject({ same: true, differing: 0, opaque: true });
    const by = Object.fromEntries(r.lines.filter((l) => typeof l.raw === 'string').map((l) => [l.raw, l])) as Record<string, { frames: number; width: number; height: number; sha256: string; rawFrames: number; encodedFrames: number; windowsAfter: number }>;
    expect(by['1x-raw']).toMatchObject({ frames: 60, width: W, height: H, rawFrames: 60, encodedFrames: 0, windowsAfter: 0 });
    expect(by['1x-png']).toMatchObject({ frames: 60, rawFrames: 0, encodedFrames: 60 });
    expect(by['2x-raw']).toMatchObject({ frames: 60, width: 2 * W, height: 2 * H, rawFrames: 60, encodedFrames: 0 });
    // The PNG frames are lossless: the same pixels, so the same video, byte for byte. A difference names its frames.
    const same = (a: string, b: string) => expect(by[a]!.sha256, by[a]!.sha256 === by[b]!.sha256 ? '' : `${a} against ${b}: ${videoDiff(join(out, `${a}.mp4`), join(out, `${b}.mp4`))}`).toBe(by[b]!.sha256);
    same('1x-raw', '1x-png');
    same('2x-raw', '2x-png');
    expect(by['43-raw']).toMatchObject({ frames: 60, height: 240, rawFrames: 60, encodedFrames: 0 });
    same('43-raw', '43-png');
    expect(by['clear-raw']).toMatchObject({ frames: 60, rawFrames: 60, encodedFrames: 0 });
    same('clear-raw', 'clear-png');
    expect(by.half).toMatchObject({ frames: 60, width: W / 2, height: H / 2, rawFrames: 0, encodedFrames: 60, windowsAfter: 0 });
  }, 900_000);

  it('report 56: raw frames are the PNG frames of the same state, every frame, and show a change made just before the read (report 57)', async (ctx) => {
    const creative = join(work, 'raw-check');
    const compDir = join(creative, 'outputs', 'v1', 'compositions', 'spike');
    frameCodedVideo(ffmpeg!, join(compDir, 'assets', 'v.mp4'), { fps: 30, frames: 95 });
    put(join(compDir, 'layers', 'outro.html'), OUTRO_LAYER);
    put(join(compDir, 'assets', 'mono.woff2'), readFileSync(FONT));
    const times = Array.from({ length: 60 }, (_, i) => i / 30);
    const r = await runHarness({ scenario: 'raw-check', creative, composition: spikeComposition(), format: 'spike', rawCheck: { times, changes: 30 } });
    expect(r.ok, r.output).toBe(true);
    const rows = (r.lines[0] as { rawCheck: Array<{ t: number; raw: { sizes: boolean; differing: number }; again: { differing: number } }> }).rawCheck;
    expect(rows).toHaveLength(60);
    // A difference in the first read is a frame from before the seek's (the CI runner's, report 57); in the second, after
    // the PNG's own redraw, a difference in the pixels themselves.
    const changes = (r.lines[0] as { changes: Array<{ i: number; mode: 'plain' | 'fresh'; want: number[]; got: number[] }>; gpu: number | null }).changes;
    const missedBy = (mode: string) => changes.filter((x) => x.mode === mode && x.want.some((v, k) => Math.abs(v - x.got[k]!) > 1));
    const [plain, fresh] = [missedBy('plain'), missedBy('fresh')];
    console.info(`[raw-check] a change read raw at once, the GPU process stalled: plain (no redraw) ${plain.length}/30 missed, fresh ${fresh.length}/30 ${JSON.stringify(fresh.slice(0, 3))}`);
    console.info(`[raw-check] stale ${rows.filter((x) => x.raw.differing > 0).length}/60 ${JSON.stringify(rows.filter((x) => x.raw.differing > 0).map((x) => [x.t, x.raw.differing]))}; again ${rows.filter((x) => x.again.differing > 0).length}`);
    expect(rows.filter((x) => !x.raw.sizes || x.raw.differing > 0), 'raw read as the seek ends').toEqual([]);
    expect(rows.filter((x) => x.again.differing > 0), 'raw read after the PNG').toEqual([]);
    // Report 57: a raw read is of a frame drawn after it was asked for (the CI runner read one from before the seek's).
    expect((r.lines[0] as { gpu: number | null }).gpu, 'the GPU process').toBeGreaterThan(0);
    expect(changes).toHaveLength(60);
    if (plain.length === 0) {
      // The negative control missed nothing: the lag is not reproduced on this machine, so the fresh reads prove nothing.
      console.warn('[raw-check] skipped: reads without the redraw missed no change (the compositor lag is not reproduced here)');
      ctx.skip();
    }
    expect(fresh, 'a raw read missed a change made just before it').toEqual([]);
  }, 900_000);

  it('report 56: under a forced Display P3 colour profile raw and PNG frames still give the same video, and the sRGB one', async () => {
    // A machine whose display is not sRGB (the CI runner's virtual display, a wide-gamut screen): the render windows are
    // offscreen, so neither capture is colour-managed for the display.
    const creative = join(work, 'raw-p3');
    const compDir = join(creative, 'outputs', 'v1', 'compositions', 'spike');
    frameCodedVideo(ffmpeg!, join(compDir, 'assets', 'v.mp4'), { fps: 30, frames: 95 });
    put(join(compDir, 'layers', 'outro.html'), OUTRO_LAYER);
    put(join(compDir, 'assets', 'mono.woff2'), readFileSync(FONT));
    const rawRuns = [{ name: '1x-raw' }, { name: '1x-png', encoded: true }];
    const run = async (switches: Record<string, string>) => {
      const r = await runHarness({ scenario: 'raw-render', creative, composition: spikeComposition(), format: 'spike', ffmpeg, rawRuns, switches });
      expect(r.ok, r.output).toBe(true);
      const by = Object.fromEntries(r.lines.filter((l) => typeof l.raw === 'string').map((l) => [l.raw, l])) as Record<string, { sha256: string; rawFrames: number }>;
      expect(by['1x-raw']!.rawFrames).toBe(60);
      return by;
    };
    const srgb = await run({ 'force-color-profile': 'srgb' });
    const p3 = await run({ 'force-color-profile': 'display-p3-d65' });
    expect(p3['1x-raw']!.sha256).toBe(p3['1x-png']!.sha256);
    expect(srgb['1x-raw']!.sha256).toBe(srgb['1x-png']!.sha256);
    expect(p3['1x-png']!.sha256).toBe(srgb['1x-png']!.sha256);
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
    // getDisplayMedia, asked with a user gesture: the session refuses it cleanly (callback(null)), nothing throws.
    expect(r.lines[0]!.displayMedia).toBe('NotAllowedError');
    expect(find(r.lines, (l) => 'windowsAfter' in l)).toEqual({ windowsAfter: 0 });
    expect(canary.hits.slice(start)).toEqual([]);
    expect(udp.packets.slice(udpStart)).toEqual([]);
  }, 900_000);

  it('preview filter alone (no will-frame-navigate guard): the UI framing the preview and the layers directly, data:/blob: self-navigation, about:blank inheritance, the core and a random port; the control leaks, the UI window reaches nothing', async () => {
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
      // Probes (I2): the UI framing the app's own port (the core's, in the app) and another loopback port (the canary's).
      const probes = [`${ui.origin}/probe-app`, `${canary.origin}/probe-random`];
      const real = [preview.url, ...names.map(layer), ...probes];
      // data: and blob: self-navigation (I1), from layers without any CSP (the filter alone).
      const nakedFrames = [...names, ...OPAQUE_NAVIGATION_CASES.map((k) => `selfnav-${k}`)].map((n) => `${naked.origin}/${TOKEN}/layers/${n}.html`);
      // N4: non-sandboxed CSP-less frames, one navigating the other to about:blank and fetching through it.
      const inherit: UiFrame[] = [
        { src: `${naked.origin}/${TOKEN}/layers/inherit-a.html`, sandbox: false },
        { src: `${naked.origin}/${TOKEN}/layers/inherit-b.html`, name: 'ms-inherit-b', sandbox: false },
      ];
      ui.setPage('all', [...real, ...nakedFrames, ...inherit]);
      ui.setPage('real', real);
      ui.setPage('naked', nakedFrames);
      ui.setPage('inherit', inherit);
      const start = canary.hits.length;
      const udpStart = udp.packets.length;
      const cuts: Record<string, { hits: number; udp: number; probes: number }> = {};
      const r = await runHarness({ scenario: 'preview', ui: {
        origin: ui.origin, all: `${ui.origin}/all.html`, real: `${ui.origin}/real.html`, naked: `${ui.origin}/naked.html`, inherit: `${ui.origin}/inherit.html`,
        realComposition: server.origin, nakedComposition: naked.origin,
      } }, (l) => {
        if (typeof l.phase === 'string') cuts[l.phase] = { hits: canary.hits.length, udp: udp.packets.length, probes: ui.probeHits.length };
      });
      expect(r.ok, r.output).toBe(true);
      const c0 = cuts['control-done']!, c1 = cuts['real-done']!, c2 = cuts['naked-done']!;
      // Control (no filter): the directly framed layers navigate themselves to the canary, the CSP-less one fetches it.
      const control = canary.hits.slice(start, c0.hits);
      for (const c of OWN_FRAME_NAVIGATION_CASES) expect(control, `control ${c}`).toContain(selfNavigationPath(c));
      expect(control, 'control fetch').toContain('/fetch');
      for (const k of OPAQUE_NAVIGATION_CASES) expect(control, `control ${k}: self-navigation`).toContain(opaqueNavigationPath(k));
      expect(control, 'control: a random port framed by the UI').toContain('/probe-random');
      expect(control, 'control: fetch through a sibling navigated to about:blank (N4)').toContain(INHERIT_PATH);
      expect(ui.probeHits.slice(0, c0.probes), "control: the app's own port framed by the UI").toContain('/probe-app');
      // The UI window: neither the core's port nor a random one is ever framed.
      expect(ui.probeHits.slice(c0.probes)).toEqual([]);
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
      // N4 really ran under the filter: B was navigated to about:blank (and its fetch, above, reached nothing).
      expect(find(r.lines, (l) => l.phase === 'inherit-done').frames as string[]).toContain('about:blank');
    } finally {
      await server?.close();
      await naked.close();
      await ui.close();
    }
  }, 900_000);

  it('lifecycle: closeAllRenderWindows closes every render window (renderers end), cancel, time limit, window cap', async () => {
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

  it('quit during a render (M1): the quit sequence cancels the render first, then no window, no output, no temp file, no work folder', async () => {
    const creative = join(work, 'quit');
    const compDir = join(creative, 'outputs', 'v1', 'compositions', 'quit');
    put(join(compDir, 'layers', 'outro.html'), OUTRO_LAYER);
    const D = 10;
    const composition = {
      $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: D, background: '#101010', fonts: [],
      scenes: [{ id: 's', start: 0, duration: D }],
      tracks: [
        { id: 'bg', kind: 'visual', clips: [{ id: 'bar', type: 'shape', start: 0, duration: D, props: { x: 0, y: 140, width: W, height: 40, fill: '#2060c0' }, animations: [{ preset: 'fadeIn', duration: 1 }] }] },
        { id: 'layer', kind: 'visual', clips: [{ id: 'outro', type: 'html', src: 'layers/outro.html', start: 0, duration: D, props: { x: 200, y: 20, width: 100, height: 100 } }] },
      ],
    } as unknown as Composition;
    const out = join(creative, 'outputs', 'v1', 'quit.mp4');
    const r = await runHarness({ scenario: 'quit', creative, composition, format: 'quit', out, ffmpeg });
    expect(r.ok, r.output).toBe(true);
    const q = find(r.lines, (l) => l.phase === 'quit');
    expect(q.windowsBefore, JSON.stringify(q)).toBeGreaterThan(0);
    expect(q).toMatchObject({ result: 'cancelled', windows: 0, allWindows: 0, out: false, temps: [], workDirs: [] });
    expect(existsSync(out)).toBe(false);
  }, 900_000);

  it('report 51: at scale 2 an html layer, still out of process, sees devicePixelRatio 2 and its text is as sharp as the ground truth; 1x unchanged', async () => {
    const creative = join(work, 'scale');
    const layers = { text: scaleLayer(), truth: scaleLayer(2), rig: scaleLayer(1, true), 'rig-truth': scaleLayer(2, true) };
    for (const [id, html] of Object.entries(layers)) {
      const dir = join(creative, 'outputs', 'v1', 'compositions', id);
      put(join(dir, 'assets', 'Mono.woff2'), readFileSync(FONT));
      put(join(dir, 'layers', `${id}.html`), html);
    }
    const pages = [
      { name: 'scaled', composition: scaleComposition('text'), format: 'text', scale: 2 },
      { name: 'truth', composition: scaleComposition('truth', 2), format: 'truth' },
      { name: 'plain', composition: scaleComposition('text'), format: 'text' },
      { name: 'one', composition: scaleComposition('text'), format: 'text', scale: 1 },
      { name: 'rig', composition: scaleComposition('rig'), format: 'rig', scale: 2, t: 1 },
      { name: 'rig-truth', composition: scaleComposition('rig-truth', 2), format: 'rig-truth', t: 1 },
      // The user's case: 1920 × 1080 exported at 2560 × 1440.
      { name: 'third', composition: scaleComposition('text'), format: 'text', scale: 4 / 3 },
      // Below 1 (a 720p export of a 1080p composition): as before, the layer at 1x and the page shrinking it (decision 1346).
      { name: 'half', composition: scaleComposition('text'), format: 'text', scale: 0.5 },
    ];
    /** The capture size each page must have: its composition at its scale. */
    const sizeOf = (name: string) => { const p = pages.find((x) => x.name === name)!; const k = p.scale ?? 1; return { width: Math.round(p.composition.width * k), height: Math.round(p.composition.height * k) }; };
    const r = await runHarness({ scenario: 'scale', creative, scalePages: pages });
    expect(r.ok, r.output).toBe(true);
    const got: Record<string, { energy: number; bar: number; width: number; layers: unknown; top: unknown; errors: unknown }> = {};
    for (const l of r.lines.filter((x) => typeof x.page === 'string')) {
      const file = join(work, `scale-${String(l.page)}.png`);
      writeFileSync(file, Buffer.from(String(l.png), 'base64'));
      const px = new Uint8Array(execFileSync(ffmpeg!.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 }));
      const { width, height } = sizeOf(String(l.page));
      expect(px.length, String(l.page)).toBe(width * height);
      const k = width / 320;
      got[String(l.page)] = { energy: gradientEnergy(px, width, TEXT_BOX, k), bar: barDpr(px, width, k), width, layers: l.layers, top: l.top, errors: l.errors };
    }
    const ratio = (a: string, b: string) => got[a]!.energy / got[b]!.energy;
    console.info(`[scale] electron text energy at scale 2: ${got.scaled?.energy.toFixed(1)}, ground truth ${got.truth?.energy.toFixed(1)}, ratio ${ratio('scaled', 'truth').toFixed(3)}; rig ${ratio('rig', 'rig-truth').toFixed(3)}`);
    for (const p of pages) expect(got[p.name]?.errors, p.name).toBe(0);
    for (const l of r.lines.filter((x) => typeof x.page === 'string')) expect(l.painting, `painting ${String(l.page)}`).toBe(false);
    expect(got.scaled!.layers).toEqual([{ outOfProcess: true, dpr: 2, inner: [320, 180] }]);
    expect(got.scaled!.top).toEqual({ dpr: 2, inner: [320, 180] });
    expect(got.scaled!.bar).toBe(2);
    expect(ratio('scaled', 'truth')).toBeGreaterThan(0.9);
    expect(ratio('rig', 'rig-truth')).toBeGreaterThan(0.9);
    expect((got.third!.layers as Array<{ dpr: number }>)[0]!.dpr).toBeCloseTo(4 / 3, 5);
    expect(got.half!.layers).toEqual([{ outOfProcess: true, dpr: 1, inner: [320, 180] }]);
    expect(got.half!.top).toEqual({ dpr: 0.5, inner: [320, 180] });
    expect(got.half!.bar).toBe(1);
    // At 1 (stills, previews, a render at the composition size): as before.
    for (const name of ['plain', 'one']) {
      expect(got[name]!.layers, name).toEqual([{ outOfProcess: true, dpr: 1, inner: [320, 180] }]);
      expect(got[name]!.bar, name).toBe(1);
    }
  }, 900_000);

  /** The motion composition (decision 1348): 2 s at 30 fps, the motion layer over the whole frame. */
  const motion = (name: string) => {
    const creative = join(work, name);
    const compDir = join(creative, 'outputs', 'v1', 'compositions', 'motion');
    frameCodedVideo(ffmpeg!, join(compDir, 'assets', 'v.mp4'), { fps: 30, frames: 70 });
    put(join(compDir, 'layers', 'motion.html'), MOTION_LAYER);
    const composition = {
      $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: 2, background: '#000000', fonts: [],
      scenes: [{ id: 's', start: 0, duration: 2 }],
      tracks: [{ id: 'l', kind: 'visual', clips: [{ id: 'm', type: 'html', src: 'layers/motion.html', start: 0, duration: 2, props: { x: 0, y: 0, width: W, height: H } }] }],
    } as unknown as Composition;
    return { creative, composition };
  };
  /** Where the motion layer's parts are in a grey frame `width` wide (k = width / W): the video code, the CSS box's left edge, the bar's width. */
  const readMotion = (px: Uint8Array, width: number) => {
    const k = width / W;
    const row = (y: number) => Array.from({ length: width }, (_, x) => px[Math.round(y * k) * width + x]!);
    const avg = (x0: number, x1: number) => { let s = 0, n = 0; for (let y = 4; y < 28; y++) for (let x = x0; x < x1; x++) { s += px[Math.round(y * k) * width + Math.round(x * k)]!; n++; } return s / n; };
    const box = row(90).findIndex((g) => g > 128);
    return { code: readCode(new Uint8Array([avg(4, 28), avg(36, 60)])), box: box < 0 ? -1 : Math.round(box / k), bar: Math.round(row(130).filter((g) => g > 128).length / k) };
  };

  it('decision 1348: a storyboard (renderFrames, purpose frames, half size) shows each time: the layer\'s video, CSS and rAF animations', async () => {
    const { creative, composition } = motion('frames');
    const times = [0, 0.5, 1, 1.5];
    const r = await runHarness({ scenario: 'frames', creative, composition, format: 'motion', frames: { times, width: W / 2 } });
    expect(r.ok, r.output).toBe(true);
    const res = r.lines[0]! as { errors: unknown[]; frames: Array<{ t: number; width: number; height: number; png: string }>; windowsAfter: number };
    expect(res.errors, JSON.stringify(res.errors)).toEqual([]);
    expect(res.windowsAfter).toBe(0);
    const seen = res.frames.map((f, i) => {
      expect([f.width, f.height]).toEqual([W / 2, H / 2]);
      const file = join(work, `frames-${i}.png`);
      writeFileSync(file, Buffer.from(f.png, 'base64'));
      return readMotion(new Uint8Array(execFileSync(ffmpeg!.path, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])), W / 2);
    });
    console.info(`[motion] storyboard: ${JSON.stringify(seen)}`);
    times.forEach((t, i) => {
      expect(seen[i]!.code, `video at ${t}`).toBe(Math.round(t * 30) + 1);
      expect(Math.abs(seen[i]!.box - 100 * t), `css at ${t}`).toBeLessThanOrEqual(3);
      expect(Math.abs(seen[i]!.bar - 100 * t), `raf at ${t}`).toBeLessThanOrEqual(3);
    });
  }, 900_000);

  it('report 56: a CSS animation paused while it starts on the compositor shows the paused time once settled (the storyboard\'s first frame)', async (ctx) => {
    // The layer agent's own functions, in a page whose CSS animation starts on load and is paused at 0 right after it.
    const runs = 15;
    const r = await runHarness({ scenario: 'css-pause', cssPause: { runs, pause: pauseAnimations.toString(), settle: settleAnimations.toString() } });
    expect(r.ok, r.output).toBe(true);
    const rows = (r.lines[0] as { cssPause: Array<{ mode: 'plain' | 'settled'; pending: boolean; box: number }> }).cssPause;
    const of = (mode: string) => rows.filter((x) => x.mode === mode);
    const off = (mode: string) => of(mode).filter((x) => x.box !== 0);
    // Without settling, Chromium leaves the compositor's value of the frames it ran (logged: a Chromium behaviour, not ours).
    console.info(`[css-pause] plain: ${of('plain').filter((x) => x.pending).length}/${runs} paused while play-pending, ${off('plain').length} off on screen ${JSON.stringify(off('plain').map((x) => x.box))}; `
      + `settled: ${of('settled').filter((x) => x.pending).length}/${runs} play-pending, ${off('settled').length} off`);
    if (!of('settled').some((x) => x.pending)) {
      // Nothing to prove on this machine: every pause landed after the animation had started on the compositor.
      console.warn('[css-pause] skipped: no pause landed while the animation was play-pending');
      ctx.skip();
    }
    expect(off('settled'), JSON.stringify(of('settled'))).toEqual([]);
  }, 900_000);

  it('decision 1348: a render (parallel windows) of a layer with its own video, a CSS animation and a self-running canvas advances every frame', async () => {
    const { creative, composition } = motion('motion');
    const out = join(creative, 'outputs', 'v1', 'motion.mp4');
    const r = await runHarness({ scenario: 'render', creative, composition, format: 'motion', out, ffmpeg, parallel: 2 });
    expect(r.ok, r.output).toBe(true);
    expect(r.lines[0]).toMatchObject({ ok: true, frames: 60, windowsAfter: 0 });
    const raw = execFileSync(ffmpeg!.path, ['-v', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
    const seen = Array.from({ length: 60 }, (_, i) => readMotion(new Uint8Array(raw.subarray(i * W * H, (i + 1) * W * H)), W));
    const off = (f: (s: (typeof seen)[number], i: number) => number) => seen.map(f);
    const codes = off((s, i) => s.code - (i + 1)), css = off((s, i) => s.box - (100 * i) / 30), raf = off((s, i) => s.bar - (100 * i) / 30);
    console.info(`[motion] render: codes off ${JSON.stringify(codes)}; css off max ${Math.max(...css.map(Math.abs)).toFixed(1)}; raf off max ${Math.max(...raf.map(Math.abs)).toFixed(1)}`);
    expect(codes.every((d) => Math.abs(d) <= 1), JSON.stringify(codes)).toBe(true);
    expect(codes.filter((d) => d === 0).length).toBeGreaterThanOrEqual(54);
    expect(css.every((d) => Math.abs(d) <= 3), JSON.stringify(css)).toBe(true);
    expect(raf.every((d) => Math.abs(d) <= 3), JSON.stringify(raf)).toBe(true);
  }, 900_000);

  // Decision 1348, a measurement (MS_RENDER_COST=1): a 10 s 1920 × 1080 composition with a moving html layer, default parallel
  // pages, at 1x and at 2560 × 1440, with the paint events (as before 1348, and at 5 fps) and without. Logged, not asserted.
  it.skipIf(process.env.MS_RENDER_COST !== '1')('render cost at 1x and at a scale (measurement)', async () => {
    const creative = join(work, 'cost');
    const dir = join(creative, 'outputs', 'v1', 'compositions', 'cost');
    put(join(dir, 'assets', 'Mono.woff2'), readFileSync(FONT));
    put(join(dir, 'layers', 'cost.html'), scaleLayer(6, true).replace('Math.min(1, t)', '(t % 1)'));
    const base = scaleComposition('cost', 6) as unknown as { duration: number; scenes: Array<{ duration: number }>; tracks: Array<{ clips: Array<{ duration: number }> }> };
    base.duration = 10; base.scenes[0]!.duration = 10; base.tracks[0]!.clips[0]!.duration = 10;
    const runs = [{ name: '1x-painting', painting: true }, { name: '1440-painting', short: 1440, painting: true }, { name: '1x' }, { name: '1440', short: 1440 },
      { name: '1440-painting-fps5', short: 1440, painting: true, frameRate: 5 }];
    const r = await runHarness({ scenario: 'render-cost', creative, composition: base, format: 'cost', ffmpeg, costRuns: runs });
    expect(r.ok, r.output).toBe(true);
    for (const l of r.lines.filter((x) => typeof x.cost === 'string')) console.info(`[cost] ${JSON.stringify(l)}`);
  }, 1_800_000);

  // Report 53, a measurement (MS_UI_LOAD=1): a dialog-like list in a shown (inactive) window, scrolled by wheel events from
  // the main process, idle and while a 1920 × 1080 60 fps composition (a full-frame canvas layer of gradients and text) is
  // exported at 2560 × 1440 quality max: its frame gaps, the main process's event-loop delay, the CPU per process kind.
  // `MS_UI_RUNS` (JSON) replaces the runs. Logged, not asserted.
  it.skipIf(process.env.MS_UI_LOAD !== '1')('the UI while an export runs (measurement)', async () => {
    const creative = join(work, 'uiload');
    const dir = join(creative, 'outputs', 'v1', 'compositions', 'heavy');
    put(join(dir, 'layers', 'heavy.html'), HEAVY_LAYER);
    const seconds = Number(process.env.MS_UI_SECONDS ?? 6);
    const composition = {
      $schema: 'motion-studio/composition@1', width: 1920, height: 1080, fps: 60, duration: seconds, background: '#000000', fonts: [],
      scenes: [{ id: 's', start: 0, duration: seconds }],
      tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'l', type: 'html', src: 'layers/heavy.html', start: 0, duration: seconds, props: { x: 0, y: 0, width: 1920, height: 1080 } }] }],
    } as unknown as Composition;
    const runs = process.env.MS_UI_RUNS ? JSON.parse(process.env.MS_UI_RUNS) as object[]
      : [{ name: 'idle', seconds: 10 }, { name: 'export', render: { short: 1440, quality: 'max' } }, { name: 'idle-after', seconds: 10 }];
    const r = await runHarness({ scenario: 'ui-load', creative, composition, format: 'heavy', ffmpeg, uiRuns: runs }, undefined, 1_700_000);
    expect(r.ok, r.output).toBe(true);
    for (const l of r.lines.filter((x) => typeof x.uiLoad === 'string')) console.info(`[ui-load] ${JSON.stringify(l)}`);
  }, 1_800_000);

  // Report 53, a measurement: the standard and high qualities read JPEG frames before; raw frames skip that loss. How far the
  // videos are apart (PSNR and SSIM of the raw one against the JPEG one), and their sizes.
  it.skipIf(process.env.MS_UI_LOAD !== '1')('raw frames against JPEG frames at standard and high (measurement)', async () => {
    const creative = join(work, 'rawq');
    const dir = join(creative, 'outputs', 'v1', 'compositions', 'heavy');
    put(join(dir, 'layers', 'heavy.html'), HEAVY_LAYER);
    const composition = {
      $schema: 'motion-studio/composition@1', width: 1920, height: 1080, fps: 60, duration: 2, background: '#000000', fonts: [],
      scenes: [{ id: 's', start: 0, duration: 2 }],
      tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'l', type: 'html', src: 'layers/heavy.html', start: 0, duration: 2, props: { x: 0, y: 0, width: 1920, height: 1080 } }] }],
    } as unknown as Composition;
    const out = join(work, 'rawq-out');
    mkdirSync(out, { recursive: true });
    const qs = ['standard', 'high'] as const;
    const rawRuns = [{ name: 'truth', quality: 'max', short: 1440 }, ...qs.flatMap((quality) => [{ name: `${quality}-raw`, quality, short: 1440 }, { name: `${quality}-jpeg`, quality, short: 1440, encoded: true }])];
    const r = await runHarness({ scenario: 'raw-render', creative, composition, format: 'heavy', ffmpeg, rawRuns, out });
    expect(r.ok, r.output).toBe(true);
    for (const q of qs) {
      const [a, b] = [join(out, `${q}-raw.mp4`), join(out, `${q}-jpeg.mp4`)];
      const truth = join(out, 'truth.mp4');
      const cmp = (x: string, filter: string) => /(?:average|All):\s*([\d.]+|inf)/.exec(spawnSync(ffmpeg!.path, ['-hide_banner', '-i', x, '-i', truth, '-lavfi', `[0:v][1:v]${filter}`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr)?.[1];
      console.info(`[raw-q] ${q} against max: raw PSNR ${cmp(a, 'psnr')} dB SSIM ${cmp(a, 'ssim')} (${statSync(a).size} B); jpeg PSNR ${cmp(b, 'psnr')} dB SSIM ${cmp(b, 'ssim')} (${statSync(b).size} B)`);
    }
  }, 900_000);

  it.skipIf(process.env.MS_UI_LOAD !== '1')('capture probe (measurement)', async () => {
    const creative = join(work, 'probe');
    put(join(creative, 'outputs', 'v1', 'compositions', 'heavy', 'layers', 'heavy.html'), HEAVY_LAYER);
    const composition = {
      $schema: 'motion-studio/composition@1', width: 1920, height: 1080, fps: 60, duration: 4, background: '#000000', fonts: [],
      scenes: [{ id: 's', start: 0, duration: 4 }],
      tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'l', type: 'html', src: 'layers/heavy.html', start: 0, duration: 4, props: { x: 0, y: 0, width: 1920, height: 1080 } }] }],
    } as unknown as Composition;
    const outDir = join(work, 'probe-out');
    mkdirSync(outDir, { recursive: true });
    const times = Array.from({ length: 12 }, (_, i) => 0.25 + i * 0.3);
    const r = await runHarness({ scenario: 'capture-probe', creative, composition, format: 'heavy', probe: { scale: Number(process.env.MS_PROBE_SCALE ?? 2560 / 1920), times, outDir } });
    expect(r.ok, r.output).toBe(true);
    console.info(`[probe] ${JSON.stringify(r.lines)}`);
    const size = (r.lines[0] as { probe: { size0: { width: number; height: number } } }).probe.size0;
    for (const i of [0, 1]) {
      const png = execFileSync(ffmpeg!.path, ['-v', 'error', '-i', join(outDir, `png-${i}.png`), '-f', 'rawvideo', '-pix_fmt', 'bgra', '-'], { maxBuffer: 1 << 27 });
      const raw = readFileSync(join(outDir, `raw-${i}.bgra`));
      let diff = 0, max = 0;
      for (let k = 0; k < Math.min(png.length, raw.length); k++) { const d = Math.abs(png[k]! - raw[k]!); if (d) { diff++; max = Math.max(max, d); } }
      console.info(`[probe] frame ${i}: png ${png.length} raw ${raw.length} (${size.width}×${size.height}) differing bytes ${diff} max ${max}`);
    }
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

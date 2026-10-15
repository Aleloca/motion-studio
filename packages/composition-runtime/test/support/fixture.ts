import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** ffmpeg for the test video: `FFMPEG_PATH`, else the usual install places, else `ffmpeg` on PATH. */
export function findFfmpeg(): string | null {
  const env = process.env.FFMPEG_PATH;
  if (env) return existsSync(env) ? env : null;
  for (const p of ['/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg']) if (existsSync(p)) return p;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch { return null; }
}

export const COMP_PATH = 'v1/compositions/story';
export const W = 320;
export const H = 180;
/** The video clip: 24 fps source, two grey blocks code the source frame number (left: units, right: tens). */
export const VIDEO = { x: 0, y: 0, width: 160, height: 80, start: 1, duration: 2.5, trimStart: 0.5, sourceFps: 24 };
/** The html layer box: a bar `msSeek` sizes to 50 px per second (colour from msParams), and a canvas driven by rAF + clocks. */
export const LAYER = { x: 0, y: 100, width: 320, height: 80, start: 0, duration: 4 };

const PROBE_LAYER = `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#000;overflow:hidden}#bar{position:absolute;left:0;top:0;height:20px;width:0}canvas{position:absolute;left:0;top:30px}
@keyframes pulse{from{opacity:0}to{opacity:1}} #dot{position:absolute;left:300px;top:0;width:20px;height:20px;background:#fff;animation:pulse 2s linear infinite}</style>
</head><body><div id="bar"></div><div id="dot"></div><canvas id="c" width="320" height="50"></canvas>
<script>
  const bar = document.getElementById('bar');
  bar.style.background = window.msParams.accent;
  // Awaits a timer, then an animation frame: both only fire because layer.js pumps the frozen clock.
  window.msSeek = (t) => new Promise((resolve) => { setTimeout(() => requestAnimationFrame(() => { bar.style.width = Math.round(t * 50) + 'px'; resolve(); }), 0); });
  const ctx = document.getElementById('c').getContext('2d');
  const t0 = performance.now();
  const d0 = Date.now();
  let late = 0;
  setTimeout(() => { late = 1; }, 1000);
  function draw() {
    const t = (performance.now() - t0) / 1000;
    const td = (Date.now() - d0) / 1000;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 320, 50);
    ctx.fillStyle = '#fff';
    ctx.fillRect(Math.round(t * 40), 0, 10, 14);
    ctx.fillRect(Math.round(td * 40), 18, 10, 14);
    if (late) ctx.fillRect(0, 36, 10, 14);
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
  window.msReady = new Promise((r) => document.fonts.ready.then(r));
</script></body></html>`;

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#2dd4bf"/></svg>';

/** Writes the test composition under `root/<COMP_PATH>`; the video only when ffmpeg is available. */
export function writeFixture(root: string, fontFile: string, ffmpeg: string | null): void {
  const dir = join(root, COMP_PATH);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  mkdirSync(join(dir, 'layers'), { recursive: true });
  copyFileSync(fontFile, join(dir, 'assets', 'mono.woff2'));
  writeFileSync(join(dir, 'assets', 'logo.svg'), LOGO);
  writeFileSync(join(dir, 'layers', 'probe.html'), PROBE_LAYER);
  if (ffmpeg) {
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x32:r=24:d=4',
      '-vf', "geq=lum='16+20*if(lt(X,32),mod(N,10),floor(N/10))':cb=128:cr=128,format=yuv420p",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '4', '-g', '12', '-movflags', '+faststart', join(dir, 'assets', 'frames24.mp4')], { stdio: 'pipe' });
  }
  const { start: vs, duration: vd, trimStart, sourceFps, ...vbox } = VIDEO;
  const { start: ls, duration: ld, ...lbox } = LAYER;
  const composition = {
    $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: 4, background: '#000000',
    fonts: [{ family: 'Mono', src: 'assets/mono.woff2' }],
    scenes: [{ id: 'all', start: 0, duration: 4 }],
    tracks: [
      ...(ffmpeg ? [{ id: 'bg', kind: 'video', clips: [{ id: 'clip-video', type: 'video', src: 'assets/frames24.mp4', start: vs, duration: vd, trimStart, sourceFps, props: vbox }] }] : []),
      { id: 'layers', kind: 'visual', clips: [
        { id: 'probe', type: 'html', src: 'layers/probe.html', start: ls, duration: ld, props: lbox, params: { accent: { type: 'color', value: '#ff0000' } } },
        { id: 'logo', type: 'svg', src: 'assets/logo.svg', start: 0, duration: 4, props: { x: 270, y: 10, width: 40, height: 40, fit: 'contain' }, animations: [{ preset: 'popIn', duration: 0.5 }] },
      ] },
      { id: 'text', kind: 'text', clips: [
        { id: 'title', type: 'text', start: 0, duration: 4, props: { text: 'Hi', x: 180, y: 20, width: 80, fontSize: 32, color: '#ffffff' }, animations: [{ preset: 'fadeIn', duration: 0.5 }] },
      ] },
    ],
  };
  writeFileSync(join(dir, 'composition.json'), JSON.stringify(composition, null, 2));
}

/**
 * UX feedback 1, task 2b: layers timed to the clock. `ready-clock` waits 300 ms of timer time in `msReady`; `seek-clock`
 * waits 50 ms of timer time in `msSeek`; `raf-clock` (final wave, Ruling AF) keeps a perpetual requestAnimationFrame loop
 * (a ticker, as GSAP or a canvas loop has) and waits 300 ms of timer time in `msReady`. Under the render clock time never
 * passes, so no wait can end on its own. All three sit inside the frame: an iframe outside it gets no native frames.
 */
export const CLOCK_PATH = 'v1/compositions/clock';
const READY_CLOCK_LAYER = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#0f0}</style></head><body>
<script>window.msReady = new Promise((r) => setTimeout(r, 300)); window.msSeek = () => {};</script></body></html>`;
const SEEK_CLOCK_LAYER = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#00f}</style></head><body>
<script>window.msSeek = (t) => new Promise((r) => setTimeout(() => { document.body.dataset.t = String(t); r(); }, 50));</script></body></html>`;

const RAF_CLOCK_LAYER = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#f0f}</style></head><body>
<script>const tick = () => requestAnimationFrame(tick); requestAnimationFrame(tick);
window.msReady = new Promise((r) => setTimeout(r, 300)); window.msSeek = () => {};</script></body></html>`;

export function writeClockFixture(root: string): void {
  const dir = join(root, CLOCK_PATH);
  mkdirSync(join(dir, 'layers'), { recursive: true });
  writeFileSync(join(dir, 'layers', 'ready-clock.html'), READY_CLOCK_LAYER);
  writeFileSync(join(dir, 'layers', 'seek-clock.html'), SEEK_CLOCK_LAYER);
  writeFileSync(join(dir, 'layers', 'raf-clock.html'), RAF_CLOCK_LAYER);
  const composition = {
    $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: 2, background: '#000000', fonts: [],
    scenes: [{ id: 'all', start: 0, duration: 2 }],
    tracks: [{ id: 'layers', kind: 'visual', clips: [
      { id: 'ready-clock', type: 'html', src: 'layers/ready-clock.html', start: 0, duration: 2, props: { x: 0, y: 0, width: 107, height: 180 } },
      { id: 'seek-clock', type: 'html', src: 'layers/seek-clock.html', start: 0, duration: 2, props: { x: 107, y: 0, width: 106, height: 180 } },
      { id: 'raf-clock', type: 'html', src: 'layers/raf-clock.html', start: 0, duration: 2, props: { x: 213, y: 0, width: 107, height: 180 } },
    ] }],
  };
  writeFileSync(join(dir, 'composition.json'), JSON.stringify(composition, null, 2));
}

/**
 * Phase 14, task 0 (UX 1 follow-up 3, decision 740): html layers outside the frame. In headless Chrome a sandboxed
 * (cross-origin) iframe with no visible area is throttled and gets no animation frames, so before the fix its seek waited
 * for frames until `frameTimeout` (30 s). `parked` sits at x -5000 for the whole clip; `slide` is parked off the frame by
 * an `x` animation until 1 s and slides in by 2 s (its `msSeek` paints green from t 2, blue before); `shrunk` is scaled
 * to 0 by a `scaleIn` until 1 s (no area) and is full size from 1.5 s (yellow).
 */
export const OFFSCREEN_PATH = 'v1/compositions/offscreen';
const solidLayer = (seek: string) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%}</style></head><body>
<script>window.msSeek = ${seek};</script></body></html>`;

export function writeOffscreenFixture(root: string): void {
  const dir = join(root, OFFSCREEN_PATH);
  mkdirSync(join(dir, 'layers'), { recursive: true });
  writeFileSync(join(dir, 'layers', 'parked.html'), solidLayer("() => { document.body.style.background = '#f00'; }"));
  writeFileSync(join(dir, 'layers', 'slide.html'), solidLayer("(t) => { document.body.style.background = t >= 2 ? '#0f0' : '#00f'; }"));
  writeFileSync(join(dir, 'layers', 'shrunk.html'), solidLayer("() => { document.body.style.background = '#ff0'; }"));
  const composition = {
    $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: 3, background: '#000000', fonts: [],
    scenes: [{ id: 'all', start: 0, duration: 3 }],
    tracks: [{ id: 'layers', kind: 'visual', clips: [
      { id: 'parked', type: 'html', src: 'layers/parked.html', start: 0, duration: 3, props: { x: -5000, y: 0, width: 100, height: 100 } },
      { id: 'slide', type: 'html', src: 'layers/slide.html', start: 0, duration: 3, props: { x: 0, y: 0, width: 160, height: 180 },
        animations: [{ prop: 'x', from: -5000, to: 0, start: 1, duration: 1, ease: 'linear' }] },
      { id: 'shrunk', type: 'html', src: 'layers/shrunk.html', start: 0, duration: 3, props: { x: 160, y: 0, width: 160, height: 180 },
        animations: [{ preset: 'scaleIn', start: 1, duration: 0.5, ease: 'linear' }] },
    ] }],
  };
  writeFileSync(join(dir, 'composition.json'), JSON.stringify(composition, null, 2));
}

/** Decision 740, ruling AJ: layers hidden only by their own clip-path (wipe, inset, circle, polygon) until t = 1..2. */
export const CLIPPED_PATH = 'v1/compositions/clipped';
export function writeClippedFixture(root: string): void {
  const dir = join(root, CLIPPED_PATH);
  mkdirSync(join(dir, 'layers'), { recursive: true });
  writeFileSync(join(dir, 'layers', 'paint.html'), solidLayer("() => { document.body.style.background = '#0f0'; }"));
  const clip = (id: string, x: number, from: string, to: string) => ({ id, type: 'html', src: 'layers/paint.html', start: 0, duration: 3, props: { x, y: 0, width: 80, height: 90 },
    animations: [{ prop: 'clip', from, to, start: 1, duration: 1, ease: 'linear' }] });
  const composition = {
    $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: 3, background: '#000000', fonts: [],
    scenes: [{ id: 'all', start: 0, duration: 3 }],
    tracks: [{ id: 'layers', kind: 'visual', clips: [
      { id: 'wipe', type: 'html', src: 'layers/paint.html', start: 0, duration: 3, props: { x: 0, y: 0, width: 80, height: 90 }, animations: [{ preset: 'wipe', start: 1, duration: 1, ease: 'linear' }] },
      clip('inset', 80, 'inset(100% 100% 100% 100%)', 'inset(0% 0% 0% 0%)'),
      clip('circle', 160, 'circle(0px at 50% 50%)', 'circle(150% at 50% 50%)'),
      clip('polygon', 240, 'polygon(50% 50%, 50% 50%, 50% 50%, 50% 50%)', 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)'),
    ] }],
  };
  writeFileSync(join(dir, 'composition.json'), JSON.stringify(composition, null, 2));
}

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
  window.msSeek = (t) => new Promise((resolve) => { setTimeout(() => { bar.style.width = Math.round(t * 50) + 'px'; resolve(); }, 0); });
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

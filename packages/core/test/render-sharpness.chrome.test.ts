// @vitest-environment node
/**
 * Report 38 (decision 1230): text in an html layer stays sharp when the layer scales it up, in real Chrome. A camera rig
 * with `will-change: transform` (or a WAAPI/CSS animation of the transform, or a translateZ hack) used to be rasterised
 * once at its first scale and then resampled: at scale(4) the text was a blurred bitmap. The render now neutralises
 * `will-change` in every layer document, so each frame is rasterised at its own scale. The frames are compared with the
 * same layer without the hint (squared gradient energy of the frame at scale ~3.9). Measured before the fix: plain 1173.8,
 * will-change (sheet, id !important, inline !important, with WAAPI) 215.4, a fifth; translateZ, WAAPI and CSS animations
 * alone 1173.8. After it, every variant 1173.8.
 * Skipped without Chrome or ffmpeg, unless MS_REQUIRE_CHROME=1.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Composition, FormatPreset } from '@motion-studio/shared';
import { ChromeProvider } from '../src/render/chromium-provider.ts';
import { renderFrames } from '../src/render/frames.ts';
import { buildRuntime, FONT, put, renderTools } from './helpers/render-env.ts';

const tools = await renderTools('render sharpness tests');
const W = 320, H = 180;
const VERSION_DIR = 'outputs/v1';
const format: FormatPreset = { id: 'sharp', channel: 'Test', name: 'sharp', width: W, height: H, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 };
const composition = (layer: string): Composition => ({
  $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: 1, background: '#000000',
  fonts: [{ family: 'Mono', src: 'assets/Mono.woff2', weight: 400 }],
  scenes: [{ id: 's', start: 0, duration: 1 }],
  tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'l', type: 'html', src: `layers/${layer}.html`, start: 0, duration: 1, props: { x: 0, y: 0, width: W, height: H } }] }],
} as unknown as Composition);

/** 10 px text scaled from 1 to 4 over the first second by the layer's own code (`how`: the transform's driver). */
const layer = (hint: string, how: 'seek' | 'waapi' | 'css') => `<!doctype html><html><head><style>
html,body{margin:0;background:#000;overflow:hidden}
#w{position:absolute;left:4px;top:4px;transform-origin:0 0;color:#fff;font:10px Mono;white-space:nowrap;${hint}}
${how === 'css' ? '#w{animation:z 1s linear forwards}@keyframes z{from{transform:scale(1)}to{transform:scale(4)}}' : ''}
</style></head><body><div id="w">Sharp 2K text ABC 123</div><script>
const w = document.getElementById('w');
window.msReady = document.fonts.ready;
${how === 'seek' ? 'window.msSeek = (t) => { w.style.transform = `scale(${1 + 3 * Math.min(1, t)})`; };' : ''}
${how === 'waapi' ? "w.animate([{ transform: 'scale(1)' }, { transform: 'scale(4)' }], { duration: 1000, fill: 'forwards' });" : ''}
</script></body></html>`;

const VARIANTS: Record<string, string> = {
  plain: layer('', 'seek'),
  hinted: layer('will-change:transform', 'seek'),
  important: layer('will-change:transform !important', 'seek'),
  inline: layer('', 'seek').replace('<div id="w">', '<div id="w" style="will-change: transform !important">'),
  tz: layer('', 'seek').replace('`scale(${', '`translateZ(0) scale(${'),
  waapi: layer('', 'waapi'),
  waapiHinted: layer('will-change:transform', 'waapi'),
  css: layer('', 'css'),
};

describe.skipIf(!tools.ok)('renderer: text in a scaled layer stays sharp (report 38)', { timeout: 300_000 }, () => {
  let work: string;
  let dist: string;
  let creative: string;
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ms-test-render-sharp-'));
    dist = join(work, 'dist');
    await buildRuntime(dist);
    creative = join(work, 'creative');
    const dir = join(creative, VERSION_DIR, 'compositions', 'sharp');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    copyFileSync(FONT, join(dir, 'assets', 'Mono.woff2'));
    for (const [name, html] of Object.entries(VARIANTS)) put(join(dir, 'layers', `${name}.html`), html);
  }, 600_000);
  afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

  /** The grey pixels of a PNG (decoded by ffmpeg). */
  const grey = (png: Buffer, name: string): Uint8Array => {
    const file = join(work, `${name}.png`);
    writeFileSync(file, png);
    return new Uint8Array(execFileSync(tools.ffmpeg!.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 }));
  };
  /** Mean absolute horizontal + vertical difference of neighbouring pixels: high for sharp edges, low for a blur. */
  const energy = (px: Uint8Array): number => {
    let sum = 0;
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      sum += (px[i]! - px[i + 1]!) ** 2 + (px[i]! - px[i + W]!) ** 2;
    }
    return sum / ((W - 1) * (H - 1));
  };
  /** The frame at t = 0 (scale 1, the first raster) then at t = 29/30 (about scale 3.9). */
  const frame = async (name: string): Promise<number> => {
    const { frames, errors } = await renderFrames({
      dir: creative, versionDir: VERSION_DIR, composition: composition(name), format, times: Array.from({ length: 11 }, (_, i) => i / 10), width: W, imageFormat: 'png',
      provider: new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 5 * 60_000 } }), signal: new AbortController().signal, distDir: dist,
    });
    expect(errors).toEqual([]);
    return energy(grey(frames.at(-1)!.data, name));
  };

  it('a will-change camera rig, an inline !important hint, a translateZ hack and WAAPI/CSS animations are as sharp as plain text', async () => {
    const plain = await frame('plain');
    const results: Record<string, number> = { plain };
    for (const name of Object.keys(VARIANTS).filter((n) => n !== 'plain')) results[name] = await frame(name);
    console.info('[sharpness] gradient energy at scale ~3.9:', JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Number(v.toFixed(3))]))));
    expect(plain).toBeGreaterThan(1);
    for (const [name, e] of Object.entries(results)) expect(e / plain, name).toBeGreaterThan(0.9);
  });
});

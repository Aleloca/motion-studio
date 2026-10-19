// @vitest-environment node
/**
 * Report 38 (decisions 1230, 1237–1247): text in an html layer stays sharp when the layer scales it up, in real Chrome. A
 * camera rig with `will-change: transform` (or scale, rotate, translate) used to be rasterised once at its first scale and
 * then resampled: at scale(4) the text was a blurred bitmap. The layer agent now drops those hints (an element without a
 * transform gets `translate: 0px`), so each frame is rasterised at its own scale, and what the hint made stays: stacking
 * context, containing block, 3D planes, a working backdrop-filter child (a `filter` substitute broke the last two). The frames are compared with the
 * same layer without the hint (squared gradient energy of the frame at scale ~3.9). Measured before the fix: plain 1173.8,
 * will-change (sheet, id !important, inline !important, with WAAPI) 215.4, a fifth; translateZ, WAAPI and CSS animations
 * alone 1173.8; opacity, filter and contents hints 1173.8 too (they do not freeze). After it, every variant 1173.8.
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
  // Decisions 1237–1239: every freezing value, from any rule, and a hint the layer's own msSeek sets after the agent ran.
  list: layer('will-change:opacity, rotate', 'seek'),
  translate: layer('will-change:translate', 'seek'),
  ids: layer('', 'seek').replace('</style>', '#w#w#w#w#w#w#w#w#w#w{will-change:scale !important}</style>'),
  layered: layer('', 'seek').replace('</style>', '@layer a{#w{will-change:transform !important}}</style>'),
  inSeek: layer('', 'seek').replace('window.msSeek = (t) => {', "window.msSeek = (t) => { w.style.setProperty('will-change', 'transform', 'important');"),
};

/**
 * What a transform hint makes besides the frozen raster (decisions 1237, 1243): a stacking context (a z-index -1 child paints over
 * the rig's background, a blend mode blends inside it) and the containing block of absolute and fixed children. `hint`
 * gives them with `will-change: transform`; the reference with an identity transform, which makes the same.
 */
const structure = (rig: string) => `<!doctype html><html><head><style>
html,body{margin:0;background:#000}
#rig{margin:40px 0 0 60px;width:160px;height:100px;background:#246;${rig}}
.abs{position:absolute;left:10px;top:10px;width:30px;height:30px;background:#f80}
.fix{position:fixed;right:10px;bottom:10px;width:20px;height:20px;background:#0f0}
.under{position:relative;z-index:-1;width:60px;height:60px;margin:40px 0 0 80px;background:#fff}
.blend{position:absolute;left:50px;top:50px;width:40px;height:40px;background:#f00;mix-blend-mode:difference}
</style></head><body><div id="rig"><div class="abs"></div><div class="fix"></div><div class="under"></div><div class="blend"></div></div></body></html>`;
/** Decision 1243: a preserve-3d rig whose two planes intersect (a flattening substitute draws one over the other). */
const threeD = (rig: string) => `<!doctype html><html><head><style>html,body{margin:0;background:#000}body{perspective:600px}
#rig{position:absolute;left:80px;top:20px;width:140px;height:140px;transform-style:preserve-3d;transform:rotateX(20deg);${rig}}
.p{position:absolute;inset:0;transform-style:preserve-3d}.a{background:rgba(255,0,0,.9);transform:rotateY(45deg)}.b{background:rgba(0,0,255,.9);transform:rotateY(-45deg)}
</style></head><body><div id="rig"><div class="p a"></div><div class="p b"></div></div></body></html>`;
/** Decision 1243: a glass panel blurring what is behind the rig (a backdrop-root substitute leaves it blurring nothing). */
const backdrop = (rig: string) => `<!doctype html><html><head><style>html,body{margin:0;background:#000}
.bg{position:absolute;left:0;top:0;width:320px;height:180px;background:repeating-linear-gradient(45deg,#fff 0 10px,#f00 10px 20px)}
#rig{position:absolute;left:30px;top:20px;width:260px;height:140px;${rig}}.glass{position:absolute;left:20px;top:20px;width:200px;height:100px;backdrop-filter:blur(8px)}
</style></head><body><div class="bg"></div><div id="rig"><div class="glass"></div></div></body></html>`;
/**
 * Decisions 1250, 1252: a `translate` that starts to match a hinted box later, without a class or id change on it: a sibling
 * inserted before it (`.s + #c`), a `:has()` flag added elsewhere, a rule added with `insertRule`, and a box whose layer
 * rewrites its inline hint before a class change gives it a translate (`.t #d`). Each box must land where its rule puts it.
 * (A layer's own `@layer` rule giving a hinted box a translate loses to the unfreezer's identity: decision 1255.)
 */
const late = (hint: boolean) => `<!doctype html><html><head><style>html,body{margin:0;background:#000}
.b{position:absolute;top:20px;width:30px;height:30px;background:#fff}
#c{left:10px;${hint ? 'will-change:transform' : ''}}.s + #c{translate:40px}
#e{left:90px;${hint ? 'will-change:transform' : ''}}body:has(.flag) #e{translate:0 60px}
#f{left:170px;${hint ? 'will-change:transform' : ''}}
.t #d{translate:30px 90px}#d{left:240px}
</style></head><body><div id="c" class="b"></div><div id="e" class="b"></div><div id="f" class="b"></div><div id="d" class="b"${hint ? ' style="will-change: transform"' : ''}></div><script>
const step = new Set();
const once = (k, t, at, f) => { if (t >= at && !step.has(k)) { step.add(k); f(); } };
window.msSeek = (t) => {
  // Each change in its own frame: no class or id change comes with the first three.
  once('sibling', t, 0.3, () => { const s = document.createElement('i'); s.className = 's'; document.getElementById('c').before(s); });
  once('has', t, 0.3, () => { const f = document.createElement('b'); f.className = 'flag'; document.body.append(f); });
  once('rule', t, 0.3, () => document.styleSheets[0].insertRule('#f{translate:0 100px}', document.styleSheets[0].cssRules.length));
  once('rewrite', t, 0.3, () => document.getElementById('d').style.setProperty('will-change', 'opacity'));
  once('class', t, 0.6, () => document.body.classList.add('t'));
};
</script></body></html>`;
/**
 * Decision 1255: the layer's own first sheet is its own. `document.querySelector('style').textContent += …` and
 * `document.styleSheets[0].cssRules[1].style` reach the layer's sheet (the unfreezer adds none to the document), so both
 * boxes turn green and the layer script never throws; a layer that empties `adoptedStyleSheets` gets the sheet back.
 */
const ownSheets = `<!doctype html><html><head><style>html,body{margin:0;background:#000}
#k{position:absolute;left:20px;top:20px;width:40px;height:40px;background:#f00;will-change:transform}
#m{position:absolute;left:100px;top:20px;width:40px;height:40px;background:#f00}
#r{margin:100px 0 0 200px;width:60px;height:60px;will-change:transform}#r i{position:absolute;left:0;top:0;width:20px;height:20px;background:#0f0}
</style></head><body><div id="k"></div><div id="m"></div><div id="r"><i></i></div><script>
let done = false;
window.msSeek = (t) => {
  if (t < 0.3 || done) return;
  done = true;
  document.querySelector('style').textContent += '#k{background:#0f0}';
  document.styleSheets[0].cssRules[2].style.background = '#0f0';
  document.adoptedStyleSheets = []; // the unfreezer's sheet comes back: #r stays the containing block of its child
};
</script></body></html>`;
const STRUCTURE: Record<string, string> = {
  ownSheets,
  hint: structure('will-change:transform'), reference: structure('transform:translate(0)'),
  hint3d: threeD('will-change:transform'), reference3d: threeD(''),
  hintBackdrop: backdrop('will-change:transform'), referenceBackdrop: backdrop(''),
  hintLate: late(true), referenceLate: late(false),
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
    for (const [name, html] of Object.entries({ ...VARIANTS, ...STRUCTURE })) put(join(dir, 'layers', `${name}.html`), html);
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
  /** The frames from t = 0 (scale 1, the first raster) to t = 29/30 (about scale 3.9), every tenth of a second. */
  const frames = async (name: string, times = Array.from({ length: 11 }, (_, i) => i / 10)) => {
    const r = await renderFrames({
      dir: creative, versionDir: VERSION_DIR, composition: composition(name), format, times, width: W, imageFormat: 'png',
      provider: new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 5 * 60_000 } }), signal: new AbortController().signal, distDir: dist,
    });
    expect(r.errors).toEqual([]);
    return r.frames;
  };
  const frame = async (name: string): Promise<number> => energy(grey((await frames(name)).at(-1)!.data, name));

  it('a will-change camera rig, an inline !important hint, a translateZ hack and WAAPI/CSS animations are as sharp as plain text', async () => {
    const plain = await frame('plain');
    const results: Record<string, number> = { plain };
    for (const name of Object.keys(VARIANTS).filter((n) => n !== 'plain')) results[name] = await frame(name);
    console.info('[sharpness] gradient energy at scale ~3.9:', JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Number(v.toFixed(3))]))));
    expect(plain).toBeGreaterThan(1);
    for (const [name, e] of Object.entries(results)) expect(e / plain, name).toBeGreaterThan(0.9);
  });

  /** The largest grey difference between the first frames of two layers. */
  /** The largest grey difference between the frames of two layers at `times` (one number per time when several). */
  const maxDiff = async (a: string, b: string, times = [0]) => {
    const [fa, fb] = [await frames(a, times), await frames(b, times)];
    const diffs = fa.map((f, k) => {
      const [x, y] = [grey(f.data, `${a}-${k}`), grey(fb[k]!.data, `${b}-${k}`)];
      let diff = 0;
      for (let i = 0; i < x.length; i++) diff = Math.max(diff, Math.abs(x[i]! - y[i]!));
      return diff;
    });
    return diffs.length === 1 ? diffs[0]! : diffs;
  };
  it('what the hint makes is kept: stacking context, blend group, containing block, 3D planes and a backdrop-filter child', async () => {
    const diffs = { structure: await maxDiff('hint', 'reference'), threeD: await maxDiff('hint3d', 'reference3d'), backdrop: await maxDiff('hintBackdrop', 'referenceBackdrop'),
      late: await maxDiff('hintLate', 'referenceLate', [0, 0.35, 0.7]) };
    console.info('[sharpness] structure differences:', JSON.stringify(diffs));
    expect(diffs).toEqual({ structure: 0, threeD: 0, backdrop: 0, late: [0, 0, 0] });
  });

  it('the layer\'s own first sheet stays its own: appended CSS and CSSOM edits apply, nothing throws (decision 1255)', async () => {
    const [, after] = await frames('ownSheets', [0, 0.5]);
    const px = grey(after!.data, 'ownSheets');
    // Green is grey ~150, red ~76.
    expect([px[40 * W + 40]!, px[40 * W + 120]!, px[110 * W + 210]!].map((g) => g > 120)).toEqual([true, true, true]);
  });
});

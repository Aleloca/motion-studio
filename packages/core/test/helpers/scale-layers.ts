/**
 * Report 51 (decisions 1340–1348): an html layer rasterised at the render's scale. The layers are sandboxed iframes, out
 * of process: the page's `Emulation.setDeviceMetricsOverride` never reached them, so a render at scale 2 drew the layer at
 * 1x and stretched it. Shared by the Chrome test (render-scale.chrome.test.ts) and the Electron one (the desktop harness).
 */
import type { Composition } from '@motion-studio/shared';

export const SCALE_W = 320, SCALE_H = 180;
/** The text block's box in composition pixels (the energy is measured there; the DPR bar is below it). */
export const TEXT_BOX = { x: 0, y: 0, width: 320, height: 140 };
/** The DPR bar: `20 × devicePixelRatio` CSS pixels wide, at y 150–160 (composition pixels), from x 8. */
export const DPR_BAR = { x: 8, y: 155, cssPerDpr: 20 };

const LINES = ['Sharp 2K text, small: ABCDEFGHIJKLMNOP', 'qrstuvwxyz 0123456789 #@&%$!?', 'The quick brown fox jumps over', 'the lazy dog; 1440p, 2160p, 4K.',
  'Lorem ipsum dolor sit amet, cons', 'ectetur adipiscing elit, sed do', 'eiusmod tempor incididunt ut lab', 'ore et dolore magna aliqua. Ut e',
  'nim ad minim veniam, quis nostru', 'd exercitation ullamco laboris n', 'isi ut aliquip ex ea commodo con'];

/**
 * 9 px text on black, and a white bar `20 × devicePixelRatio` CSS pixels wide (what the layer's own JS sees). `zoom`: the
 * ground truth, the same layer laid out `zoom` times larger (CSS zoom), for a composition `zoom` times larger at scale 1.
 * `rig`: report 38's camera rig, the text block scaled by the layer's seek from 1 (t = 0) to 2 (t = 1), `will-change:
 * transform` on it (the layer agent drops the hint, so each frame is rasterised at its own scale).
 */
export function scaleLayer(zoom = 1, rig = false): string {
  return `<!doctype html><html><head><style>
html,body{margin:0;background:#000;overflow:hidden}${zoom !== 1 ? `html{zoom:${zoom}}` : ''}
#t{position:absolute;left:8px;top:6px;color:#fff;font:9px Mono;line-height:12px;white-space:pre;transform-origin:0 0;${rig ? 'will-change:transform' : ''}}
#d{position:absolute;left:${DPR_BAR.x}px;top:150px;height:10px;background:#fff}
</style></head><body><div id="t">${LINES.join('\n')}</div><div id="d"></div><script>
document.getElementById('d').style.width = (${DPR_BAR.cssPerDpr} * devicePixelRatio) + 'px';
window.msReady = document.fonts.ready;
${rig ? "window.msSeek = (t) => { document.getElementById('t').style.transform = `scale(${1 + Math.min(1, t)})`; };" : ''}
</script></body></html>`;
}

/** A composition with the one layer over the whole frame, `zoom` times the base size. */
export function scaleComposition(layer: string, zoom = 1): Composition {
  const w = SCALE_W * zoom, h = SCALE_H * zoom;
  return {
    $schema: 'motion-studio/composition@1', width: w, height: h, fps: 30, duration: 1, background: '#000000',
    fonts: [{ family: 'Mono', src: 'assets/Mono.woff2', weight: 400 }],
    scenes: [{ id: 's', start: 0, duration: 1 }],
    tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'l', type: 'html', src: `layers/${layer}.html`, start: 0, duration: 1, props: { x: 0, y: 0, width: w, height: h } }] }],
  } as unknown as Composition;
}

/** Mean squared horizontal + vertical difference of neighbouring grey pixels in `box` (scaled by `k`): high when sharp. */
export function gradientEnergy(px: Uint8Array, width: number, box: { x: number; y: number; width: number; height: number }, k: number): number {
  const x0 = Math.round(box.x * k), y0 = Math.round(box.y * k), w = Math.round(box.width * k), h = Math.round(box.height * k);
  let sum = 0;
  for (let y = y0; y < y0 + h - 1; y++) for (let x = x0; x < x0 + w - 1; x++) {
    const i = y * width + x;
    sum += (px[i]! - px[i + 1]!) ** 2 + (px[i]! - px[i + width]!) ** 2;
  }
  return sum / ((w - 1) * (h - 1));
}

/** The devicePixelRatio the layer saw, read from its bar in a capture at scale `k` (bar width in pixels / 20 / k). */
export function barDpr(px: Uint8Array, width: number, k: number): number {
  const y = Math.round(DPR_BAR.y * k), x0 = Math.round(DPR_BAR.x * k);
  let n = 0;
  while (x0 + n < width && px[y * width + x0 + n]! > 127) n++;
  return Math.round((n / DPR_BAR.cssPerDpr / k) * 100) / 100;
}

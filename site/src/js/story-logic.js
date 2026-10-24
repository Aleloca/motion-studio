// Pure helpers of the live story (story.js): the camera's fit, the framing between two steps, the step at a time, the
// composer's typing, the steps a board or figure belongs to. Tested in site/test/story.test.mjs.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, p) => a + (b - a) * p;

/**
 * The transform that fits a world rectangle into the canvas, centred in the canvas minus its insets (the intro, the tool
 * bar, the bottom sheet).
 * @param {number[]} rect [x, y, w, h] in world units
 * @param {{ w: number, h: number }} view the canvas in pixels
 * @param {{ top: number, right: number, bottom: number, left: number }} inset pixels
 * @returns {{ s: number, tx: number, ty: number }} screen = world * s + t
 */
export function cameraFit([x, y, w, h], view, inset) {
  const aw = Math.max(1, view.w - inset.left - inset.right);
  const ah = Math.max(1, view.h - inset.top - inset.bottom);
  const s = Math.min(aw / w, ah / h);
  return { s, tx: inset.left + (aw - w * s) / 2 - x * s, ty: inset.top + (ah - h * s) / 2 - y * s };
}

/** The framing at a fractional index of a list of framings: between two framings, each value in proportion. */
export function framingAt(list, k) {
  const i = clamp(Math.floor(k), 0, list.length - 1);
  const j = clamp(i + 1, 0, list.length - 1);
  const p = clamp(k - i, 0, 1);
  return list[i].map((v, n) => lerp(v, list[j][n], p));
}

/** The step on screen at a time of the story's timeline: step n runs from n - 1 to n (the last one holds). */
export const stepAt = (t, count) => clamp(Math.floor(t) + 1, 1, count);

/**
 * What the composer shows at a time: in the second half of a step, the next step's request typed letter by letter; it
 * is sent (and the composer empties) when that step starts. Steps without a request (a click) leave it empty.
 * @param {(string | null)[]} requests the request of each step, in order
 */
export function typedAt(t, requests) {
  const seg = Math.floor(t);
  const req = requests[seg + 1];
  if (!req) return '';
  const p = clamp((t - seg - 0.45) / 0.45, 0, 1);
  return req.slice(0, Math.round(p * req.length));
}

/** "1-2" or "4" or "3-4 8" → [[1, 2], [4, 4], …] */
export const parseSteps = (s) => String(s).trim().split(/\s+/).map((part) => {
  const [a, b] = part.split('-').map(Number);
  return [a, b ?? a];
});
export const inSteps = (ranges, n) => ranges.some(([a, b]) => n >= a && n <= b);

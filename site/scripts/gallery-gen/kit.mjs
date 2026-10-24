// Small motion builders shared by the gallery's creatives, on top of hero-gen's lib.mjs: per-letter and per-word type,
// lines drawn with a wipe along their own direction, a seeded random, and rounding for SVG coordinates.
import { tw } from '../hero-gen/lib.mjs';

/** A deterministic random in [0, 1): the generator's output must be the same on every run. */
export function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

export const f1 = (v) => (Math.round(v * 10) / 10).toString();

/**
 * One text clip per letter, placed with the measured width of the text before it (`tracking` px between letters).
 * `p`: { x, y, size, font, weight, color, tracking, align: left|center|right, end } (end: when every letter leaves).
 * `anims(i, start)`: the animations of the i-th letter (spaces skipped). Returns the total width.
 */
export function letters(c, track, name, text, p, start, step, anims) {
  const font = p.font ?? 'display'; const weight = p.weight ?? 800; const trk = p.tracking ?? 0;
  const total = width(text, p.size, font, weight, trk);
  const x0 = p.align === 'center' ? p.x - total / 2 : p.align === 'right' ? p.x - total : p.x;
  // On a tilted line (rotation) each letter turns on its own centre, so the centres are placed along the tilt.
  const a = ((p.rotation ?? 0) * Math.PI) / 180; const mid = x0 + total / 2;
  let k = 0;
  [...text].forEach((ch, i) => {
    if (ch === ' ') return;
    const lw = tw(ch, p.size, font, weight) + p.size * 0.12;
    const lx = x0 + (i ? tw(text.slice(0, i), p.size, font, weight) : 0) + trk * i;
    const dx = lx + lw / 2 - mid;
    const x = mid + dx * Math.cos(a) - lw / 2; const y = p.y + dx * Math.sin(a);
    const s = start + k * step;
    c.text(track, name, s, p.end - s, { font, weight, size: p.size, color: p.color, text: ch, x, y, w: lw, ...(p.rotation ? { rotation: p.rotation } : {}) }, anims(k, s));
    k++;
  });
  return total;
}

/** The width of a text with `trk` px between letters. */
export const width = (text, size, font = 'display', weight = 800, trk = 0) => tw(text, size, font, weight) + trk * (text.length - 1);

/** One text clip per word, on one line from `p.x` (align left/center), `gap` = the space's width. */
export function words(c, track, name, text, p, start, step, anims) {
  const font = p.font ?? 'display'; const weight = p.weight ?? 800;
  const list = text.split(' ');
  const space = tw('a b', p.size, font, weight) - tw('ab', p.size, font, weight);
  const total = list.reduce((sum, wd) => sum + tw(wd, p.size, font, weight), 0) + space * (list.length - 1);
  let x = p.align === 'center' ? p.x - total / 2 : p.x;
  list.forEach((wd, i) => {
    const s = start + i * step;
    const wW = tw(wd, p.size, font, weight);
    c.text(track, name, s, p.end - s, { font, weight, size: p.size, color: p.color, text: wd, x, y: p.y, w: wW + p.size * 0.15 }, anims(i, s));
    x += wW + space;
  });
  return total;
}

/**
 * A straight line from (x1, y1) to (x2, y2), `t` px thick: a shape clip turned along the line, drawn by a wipe that runs
 * from the first point to the second over `draw` seconds (a wipe works in the clip's own frame, so it follows the turn).
 */
export function line(c, track, name, [x1, y1], [x2, y2], t, fill, start, end, draw, ease, extra = []) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  const cx = (x1 + x2) / 2; const cy = (y1 + y2) / 2;
  return c.shape(track, name, start, end - start, { x: cx - len / 2, y: cy - t / 2, w: len, h: t, fill, rotation: Math.round(ang * 1000) / 1000 || undefined, radius: t / 2 },
    [{ preset: 'wipe', start: 0, duration: draw, ease }, ...extra]);
}

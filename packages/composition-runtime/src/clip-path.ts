/**
 * Render mode (decision 740/794): whether a computed `clip-path` of a w x h box leaves it no visible area: `inset()` whose
 * sides meet or cross, `circle()`/`ellipse()` of radius 0, `polygon()` collapsed to a line or a point. px and % only;
 * anything else (calc(), var(), path(), url(), keywords, other units, an ancestor's clip) reads as visible.
 *
 * `w` and `h` are the rounded layout size (`offsetWidth`/`offsetHeight`): the real size can be up to 0.5 px larger or
 * smaller. A length is kept as px plus a fraction of the box, and "no area" must hold for every real size in
 * [w - 0.5, w + 0.5] (decision 797): px insets must cover `w + 0.5`, so a sub-pixel sliver is never read as no area, while
 * % insets (the runtime's own wipe) scale with the real size and still meet exactly.
 */
export function clipPathHasNoArea(clipPath: string, w: number, h: number): boolean {
  const cp = clipPath.trim();
  const m = /^(inset|circle|ellipse|polygon)\((.*)\)$/.exec(cp);
  if (!m) return false;
  if (!(w > 0 && h > 0)) return false;
  /** A length as px + frac x (the real box size); null when not px, % or a unitless 0. */
  const len = (tok: string): { px: number; frac: number } | null => {
    const x = /^(-?\d*\.?\d+(?:e-?\d+)?)(px|%)?$/.exec(tok);
    if (!x) return null;
    const v = Number(x[1]);
    return x[2] === '%' ? { px: 0, frac: v / 100 } : x[2] === 'px' || v === 0 ? { px: v, frac: 0 } : null;
  };
  /** Whether px + frac x size >= size for every real size the rounded `base` can stand for (the check is linear). */
  const covers = (a: { px: number; frac: number }, b: { px: number; frac: number }, base: number): boolean =>
    [Math.max(base - 0.5, 0), base + 0.5].every((size) => a.px + b.px + (a.frac + b.frac) * size >= size);
  const body = m[2]!.trim();
  if (m[1] === 'inset') {
    const toks = body.split(/\s+round\s+/)[0]!.trim().split(/\s+/);
    if (toks.length < 1 || toks.length > 4) return false;
    const [t, r = t, b = t, l = r] = toks as [string, string?, string?, string?];
    const top = len(t), right = len(r), bottom = len(b!), left = len(l!);
    if (top === null || right === null || bottom === null || left === null) return false;
    return covers(left, right, w) || covers(top, bottom, h);
  }
  if (m[1] === 'circle' || m[1] === 'ellipse') {
    const shape = body.split(/\s+at\s+/)[0]!.trim();
    if (!shape || /closest|farthest/.test(shape)) return false;
    const radii = shape.split(/\s+/).map(len);
    if (radii.some((v) => v === null)) return false;
    const zero = radii.map((v) => v!.px === 0 && v!.frac === 0);
    return m[1] === 'circle' ? zero[0] === true : zero[0] === true || zero[1] === true;
  }
  const pts = body.replace(/^(?:nonzero|evenodd)\s*,\s*/, '').split(',').map((pt) => pt.trim().split(/\s+/));
  const xs: Array<{ px: number; frac: number }> = []; const ys: Array<{ px: number; frac: number }> = [];
  for (const [px, py, ...rest] of pts) {
    if (px === undefined || py === undefined || rest.length) return false;
    const x = len(px), y = len(py);
    if (x === null || y === null) return false;
    xs.push(x); ys.push(y);
  }
  if (!xs.length) return false;
  // Collapsed onto an axis for every real size: the same px and the same fraction on that axis.
  const same = (vs: Array<{ px: number; frac: number }>) => vs.every((v) => v.px === vs[0]!.px && v.frac === vs[0]!.frac);
  return same(xs) || same(ys);
}

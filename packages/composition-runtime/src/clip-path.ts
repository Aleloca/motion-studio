/**
 * Render mode (decision 740/794): whether a computed `clip-path` of a w x h box leaves it no visible area: `inset()` whose
 * sides meet or cross, `circle()`/`ellipse()` of radius 0, `polygon()` collapsed to a line or a point. px and % only;
 * anything else (calc(), var(), path(), url(), keywords, other units, an ancestor's clip) reads as visible.
 */
export function clipPathHasNoArea(clipPath: string, w: number, h: number): boolean {
  const cp = clipPath.trim();
  const m = /^(inset|circle|ellipse|polygon)\((.*)\)$/.exec(cp);
  if (!m) return false;
  if (!(w > 0 && h > 0)) return false;
  const len = (tok: string, base: number): number | null => {
    const x = /^(-?\d*\.?\d+(?:e-?\d+)?)(px|%)?$/.exec(tok);
    if (!x) return null;
    const v = Number(x[1]);
    return x[2] === '%' ? (v / 100) * base : x[2] === 'px' || v === 0 ? v : null;
  };
  const body = m[2]!.trim();
  if (m[1] === 'inset') {
    const toks = body.split(/\s+round\s+/)[0]!.trim().split(/\s+/);
    if (toks.length < 1 || toks.length > 4) return false;
    const [t, r = t, b = t, l = r] = toks as [string, string?, string?, string?];
    const top = len(t, h), right = len(r, w), bottom = len(b!, h), left = len(l!, w);
    if (top === null || right === null || bottom === null || left === null) return false;
    return left + right >= w || top + bottom >= h;
  }
  if (m[1] === 'circle' || m[1] === 'ellipse') {
    const shape = body.split(/\s+at\s+/)[0]!.trim();
    if (!shape || /closest|farthest/.test(shape)) return false;
    const radii = shape.split(/\s+/);
    const zero = radii.map((tok, i) => len(tok, m[1] === 'circle' ? Math.hypot(w, h) / Math.SQRT2 : i === 0 ? w : h));
    if (zero.some((v) => v === null)) return false;
    return m[1] === 'circle' ? zero[0] === 0 : zero[0] === 0 || zero[1] === 0;
  }
  const pts = body.replace(/^(?:nonzero|evenodd)\s*,\s*/, '').split(',').map((pt) => pt.trim().split(/\s+/));
  const xs: number[] = []; const ys: number[] = [];
  for (const [px, py, ...rest] of pts) {
    if (px === undefined || py === undefined || rest.length) return false;
    const x = len(px, w), y = len(py, h);
    if (x === null || y === null) return false;
    xs.push(x); ys.push(y);
  }
  if (!xs.length) return false;
  return Math.max(...xs) - Math.min(...xs) <= 0 || Math.max(...ys) - Math.min(...ys) <= 0;
}

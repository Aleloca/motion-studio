// The stage handles' arithmetic (Phase 10b, Task 6): pointer deltas in stage pixels (CSS pixels of the overlay, which is the
// player's iframe viewport) to the base props of a clip, in composition pixels. Pure.
//
// The model is the runtime's (mount.ts): a clip is a box at (x, y) of `width` × `height`; `scale` and `rotation` (degrees,
// clockwise) apply around the box centre, so the centre is (x + width/2, y + height/2) whatever they are, and the box seen
// on the stage is `width·scale` × `height·scale` turned by `rotation`. Every function takes the props the gesture STARTED
// with and the total pointer movement since, never the previous step's result: nothing accumulates, ten drags cannot drift,
// and animations (which the runtime adds on top of the base props) are never baked in.
/** The safe area of a format: the margins (composition pixels) the platform's interface covers. */
export type SafeZone = { top: number; bottom: number; left: number; right: number };
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** A clip's box props with every default resolved. */
export interface BoxProps { x: number; y: number; width: number; height: number; rotation: number; scale: number }
export type Corner = 'nw' | 'ne' | 'se' | 'sw';

/** The smallest a side may be made by a resize, in composition pixels on the stage (before the clip's `scale`). */
export const MIN_SIDE = 8;
/** Rotation snaps to this many degrees with Shift. */
export const ROTATE_STEP = 15;
/** Distance (stage pixels) within which a moved edge or centre jumps to a guide. */
export const SNAP_PX = 6;

const SIGN: Record<Corner, readonly [number, number]> = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1] };
const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
/** Props are written with 3 decimals (rotation 2): enough for sub-pixel precision, short in the saved file. */
const r3 = (n: number) => Math.round(n * 1e3) / 1e3;
const r2 = (n: number) => Math.round(n * 1e2) / 1e2;

/** Rotates the vector `(x, y)` by `deg` degrees clockwise (the y axis points down). */
export function turn(x: number, y: number, degrees: number): Point {
  const c = Math.cos(rad(degrees)), s = Math.sin(rad(degrees));
  return { x: x * c - y * s, y: x * s + y * c };
}

/** A pointer movement in stage pixels as composition pixels. */
export const toComp = (px: number, scale: number): number => (scale > 0 ? px / scale : 0);

/** The props of a clip with the defaults the runtime applies (`fallback`: the size of a box with no width or height). */
export function resolveBox(props: Partial<BoxProps> | undefined, fallback: { width: number; height: number }): BoxProps {
  return {
    x: props?.x ?? 0, y: props?.y ?? 0, width: props?.width ?? fallback.width, height: props?.height ?? fallback.height,
    rotation: props?.rotation ?? 0, scale: props?.scale ?? 1,
  };
}

/** The centre of the box in composition pixels (unchanged by rotation and scale). */
export const centreOf = (b: BoxProps): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** The four corners of the box as drawn (scale and rotation applied), in composition pixels. */
export function cornersOf(b: BoxProps): Record<Corner, Point> {
  const c = centreOf(b);
  const hw = (b.width * b.scale) / 2, hh = (b.height * b.scale) / 2;
  const at = (sx: number, sy: number): Point => {
    const v = turn(sx * hw, sy * hh, b.rotation);
    return { x: c.x + v.x, y: c.y + v.y };
  };
  return { nw: at(-1, -1), ne: at(1, -1), se: at(1, 1), sw: at(-1, 1) };
}

/** The axis-aligned box around the drawn box. */
export function aabbOf(b: BoxProps): Rect {
  const cs = Object.values(cornersOf(b));
  const xs = cs.map((p) => p.x), ys = cs.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * The unrotated size (stage pixels) of a box turned by `rotation` whose axis-aligned bounds are `bounds`, or null when the
 * rotation leaves it ambiguous (near 45°, where the two sides cannot be told apart).
 */
export function sizeFromBounds(bounds: Pick<Rect, 'width' | 'height'>, rotation: number): { width: number; height: number } | null {
  const c = Math.abs(Math.cos(rad(rotation))), s = Math.abs(Math.sin(rad(rotation)));
  const det = c * c - s * s;
  if (Math.abs(det) < 0.05) return null;
  const width = (bounds.width * c - bounds.height * s) / det;
  const height = (bounds.height * c - bounds.width * s) / det;
  return width > 0 && height > 0 ? { width, height } : null;
}

// ---------- gestures ----------

/** Move: the same distance the pointer went. */
export function movePatch(start: BoxProps, dx: number, dy: number, scale: number): Pick<BoxProps, 'x' | 'y'> {
  return { x: r3(start.x + toComp(dx, scale)), y: r3(start.y + toComp(dy, scale)) };
}

export interface ResizeOptions { keepAspect?: boolean }

/**
 * Resize from `corner`: the opposite corner stays where it is on the stage, whatever the rotation and the scale. The pointer
 * movement is taken in the clip's own (rotated) frame. With `keepAspect` the box keeps its ratio (the movement is projected
 * on the diagonal). The result never makes a side smaller than MIN_SIDE.
 */
export function resizePatch(
  start: BoxProps, corner: Corner, dx: number, dy: number, scale: number, o: ResizeOptions = {},
): Pick<BoxProps, 'x' | 'y' | 'width' | 'height'> {
  const s = start.scale;
  const [sx, sy] = SIGN[corner];
  const wv = start.width * s, hv = start.height * s; // the sides as drawn
  if (!(s > 0) || !(wv > 0) || !(hv > 0) || !(scale > 0)) return { x: start.x, y: start.y, width: start.width, height: start.height };
  const local = turn(toComp(dx, scale), toComp(dy, scale), -start.rotation);
  let nw = wv + sx * local.x, nh = hv + sy * local.y;
  if (o.keepAspect) {
    const f = Math.max(1 + (sx * local.x * wv + sy * local.y * hv) / (wv * wv + hv * hv), MIN_SIDE / Math.min(wv, hv));
    nw = wv * f; nh = hv * f;
  } else {
    nw = Math.max(nw, MIN_SIDE); nh = Math.max(nh, MIN_SIDE);
  }
  const c = centreOf(start);
  // The fixed corner, then the new centre from it.
  const fixed = turn(-sx * wv / 2, -sy * hv / 2, start.rotation);
  const anchor = { x: c.x + fixed.x, y: c.y + fixed.y };
  const away = turn(sx * nw / 2, sy * nh / 2, start.rotation);
  const centre = { x: anchor.x + away.x, y: anchor.y + away.y };
  const width = nw / s, height = nh / s;
  return { x: r3(centre.x - width / 2), y: r3(centre.y - height / 2), width: r3(width), height: r3(height) };
}

/** The angle (degrees, clockwise from the +x axis) of `p` seen from `centre`. */
export const angleOf = (centre: Point, p: Point): number => deg(Math.atan2(p.y - centre.y, p.x - centre.x));

/** Wraps an angle to (-180, 180]. */
export function wrapAngle(a: number): number {
  const w = ((((a + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
}

/**
 * Rotate about the box centre (`centre`, stage pixels): the clip turns by the angle the pointer swept around it. With
 * `snap` the result is a multiple of ROTATE_STEP. The position is not touched: the centre stays.
 */
export function rotatePatch(start: BoxProps, centre: Point, from: Point, to: Point, o: { snap?: boolean } = {}): Pick<BoxProps, 'rotation'> {
  let next = start.rotation + (angleOf(centre, to) - angleOf(centre, from));
  if (o.snap) next = Math.round(next / ROTATE_STEP) * ROTATE_STEP;
  return { rotation: r2(wrapAngle(next)) };
}

// ---------- snap guides ----------

/** The lines a drag snaps to, in composition pixels: the frame's centre and edges and those of the safe area. */
export interface GuideLines { x: number[]; y: number[] }
export function guideLines(width: number, height: number, safe?: SafeZone): GuideLines {
  const x = [0, width / 2, width], y = [0, height / 2, height];
  if (safe) {
    x.push(safe.left, width - safe.right);
    y.push(safe.top, height - safe.bottom);
  }
  return { x: [...new Set(x)].sort((a, b) => a - b), y: [...new Set(y)].sort((a, b) => a - b) };
}

/** The closest line to any of `values` within `threshold`: how far to move (target − value), and the line. */
function closest(values: number[], lines: number[], threshold: number): { by: number; line: number } | null {
  let best: { by: number; line: number } | null = null;
  for (const v of values) for (const line of lines) {
    const d = line - v;
    if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best.by))) best = { by: d, line };
  }
  return best;
}

export interface Snapped { dx: number; dy: number; guides: { axis: 'x' | 'y'; at: number }[] }

/**
 * Snaps a move: of the drawn box's left, centre and right (top, middle, bottom) the one closest to a guide within
 * `thresholdPx` jumps onto it. Returns the pointer movement (stage pixels) to use instead, and the guides now touched.
 */
export function snapMove(start: BoxProps, dx: number, dy: number, scale: number, lines: GuideLines, thresholdPx = SNAP_PX): Snapped {
  const moved = { ...start, ...movePatch(start, dx, dy, scale) };
  const box = aabbOf(moved);
  const limit = toComp(thresholdPx, scale);
  const sx = closest([box.x, box.x + box.width / 2, box.x + box.width], lines.x, limit);
  const sy = closest([box.y, box.y + box.height / 2, box.y + box.height], lines.y, limit);
  const guides: Snapped['guides'] = [];
  if (sx) guides.push({ axis: 'x', at: sx.line });
  if (sy) guides.push({ axis: 'y', at: sy.line });
  return { dx: dx + (sx ? sx.by * scale : 0), dy: dy + (sy ? sy.by * scale : 0), guides };
}

/**
 * Snaps the moving corner of a resize (a box that is not rotated only: a turned box has no edge to line up). Returns the
 * pointer movement to use, and the guides touched.
 */
export function snapResize(start: BoxProps, corner: Corner, dx: number, dy: number, scale: number, lines: GuideLines, thresholdPx = SNAP_PX): Snapped {
  if (Math.abs(wrapAngle(start.rotation)) > 1e-9 || !(scale > 0)) return { dx, dy, guides: [] };
  const at = cornersOf(start)[corner];
  const limit = toComp(thresholdPx, scale);
  const sx = closest([at.x + toComp(dx, scale)], lines.x, limit);
  const sy = closest([at.y + toComp(dy, scale)], lines.y, limit);
  const guides: Snapped['guides'] = [];
  if (sx) guides.push({ axis: 'x', at: sx.line });
  if (sy) guides.push({ axis: 'y', at: sy.line });
  return { dx: dx + (sx ? sx.by * scale : 0), dy: dy + (sy ? sy.by * scale : 0), guides };
}

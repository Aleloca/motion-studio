// The timeline's arithmetic (Phase 10b, Task 7): time <-> pixels at a zoom level, zoom anchored at a point, snapping a
// dragged clip's edges, the timing a move or a trim asks for, and the ruler's ticks. Pure. Like stageMath, every function
// takes the state a gesture STARTED with and the total movement since, so nothing accumulates.
import { COMPOSITION_LIMITS, snapTime, type Composition, type Clip } from '@motion-studio/shared';

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 20;
/** Distance (screen pixels) within which a dragged edge jumps to a snap target. */
export const SNAP_PX = 8;
/** Pointer movement (pixels) before a press on a clip becomes a drag: a click is no edit. */
export const DRAG_SLOP = 3;

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

export const clampZoom = (z: number): number => clamp(Number.isFinite(z) ? z : 1, ZOOM_MIN, ZOOM_MAX);
/** Pixels per second when the whole composition fits `viewportPx` at zoom 1. */
export const pxPerSec = (viewportPx: number, duration: number, zoom: number): number => (duration > 0 && viewportPx > 0 ? (viewportPx * clampZoom(zoom)) / duration : 0);
export const timeToPx = (t: number, pps: number): number => t * pps;
export const pxToTime = (px: number, pps: number): number => (pps > 0 ? px / pps : 0);
/** The smallest clip, rounded up so a clamped clip is never shorter than a frame (as `applyEdit` does). */
export const minDuration = (fps: number): number => Math.ceil(1e6 / fps) / 1e6;
export const frameRound = (t: number, fps: number): number => r6(Math.round(t * fps) / fps);

/** The slider is linear in the logarithm of the zoom (0 to 100 for 1x to 20x): every step is the same factor. */
export const sliderToZoom = (v: number): number => clampZoom(ZOOM_MAX ** (clamp(v, 0, 100) / 100));
export const zoomToSlider = (z: number): number => Math.round((Math.log(clampZoom(z)) / Math.log(ZOOM_MAX)) * 100);

/**
 * The zoom and horizontal scroll after changing to `next`, keeping the time under `anchorPx` (a pixel of the viewport, from its
 * left edge) where it is.
 */
export function zoomAt(o: { zoom: number; next: number; scrollLeft: number; anchorPx: number; viewportPx: number; duration: number }): { zoom: number; scrollLeft: number } {
  const zoom = clampZoom(o.next);
  const before = pxPerSec(o.viewportPx, o.duration, o.zoom);
  const after = pxPerSec(o.viewportPx, o.duration, zoom);
  if (before <= 0 || after <= 0) return { zoom, scrollLeft: 0 };
  const t = (o.scrollLeft + o.anchorPx) / before;
  const max = Math.max(0, o.duration * after - o.viewportPx);
  return { zoom, scrollLeft: clamp(t * after - o.anchorPx, 0, max) };
}

/**
 * Snaps the closest of `edges` (times) to the closest of `targets` within `SNAP_PX` at `pps`; `enabled` false (Alt, or the
 * magnet off) leaves them as they are. `delta` is what to add to the edges.
 */
export function snapEdges(edges: number[], targets: number[], pps: number, enabled: boolean): { delta: number; snappedTo: number | null } {
  if (!enabled || pps <= 0) return { delta: 0, snappedTo: null };
  const threshold = SNAP_PX / pps;
  let best: { delta: number; snappedTo: number } | null = null;
  for (const edge of edges) {
    const s = snapTime(edge, targets, threshold);
    if (s.snappedTo === null) continue;
    const delta = s.snappedTo - edge;
    if (best === null || Math.abs(delta) < Math.abs(best.delta) - 1e-9) best = { delta, snappedTo: s.snappedTo };
  }
  return best ?? { delta: 0, snappedTo: null };
}

/** The range a clip may occupy: its scene, else the whole composition. With `ripple` the end may grow (later scenes shift). */
export function clipBounds(c: Composition, clip: Clip, ripple: boolean): { lo: number; hi: number } {
  const scene = clip.scene !== undefined ? c.scenes.find((s) => s.id === clip.scene) : undefined;
  const lo = scene ? scene.start : 0;
  const hi = scene ? scene.start + scene.duration : c.duration;
  return { lo, hi: ripple && scene ? COMPOSITION_LIMITS.durationSec : hi };
}

export type Timing = { start: number; duration: number };

/** A body move: the start `want`, the duration kept; the clip stays inside `bounds`. */
export function moveTiming(from: Timing, want: number, bounds: { lo: number; hi: number }): Timing {
  const start = clamp(want, bounds.lo, bounds.hi - from.duration);
  return { start: r6(start), duration: from.duration };
}

/** A timing on whole frames: the start and the duration rounded to 1/fps, the clip keeping at least one frame. */
export function frameTiming(t: Timing, fps: number): Timing {
  return { start: frameRound(t.start, fps), duration: Math.max(frameRound(t.duration, fps), minDuration(fps)) };
}

/** An edge trim to time `want`: the other edge stays, the clip keeps at least one frame and stays inside `bounds`. */
export function trimTiming(from: Timing, edge: 'start' | 'end', want: number, bounds: { lo: number; hi: number }, fps: number): Timing {
  const min = minDuration(fps);
  const end = from.start + from.duration;
  if (edge === 'start') {
    const start = clamp(want, bounds.lo, end - min);
    return { start: r6(start), duration: r6(end - start) };
  }
  const to = clamp(want, from.start + min, bounds.hi);
  return { start: from.start, duration: r6(to - from.start) };
}

/** Ticks of the ruler for the visible range [t0, t1]: labelled seconds (spaced at least `MIN_LABEL_PX`) and, when zoomed in, frames. */
export const MIN_LABEL_PX = 72;
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
export function rulerTicks(pps: number, fps: number, t0: number, t1: number): { step: number; major: number[]; frames: number[] } {
  if (pps <= 0 || t1 <= t0) return { step: 1, major: [], frames: [] };
  const step = STEPS.find((s) => s * pps >= MIN_LABEL_PX) ?? 600;
  const list = (every: number): number[] => {
    const out: number[] = [];
    for (let i = Math.max(0, Math.floor(t0 / every)); i * every <= t1 + 1e-9; i += 1) out.push(r6(i * every));
    return out;
  };
  const major = list(step);
  // Frame ticks when a frame is at least 6 px wide; those that fall on a major tick are drawn by it.
  const frames = pps / fps >= 6 ? list(1 / fps).filter((t) => !major.some((m) => Math.abs(m - t) < 1e-6)) : [];
  return { step, major, frames };
}

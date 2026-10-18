// The canvas zoom without a toolbar (decision 973): a trackpad pinch (Chromium and Electron send it as a wheel event with
// ctrlKey) zooms around the pointer, two-finger scrolling keeps scrolling, and ⌘+ / ⌘− / ⌘0 (Ctrl elsewhere) step and fit.
import { isMac } from '../platform.ts';

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
/** A wheel delta this large (a mouse notch is ~100) is taken as this much: one notch is a moderate step, never a jump. */
const MAX_PINCH_DELTA = 40;

const clamp = (z: number, min: number, max: number) => Math.min(max, Math.max(min, z));

/** The zoom after one pinch event of `deltaY` (negative: fingers apart, zoom in), kept within the limits. */
export function pinchZoom(z: number, deltaY: number, min = ZOOM_MIN, max = ZOOM_MAX): number {
  const d = clamp(deltaY, -MAX_PINCH_DELTA, MAX_PINCH_DELTA);
  return clamp(Math.round(z * Math.exp(-d / 100) * 1000) / 1000, min, max);
}

/**
 * The scroll that keeps the world point under the pointer where it is when the zoom goes from `z0` to `z1` (the world grows
 * with the zoom). `pointer` is relative to the viewport's top-left corner. Never negative.
 */
export function scrollAfterZoom(scroll: { left: number; top: number }, pointer: { x: number; y: number }, z0: number, z1: number): { left: number; top: number } {
  const k = z1 / z0;
  return { left: Math.max(0, (scroll.left + pointer.x) * k - pointer.x), top: Math.max(0, (scroll.top + pointer.y) * k - pointer.y) };
}

/** ⌘+ (`dir` 1) or ⌘− (-1): 10% steps, rounded to 5%, within the limits. */
export function stepZoom(z: number, dir: 1 | -1, min = ZOOM_MIN, max = ZOOM_MAX): number {
  return clamp(Math.round((z + dir * ZOOM_STEP) * 20) / 20, min, max);
}

/** The zoom shortcut of a key event: ⌘ on a Mac, Ctrl elsewhere, never with Alt; `=` or `+` in, `-` out, `0` fit. */
export function zoomKey(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>, mac: boolean = isMac()): 'in' | 'out' | 'fit' | null {
  if (e.altKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey)) return null;
  if (e.key === '=' || e.key === '+') return 'in';
  if (e.key === '-' || e.key === '_') return 'out';
  if (e.key === '0') return 'fit';
  return null;
}

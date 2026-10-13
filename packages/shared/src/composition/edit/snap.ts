import type { Composition } from '../schema.ts';

const r = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Snaps `t` to the nearest of `targets` within `thresholdSec` (inclusive). Of two targets at the same distance the earlier
 * one wins. `snappedTo` is the target, or null when none is close enough (then `t` is returned as it is).
 */
export function snapTime(t: number, targets: number[], thresholdSec: number): { t: number; snappedTo: number | null } {
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const target of targets) {
    const d = Math.abs(target - t);
    if (d > thresholdSec + 1e-9) continue;
    if (d < bestDistance - 1e-9 || (Math.abs(d - bestDistance) <= 1e-9 && best !== null && target < best)) { best = target; bestDistance = d; }
  }
  return best === null ? { t, snappedTo: null } : { t: best, snappedTo: best };
}

/** The times a drag snaps to: 0, the duration, scene bounds and the edges of every clip but `exceptClipId`; sorted, no duplicates. */
export function snapTargets(c: Composition, exceptClipId?: string): number[] {
  const set = new Set<number>([0, r(c.duration)]);
  for (const s of c.scenes) { set.add(r(s.start)); set.add(r(s.start + s.duration)); }
  for (const t of c.tracks) for (const k of t.clips) {
    if (k.id === exceptClipId) continue;
    set.add(r(k.start)); set.add(r(k.start + k.duration));
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * What a composition figure should be doing, from where it is and what we know about it.
 * @param {{ visible: boolean, near: boolean, reducedMotion: boolean, ready: boolean, failed: boolean }} s
 * @returns {'unmounted' | 'mount' | 'unmount' | 'play' | 'pause' | 'still' | 'poster'}
 */
export function decide(s) {
  if (s.failed) return 'poster';
  if (s.ready) {
    // Far from the screen a live runtime only costs memory: drop it, the poster covers the frame until it is back.
    if (!s.near) return 'unmount';
    if (s.reducedMotion) return 'still';
    return s.visible ? 'play' : 'pause';
  }
  return s.near ? 'mount' : 'unmounted';
}

/** Share of a figure that must be on screen for it to play. */
export const VISIBLE_RATIO = 0.25;

/** @param {{ isIntersecting: boolean, intersectionRatio: number }} entry an IntersectionObserver entry */
export const isVisible = (entry) => entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO;

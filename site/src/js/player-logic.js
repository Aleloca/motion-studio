/**
 * What a composition figure should be doing, from where it is and what we know about it.
 * `still` holds the poster frame (a board being edited by hand); `intent` is the viewer's own play or pause (the final
 * cut's controls): a pause holds wherever it is, a play plays even under reduced motion.
 * @param {{ visible: boolean, near: boolean, reducedMotion: boolean, ready: boolean, failed: boolean, still?: boolean, intent?: 'play' | 'pause' | null }} s
 * @returns {'unmounted' | 'mount' | 'unmount' | 'play' | 'pause' | 'still' | 'poster'}
 */
export function decide(s) {
  if (s.failed) return 'poster';
  if (s.ready) {
    // Far from the screen a live runtime only costs memory: drop it, the poster covers the frame until it is back.
    if (!s.near) return 'unmount';
    if (s.intent === 'pause') return 'pause';
    if (s.still || (s.reducedMotion && s.intent !== 'play')) return 'still';
    return s.visible ? 'play' : 'pause';
  }
  return s.near ? 'mount' : 'unmounted';
}

/** Share of a figure that must be on screen for it to play. */
export const VISIBLE_RATIO = 0.25;

/** @param {{ isIntersecting: boolean, intersectionRatio: number }} entry an IntersectionObserver entry */
export const isVisible = (entry) => entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO;

/**
 * What a composition figure should be doing, from where it is and what we know about it.
 * @param {{ visible: boolean, near: boolean, reducedMotion: boolean, ready: boolean, failed: boolean }} s
 * @returns {'unmounted' | 'mount' | 'play' | 'pause' | 'still' | 'poster'}
 */
export function decide(s) {
  if (s.failed) return 'poster';
  if (s.ready) {
    if (s.reducedMotion) return 'still';
    return s.visible ? 'play' : 'pause';
  }
  return s.near ? 'mount' : 'unmounted';
}

// Pure rules of the home's gallery (gallery.js): which boards play and which keep a live runtime. Tested in
// site/test/gallery.test.mjs.

/** At most this many boards play at once, and this many runtimes stay mounted (the playing ones first). */
export const GALLERY_LIMITS = { playing: 4, mounted: 6, ratio: 1 / 3 };

/**
 * @param {{ ratio: number, near: boolean }[]} boards each board's share on screen and whether it is near it
 * @param {{ reducedMotion?: boolean }} [options] under reduced motion nothing mounts: every board keeps its poster
 * @returns {{ playing: Set<number>, mounted: Set<number> }} board indexes
 */
export function pickGallery(boards, { reducedMotion = false } = {}) {
  const playing = new Set();
  const mounted = new Set();
  if (reducedMotion) return { playing, mounted };
  const byShare = boards.map((b, i) => ({ ...b, i })).sort((a, b) => b.ratio - a.ratio || a.i - b.i);
  for (const b of byShare) if (b.ratio >= GALLERY_LIMITS.ratio && playing.size < GALLERY_LIMITS.playing) playing.add(b.i);
  for (const i of playing) mounted.add(i);
  for (const b of byShare) if (b.near && mounted.size < GALLERY_LIMITS.mounted) mounted.add(b.i);
  return { playing, mounted };
}

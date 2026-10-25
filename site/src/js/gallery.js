// The home's gallery: each board plays its composition while it is on screen, muted and looping, at most four at once
// (the most visible ones), with at most six runtimes mounted, and never past the page's budget of live runtimes (two on
// a phone, see player.js); the others hold their poster. Under reduced motion nothing
// mounts: the boards are their posters. The players are made by mountPlayers, which leaves these figures to us.
import { pickGallery } from './gallery-logic.js';

/** @param {import('./player.js').CompositionPlayer[]} players every player of the page */
export function startGallery(players, win = window) {
  const list = players.filter((p) => p.figure.hasAttribute('data-gallery'));
  const motion = win.matchMedia('(prefers-reduced-motion: reduce)');
  const state = new Map(list.map((p) => [p.figure, { ratio: 0, near: false }]));
  let queued = false;
  const apply = () => {
    queued = false;
    const reducedMotion = motion.matches;
    const { playing, mounted } = pickGallery(list.map((p) => state.get(p.figure)), { reducedMotion, budget: players.budget?.limit ?? Infinity });
    list.forEach((p, i) => p.update({ near: mounted.has(i), visible: playing.has(i), reducedMotion }));
  };
  const schedule = () => { if (!queued) { queued = true; win.requestAnimationFrame(apply); } };
  const seen = new win.IntersectionObserver((entries) => {
    for (const e of entries) state.get(e.target).ratio = e.isIntersecting ? e.intersectionRatio : 0;
    schedule();
  }, { threshold: Array.from({ length: 11 }, (_, i) => i / 10) });
  const near = new win.IntersectionObserver((entries) => {
    for (const e of entries) state.get(e.target).near = e.isIntersecting;
    schedule();
  }, { rootMargin: '60% 0px' });
  for (const p of list) { seen.observe(p.figure); near.observe(p.figure); }
  motion.addEventListener('change', schedule);
  return { players: list, get playing() { return list.filter((p) => p.playing).map((p) => p.id); } };
}

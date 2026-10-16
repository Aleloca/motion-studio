// Boot: live compositions everywhere; the page choreography only when motion is allowed. Without JS, or with reduced
// motion, the page is already in its final, readable state (the CSS default).
import { mountPlayers } from './player.js';
import { startMotion } from './motion.js';

const root = document.documentElement;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const debug = new URLSearchParams(location.search).has('debug');
const commands = [];
if (debug) window.__siteDebug = { commands };

const players = mountPlayers(document, debug ? { log: (m) => commands.push(m) } : {});

if (!reducedMotion && window.gsap && window.ScrollTrigger && window.SplitText) {
  root.classList.add('js-motion');
  document.fonts.ready.then(() => {
    startMotion({ reducedMotion, players });
    root.classList.add('motion-ready');
  });
} else {
  root.classList.remove('js-motion');
}

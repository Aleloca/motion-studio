// Boot: live compositions everywhere, the demos replaying their steps when motion is allowed, the two Play with sound
// controls, the final cut and the gallery. Without JS, or with reduced motion, every demo is drawn in its finished state
// (the HTML and CSS default) and the final cut waits on its poster for Play.
import { mountPlayers } from './player.js';
import { startScenes } from './scenes.js';
import { startSounds } from './sounds.js';
import { finalCut } from './final-cut.js';
import { soundSwitch } from './sound.js';
import { startGallery } from './gallery.js';

const root = document.documentElement;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const debug = new URLSearchParams(location.search).has('debug');
const commands = [];
const live = !reducedMotion && Boolean(window.gsap);

const players = mountPlayers(document, {
  ...(debug ? { log: (m) => commands.push(m) } : {}),
  // The gallery drives its own boards (at most four playing).
  manual: (figure) => figure.hasAttribute('data-gallery'),
});
// The final cut's sound switch: off until its Play.
const sound = soundSwitch();
const film = players.find((p) => p.figure.hasAttribute('data-controls'));
if (film) finalCut(film, sound);
const gallery = startGallery(players);

let scenes = [];
if (live) {
  root.classList.add('js-motion');
  scenes = startScenes({ gsap: window.gsap });
  root.classList.add('motion-ready');
} else {
  root.classList.remove('js-motion');
}
// One sound at a time: a demo's sound stops the film, the film's Play stops the demo's.
const sounds = startSounds({ players, scenes, film });
if (debug) window.__siteDebug = { commands, players, sound, gallery, budget: players.budget, scenes, sounds };

// Boot: live compositions everywhere; the story's canvas only when motion is allowed. Without JS, or with reduced motion,
// every step is already a static block (the CSS default) and the final cut waits on its poster for Play.
import { mountPlayers } from './player.js';
import { startStory } from './story.js';
import { finalCut } from './final-cut.js';
import { soundSwitch } from './sound.js';

const root = document.documentElement;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const debug = new URLSearchParams(location.search).has('debug');
const commands = [];
const live = !reducedMotion && Boolean(window.gsap && window.ScrollTrigger);
const inStage = (figure) => Boolean(figure.closest('[data-stage]'));

const players = mountPlayers(document, {
  ...(debug ? { log: (m) => commands.push(m) } : {}),
  // The canvas's boards are driven by the story, step by step; without it they are never shown (nor mounted).
  manual: inStage,
});
// One sound switch for the page: the story's voice-over and the final cut.
const sound = soundSwitch();
for (const p of players) if (p.figure.hasAttribute('data-controls')) finalCut(p, sound);

if (live) {
  root.classList.add('js-motion');
  window.gsap.registerPlugin(window.ScrollTrigger);
  document.fonts.ready.then(() => {
    const story = startStory({ gsap: window.gsap, ScrollTrigger: window.ScrollTrigger, players, sound });
    if (debug) window.__siteDebug.story = story;
    root.classList.add('motion-ready');
  });
} else {
  root.classList.remove('js-motion');
}
if (debug) window.__siteDebug = { commands, players, sound };

// Pure helpers of the home's demos (scenes.js): the typed request, a label's state at a time, what a demo does as it
// comes on and off screen, the subtitle line being said. Tested in site/test/story.test.mjs.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Share of a demo that must be on screen for it to play. */
export const PLAY_RATIO = 0.35;

/** A request typed into its bubble: the first `p` (0-1) of its letters. */
export const typed = (text, p) => text.slice(0, Math.round(clamp(p, 0, 1) * text.length));

/**
 * The state a label shows at time `t` of its scene: the last mark reached (the first one before any).
 * @param {[number, string][]} marks [time, label], in time order
 */
export const labelAt = (marks, t) => (marks.filter(([at]) => t >= at).at(-1) ?? marks[0])[1];

/**
 * What a demo does as the share of it on screen changes: it plays while enough of it shows, and pauses otherwise. Once it
 * has left the screen entirely, its next visit plays it from its start (a visitor never lands mid-way through a step);
 * scrolled only partly away and back, it goes on where it was.
 * @param {{ playing: boolean, left: boolean }} state `left`: off screen entirely since it last played
 * @param {number} ratio the share of it on screen (0-1)
 * @returns {{ playing: boolean, restart: boolean, left: boolean }}
 */
export function viewChange(state, ratio) {
  if (ratio >= PLAY_RATIO) return { playing: true, restart: state.left, left: false };
  return { playing: false, restart: false, left: state.left || ratio === 0 };
}

/** Which subtitle lines are being said at time `t` (seconds) of the board. */
export const cuesOn = (cues, t) => cues.map((c) => t >= c.start && t < c.end);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, isVisible } from '../src/js/player-logic.js';
import { CompositionPlayer, READY_TIMEOUT_MS, liveBudget, LIVE_BUDGET } from '../src/js/player.js';

const S = (o) => ({ visible: false, near: false, reducedMotion: false, ready: false, failed: false, ...o });

test('decide table', () => {
  assert.equal(decide(S({ failed: true, near: true, ready: true, visible: true })), 'poster');
  assert.equal(decide(S({})), 'unmounted');
  assert.equal(decide(S({ near: true })), 'mount');
  assert.equal(decide(S({ near: true, ready: true, reducedMotion: true, visible: true })), 'still');
  assert.equal(decide(S({ near: true, ready: true, visible: true })), 'play');
  assert.equal(decide(S({ near: true, ready: true })), 'pause');
  assert.equal(decide(S({ ready: true, visible: false })), 'unmount');
  assert.equal(decide(S({ ready: true, reducedMotion: true })), 'unmount');
  // A board held still (edited by hand), and the viewer's own play or pause (the final cut).
  assert.equal(decide(S({ near: true, ready: true, visible: true, still: true })), 'still');
  assert.equal(decide(S({ near: true, ready: true, visible: true, intent: 'pause' })), 'pause');
  assert.equal(decide(S({ near: true, ready: true, visible: true, reducedMotion: true, intent: 'play' })), 'play');
  assert.equal(decide(S({ near: true, ready: true, visible: false, intent: 'play' })), 'pause');
  assert.equal(decide(S({ ready: true, intent: 'play' })), 'unmount');
});

const ORIGIN = 'https://aleloca.github.io';

/** A player wired to fakes: a figure, an iframe window that records commands, and a manual clock. */
function harness({ posterTime = 2, replay, loopFrom, loop, autoplay } = {}) {
  const sent = [];
  const timers = [];
  const classes = new Set();
  const frame = { contentWindow: { postMessage: (m, origin) => sent.push({ m, origin }) }, removed: false, remove() { this.removed = true; } };
  let mounts = 0;
  const figure = { dataset: { composition: 'kova-16x9', posterTime: String(posterTime), ...(replay ? { replay } : {}), ...(loopFrom ? { loopFrom } : {}), ...(loop ? { loop } : {}), ...(autoplay ? { autoplay } : {}) }, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  const player = new CompositionPlayer(figure, {
    origin: ORIGIN,
    mount: (src) => { mounts++; frame.src = src; return frame; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  });
  const fire = () => timers.splice(0).forEach((t) => t.fn?.());
  const msg = (data, o = {}) => player.onMessage({ data, origin: ORIGIN, source: frame.contentWindow, ...o });
  return { player, sent, frame, classes, fire, msg, mounts: () => mounts, types: () => sent.map((s) => s.m.type) };
}

test('mounts the runtime page in preview mode with the parent origin', () => {
  const h = harness();
  h.player.update(S({ near: true }));
  assert.equal(h.mounts(), 1);
  assert.equal(h.frame.src, `runtime/kova-16x9.html?mode=preview&parentOrigin=${encodeURIComponent(ORIGIN)}`);
  h.player.update(S({ near: true, visible: true }));
  assert.equal(h.mounts(), 1, 'mounted once');
});

test('mounts within 1 viewport margin, pauses when hidden', () => {
  const h = harness();
  h.player.update(S({}));
  assert.equal(h.mounts(), 0);
  h.player.update(S({ near: true }));
  h.msg({ type: 'ready' });
  h.player.update(S({ near: true, visible: true }));
  h.player.update(S({ near: true, visible: false }));
  assert.deepEqual(h.types(), ['setScale', 'mute', 'seek', 'play', 'pause']);
  assert.deepEqual(h.sent[0].m, { type: 'setScale', scale: 'fit' });
  assert.deepEqual(h.sent[1].m, { type: 'mute', muted: true });
  assert.deepEqual(h.sent[2].m, { type: 'seek', t: 2 });
  assert.deepEqual(h.sent[3].m, { type: 'play', loop: true });
  assert.ok(h.sent.every((s) => s.origin === ORIGIN));
});

test('reduced motion seeks to posterTime and never plays', () => {
  const h = harness({ posterTime: 3.5 });
  h.player.update(S({ near: true, visible: true, reducedMotion: true }));
  h.msg({ type: 'ready' });
  h.player.update(S({ near: true, visible: true, reducedMotion: true }));
  assert.ok(!h.types().includes('play'));
  assert.deepEqual(h.sent.filter((s) => s.m.type === 'seek').map((s) => s.m), [{ type: 'seek', t: 3.5 }]);
});

test('turning reduced motion on while playing pauses on the poster frame', () => {
  const h = harness({ posterTime: 1 });
  h.player.update(S({ near: true, visible: true }));
  h.msg({ type: 'ready' });
  h.player.update(S({ near: true, visible: true, reducedMotion: true }));
  assert.deepEqual(h.types().slice(-2), ['pause', 'seek']);
});

test('fallback to poster on error and timeout', () => {
  const a = harness();
  a.player.update(S({ near: true }));
  a.msg({ type: 'error', error: { code: 'fontLoadFailed', message: 'x' } });
  assert.ok(a.frame.removed && a.classes.has('is-failed') && !a.classes.has('is-ready'));
  a.player.update(S({ near: true, visible: true }));
  assert.equal(a.mounts(), 1, 'a failed player never mounts again');

  const b = harness();
  b.player.update(S({ near: true }));
  b.fire();
  assert.ok(b.frame.removed && b.classes.has('is-failed'));
  assert.equal(READY_TIMEOUT_MS, 20000);

  const c = harness();
  c.player.update(S({ near: true }));
  c.msg({ type: 'ready' });
  c.fire();
  assert.ok(!c.frame.removed, 'ready cancels the timeout');
});

test('a runtime error after ready keeps playing (the runtime reports asset warnings too)', () => {
  const h = harness();
  h.player.update(S({ near: true, visible: true }));
  h.msg({ type: 'ready' });
  h.msg({ type: 'error', error: { code: 'imageLoadFailed', message: 'x' } });
  assert.ok(!h.frame.removed);
});

test('ignores messages from other sources or origins', () => {
  const h = harness();
  h.player.update(S({ near: true, visible: true }));
  h.msg({ type: 'ready' }, { origin: 'https://evil.example' });
  h.msg({ type: 'ready' }, { source: {} });
  h.msg('ready');
  assert.deepEqual(h.types(), []);
});

test('visible means at least a quarter of the figure on screen, not the first pixel', () => {
  assert.equal(isVisible({ isIntersecting: true, intersectionRatio: 0.01 }), false);
  assert.equal(isVisible({ isIntersecting: true, intersectionRatio: 0.25 }), true);
  assert.equal(isVisible({ isIntersecting: false, intersectionRatio: 0 }), false);
});

test('a ready player that leaves the near margin unmounts, and mounts again on return', () => {
  const h = harness();
  h.player.update(S({ near: true, visible: true }));
  h.msg({ type: 'ready' });
  h.player.update(S({ near: false, visible: false }));
  assert.ok(h.frame.removed, 'iframe removed when far away');
  assert.ok(!h.classes.has('is-ready'), 'poster shown again');
  assert.ok(!h.classes.has('is-failed'));
  h.frame.removed = false;
  h.player.update(S({ near: true }));
  assert.equal(h.mounts(), 2, 'mounted again');
  h.msg({ type: 'ready' });
  h.player.update(S({ near: true, visible: true }));
  assert.equal(h.types().filter((t) => t === 'play').length, 2);
});

test('a player still loading that leaves the near margin cancels its load, without failing', () => {
  const h = harness();
  h.player.update(S({ near: true }));
  h.player.update(S({ near: false }));
  assert.ok(h.frame.removed, 'loading iframe removed');
  h.fire();
  assert.ok(!h.classes.has('is-failed'), 'the cancelled timeout never fails it');
  h.player.update(S({ near: true }));
  assert.equal(h.mounts(), 2);
});

test('the poster stays until the runtime reports a played frame', () => {
  const h = harness();
  h.player.update(S({ near: true, visible: true }));
  h.msg({ type: 'ready' });
  assert.ok(!h.classes.has('is-ready'), 'ready alone keeps the poster');
  h.msg({ type: 'time', t: 2, playing: false });
  assert.ok(!h.classes.has('is-ready'), 'a paused frame keeps the poster');
  h.msg({ type: 'time', t: 2.03, playing: true });
  assert.ok(!h.classes.has('is-ready'), 'one played frame: the poster stays (the frame may not be painted yet)');
  h.msg({ type: 'time', t: 2.06, playing: true });
  assert.ok(h.classes.has('is-ready'), 'frames moving on: the live frame takes over');
});

test('on ready it starts from the poster frame, so the handoff matches the poster', () => {
  const h = harness({ posterTime: 3.2 });
  h.player.update(S({ near: true, visible: true }));
  h.msg({ type: 'ready' });
  assert.deepEqual(h.sent.map((s) => s.m), [{ type: 'setScale', scale: 'fit' }, { type: 'mute', muted: true }, { type: 'seek', t: 3.2 }, { type: 'play', loop: true }]);
});

test('a timed-out player retries once it has left and comes back; an errored one stays on its poster', () => {
  const t = harness();
  t.player.update(S({ near: true }));
  t.fire();
  assert.ok(t.classes.has('is-failed'));
  t.player.update(S({ near: false }));
  assert.ok(!t.classes.has('is-failed'), 'cleared once far away');
  t.player.update(S({ near: true }));
  assert.equal(t.mounts(), 2, 'tries again');

  const e = harness();
  e.player.update(S({ near: true }));
  e.msg({ type: 'error', error: { code: 'compositionInvalid', message: 'x' } });
  e.player.update(S({ near: false }));
  e.player.update(S({ near: true }));
  assert.equal(e.mounts(), 1);
  assert.ok(e.classes.has('is-failed'));
});

test('restart: back to the first frame, playing again when it was playing', () => {
  const h = harness();
  h.player.update(S({ near: true }));
  assert.equal(h.player.restart(), false, 'not ready yet');
  h.msg({ type: 'ready' });
  h.player.update(S({ near: true, visible: true }));
  h.sent.length = 0;
  assert.equal(h.player.restart(), true);
  assert.deepEqual(h.sent.map((s) => s.m), [{ type: 'seek', t: 0 }, { type: 'play', loop: true }]);
});

test('restart while paused only seeks; the next play starts from there', () => {
  const h = harness();
  h.player.update(S({ near: true }));
  h.msg({ type: 'ready' });
  h.player.update(S({ near: true, visible: false }));
  h.sent.length = 0;
  assert.equal(h.player.restart(), true);
  assert.deepEqual(h.sent.map((s) => s.m), [{ type: 'seek', t: 0 }]);
  h.player.update(S({ near: true, visible: true }));
  assert.deepEqual(h.sent.map((s) => s.m.type), ['seek', 'play']);
});

test('restart leaves a failed player on its poster', () => {
  const h = harness();
  h.player.update(S({ near: true }));
  h.msg({ type: 'error', error: { code: 'compositionInvalid', message: 'x' } });
  h.sent.length = 0;
  assert.equal(h.player.restart(), false);
  assert.deepEqual(h.sent, []);
});

test('data-replay="poster": every return to the screen plays again from the poster frame', () => {
  const h = harness({ posterTime: 4.4, replay: 'poster' });
  h.player.update(S({ near: true }));
  h.msg({ type: 'ready' });
  h.player.update(S({ near: true, visible: true }));
  h.player.update(S({ near: true, visible: false }));
  h.player.update(S({ near: true, visible: true }));
  assert.deepEqual(h.types(), ['setScale', 'mute', 'seek', 'play', 'pause', 'seek', 'play']);
  assert.deepEqual(h.sent[5].m, { type: 'seek', t: 4.4 });
});

test('without data-replay a player resumes where it paused', () => {
  const h = harness();
  h.player.update(S({ near: true }));
  h.msg({ type: 'ready' });
  h.player.update(S({ near: true, visible: true }));
  h.player.update(S({ near: true, visible: false }));
  h.player.update(S({ near: true, visible: true }));
  assert.deepEqual(h.types(), ['setScale', 'mute', 'seek', 'play', 'pause', 'play']);
});

test('data-loop-from: when the film wraps to its start it jumps past the empty opening, and plays on', () => {
  const h = harness({ posterTime: 5, loopFrom: '2.5' });
  h.player.update(S({ near: true }));
  h.msg({ type: 'ready' });
  h.player.update(S({ near: true, visible: true }));
  h.msg({ type: 'time', t: 5.1, playing: true });
  h.msg({ type: 'time', t: 6.98, playing: true });
  assert.deepEqual(h.types(), ['setScale', 'mute', 'seek', 'play']);
  h.msg({ type: 'time', t: 0.02, playing: true });
  assert.deepEqual(h.types(), ['setScale', 'mute', 'seek', 'play', 'seek', 'play']);
  assert.deepEqual(h.sent[4].m, { type: 'seek', t: 2.5 });
  h.msg({ type: 'time', t: 2.52, playing: true });
  h.msg({ type: 'time', t: 3, playing: true });
  assert.equal(h.types().length, 6, 'no jump while it plays forward from there');
});

test('without data-loop-from the film loops from its start untouched', () => {
  const h = harness({ posterTime: 5 });
  h.player.update(S({ near: true }));
  h.msg({ type: 'ready' });
  h.player.update(S({ near: true, visible: true }));
  h.msg({ type: 'time', t: 6.98, playing: true });
  h.msg({ type: 'time', t: 0.02, playing: true });
  assert.deepEqual(h.types(), ['setScale', 'mute', 'seek', 'play']);
});

test('a board held still pauses on its poster frame, and plays on when released', () => {
  const h = harness({ posterTime: 4 });
  h.player.update(S({ near: true, visible: true }));
  h.msg({ type: 'ready', duration: 8, scenes: [] });
  h.player.update({ still: true });
  assert.deepEqual(h.types().slice(-2), ['pause', 'seek']);
  h.player.update({ still: false });
  assert.equal(h.types().at(-1), 'play');
});

test('ready reports the duration and scenes; time and play state reach the listeners', () => {
  const h = harness();
  const seen = [];
  h.player.onChange((p) => seen.push([p.time, p.playing]));
  h.player.update(S({ near: true, visible: true }));
  h.msg({ type: 'ready', duration: 12, scenes: [{ id: 'a', start: 0, duration: 12 }] });
  assert.equal(h.player.duration, 12);
  assert.equal(h.player.scenes.length, 1);
  h.msg({ type: 'time', t: 3.5, playing: true });
  assert.deepEqual(seen.at(-1), [3.5, true]);
});

test('a film played once (data-loop="false") stops at its end; Play starts it again from 0', () => {
  const h = harness({ loop: 'false', posterTime: 1 });
  h.player.update(S({ near: true, visible: true }));
  h.msg({ type: 'ready', duration: 10, scenes: [] });
  assert.deepEqual(h.sent.at(-1).m, { type: 'play', loop: false });
  h.msg({ type: 'time', t: 10, playing: false });
  assert.equal(h.player.ended, true);
  assert.equal(h.player.playing, false);
  h.player.update({ intent: 'play' });
  assert.deepEqual(h.sent.slice(-2).map((s) => s.m), [{ type: 'seek', t: 0 }, { type: 'play', loop: false }]);
});

test('the viewer\'s seek plays on from there when playing, and is refused before the runtime is ready', () => {
  const h = harness();
  assert.equal(h.player.seekTo(2), false);
  h.player.update(S({ near: true, visible: true }));
  h.msg({ type: 'ready', duration: 10, scenes: [] });
  assert.equal(h.player.seekTo(6), true);
  assert.deepEqual(h.sent.slice(-2).map((s) => s.m), [{ type: 'seek', t: 6 }, { type: 'play', loop: true }]);
  assert.equal(h.player.time, 6);
});

test('silent by default; setMuted reaches a live runtime, and a runtime mounted later starts with the last setting', () => {
  const h = harness();
  h.player.update(S({ near: true, visible: true }));
  h.msg({ type: 'ready' });
  assert.deepEqual(h.sent[1].m, { type: 'mute', muted: true });
  h.player.setMuted(false);
  assert.deepEqual(h.sent.at(-1).m, { type: 'mute', muted: false });
  const count = h.sent.length;
  h.player.setMuted(false);
  assert.equal(h.sent.length, count, 'no repeat');
  const later = harness();
  later.player.setMuted(false);
  assert.equal(later.sent.length, 0, 'nothing to tell before ready');
  later.player.update(S({ near: true, visible: true }));
  later.msg({ type: 'ready' });
  assert.deepEqual(later.sent[1].m, { type: 'mute', muted: false });
});

test('data-autoplay="false": no runtime until the viewer\'s Play (it never starts by itself), then it starts from 0:00', () => {
  const h = harness({ posterTime: 30, loop: 'false', autoplay: 'false' });
  h.player.update(S({ near: true, visible: true }));
  assert.equal(h.mounts(), 0, 'on screen it is its poster, with no runtime behind it');
  h.player.update(S({ near: true, visible: false })); h.player.update(S({ near: true, visible: true }));
  assert.equal(h.mounts(), 0, 'nor when it scrolls back on screen');
  h.player.update({ intent: 'play' });
  assert.equal(h.mounts(), 1, 'Play mounts it');
  h.msg({ type: 'ready', duration: 60 });
  assert.equal(h.player.playing, true);
  assert.deepEqual(h.sent.slice(-2).map((x) => x.m), [{ type: 'seek', t: 0 }, { type: 'play', loop: false }]);
  h.player.update({ intent: 'pause' }); h.player.update({ intent: 'play' });
  assert.deepEqual(h.sent.at(-1).m, { type: 'play', loop: false });
  assert.notDeepEqual(h.sent.at(-2).m, { type: 'seek', t: 0 }, 'a later play resumes where it paused');
});

/** Players sharing one live budget, each on its own fake frame. */
function budgetHarness(limit, n) {
  const budget = liveBudget(() => limit);
  const frames = [];
  const players = Array.from({ length: n }, (_, i) => new CompositionPlayer(
    { dataset: { composition: `c${i}` }, classList: { add() {}, remove() {} } },
    {
      origin: ORIGIN, budget,
      mount: (src) => { const f = { src, contentWindow: { postMessage() {} }, removed: false, remove() { this.removed = true; } }; frames.push(f); return f; },
      setTimeout: () => 0, clearTimeout: () => {},
    },
  ));
  const live = () => players.filter((p) => p.frame).map((p) => p.id);
  return { budget, players, frames, live };
}

test('a page-wide budget of live runtimes: past it a player waits on its poster, and mounts when a slot frees', () => {
  const { players: [a, b, c], live } = budgetHarness(2, 3);
  for (const p of [a, b, c]) p.update(S({ near: true, visible: true }));
  assert.deepEqual(live(), ['c0', 'c1']);
  a.update({ near: false, visible: false });
  assert.deepEqual(live(), ['c1', 'c2'], 'the waiting one takes the freed slot');
});

test('a player on screen takes the slot of one only kept near (mounted ahead), never of one on screen', () => {
  const { players: [a, b, c], live } = budgetHarness(2, 3);
  a.update(S({ near: true })); b.update(S({ near: true, visible: true }));
  c.update(S({ near: true, visible: true }));
  assert.deepEqual(live(), ['c1', 'c2'], 'c took a\'s slot: a was only near');
  a.update({ visible: true });
  assert.deepEqual(live(), ['c1', 'c2'], 'a, now on screen too, waits: nobody below it to evict');
  // A higher priority wins between two on screen (the story's board in its framing).
  a.update({ priority: 5 });
  assert.equal(live().length, 2);
  assert.ok(live().includes('c0'));
});

test('an unloaded runtime lets go of its page: about:blank, then removed', () => {
  const { players: [a], frames } = budgetHarness(2, 1);
  a.update(S({ near: true, visible: true }));
  a.update(S({}));
  assert.equal(frames[0].src, 'about:blank');
  assert.equal(frames[0].removed, true);
  assert.equal(a.frame, null);
});

test('two live runtimes on a phone, four on a wide screen', () => {
  assert.deepEqual(LIVE_BUDGET, { phone: 2, desktop: 4 });
});

test('a figure\'s data-priority ranks it in the budget from the start: the chosen board wins a phone\'s slot over the others', () => {
  const h = harness();
  assert.equal(h.player.state.priority, 0);
  const figure = { dataset: { composition: 'story-signal-v1', priority: '2' }, classList: { add() {}, remove() {} } };
  const p = new CompositionPlayer(figure, { origin: ORIGIN, mount: () => ({}), setTimeout: () => 0, clearTimeout: () => {} });
  assert.equal(p.state.priority, 2);
});

test('data-loop-from: a looping board jumps back just before its end, so its empty first frame is never drawn', () => {
  const h = harness({ posterTime: 5, loopFrom: '2.4' });
  h.player.update(S({ near: true }));
  h.msg({ type: 'ready', duration: 8, scenes: [] });
  h.player.update(S({ near: true, visible: true }));
  h.msg({ type: 'time', t: 7.5, playing: true });
  assert.deepEqual(h.types(), ['setScale', 'mute', 'seek', 'play']);
  h.msg({ type: 'time', t: 7.93, playing: true });
  assert.deepEqual(h.types(), ['setScale', 'mute', 'seek', 'play', 'seek', 'play']);
  assert.deepEqual(h.sent[4].m, { type: 'seek', t: 2.4 });
  // The jump's own report, and the one after it: no second jump.
  h.msg({ type: 'time', t: 7.97, playing: true });
  h.msg({ type: 'time', t: 2.45, playing: true });
  h.msg({ type: 'time', t: 3, playing: true });
  assert.equal(h.types().length, 6);
});

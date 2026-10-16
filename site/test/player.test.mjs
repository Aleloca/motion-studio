import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, isVisible } from '../src/js/player-logic.js';
import { CompositionPlayer, READY_TIMEOUT_MS } from '../src/js/player.js';

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
});

const ORIGIN = 'https://aleloca.github.io';

/** A player wired to fakes: a figure, an iframe window that records commands, and a manual clock. */
function harness({ posterTime = 2 } = {}) {
  const sent = [];
  const timers = [];
  const classes = new Set();
  const frame = { contentWindow: { postMessage: (m, origin) => sent.push({ m, origin }) }, removed: false, remove() { this.removed = true; } };
  let mounts = 0;
  const figure = { dataset: { composition: 'hero-16x9', posterTime: String(posterTime) }, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
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
  assert.equal(h.frame.src, `runtime/hero-16x9.html?mode=preview&parentOrigin=${encodeURIComponent(ORIGIN)}`);
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
  assert.deepEqual(h.types(), ['setScale', 'mute', 'play', 'pause']);
  assert.deepEqual(h.sent[0].m, { type: 'setScale', scale: 'fit' });
  assert.deepEqual(h.sent[1].m, { type: 'mute', muted: true });
  assert.deepEqual(h.sent[2].m, { type: 'play', loop: true });
  assert.ok(h.sent.every((s) => s.origin === ORIGIN));
  assert.ok(h.classes.has('is-ready'));
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

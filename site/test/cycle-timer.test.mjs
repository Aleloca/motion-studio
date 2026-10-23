import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CycleTimer } from '../src/js/cycle-timer.js';

/** A timer on a manual clock: advance(ms) moves time and fires what is due. */
function harness() {
  let now = 0;
  let timers = [];
  let fired = 0;
  const timer = new CycleTimer({
    now: () => now,
    setTimeout: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimeout: (t) => { timers = timers.filter((x) => x !== t); },
  });
  const advance = (ms) => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    for (const t of due) t.fn();
  };
  return { timer, advance, fire: () => { fired++; }, fired: () => fired };
}

test('fires once after its delay', () => {
  const h = harness();
  h.timer.after(7, h.fire);
  h.advance(6999);
  assert.equal(h.fired(), 0);
  h.advance(1);
  h.advance(10000);
  assert.equal(h.fired(), 1);
});

test('paused, it keeps the time left and fires that much after resuming', () => {
  const h = harness();
  h.timer.after(7, h.fire);
  h.advance(3000);
  h.timer.pause();
  h.advance(60000);
  assert.equal(h.fired(), 0, 'nothing while off screen');
  h.timer.resume();
  h.advance(3999);
  assert.equal(h.fired(), 0);
  h.advance(1);
  assert.equal(h.fired(), 1);
});

test('scheduled while paused, it starts counting on resume; pause and resume twice change nothing', () => {
  const h = harness();
  h.timer.pause();
  h.timer.pause();
  h.timer.after(2, h.fire);
  h.advance(5000);
  assert.equal(h.fired(), 0);
  h.timer.resume();
  h.timer.resume();
  h.advance(2000);
  assert.equal(h.fired(), 1);
});

test('a new schedule replaces the pending one', () => {
  const h = harness();
  h.timer.after(1, h.fire);
  h.timer.after(5, h.fire);
  h.advance(5000);
  assert.equal(h.fired(), 1);
});

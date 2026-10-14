import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { CLOCK_EPOCH, installVirtualClock, nativesOf } from '../src/clock.ts';

function freshWindow() {
  return new JSDOM('<!doctype html><p>x</p>', { pretendToBeVisual: true }).window as unknown as Window & typeof globalThis;
}

describe('virtual clock', () => {
  it('freezes Date and performance.now at the composition time', () => {
    const w = freshWindow();
    const clock = installVirtualClock(w);
    expect(w.Date.now()).toBe(CLOCK_EPOCH);
    expect(new w.Date().getTime()).toBe(CLOCK_EPOCH);
    expect(new w.Date(5).getTime()).toBe(5);
    expect(new w.Date() instanceof w.Date).toBe(true);
    expect(typeof w.Date()).toBe('string');
    expect(w.performance.now()).toBe(0);
    clock.advanceTo(1500);
    expect(w.Date.now()).toBe(CLOCK_EPOCH + 1500);
    expect(w.performance.now()).toBe(1500);
    expect(clock.now).toBe(1500);
  });

  it('fires timers in due order up to the target, then one animation frame at the target', () => {
    const w = freshWindow();
    const clock = installVirtualClock(w);
    const log: string[] = [];
    w.setTimeout(() => log.push(`b@${w.performance.now()}`), 200);
    w.setTimeout(() => {
      log.push(`a@${w.performance.now()}`);
      w.setTimeout(() => log.push(`nested@${w.performance.now()}`), 50); // due 150: still inside this advance
    }, 100);
    const iv = w.setInterval(() => log.push(`i@${w.performance.now()}`), 120);
    w.requestAnimationFrame((ts) => {
      log.push(`raf@${ts}`);
      w.requestAnimationFrame(() => log.push('raf2')); // the next advance, not this one
    });
    const cancelled = w.setTimeout(() => log.push('never'), 10);
    w.clearTimeout(cancelled);
    clock.advanceTo(250);
    expect(log).toEqual(['a@100', 'i@120', 'nested@150', 'b@200', 'i@240', 'raf@250']);
    w.clearInterval(iv);
    clock.advanceTo(1000);
    expect(log.slice(6)).toEqual(['raf2']);
  });

  it('cancelAnimationFrame removes a callback; a throwing callback does not stop the others', () => {
    const w = freshWindow();
    w.console.error = () => {}; // the thrown error is logged by the clock
    const clock = installVirtualClock(w);
    const log: string[] = [];
    const id = w.requestAnimationFrame(() => log.push('cancelled'));
    w.requestAnimationFrame(() => { throw new Error('layer bug'); });
    w.requestAnimationFrame(() => log.push('ok'));
    w.cancelAnimationFrame(id);
    clock.advanceTo(16);
    expect(log).toEqual(['ok']);
  });

  it('ignores string handlers (no eval) and bounds runaway intervals', () => {
    const w = freshWindow();
    const clock = installVirtualClock(w);
    (w.setTimeout as unknown as (s: string, ms: number) => number)('globalThis.hacked = 1', 0);
    let n = 0;
    w.setInterval(() => { n++; }, 0);
    clock.advanceTo(60_000);
    expect((w as unknown as { hacked?: number }).hacked).toBeUndefined();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(100_000);
  });

  it('is idempotent and keeps the native functions for the runtime', () => {
    const w = freshWindow();
    const nativeRaf = w.requestAnimationFrame;
    const a = installVirtualClock(w);
    const b = installVirtualClock(w);
    expect(b).toBe(a);
    expect(a.native.requestAnimationFrame).not.toBe(w.requestAnimationFrame);
    expect(nativesOf(w)).toBe(a.native);
    expect(typeof nativeRaf).toBe('function');
  });

  it('nativesOf without a clock gives the window functions', () => {
    const w = freshWindow();
    const n = nativesOf(w);
    expect(n.performanceNow()).toBeGreaterThanOrEqual(0);
    expect(typeof n.setTimeout).toBe('function');
  });

  it('runDueTimers fires only timers due now, runFrame one frame, and neither moves time', () => {
    const w = freshWindow();
    const clock = installVirtualClock(w);
    clock.advanceTo(500);
    const log: string[] = [];
    w.setTimeout(() => log.push('now'), 0);
    w.setTimeout(() => log.push('later'), 10);
    w.requestAnimationFrame((ts) => log.push(`raf@${ts}`));
    expect(clock.runDueTimers()).toBe(1);
    expect(clock.runDueTimers()).toBe(0);
    expect(clock.runFrame()).toBe(1); // the count of frame callbacks run (the stall watchdog reads it)
    expect(clock.runFrame()).toBe(0);
    expect(log).toEqual(['now', 'raf@500']);
    expect(w.performance.now()).toBe(500);
  });

  it('nextTimerDue gives the earliest pending timer without firing it, or null (task 2b)', () => {
    const w = freshWindow();
    const clock = installVirtualClock(w);
    expect(clock.nextTimerDue()).toBeNull();
    clock.advanceTo(100);
    let fired = 0;
    const a = w.setTimeout(() => fired++, 300);
    w.setInterval(() => fired++, 50);
    expect(clock.nextTimerDue()).toBe(150);
    expect(clock.nextTimerDue()).toBe(150);
    expect(fired).toBe(0);
    w.clearTimeout(a);
    clock.advanceTo(160);
    expect(clock.nextTimerDue()).toBe(200);
  });
});

import { describe, expect, it } from 'vitest';
import { pumpUntilDone, PUMP_FRAME_EVERY } from '../src/layer-agent.ts';

// Final wave C8: a layer that re-arms setTimeout(0) forever must not starve the animation frame it awaits.
function fakeClock() {
  const log = { frames: 0, timers: 0 };
  let rearm = true;
  return {
    log,
    stop: () => { rearm = false; },
    clock: {
      native: { setTimeout: (fn: () => void) => setTimeout(fn, 0) },
      runDueTimers: () => { if (!rearm) return 0; log.timers++; return 1; }, // a due timer every macrotask
      runFrame: () => { log.frames++; },
    } as never,
  };
}

describe('pumpUntilDone (C8)', () => {
  it('a frame fires within PUMP_FRAME_EVERY busy macrotasks even if a timer is always due', async () => {
    const f = fakeClock();
    let resolve!: () => void;
    const waiting = new Promise<void>((r) => { resolve = r; });
    const run = pumpUntilDone(waiting, f.clock);
    for (let i = 0; i < 400 && f.log.frames === 0; i++) await new Promise((r) => setTimeout(r, 1));
    expect(f.log.frames).toBeGreaterThan(0);
    expect(f.log.timers).toBeLessThanOrEqual(PUMP_FRAME_EVERY + 1);
    resolve();
    await run;
  });
  it('stops pumping after maxPumps', async () => {
    let calls = 0;
    const clock = { native: { setTimeout: (fn: () => void) => { calls++; return setTimeout(fn, 0); } }, runDueTimers: () => 0, runFrame: () => {} } as never;
    void pumpUntilDone(new Promise<void>(() => {}), clock, 5);
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(5);
  });
  it('a non-promise value is returned as is', async () => {
    await expect(pumpUntilDone(7, fakeClock().clock)).resolves.toBe(7);
  });
});

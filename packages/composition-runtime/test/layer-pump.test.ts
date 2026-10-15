import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { installVirtualClock } from '../src/clock.ts';
import { ClockStallError, pumpUntilDone, PUMP_FRAME_EVERY } from '../src/layer-agent.ts';

const freshWindow = () => new JSDOM('<!doctype html><p>x</p>', { pretendToBeVisual: true }).window as unknown as Window & typeof globalThis;

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

// UX feedback 1, task 2b (decision 709): a layer promise waiting on a timer the frozen render clock never fires.
describe('pumpUntilDone stall (render mode)', () => {
  /** A frozen clock at `now` with one timer due at `due` (null: none); `firing` makes every macrotask fire a timer. */
  function frozen(due: number | null, o: { firing?: () => boolean; frames?: () => number; pending?: () => number } = {}) {
    return {
      now: 100,
      native: { setTimeout: (fn: () => void) => setTimeout(fn, 0), performanceNow: () => performance.now() },
      runDueTimers: () => (o.firing?.() ? 1 : 0),
      runFrame: () => o.frames?.() ?? 0,
      pendingFrames: () => o.pending?.() ?? 0,
      nextTimerDue: () => due,
    } as never;
  }
  const never = () => new Promise<void>(() => {});

  it('rejects with a diagnostic once no timer fired for stall.ms while a later timer is pending', async () => {
    const t0 = performance.now();
    const err = await pumpUntilDone(never(), frozen(400), 20_000, { ms: 40, what: 'msReady' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClockStallError);
    expect((err as Error).message).toMatch(/^msReady waited 0\.04 s for a timer \(due in 300 ms\) that the render clock never fires: .*setTimeout, setInterval, Date or performance\.now$/);
    expect(performance.now() - t0).toBeLessThan(5_000); // nowhere near the runtime's 60 s layer timeout
  });

  it('never stalls while nothing is pending on the clock (a wait on images or fonts ends on native events)', async () => {
    let resolve!: () => void;
    const waiting = new Promise<void>((r) => { resolve = r; });
    const run = pumpUntilDone(waiting, frozen(null), 20_000, { ms: 20, what: 'msReady' });
    await new Promise((r) => setTimeout(r, 120));
    resolve();
    await expect(run).resolves.toBeUndefined();
  });

  it('never stalls while timers keep firing, nor without the stall option', async () => {
    let resolve!: () => void;
    const waiting = new Promise<void>((r) => { resolve = r; });
    const run = pumpUntilDone(waiting, frozen(400, { firing: () => true }), 20_000, { ms: 20, what: 'msSeek' });
    const plain = pumpUntilDone(waiting, frozen(400), 20_000); // preview mode passes no stall
    await new Promise((r) => setTimeout(r, 120));
    resolve();
    await expect(run).resolves.toBeUndefined();
    await expect(plain).resolves.toBeUndefined();
  });

  it('a finite rAF-only wait restarts the stall count: frames that run callbacks and leave none queued (final wave M1)', async () => {
    // Each frame runs the layer's callback and the queue is then empty: the frame work ended, which is progress.
    let resolve!: () => void;
    const waiting = new Promise<void>((r) => { resolve = r; });
    const run = pumpUntilDone(waiting, frozen(400, { frames: () => 1, pending: () => 0 }), 20_000, { ms: 20, what: 'msSeek' });
    await new Promise((r) => setTimeout(r, 120));
    resolve();
    await expect(run).resolves.toBeUndefined();
    // Frames with no callback are not progress: the wait still stalls.
    const err = await pumpUntilDone(never(), frozen(400, { frames: () => 0 }), 20_000, { ms: 20, what: 'msSeek' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClockStallError);
  });

  it('a perpetual rAF loop next to msReady waiting on setTimeout(300) still stalls, fast (Ruling AF)', async () => {
    // The real clock: a layer with a ticker that re-arms every frame, and an msReady on a timer the frozen clock never fires.
    const w = freshWindow();
    const clock = installVirtualClock(w);
    let ticks = 0;
    const loop = () => { ticks++; w.requestAnimationFrame(loop); };
    w.requestAnimationFrame(loop);
    const ready = new Promise<void>((r) => { w.setTimeout(r, 300); });
    const t0 = performance.now();
    const err = await pumpUntilDone(ready, clock, 20_000, { ms: 40, what: 'msReady' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClockStallError);
    expect((err as Error).message).toMatch(/^msReady waited 0\.04 s for a timer \(due in 300 ms\)/);
    expect(ticks).toBeGreaterThan(0); // the loop did run on the pumped frames
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

/**
 * Timesnap-style virtual clock (spike §1). Installed in render mode in the runtime document before anything else runs,
 * and in every html layer (by `layer.js`, the first script of the layer) in both modes. It freezes `Date`,
 * `performance.now`, `requestAnimationFrame` and the timers; `advanceTo(ms)` moves time forward:
 * - timers due up to the target fire in due order (timers they schedule fire too when due within the target);
 * - then exactly one animation frame fires, with the target as its timestamp.
 * Time is in milliseconds from the composition start (for a layer: from its clip start). `Date` reads
 * `CLOCK_EPOCH + now`.
 *
 * The runtime itself never waits on the virtual clock: it keeps the native functions (`native`) for its own waits
 * (the two animation frames after a seek, timeouts), so a seek can never deadlock on a frozen clock.
 *
 * String timer handlers are ignored (no eval). Not covered: Workers, AudioContext time, media playback,
 * `requestIdleCallback` and `document.timeline` (the runtime and `layer.js` drive WAAPI and CSS animations directly).
 */

/** The fixed wall clock the virtual `Date` starts from: 2026-01-01T00:00:00Z. */
export const CLOCK_EPOCH = 1767225600000;
/** Most timer callbacks fired by one `advanceTo` (a 0 ms interval cannot hang a seek). */
export const MAX_TIMER_FIRINGS = 100_000;

export interface Natives {
  setTimeout: (fn: () => void, ms?: number) => number;
  clearTimeout: (id: number) => void;
  requestAnimationFrame: (fn: (ts: number) => void) => number;
  performanceNow: () => number;
}

export interface VirtualClock {
  readonly now: number;
  advanceTo(ms: number): void;
  /** Fires the timers due at or before `now`, without moving time and without an animation frame. Returns how many fired. */
  runDueTimers(): number;
  /** Fires one animation frame at `now`, without moving time. */
  runFrame(): void;
  /** The due time of the earliest pending timer, or null when no timer is pending (read-only: nothing fires). */
  nextTimerDue(): number | null;
  readonly native: Natives;
}

type ClockWindow = Window & typeof globalThis & { __msClock?: VirtualClock };
interface Timer { due: number; fn: unknown; args: unknown[]; interval?: number }

function captureNatives(w: Window & typeof globalThis): Natives {
  const raf = typeof w.requestAnimationFrame === 'function' ? w.requestAnimationFrame.bind(w) : null;
  const st = w.setTimeout.bind(w);
  return {
    setTimeout: (fn, ms) => st(fn, ms) as unknown as number,
    clearTimeout: w.clearTimeout.bind(w) as (id: number) => void,
    requestAnimationFrame: raf ?? ((fn) => st(() => fn(0), 16) as unknown as number),
    performanceNow: w.performance.now.bind(w.performance),
  };
}

/** The native timing functions of `w`: the ones the clock saved when installed, or the window's own. */
export function nativesOf(w: Window & typeof globalThis): Natives {
  return (w as ClockWindow).__msClock?.native ?? captureNatives(w);
}

/** Installs the clock in `w` (once: a second call returns the installed clock). */
export function installVirtualClock(w: Window & typeof globalThis): VirtualClock {
  const win = w as ClockWindow;
  if (win.__msClock) return win.__msClock;
  const native = captureNatives(w);
  const NativeDate = w.Date;
  let now = 0;
  let seq = 0;
  const timers = new Map<number, Timer>();
  let frames = new Map<number, (ts: number) => void>();

  const call = (fn: unknown, args: unknown[]) => {
    if (typeof fn !== 'function') return; // string handlers are never evaluated
    try { (fn as (...a: unknown[]) => void)(...args); } catch (err) { w.console?.error(err); }
  };

  function FakeDate(this: unknown, ...a: unknown[]) {
    if (!new.target) return new NativeDate(CLOCK_EPOCH + now).toString();
    return a.length ? new (NativeDate as unknown as new (...x: unknown[]) => Date)(...a) : new NativeDate(CLOCK_EPOCH + now);
  }
  FakeDate.prototype = NativeDate.prototype;
  FakeDate.now = () => CLOCK_EPOCH + now;
  FakeDate.UTC = NativeDate.UTC;
  FakeDate.parse = NativeDate.parse;
  w.Date = FakeDate as unknown as DateConstructor;
  Object.defineProperty(w.performance, 'now', { value: () => now, configurable: true, writable: true });

  const schedule = (fn: unknown, ms: unknown, args: unknown[], repeat: boolean) => {
    const id = ++seq;
    const delay = Math.max(repeat ? 1 : 0, Number(ms) || 0);
    timers.set(id, { due: now + delay, fn, args, ...(repeat ? { interval: delay } : {}) });
    return id;
  };
  const clear = (id: unknown) => { timers.delete(Number(id)); };
  w.setTimeout = ((fn: unknown, ms?: unknown, ...args: unknown[]) => schedule(fn, ms, args, false)) as unknown as typeof w.setTimeout;
  w.setInterval = ((fn: unknown, ms?: unknown, ...args: unknown[]) => schedule(fn, ms, args, true)) as unknown as typeof w.setInterval;
  w.clearTimeout = clear as typeof w.clearTimeout;
  w.clearInterval = clear as typeof w.clearInterval;
  w.requestAnimationFrame = (fn: FrameRequestCallback) => { const id = ++seq; frames.set(id, fn); return id; };
  w.cancelAnimationFrame = (id: number) => { frames.delete(id); };

  /** Fires the timers due at or before `target` in due order (bounded); returns how many fired. */
  const runTimers = (target: number): number => {
    let fired = 0;
    for (; fired < MAX_TIMER_FIRINGS; fired++) {
      let nextId = -1; let next: Timer | undefined;
      for (const [id, tm] of timers) if (tm.due <= target && (!next || tm.due < next.due)) { nextId = id; next = tm; }
      if (!next) break;
      if (next.due > now) now = next.due;
      if (next.interval) next.due += next.interval; else timers.delete(nextId);
      call(next.fn, next.args);
    }
    return fired;
  };
  const runFrame = () => {
    const due = frames;
    frames = new Map();
    for (const fn of due.values()) call(fn, [now]);
  };

  const clock: VirtualClock = {
    get now() { return now; },
    native,
    advanceTo(target: number) {
      if (!Number.isFinite(target)) return;
      runTimers(target);
      now = target;
      runFrame();
    },
    runDueTimers: () => runTimers(now),
    runFrame,
    nextTimerDue() {
      let due: number | null = null;
      for (const tm of timers.values()) if (due === null || tm.due < due) due = tm.due;
      return due;
    },
  };
  Object.defineProperty(win, '__msClock', { value: clock, configurable: false, enumerable: false, writable: false });
  return clock;
}

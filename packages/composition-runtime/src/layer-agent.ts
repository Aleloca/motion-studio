import { installVirtualClock, type VirtualClock } from './clock.ts';
import { FrameTimeoutError, PREVIEW_FRAME_WAIT, twoFrames, type FrameWait } from './frames.ts';
import { decodeLayerConfig, LAYER_PROTOCOL_VERSION, type LayerConfig, type LayerRequest } from './layer-protocol.ts';

/**
 * The html layer side (`layer.js`), injected by the core as the layer's first script. It runs before any layer code:
 * - installs the virtual clock (both modes: in preview the runtime advances it on every frame, so free JS animations
 *   follow the timeline, pause with it and scrub with it);
 * - defines `window.msParams` (frozen) from the configuration in `window.name`;
 * - answers the runtime: `ready` (every font face of the layer and of the composition `FontFace.load()`ed, then
 *   `msReady` awaited), `seek(t)` (clock to t, every animation of the document paused at t, `msTimeline` to t,
 *   `await msSeek(t)`, then two native animation frames), `tick(t)` (the same without waiting, for playback).
 * Render mode: an `msReady` or `msSeek` that waits on a timer the frozen clock never fires fails after `CLOCK_STALL_MS`
 *   with a diagnostic (and, for `msSeek`, every later seek fails at once), instead of holding the render for the 60 s
 *   layer timeout (decision 709).
 * The layer contract (spec §3.2): `msSeek(t)` (may be async) or a paused timeline in `msTimeline` (GSAP-style `seek(t)`,
 * or WAAPI-style `currentTime` in ms), and an optional `msReady` promise. `t` is the layer's local time in seconds.
 */

interface LayerWindow extends Window {
  msParams?: Readonly<Record<string, string | number>>;
  msReady?: unknown;
  msSeek?: (t: number) => unknown;
  msTimeline?: { seek?: (t: number, suppressEvents?: boolean) => unknown; pause?: () => unknown; currentTime?: number | null };
}

/** Bound on the clock pumps while awaiting layer code (the runtime gives up earlier, on its own timeout). */
const MAX_PUMPS = 20_000;

/** After this many macrotasks in a row in which a timer fired, one animation frame is fired anyway (C8). */
export const PUMP_FRAME_EVERY = 50;

/**
 * Render mode (UX feedback 1, task 2b, decision 709): how long, in native time, `msReady` or `msSeek` may stay pending
 * while no timer fires and only timers due later are pending. The render clock never moves while layer code is awaited,
 * so such a wait would otherwise last until the runtime's layer timeout (60 s). Honest waits (images, fonts) end on
 * native events, not on the clock.
 */
export const CLOCK_STALL_MS = 5_000;

/** A layer promise that waits on a timer the frozen render clock never fires. */
export class ClockStallError extends Error {
  constructor(what: string, stallMs: number, dueInMs: number) {
    super(`${what} waited ${stallMs / 1000} s for a timer (due in ${Math.round(dueInMs)} ms) that the render clock never fires: `
      + 'time does not pass while a frame is rendered, so msReady and msSeek must not wait on setTimeout, setInterval, Date or performance.now');
    this.name = 'ClockStallError';
  }
}

type PumpClock = Pick<VirtualClock, 'native' | 'runDueTimers' | 'runFrame' | 'now' | 'nextTimerDue'>;

/**
 * Awaits `value` while pumping a frozen clock: on every native macrotask the timers already due fire; after a macrotask
 * in which no timer fired, one animation frame fires. A layer whose code re-arms `setTimeout(0)` forever would never see
 * an idle macrotask, so a frame is also forced every `PUMP_FRAME_EVERY` busy ones: a `requestAnimationFrame` awaited next
 * to such a chain is not starved until `maxPumps` runs out. Time never moves.
 *
 * `stall` (render mode): once `stall.ms` of native time pass in which no timer fired while a timer due later is pending,
 * the wait rejects with a `ClockStallError` naming `stall.what`, instead of running on until the runtime's layer timeout.
 */
export async function pumpUntilDone<T>(value: T, clock: PumpClock, maxPumps = MAX_PUMPS, stall?: { ms: number; what: string }): Promise<Awaited<T>> {
  if (!value || typeof (value as { then?: unknown }).then !== 'function') return value as Awaited<T>;
  let done = false;
  const p = Promise.resolve(value).finally(() => { done = true; });
  p.catch(() => {});
  let idle = false; // the previous macrotask fired no timer
  let busy = 0; // macrotasks in a row in which a timer fired
  let stallSince: number | null = null; // native time since which no timer fired while only later timers are pending
  for (let i = 0; !done && i < maxPumps; i++) {
    await new Promise<void>((r) => clock.native.setTimeout(r, 0));
    if (done) break;
    if (idle || busy >= PUMP_FRAME_EVERY) { clock.runFrame(); idle = false; busy = 0; continue; }
    idle = clock.runDueTimers() === 0;
    busy = idle ? 0 : busy + 1;
    if (!stall) continue;
    const due = clock.nextTimerDue();
    if (!idle || due === null || due <= clock.now) { stallSince = null; continue; }
    const at = clock.native.performanceNow();
    if (stallSince === null) stallSince = at;
    else if (at - stallSince >= stall.ms) throw new ClockStallError(stall.what, stall.ms, due - clock.now);
  }
  return p;
}

export function startLayerAgent(w: Window & typeof globalThis): void {
  const config: LayerConfig | null = decodeLayerConfig(w.name);
  if (!config) return; // not a Motion Studio layer frame (opened on its own): leave the page alone
  const clock: VirtualClock = installVirtualClock(w);
  // Render: a missing frame fails the seek (never a stale capture); preview: a short fallback.
  const frameWait: FrameWait = config.mode === 'render' ? { strict: true, timeoutMs: config.frameTimeoutMs ?? 30_000 } : PREVIEW_FRAME_WAIT;
  const lw = w as unknown as LayerWindow;
  Object.defineProperty(lw, 'msParams', { value: Object.freeze({ ...config.params }), writable: false, configurable: false, enumerable: true });

  const declared: FontFace[] = [];
  for (const f of config.fonts) {
    try {
      const face = new w.FontFace(f.family, `url("${f.url}")`, { ...(f.weight ? { weight: f.weight } : {}), ...(f.style ? { style: f.style } : {}) });
      w.document.fonts.add(face);
      declared.push(face);
    } catch { /* a bad descriptor: reported by the runtime for the main document already */ }
  }

  let port: MessagePort | null = null;
  let seekRunning = false;

  const syncAnimations = (t: number) => {
    for (const a of w.document.getAnimations()) {
      try { a.pause(); a.currentTime = t * 1000; } catch { /* an animation without a timeline */ }
    }
  };
  const applyTime = (t: number) => {
    clock.advanceTo(t * 1000);
    syncAnimations(t);
    const tl = lw.msTimeline;
    if (tl && typeof tl === 'object') {
      if (typeof tl.pause === 'function') tl.pause();
      if (typeof tl.seek === 'function') tl.seek(t, false);
      else if ('currentTime' in tl) tl.currentTime = t * 1000;
    }
  };
  /**
   * Awaits a promise of layer code while pumping the frozen clock at the current time. On every native macrotask the
   * timers already due fire; only after a macrotask in which no timer fired does one animation frame fire (at the same
   * time). Without it, `msSeek` or `msReady` code that awaits a `setTimeout(0)` or a `requestAnimationFrame` would wait
   * forever on the virtual clock. Time never moves.
   */
  const pumping = <T>(value: T, what: string): Promise<Awaited<T>> =>
    pumpUntilDone(value, clock, MAX_PUMPS, config.mode === 'render' ? { ms: CLOCK_STALL_MS, what } : undefined);
  /** Render mode: set once an `msSeek` stalled on the clock; later seeks fail at once instead of waiting again. */
  let seekStalled: string | null = null;
  const callSeek = async (t: number) => {
    if (typeof lw.msSeek === 'function') {
      try { await pumping(lw.msSeek(t), 'msSeek'); } catch (err) { if (err instanceof ClockStallError) seekStalled = err.message; throw err; }
    }
    syncAnimations(t); // msSeek may have created animations
  };

  async function ready(): Promise<string[]> {
    const warnings: string[] = [];
    const faces = new Set<FontFace>([...declared, ...w.document.fonts]);
    await Promise.all([...faces].map((f) => f.load().catch(() => { warnings.push(`font ${f.family} failed to load`); })));
    await pumping(lw.msReady, 'msReady');
    return warnings;
  }

  async function onRequest(req: LayerRequest): Promise<void> {
    if (req.op === 'tick') {
      if (!Number.isFinite(req.t)) return;
      applyTime(req.t);
      if (!seekRunning && typeof lw.msSeek === 'function') {
        seekRunning = true;
        try { await callSeek(req.t); } catch { /* reported by the next real seek */ } finally { seekRunning = false; }
      }
      return;
    }
    try {
      if (req.op === 'ready') {
        const warnings = await ready();
        port?.postMessage({ id: req.id, ok: true, warnings });
      } else if (req.op === 'seek') {
        applyTime(req.t);
        if (seekStalled !== null) throw new Error(`msSeek not called again: ${seekStalled}`);
        await callSeek(req.t);
        await twoFrames(clock.native, frameWait);
        port?.postMessage({ id: req.id, ok: true });
      }
    } catch (err) {
      port?.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err), ...(err instanceof FrameTimeoutError ? { code: 'frameTimeout' } : {}) });
    }
  }

  w.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== w.parent || ev.ports.length !== 1) return;
    const d = ev.data as { type?: unknown; v?: unknown } | null;
    if (!d || d.type !== 'ms-layer-connect' || d.v !== LAYER_PROTOCOL_VERSION) return;
    port?.close();
    port = ev.ports[0]!;
    port.onmessage = (m: MessageEvent) => {
      const req = m.data as LayerRequest;
      if (req && typeof req === 'object' && (req.op === 'ready' || req.op === 'seek' || req.op === 'tick')) void onRequest(req);
    };
    port.postMessage({ type: 'hello', v: LAYER_PROTOCOL_VERSION });
  });
}

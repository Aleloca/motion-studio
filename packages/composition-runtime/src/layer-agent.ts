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
 * Awaits `value` while pumping a frozen clock: on every native macrotask the timers already due fire; after a macrotask
 * in which no timer fired, one animation frame fires. A layer whose code re-arms `setTimeout(0)` forever would never see
 * an idle macrotask, so a frame is also forced every `PUMP_FRAME_EVERY` busy ones: a `requestAnimationFrame` awaited next
 * to such a chain is not starved until `maxPumps` runs out. Time never moves.
 */
export async function pumpUntilDone<T>(value: T, clock: Pick<VirtualClock, 'native' | 'runDueTimers' | 'runFrame'>, maxPumps = MAX_PUMPS): Promise<Awaited<T>> {
  if (!value || typeof (value as { then?: unknown }).then !== 'function') return value as Awaited<T>;
  let done = false;
  const p = Promise.resolve(value).finally(() => { done = true; });
  p.catch(() => {});
  let idle = false; // the previous macrotask fired no timer
  let busy = 0; // macrotasks in a row in which a timer fired
  for (let i = 0; !done && i < maxPumps; i++) {
    await new Promise<void>((r) => clock.native.setTimeout(r, 0));
    if (done) break;
    if (idle || busy >= PUMP_FRAME_EVERY) { clock.runFrame(); idle = false; busy = 0; continue; }
    idle = clock.runDueTimers() === 0;
    busy = idle ? 0 : busy + 1;
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
  const pumping = <T>(value: T): Promise<Awaited<T>> => pumpUntilDone(value, clock);
  const callSeek = async (t: number) => {
    if (typeof lw.msSeek === 'function') await pumping(lw.msSeek(t));
    syncAnimations(t); // msSeek may have created animations
  };

  async function ready(): Promise<string[]> {
    const warnings: string[] = [];
    const faces = new Set<FontFace>([...declared, ...w.document.fonts]);
    await Promise.all([...faces].map((f) => f.load().catch(() => { warnings.push(`font ${f.family} failed to load`); })));
    await pumping(lw.msReady);
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

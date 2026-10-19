import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { installVirtualClock } from '../src/clock.ts';
import { ClockStallError, pumpUntilDone, PUMP_FRAME_EVERY, startLayerAgent, UNFREEZE_CSS, unfreezeRaster } from '../src/layer-agent.ts';
import { encodeLayerConfig } from '../src/layer-protocol.ts';

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

// Phase 14, task 0 (UX 1 follow-up 2): a stall has its own reply code, `layerStalled`, so the runtime reports it as such and
// not as `layerTimeout` (msReady) or `layerError` (msSeek).
describe('layer.js replies to a stall with code layerStalled', () => {
  /** A render-mode layer window running layer.js, connected to a fake port; returns a request function. */
  function renderLayer(layerCode: (w: Window & typeof globalThis) => void) {
    const w = freshWindow();
    w.name = encodeLayerConfig({ v: 1, mode: 'render', clipId: 'l', params: {}, fonts: [] });
    Object.defineProperty(w.document, 'fonts', { value: [], configurable: true }); // jsdom has no FontFaceSet
    Object.defineProperty(w.document, 'getAnimations', { value: () => [], configurable: true });
    startLayerAgent(w, { stallMs: 40 });
    layerCode(w); // after layer.js, as in a real layer: its timers are on the virtual clock
    const replies = new Map<number, (r: Record<string, unknown>) => void>();
    const port = { onmessage: null as ((m: { data: unknown }) => void) | null, close() {},
      postMessage(m: { id?: number }) { if (typeof m.id === 'number') replies.get(m.id)?.(m as Record<string, unknown>); } };
    const connect = new w.Event('message');
    Object.defineProperties(connect, { source: { value: w.parent }, ports: { value: [port] }, data: { value: { type: 'ms-layer-connect', v: 1 } } });
    w.dispatchEvent(connect);
    let id = 0;
    return (req: { op: 'ready' } | { op: 'seek'; t: number }) => new Promise<Record<string, unknown>>((resolve) => {
      replies.set(++id, resolve);
      port.onmessage!({ data: { id, ...req } });
    });
  }

  it('msReady waiting on a timer: layerStalled with the diagnostic', async () => {
    const request = renderLayer((w) => { (w as unknown as { msReady: unknown }).msReady = new Promise((r) => w.setTimeout(r, 300)); });
    const r = await request({ op: 'ready' });
    expect(r).toMatchObject({ ok: false, code: 'layerStalled' });
    expect(r.error).toMatch(/^msReady waited 0\.04 s for a timer \(due in 300 ms\) that the render clock never fires/);
  });

  it('msSeek waiting on a timer: layerStalled, and so is every later seek, refused at once', async () => {
    let calls = 0;
    const request = renderLayer((w) => { (w as unknown as { msSeek: unknown }).msSeek = () => { calls++; return new Promise((r) => w.setTimeout(r, 50)); }; });
    const first = await request({ op: 'seek', t: 0.5 });
    expect(first).toMatchObject({ ok: false, code: 'layerStalled' });
    expect(first.error).toMatch(/^msSeek waited 0\.04 s for a timer/);
    const second = await request({ op: 'seek', t: 1 });
    expect(second).toMatchObject({ ok: false, code: 'layerStalled' });
    expect(second.error).toMatch(/^msSeek not called again: msSeek waited/);
    expect(calls).toBe(1);
  });

  it('any other failure carries no code (the runtime keeps layerTimeout or layerError)', async () => {
    const request = renderLayer((w) => { (w as unknown as { msReady: unknown }).msReady = Promise.reject(new Error('boom')); });
    const r = await request({ op: 'ready' });
    expect(r).toEqual({ id: 1, ok: false, error: 'boom' });
  });
});

// Report 38 (decision 1230): the layer document never keeps a will-change hint that freezes the raster scale.
describe('unfreezeRaster', () => {
  it('adds the sheet once, adds it back when layer code removed it, and clears an inline !important hint', () => {
    const w = freshWindow();
    const doc = w.document;
    doc.body.innerHTML = '<div id="a" style="will-change: transform !important; color: red"></div><div id="b" style="color: blue"></div>';
    const sheet: { el: HTMLStyleElement | null } = { el: null };
    unfreezeRaster(doc, sheet);
    expect(doc.querySelectorAll('style')).toHaveLength(1);
    expect(sheet.el!.textContent).toBe(UNFREEZE_CSS);
    const a = doc.getElementById('a')!;
    expect([a.style.getPropertyValue('will-change'), a.style.getPropertyPriority('will-change'), a.style.color]).toEqual(['auto', 'important', 'red']);
    expect(doc.getElementById('b')!.getAttribute('style')).toBe('color: blue');
    unfreezeRaster(doc, sheet);
    expect(doc.querySelectorAll('style')).toHaveLength(1);
    sheet.el!.remove();
    unfreezeRaster(doc, sheet);
    expect(doc.querySelectorAll('style')).toHaveLength(1);
  });
  it('the layer agent installs it at start in a Motion Studio layer only', () => {
    const plain = freshWindow();
    startLayerAgent(plain);
    expect(plain.document.querySelectorAll('style')).toHaveLength(0);
    const w = new JSDOM('<!doctype html><p>x</p>', { pretendToBeVisual: true }).window as unknown as Window & typeof globalThis;
    w.name = encodeLayerConfig({ v: 1, mode: 'preview', clipId: 'c', params: {}, fonts: [] });
    startLayerAgent(w);
    expect(w.document.querySelector('style')!.textContent).toBe(UNFREEZE_CSS);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { installVirtualClock } from '../src/clock.ts';
import { ClockStallError, pumpUntilDone, PUMP_FRAME_EVERY, createUnfreezer, pauseAnimations, settleAnimations, startLayerAgent } from '../src/layer-agent.ts';
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

// Report 38 (decisions 1230, 1237–1247): the layer document never keeps a will-change hint that freezes the raster scale.
describe('createUnfreezer', () => {
  const doc = (html: string) => new JSDOM(`<!doctype html>${html}`, { pretendToBeVisual: true }).window.document;
  const wc = (d: Document, id: string) => { const el = d.getElementById(id)!; const s = el.style; return `${s.getPropertyValue('will-change')}|${s.getPropertyPriority('will-change')}|${el.hasAttribute('data-ms-u') ? 'u' : ''}${s.getPropertyValue('translate')}`; };
  it('drops the freezing values (any rule, inline !important too), keeps the others; the element is marked for the layered translate 0, never inline', () => {
    const d = doc(`<style>#a:not(#x):not(#y){will-change:transform !important}</style><div id="a"></div>
      <div id="b" style="will-change: opacity, scale !important; color: red; transform: rotate(3deg)"></div><div id="c" style="will-change: opacity"></div><div id="e"></div>`);
    createUnfreezer(d).run();
    expect([wc(d, 'a'), wc(d, 'b'), wc(d, 'c'), wc(d, 'e')]).toEqual(['auto|important|u', 'opacity|important|u', 'opacity||', '||']);
    expect(d.getElementById('b')!.style.color).toBe('red');
  });
  it('after the layer\'s code: a rewritten inline style, a new element, a class change, another attribute and a new sheet are caught; nothing changed costs nothing', () => {
    const d = doc('<style>.z{will-change:rotate}[data-k]{will-change:scale}</style><div id="a" style="will-change: transform"></div><div id="b"></div><div id="c"></div>');
    const u = createUnfreezer(d);
    u.run();
    const a = d.getElementById('a')!;
    a.style.cssText = 'will-change: translate !important; transform: scale(2)';
    u.run();
    expect(wc(d, 'a')).toBe('auto|important|u');
    expect(a.style.transform).toBe('scale(2)');
    const n = d.createElement('div'); n.id = 'n'; n.innerHTML = '<span id="m" style="will-change: transform"></span>'; d.body.append(n);
    d.getElementById('b')!.className = 'z';
    u.run();
    expect([wc(d, 'm'), wc(d, 'b')]).toEqual(['auto|important|u', 'auto|important|u']);
    d.getElementById('c')!.setAttribute('data-k', '1');
    u.run();
    expect(wc(d, 'c')).toBe('auto|important|u');
    const st = d.createElement('style'); st.textContent = '#n{will-change:scale}'; d.head.append(st);
    u.run();
    expect(wc(d, 'n')).toBe('auto|important|u');
    const spy = vi.spyOn(d.defaultView!, 'getComputedStyle');
    u.run();
    a.style.transform = 'scale(3)'; // the camera rig's own frame: no style is computed
    for (let i = 0; i < 50; i++) d.getElementById('e' + i)?.remove();
    u.run();
    expect(spy).toHaveBeenCalledTimes(0);
    spy.mockRestore();
  });
  it('a hint the layer drops gives back its own behaviour; an inline hint it keeps is put back first, then dropped again', () => {
    const d = doc('<style id="s">#a{will-change:transform}</style><div id="a"></div><div id="b" style="will-change: transform; color: red"></div>');
    const u = createUnfreezer(d);
    u.run();
    expect([wc(d, 'a'), wc(d, 'b')]).toEqual(['auto|important|u', 'auto|important|u']);
    d.getElementById('s')!.textContent = '#a{color:blue}';
    u.run();
    expect([wc(d, 'a'), wc(d, 'b')]).toEqual(['||', 'auto|important|u']);
    expect(d.getElementById('b')!.style.color).toBe('red');
  });
  it('decisions 1250, 1252, 1255: no sheet in the document; a rewritten hint loses its mark; our mark costs no scan', () => {
    const d = doc('<style>#z{color:red}</style><div id="a" style="will-change: transform"></div>');
    const u = createUnfreezer(d);
    u.run();
    expect([...d.querySelectorAll('style')].map((x) => x.textContent)).toEqual(['#z{color:red}']);
    expect(d.styleSheets).toHaveLength(1);
    const a = d.getElementById('a')!;
    expect(wc(d, 'a')).toBe('auto|important|u');
    a.style.setProperty('will-change', 'opacity');
    u.run();
    expect(wc(d, 'a')).toBe('opacity||');
    a.style.setProperty('will-change', 'transform');
    u.run();
    expect(wc(d, 'a')).toBe('auto|important|u');
    const spy = vi.spyOn(d.defaultView!, 'getComputedStyle');
    // Decision 1261: a mark the layer strips comes back at the next run, without computing any style.
    a.removeAttribute('data-ms-u');
    u.run();
    expect(wc(d, 'a')).toBe('auto|important|u');
    a.setAttribute('data-ms-u', 'x');
    a.removeAttribute('data-ms-u');
    u.run();
    expect(wc(d, 'a')).toBe('auto|important|u');
    expect(spy).toHaveBeenCalledTimes(0);
    spy.mockRestore();
  });
  it('decision 1260: removed elements are let go (their own hint given back); one put back is decided again', () => {
    const d = doc('<div id="w"></div>');
    const u = createUnfreezer(d);
    u.run();
    const w = d.getElementById('w')!;
    for (let f = 0; f < 50; f++) {
      const p = d.createElement('i'); p.style.setProperty('will-change', 'transform'); w.append(p);
      u.run();
      expect(p.hasAttribute('data-ms-u')).toBe(true);
      p.remove();
    }
    u.run();
    expect(u.tracked()).toBe(0);
    const p = d.createElement('i'); p.id = 'p'; p.style.setProperty('will-change', 'transform'); w.append(p);
    u.run();
    p.remove();
    u.run();
    expect(wc({ getElementById: () => p } as unknown as Document, 'p')).toBe('transform||');
    w.append(p);
    u.run();
    expect([wc(d, 'p'), u.tracked()]).toEqual(['auto|important|u', 1]);
  });
  it('decision 1256: a mark copied by cloneNode or markup goes; a full scan strips every mark it did not write', () => {
    const d = doc('<div id="a" style="will-change: transform"><i>x</i></div><div id="w"></div>');
    const u = createUnfreezer(d);
    u.run();
    const copy = d.getElementById('a')!.cloneNode(true) as HTMLElement;
    copy.id = 'c';
    d.body.append(copy);
    d.getElementById('w')!.innerHTML = '<p id="p" data-ms-u=""></p>';
    u.run();
    expect([d.getElementById('c')!.hasAttribute('data-ms-u'), d.getElementById('p')!.hasAttribute('data-ms-u'), d.getElementById('a')!.hasAttribute('data-ms-u')]).toEqual([false, false, true]);
    const q = d.createElement('q'); q.id = 'q'; q.setAttribute('data-ms-u', ''); d.body.append(q);
    d.body.className = 'x'; // a full scan
    u.run();
    expect([d.getElementById('q')!.hasAttribute('data-ms-u'), d.getElementById('a')!.hasAttribute('data-ms-u')]).toEqual([false, true]);
  });
  it('captures getComputedStyle when made: a layer replacing it later changes nothing', () => {
    const d = doc('<div id="a"></div>');
    const u = createUnfreezer(d);
    u.run();
    (d.defaultView as unknown as { getComputedStyle: unknown }).getComputedStyle = () => { throw new Error('replaced'); };
    d.getElementById('a')!.setAttribute('style', 'will-change: transform');
    expect(() => u.run()).not.toThrow();
    expect(wc(d, 'a')).toBe('auto|important|u');
  });
  it('a budget bounds one run; the rest waits for the next', () => {
    const d = doc(`${Array.from({ length: 10 }, (_, i) => `<i id="i${i}" style="will-change: transform"></i>`).join('')}`);
    const u = createUnfreezer(d);
    u.run(4);
    const done = () => Array.from({ length: 10 }, (_, i) => wc(d, `i${i}`).startsWith('auto')).filter(Boolean).length;
    expect(done()).toBeLessThan(10);
    u.run(100);
    expect(done()).toBe(10);
  });
  it('the layer agent runs it in a Motion Studio layer only', async () => {
    const plain = new JSDOM('<!doctype html><div id="a" style="will-change: transform"></div>', { pretendToBeVisual: true }).window as unknown as Window & typeof globalThis;
    startLayerAgent(plain);
    expect(plain.document.getElementById('a')!.style.getPropertyValue('will-change')).toBe('transform');
  });
});

// Report 56: the animations a seek pauses that were running are sent again to the compositor (one frame at another time).
describe('pausing the layer\'s animations', () => {
  const anim = (playState: string, o: { delay?: number; activeDuration?: number } = {}) => {
    const times: Array<number | null> = [];
    const a = { playState, effect: { getComputedTiming: () => ({ delay: o.delay ?? 0, activeDuration: o.activeDuration ?? 2000 }) }, pause: vi.fn(() => { a.playState = 'paused'; }),
      get currentTime() { return times.at(-1) ?? null; }, set currentTime(v: number | null) { times.push(v); } };
    return Object.assign(a, { times });
  };
  const settle = (list: unknown[], t: number, frame: () => Promise<void>) => settleAnimations(list as Animation[], t, frame);

  it('pauses every animation at t and returns those that were not paused yet', () => {
    const running = anim('running'), pending = anim('running'), finished = anim('finished'), paused = anim('paused');
    const doc = { getAnimations: () => [running, pending, finished, paused] } as unknown as Document;
    expect(pauseAnimations(doc, 0.5)).toEqual([running, pending, finished]);
    for (const a of [running, pending, finished, paused]) { expect(a.pause).toHaveBeenCalled(); expect(a.currentTime).toBe(500); }
  });

  it('settles inside the active phase: 1 ms on (back near the end) for one frame, then t again', async () => {
    const a = anim('paused'), end = anim('paused', { activeDuration: 1000.5 });
    let frames = 0;
    expect(await settle([a, end], 1, async () => { frames++; expect([a.currentTime, end.currentTime]).toEqual([1001, 999]); })).toBe(true);
    expect(frames).toBe(1);
    expect([a.currentTime, end.currentTime]).toEqual([1000, 1000]);
    expect(await settle([], 1, async () => { frames++; })).toBe(false);
    expect(frames).toBe(1);
  });

  it('never leaves the active phase (no animationstart/end again): in its delay, at or after its end, nothing', async () => {
    const delayed = anim('paused', { delay: 1500 }), ended = anim('paused', { activeDuration: 1000 }), past = anim('paused', { activeDuration: 400 });
    const frame = vi.fn(async () => {});
    expect(await settle([delayed, ended, past], 1, frame)).toBe(false);
    expect(frame).not.toHaveBeenCalled();
    for (const a of [delayed, ended, past]) expect(a.times).toEqual([]);
  });

  it('leaves alone an animation that msSeek cancelled (idle), before or during the frame', async () => {
    const cancelled = anim('idle'), later = anim('paused'), live = anim('paused');
    const done = await settle([cancelled, later, live], 0.5, async () => { later.playState = 'idle'; });
    expect(done).toBe(true);
    expect(cancelled.times).toEqual([]);
    expect(later.times).toEqual([501]); // not set back: a time would bring it back, paused, over its replacement
    expect(live.times).toEqual([501, 500]);
  });
});

// Decision 1752: when Chrome's GPU process goes, the layer's own canvases lose their pixels too (the macOS CI failure of
// "render mode ignores setComposition": exactly the probe canvas's three white rectangles gone, 420 px, diff 0.0073).
describe('a layer canvas that loses its GPU context', () => {
  /** The events these tests dispatch stand for Chrome's (`isTrusted` cannot be set in jsdom), unless `trusted` says no. */
  function renderLayer(layerCode: (w: Window & typeof globalThis) => void, frameTimeoutMs = 5_000, trusted: (ev: Event) => boolean = () => true) {
    const w = freshWindow();
    w.name = encodeLayerConfig({ v: 1, mode: 'render', clipId: 'l', params: {}, fonts: [], frameTimeoutMs });
    Object.defineProperty(w.document, 'fonts', { value: [], configurable: true });
    Object.defineProperty(w.document, 'getAnimations', { value: () => [], configurable: true });
    startLayerAgent(w, { stallMs: 1_000, trusted });
    layerCode(w);
    const replies = new Map<number, (r: Record<string, unknown>) => void>();
    const pushed: unknown[] = [];
    const port = { onmessage: null as ((m: { data: unknown }) => void) | null, close() {},
      postMessage(m: { id?: number }) { if (typeof m.id === 'number') replies.get(m.id)?.(m as Record<string, unknown>); else pushed.push(m); } };
    const connect = new w.Event('message');
    Object.defineProperties(connect, { source: { value: w.parent }, ports: { value: [port] }, data: { value: { type: 'ms-layer-connect', v: 1 } } });
    w.dispatchEvent(connect);
    let id = 0;
    const request = (req: { op: 'seek'; t: number }) => new Promise<Record<string, unknown>>((resolve) => {
      replies.set(++id, resolve);
      port.onmessage!({ data: { id, ...req } });
    });
    return { w, request, pushed };
  }
  const canvasIn = (w: Window & typeof globalThis) => { const c = w.document.createElement('canvas'); w.document.body.append(c); return c; };

  it('render: the seek waits for the context to come back and calls msSeek again, so the layer draws its frame again; the losses are reported', async () => {
    const draws: number[] = [];
    let lose = false;
    const { request, pushed } = renderLayer((w) => {
      const c = canvasIn(w);
      (w as unknown as { msSeek: unknown }).msSeek = (t: number) => {
        draws.push(t);
        // The GPU process goes just after this draw: lost now, back 50 ms later.
        if (lose) {
          lose = false;
          setTimeout(() => { c.dispatchEvent(new w.Event('contextlost')); setTimeout(() => c.dispatchEvent(new w.Event('contextrestored')), 50); }, 0);
        }
      };
    });
    expect(await request({ op: 'seek', t: 0.5 })).toEqual({ id: 1, ok: true, canvasLosses: 0 });
    lose = true;
    expect(await request({ op: 'seek', t: 1 })).toEqual({ id: 2, ok: true, canvasLosses: 1 });
    expect(draws).toEqual([0.5, 1, 1]);
    expect(pushed).toContainEqual({ type: 'canvasLost', canvasLosses: 1 });
  });

  it('render: a context that never comes back fails the seek with frameTimeout (never a blank capture)', async () => {
    const { request } = renderLayer((w) => {
      const c = canvasIn(w);
      (w as unknown as { msSeek: unknown }).msSeek = () => { setTimeout(() => c.dispatchEvent(new w.Event('contextlost')), 0); };
    }, 200);
    const r = await request({ op: 'seek', t: 1 });
    expect(r).toMatchObject({ ok: false, code: 'frameTimeout' });
    expect(r.error).toMatch(/lost its GPU context/);
  });

  it('render: a lost canvas the layer removes (it builds a new one each seek) is not waited for (I2)', async () => {
    let lose = false;
    const { request } = renderLayer((w) => {
      (w as unknown as { msSeek: unknown }).msSeek = () => {
        w.document.querySelectorAll('canvas').forEach((c) => c.remove()); // a chart library that rebuilds
        const c = canvasIn(w);
        if (lose) {
          lose = false;
          // Lost after this seek's reply; the next seek removes it before its restore, which so never reaches the window.
          setTimeout(() => c.dispatchEvent(new w.Event('contextlost')), 150);
          setTimeout(() => c.dispatchEvent(new w.Event('contextrestored')), 400);
        }
      };
    }, 2_000);
    lose = true;
    expect(await request({ op: 'seek', t: 1 })).toMatchObject({ ok: true, canvasLosses: 0 });
    await new Promise((r) => setTimeout(r, 200));
    let t0 = performance.now();
    expect(await request({ op: 'seek', t: 2 })).toMatchObject({ ok: true, canvasLosses: 1 });
    await new Promise((r) => setTimeout(r, 300)); // the restore went to the removed canvas
    t0 = performance.now();
    expect(await request({ op: 'seek', t: 3 })).toMatchObject({ ok: true, canvasLosses: 1 });
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  it('render: an event the layer dispatched itself (not Chrome\'s) is ignored (M5)', async () => {
    const { request, pushed } = renderLayer((w) => {
      const c = canvasIn(w);
      (w as unknown as { msSeek: unknown }).msSeek = () => { c.dispatchEvent(new w.Event('contextlost')); };
    }, 5_000, (ev) => ev.isTrusted);
    expect(await request({ op: 'seek', t: 1 })).toEqual({ id: 1, ok: true, canvasLosses: 0 });
    expect(pushed).not.toContainEqual(expect.objectContaining({ type: 'canvasLost' }));
  });
});

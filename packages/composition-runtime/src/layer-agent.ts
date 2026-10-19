import { installVirtualClock, type VirtualClock } from './clock.ts';
import { FrameTimeoutError, nextFrame, PREVIEW_FRAME_WAIT, twoFrames, type FrameWait } from './frames.ts';
import { decodeLayerConfig, LAYER_PROTOCOL_VERSION, type LayerConfig, type LayerRequest } from './layer-protocol.ts';

/**
 * The html layer side (`layer.js`), injected by the core as the layer's first script. It runs before any layer code:
 * - installs the virtual clock (both modes: in preview the runtime advances it on every frame, so free JS animations
 *   follow the timeline, pause with it and scrub with it);
 * - defines `window.msParams` (frozen) from the configuration in `window.name`;
 * - turns off the `will-change` hints that freeze the raster scale (`createUnfreezer`, report 38, decision 1230), in
 *   both modes, after every seek and tick;
 * - answers the runtime: `ready` (every font face of the layer and of the composition `FontFace.load()`ed, then
 *   `msReady` awaited), `seek(t)` (clock to t, every animation of the document paused at t, `msTimeline` to t,
 *   `await msSeek(t)`, then two native animation frames; animations it paused that were running are shown at t on the
 *   compositor too, `settleAnimations`), `tick(t)` (the same without waiting, for playback).
 * Render mode: an `msReady` or `msSeek` that waits on a timer the frozen clock never fires fails after `CLOCK_STALL_MS`
 *   with a diagnostic and the reply code `layerStalled` (and, for `msSeek`, every later seek fails at once, with the same
 *   code), instead of holding the render for the 60 s layer timeout (decision 709).
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

/** A seek refused at once because an earlier `msSeek` of the layer stalled on the clock (decision 709). */
class SeekStalledError extends Error {}

type PumpClock = Pick<VirtualClock, 'native' | 'runDueTimers' | 'runFrame' | 'now' | 'nextTimerDue' | 'pendingFrames'>;

/**
 * Awaits `value` while pumping a frozen clock: on every native macrotask the timers already due fire; after a macrotask
 * in which no timer fired, one animation frame fires. A layer whose code re-arms `setTimeout(0)` forever would never see
 * an idle macrotask, so a frame is also forced every `PUMP_FRAME_EVERY` busy ones: a `requestAnimationFrame` awaited next
 * to such a chain is not starved until `maxPumps` runs out. Time never moves.
 *
 * `stall` (render mode): once `stall.ms` of native time pass in which no timer fired and no animation frame ended the
 * layer's frame work (ran callbacks and left none queued) while a timer due later is pending, the wait rejects with a `ClockStallError` naming `stall.what`, instead of running on
 * until the runtime's layer timeout.
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
    if (idle || busy >= PUMP_FRAME_EVERY) {
      // A frame is progress only when the layer's frame work ended with it (a finite rAF wait resolved): a frame that
      // re-arms itself (a GSAP ticker, a canvas or three.js loop) runs forever and must not keep the watchdog off (Ruling AF).
      if (clock.runFrame() > 0 && clock.pendingFrames() === 0) stallSince = null;
      idle = false; busy = 0; continue;
    }
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

/**
 * Report 38 (decisions 1230, 1231, 1237–1240, 1243–1247): Chromium rasterises an element whose `will-change` names a
 * transform property once, at the scale it first had, and then transforms that bitmap, so a camera rig that zooms text
 * (`#world{will-change:transform}` scaled every frame) came out as a resampled, blurred bitmap at any export size. Measured
 * in Chrome: `transform`, `scale`, `rotate` and `translate` freeze the raster scale; `opacity`, `filter` and `contents`
 * do not, and are left alone.
 *
 * The unfreezer reads each element's computed `will-change` (any rule counts: any specificity, `@layer`, an external
 * sheet, an inline hint) and, on an element that names a freezing value, writes an inline `will-change … !important`
 * without them (`auto` when nothing else is left): an inline `!important` beats every sheet. What the hint made besides
 * the frozen raster (a stacking context, the containing block of absolute and fixed descendants) comes from an identity
 * `translate: 0px` (decision 1243): it composes with any transform, keeps `preserve-3d` and is no backdrop root (a `filter`
 * hint flattened 3D children and hid a `backdrop-filter` child). It is not written inline (decisions 1250, 1255): the
 * element gets the `data-ms-u` attribute, matched by a rule in the cascade layer `ms-unfreeze` of an adopted sheet, so
 * every unlayered rule of the layer that gives the element a `translate`, whenever it starts to match (a sibling, `:has()`,
 * `insertRule`…), wins over it; an adopted sheet comes after the document's, so a layer's own `@layer` rule loses to it.
 * Taking it back is removing the attribute; a mark this unfreezer did not write (a clone) is removed (decision 1256).
 *
 * Cost (decisions 1240, 1245): a full scan only when a class, an id or a sheet changed; an element whose `style` changed is
 * checked only when its inline style names a freezing hint, one whose other attributes changed (SVG `cx`, `d`…) or that
 * was added is checked on its own. A full scan first takes back this unfreezer's own writes, so a layer that drops its
 * hint gets its own behaviour back (decision 1246). `budget` bounds the elements checked in one run (the preview); the rest
 * waits for the next one. Self-contained (no module-level references), so a Chrome test can run its source as it is.
 */
export function createUnfreezer(doc: Document): { run(budget?: number): void; tracked(): number } {
  const FREEZE = new Set(['transform', 'scale', 'rotate', 'translate']);
  const win = doc.defaultView;
  // Captured now: layer code may replace window.getComputedStyle later (decision 1247).
  const computed = win ? win.getComputedStyle.bind(win) : null;
  const Observer = win ? win.MutationObserver : null;
  /** What this unfreezer wrote on an element, and the inline `will-change` it replaced (to give it back). */
  const written = new Map<Element, { wc: string; was: string; wasPriority: string }>();
  // The identity translate of the hinted elements, in the lowest cascade layer (decision 1250).
  const MARK = 'data-ms-u';
  const SHEET = `@layer ms-unfreeze { [${MARK}] { translate: 0px; } }`;
  /**
   * A constructed sheet in `document.adoptedStyleSheets`, never a `<style>` of the document (decision 1255): the layer's
   * `document.querySelector('style')` and `document.styleSheets[0]` stay its own. Kept there when the layer reassigns the
   * list. Without constructable sheets (jsdom) the mark alone is set.
   */
  type Adopting = Document & { adoptedStyleSheets?: CSSStyleSheet[] };
  const Sheet = win?.CSSStyleSheet as (typeof CSSStyleSheet & { prototype: { replaceSync?: unknown } }) | undefined;
  let sheet: CSSStyleSheet | null = null;
  try {
    if (Sheet && typeof Sheet.prototype.replaceSync === 'function' && Array.isArray((doc as Adopting).adoptedStyleSheets)) {
      sheet = new Sheet();
      sheet.replaceSync(SHEET);
    }
  } catch { sheet = null; }
  const ensureSheet = () => {
    if (!sheet) return;
    if (sheet.cssRules.length !== 1) sheet.replaceSync(SHEET);
    const list = (doc as Adopting).adoptedStyleSheets!;
    if (!list.includes(sheet)) (doc as Adopting).adoptedStyleSheets = [...list, sheet];
  };
  ensureSheet();
  const queue = new Set<Element>();
  let full = true;
  const sheetNode = (n: Node | null): boolean => {
    for (let e: Node | null = n; e; e = e.parentNode) {
      const name = e.nodeName.toLowerCase();
      if (name === 'style' || name === 'link') return true;
    }
    return false;
  };
  const freezing = (value: string) => value.split(',').some((t) => FREEZE.has(t.trim()));
  const styleOf = (el: Element) => (el as HTMLElement).style as CSSStyleDeclaration | undefined;
  const note = (records: MutationRecord[]) => {
    if (full) return;
    for (const r of records) {
      if (r.type === 'attributes') {
        // Our mark stripped by the layer: put back at the next run (decision 1261); our own writes leave no record.
        if (r.attributeName === MARK) { if (written.has(r.target as Element)) queue.add(r.target as Element); continue; }
        if (sheetNode(r.target) || r.attributeName === 'class' || r.attributeName === 'id') { full = true; return; }
        const el = r.target as Element;
        // A style change matters only through an inline hint; any other attribute may match a rule: checked on its own.
        if (r.attributeName !== 'style' || written.has(el) || freezing(styleOf(el)?.getPropertyValue('will-change') ?? '')) queue.add(el);
      } else if (r.type === 'characterData') {
        if (sheetNode(r.target)) { full = true; return; }
      } else {
        if (sheetNode(r.target)) { full = true; return; }
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          const el = n as Element;
          if (sheetNode(el) || el.querySelector('style, link')) { full = true; return; }
          queue.add(el);
          for (const d of el.querySelectorAll('*')) queue.add(d);
        }
      }
    }
  };
  const observer = Observer ? new Observer(note) : null;
  /**
   * The attributes worth a record: class, id, style, a sheet's own, and those the readable sheets name in a selector
   * (`[data-k]`); all of them while a sheet cannot be read (decision 1245). An SVG `cx` animated on 10 000 elements then
   * costs no record at all.
   */
  let watched: string | null = null;
  const watch = () => {
    let names: Set<string> | null = new Set(['class', 'id', 'style', 'media', 'disabled', 'href', 'rel', 'type']);
    const own = names;
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        const sel = (rule as CSSStyleRule).selectorText;
        if (sel) for (const m of sel.matchAll(/\[\s*(?:[-\w*]*\|)?([-\w]+)/g)) names!.add(m[1]!.toLowerCase());
        const inner = (rule as CSSGroupingRule).cssRules;
        if (inner) visit(inner);
      }
    };
    for (const s of doc.styleSheets) {
      try { visit(s.cssRules); } catch { names = null; break; }
    }
    own.add(MARK); // the layer stripping our mark (our own writes are dropped with takeRecords)
    const key = names ? [...names].sort().join(' ') : '*';
    if (!observer || key === watched) return;
    watched = key;
    observer.disconnect();
    observer.observe(doc, { subtree: true, childList: true, characterData: true, attributes: true, ...(names ? { attributeFilter: [...names] } : {}) });
  };
  observer?.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
  /** Takes back this unfreezer's writes on `el` (its own values only: a layer that rewrote them keeps its own). */
  const restore = (el: Element) => {
    const w = written.get(el);
    const style = styleOf(el);
    written.delete(el);
    el.removeAttribute(MARK);
    if (!w || !style) return;
    if (style.getPropertyValue('will-change') === w.wc && style.getPropertyPriority('will-change') === 'important') {
      if (w.was) style.setProperty('will-change', w.was, w.wasPriority); else style.removeProperty('will-change');
    }
  };
  const fix = (el: Element) => {
    const style = styleOf(el);
    if (!style || !computed || !el.isConnected) return;
    const mine = written.get(el);
    if (!mine && el.hasAttribute(MARK)) el.removeAttribute(MARK); // copied by cloneNode or markup (decision 1256)
    if (mine) {
      if (style.getPropertyValue('will-change') === mine.wc && style.getPropertyPriority('will-change') === 'important') {
        if (!el.hasAttribute(MARK)) el.setAttribute(MARK, ''); // stripped by the layer (decision 1261)
        return;
      }
      written.delete(el); // the layer rewrote its style: decided again from what it wrote, without our translate
      el.removeAttribute(MARK);
    }
    const cs = computed(el);
    const value = cs.willChange;
    if (!value || value === 'auto' || !freezing(value)) return;
    const was = style.getPropertyValue('will-change');
    const wasPriority = style.getPropertyPriority('will-change');
    const kept = value.split(',').map((t) => t.trim()).filter((t) => t && !FREEZE.has(t));
    style.setProperty('will-change', kept.length ? kept.join(', ') : 'auto', 'important');
    el.setAttribute(MARK, '');
    written.set(el, { wc: style.getPropertyValue('will-change'), was, wasPriority });
  };
  return {
    run(budget = Infinity) {
      if (observer) note(observer.takeRecords());
      ensureSheet();
      // Elements the layer removed are let go, their own hint given back (decision 1260): a layer that makes and drops
      // hinted particles every frame never grows this map, and one put back later is decided again.
      for (const el of [...written.keys()]) if (!el.isConnected) restore(el);
      if (full) {
        full = false;
        queue.clear();
        watch();
        for (const el of [...written.keys()]) restore(el);
        for (const el of doc.querySelectorAll(`[${MARK}]`)) el.removeAttribute(MARK); // none of ours is left: copies only
        for (const el of doc.querySelectorAll('*')) queue.add(el);
      }
      let n = 0;
      for (const el of queue) {
        if (n++ >= budget) break;
        queue.delete(el);
        fix(el);
      }
      observer?.takeRecords(); // our own writes
    },
    /** The elements this unfreezer holds a write for (tests). */
    tracked: () => written.size,
  };
}

/**
 * Pauses every animation of `doc` at `t` seconds (CSS animations and transitions, WAAPI). Returns the ones that were not
 * paused yet: those may already run on the compositor (`settleAnimations`).
 */
export function pauseAnimations(doc: Document, t: number): Animation[] {
  const started: Animation[] = [];
  for (const a of doc.getAnimations()) {
    try {
      if (a.playState !== 'paused') started.push(a);
      a.pause();
      a.currentTime = t * 1000;
    } catch { /* an animation without a timeline */ }
  }
  return started;
}

/**
 * Report 56: animations just paused by `pauseAnimations` shown at `t` on screen too. Chromium runs a transform or opacity
 * animation on the compositor; paused while it is still starting there (play-pending: as a layer reports ready, or on a
 * slow machine), the compositor keeps the value of the frames it already ran (measured: one frame ahead in 28 of 29 such
 * pauses here, 4 and 8 px of a 100 px/s box on the CI runner) while the page's own value is `t`'s, so setting `t` again
 * changes nothing. A different time for one frame, then `t`, makes the page send its value again. `frame` waits one
 * native animation frame. Never visible: the seek waits its frames after this.
 */
export async function settleAnimations(started: readonly Animation[], t: number, frame: () => Promise<void>): Promise<void> {
  if (started.length === 0) return;
  const ms = t * 1000;
  for (const a of started) {
    try {
      // 1 ms on, or back where on is past the end (a value that does not change would send nothing).
      const end = a.effect?.getComputedTiming().endTime;
      a.currentTime = typeof end === 'number' && ms + 1 > end ? ms - 1 : ms + 1;
    } catch { /* an animation without a timeline */ }
  }
  await frame();
  for (const a of started) { try { a.currentTime = ms; } catch { /* an animation without a timeline */ } }
}

/** The elements the unfreezer checks in one preview tick at most (decision 1245); a render checks them all. */
export const PREVIEW_UNFREEZE_BUDGET = 2000;

/** `stallMs`: the render-mode stall bound (`CLOCK_STALL_MS`; shorter only in tests). */
export function startLayerAgent(w: Window & typeof globalThis, o: { stallMs?: number } = {}): void {
  const config: LayerConfig | null = decodeLayerConfig(w.name);
  if (!config) return; // not a Motion Studio layer frame (opened on its own): leave the page alone
  const clock: VirtualClock = installVirtualClock(w);
  // Render: a missing frame fails the seek (never a stale capture); preview: a short fallback.
  const frameWait: FrameWait = config.mode === 'render' ? { strict: true, timeoutMs: config.frameTimeoutMs ?? 30_000 } : PREVIEW_FRAME_WAIT;
  const lw = w as unknown as LayerWindow;
  const unfreezer = createUnfreezer(w.document);
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

  const syncAnimations = (t: number) => pauseAnimations(w.document, t);
  /** Sets the layer to `t`; returns the animations it paused that were not paused yet (`settleAnimations`). */
  const applyTime = (t: number): Animation[] => {
    clock.advanceTo(t * 1000);
    const started = syncAnimations(t);
    const tl = lw.msTimeline;
    if (tl && typeof tl === 'object') {
      if (typeof tl.pause === 'function') tl.pause();
      if (typeof tl.seek === 'function') tl.seek(t, false);
      else if ('currentTime' in tl) tl.currentTime = t * 1000;
    }
    return started;
  };
  /**
   * Awaits a promise of layer code while pumping the frozen clock at the current time. On every native macrotask the
   * timers already due fire; only after a macrotask in which no timer fired does one animation frame fire (at the same
   * time). Without it, `msSeek` or `msReady` code that awaits a `setTimeout(0)` or a `requestAnimationFrame` would wait
   * forever on the virtual clock. Time never moves.
   */
  const pumping = <T>(value: T, what: string): Promise<Awaited<T>> =>
    pumpUntilDone(value, clock, MAX_PUMPS, config.mode === 'render' ? { ms: o.stallMs ?? CLOCK_STALL_MS, what } : undefined);
  /**
   * Render mode: set once an `msSeek` stalled on the clock; later seeks fail at once instead of waiting again. The layer
   * cannot tell a final render from a storyboard (both are `mode: 'render'`; telling them apart would change the layer
   * protocol), so the memo holds for both. In a final render a failed seek is a `layerError`, which fails the render
   * anyway: the memo only makes it fail sooner, it never ships a video with the layer blank (decision 709).
   */
  let seekStalled: string | null = null;
  /** Calls `msSeek`; returns the animations it started (paused now, see `applyTime`). */
  const callSeek = async (t: number): Promise<Animation[]> => {
    if (typeof lw.msSeek === 'function') {
      try { await pumping(lw.msSeek(t), 'msSeek'); } catch (err) { if (err instanceof ClockStallError) seekStalled = err.message; throw err; }
    }
    return syncAnimations(t); // msSeek may have created animations
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
      // Preview playback: one bounded run per tick, after the layer's own code (decision 1245); never fatal to the tick.
      const unfreeze = () => { try { unfreezer.run(PREVIEW_UNFREEZE_BUDGET); } catch { /* the next run tries again */ } };
      if (!seekRunning && typeof lw.msSeek === 'function') {
        seekRunning = true;
        try { await callSeek(req.t); } catch { /* reported by the next real seek */ } finally { seekRunning = false; unfreeze(); }
      } else unfreeze();
      return;
    }
    try {
      if (req.op === 'ready') {
        const warnings = await ready();
        unfreezer.run();
        port?.postMessage({ id: req.id, ok: true, warnings });
      } else if (req.op === 'seek') {
        const started = applyTime(req.t);
        if (seekStalled !== null) throw new SeekStalledError(`msSeek not called again: ${seekStalled}`);
        started.push(...await callSeek(req.t));
        unfreezer.run(); // after the layer's own code drew the frame, before it is painted (decision 1238)
        await twoFrames(clock.native, frameWait);
        // Report 56: animations that were running (the first seek pauses the layer's CSS animations) shown at `t`, then
        // two more frames, so the capture sees it.
        if (started.length) {
          await settleAnimations(started, req.t, () => nextFrame(clock.native, frameWait));
          await twoFrames(clock.native, frameWait);
        }
        port?.postMessage({ id: req.id, ok: true });
      }
    } catch (err) {
      const code = err instanceof FrameTimeoutError ? 'frameTimeout' : err instanceof ClockStallError || err instanceof SeekStalledError ? 'layerStalled' : undefined;
      port?.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err), ...(code ? { code } : {}) });
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

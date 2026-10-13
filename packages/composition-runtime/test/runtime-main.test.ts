import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { renderRuntimePage } from '../src/page.ts';
import { parseDraft } from '../src/draft.ts';
import { DRAFT_PARSER_KEY } from '../src/preview-bridge.ts';
import { startRuntime } from '../src/runtime-main.ts';

const INDEX = '<!doctype html><html><head><!--ms-composition--></head><body><div id="ms-root"></div></body></html>';

function runtimeIn(composition: unknown, base = '../v1/compositions/story/') {
  const html = renderRuntimePage(INDEX, { base, composition });
  const w = new JSDOM(html, { url: 'http://127.0.0.1:9999/tok/runtime/index.html?mode=render', pretendToBeVisual: true }).window;
  w.console.warn = () => {};
  return startRuntime(w);
}

describe('startRuntime fatal errors', () => {
  it('a composition the mount cannot handle fails ready() with compositionInvalid instead of throwing', async () => {
    const api = runtimeIn({ width: 10, height: 10, fps: 30, duration: 1, background: '#000000', fonts: [], scenes: [], tracks: [{ id: 't', kind: 'visual', clips: [null] }] });
    await expect(api.ready()).rejects.toThrow(/compositionInvalid/);
    expect(api.errors.map((e) => e.code)).toEqual(['compositionInvalid']);
  });
  it('a malformed composition fails ready() with compositionInvalid', async () => {
    const api = runtimeIn({ width: 10 });
    await expect(api.ready()).rejects.toThrow(/compositionInvalid/);
  });
});

describe('setComposition (preview, same document)', () => {
  const ORIGIN = 'http://127.0.0.1:4317';
  const comp = (over: Record<string, unknown> = {}) => ({
    $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 4, background: '#000000', fonts: [],
    scenes: [{ id: 's', start: 0, duration: 4 }],
    tracks: [{ id: 't', kind: 'visual', clips: [
      { id: 'card', type: 'shape', start: 0, duration: 4, props: { x: 10, y: 10, width: 50, height: 50, fill: '#ff0000' } },
      { id: 'late', type: 'shape', start: 3, duration: 1, props: { x: 100, width: 10, height: 10 } },
    ] }],
    ...over,
  });

  /** `parser`: preview.js has already run (jsdom loads no scripts); false leaves it to the test. */
  function preview(composition: unknown, mode: 'preview' | 'render' = 'preview', before?: (w: Window & typeof globalThis) => void, parser = true) {
    const html = renderRuntimePage(INDEX, { base: '../v1/compositions/story/', composition });
    const url = `http://127.0.0.1:9999/tok/runtime/index.html?mode=${mode}&parentOrigin=${encodeURIComponent(ORIGIN)}`;
    const w = new JSDOM(html, { url, pretendToBeVisual: true }).window;
    w.console.warn = () => {};
    const sent: Array<Record<string, unknown>> = [];
    const parent = { postMessage: (m: Record<string, unknown>, o: string) => { if (o === ORIGIN) sent.push(m); } };
    Object.defineProperty(w, 'parent', { value: parent, configurable: true });
    before?.(w as unknown as Window & typeof globalThis);
    if (parser) Object.defineProperty(w, DRAFT_PARSER_KEY, { value: { parseDraft } });
    const api = startRuntime(w as unknown as Window & typeof globalThis);
    const post = (data: unknown, source: unknown = parent, origin = ORIGIN) => {
      const ev = new w.Event('message');
      Object.defineProperties(ev, { data: { value: data }, origin: { value: origin }, source: { value: source } });
      w.dispatchEvent(ev);
    };
    const until = async (f: () => unknown, ms = 5000) => {
      const t0 = Date.now();
      while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); }
    };
    const boxes = () => [...w.document.querySelectorAll<HTMLElement>('.ms-clip')].map((b) => b.dataset.clipId);
    return { w, api, sent, post, until, boxes, parent };
  }

  it('re-mounts in the same document, keeps the time (clamped) and the selection, re-sends clipBounds, answers with the seq', async () => {
    const p = preview(comp());
    await p.until(() => p.sent.some((m) => m.type === 'ready'));
    const root = p.w.document.getElementById('ms-root')!;
    p.post({ type: 'seek', t: 3.5 });
    p.post({ type: 'select', clipId: 'card' });
    await p.until(() => p.sent.some((m) => m.type === 'clipBounds' && m.clipId === 'card'));
    p.sent.length = 0;
    const next = comp({ duration: 3, scenes: [{ id: 's', start: 0, duration: 3 }], tracks: [{ id: 't', kind: 'visual', clips: [
      { id: 'card', type: 'shape', start: 0, duration: 3, props: { x: 40, y: 10, width: 50, height: 50, fill: '#00ff00' } },
      { id: 'gone', type: 'shape', start: 0, duration: 3, hidden: true, props: {} },
    ] }] });
    p.post({ type: 'setComposition', composition: next, keepTime: true, seq: 12 });
    await p.until(() => p.sent.some((m) => m.type === 'compositionApplied'));
    expect(p.sent.find((m) => m.type === 'compositionApplied')).toEqual({ type: 'compositionApplied', seq: 12, errors: [] });
    expect(p.boxes()).toEqual(['card']);
    expect(root.querySelectorAll('.ms-stage')).toHaveLength(1);
    expect(root.querySelector<HTMLElement>('[data-clip-id="card"]')!.style.left).toBe('40px');
    // 3.5 s clamped to the new duration.
    expect(p.sent.filter((m) => m.type === 'time').at(-1)).toEqual({ type: 'time', t: 3, playing: false });
    expect(p.sent.some((m) => m.type === 'clipBounds' && m.clipId === 'card')).toBe(true);
    // The runtime's own API (render) is untouched by a preview re-mount.
    expect(p.api.mode).toBe('preview');
  });

  it('select, setScale and seek sent while a draft re-mounts hold after the swap (I1)', async () => {
    const p = preview(comp());
    await p.until(() => p.sent.some((m) => m.type === 'ready'));
    p.post({ type: 'select', clipId: 'card' });
    p.post({ type: 'seek', t: 1 });
    await p.until(() => p.sent.some((m) => m.type === 'clipBounds' && m.clipId === 'card'));
    // During the load phase.
    p.post({ type: 'setComposition', composition: comp(), keepTime: true, seq: 1 });
    p.post({ type: 'select', clipId: 'late' });
    p.post({ type: 'setScale', scale: 2 });
    p.post({ type: 'seek', t: 3.5 });
    await p.until(() => p.sent.some((m) => m.type === 'compositionApplied' && m.seq === 1));
    const bounds = p.sent.filter((m) => m.type === 'clipBounds').at(-1);
    expect(bounds).toMatchObject({ clipId: 'late', scale: 2 });
    expect(p.sent.filter((m) => m.type === 'time').at(-1)).toMatchObject({ t: 3.5 });
    // During the seek phase: the commands come once the draft has loaded (the next animation frame).
    p.sent.length = 0;
    p.post({ type: 'setComposition', composition: comp(), keepTime: true, seq: 2 });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => p.w.requestAnimationFrame(() => r(null)));
    p.post({ type: 'select', clipId: 'card' });
    p.post({ type: 'setScale', scale: 0.5 });
    p.post({ type: 'seek', t: 2.25 });
    await p.until(() => p.sent.some((m) => m.type === 'compositionApplied' && m.seq === 2));
    expect(p.sent.filter((m) => m.type === 'clipBounds').at(-1)).toMatchObject({ clipId: 'card', scale: 0.5 });
    expect(p.sent.filter((m) => m.type === 'time').at(-1)).toMatchObject({ t: 2.25, playing: false });
    const stage = p.w.document.querySelector<HTMLElement>('.ms-stage')!;
    expect(stage.style.transform).toContain('scale(0.5)');
  });

  it('a draft that comes before preview.js has loaded is applied once it loads; render pages never load it', async () => {
    const p = preview(comp(), 'preview', undefined, false);
    await p.until(() => p.sent.some((m) => m.type === 'ready'));
    const script = p.w.document.querySelector<HTMLScriptElement>('script[src="preview.js"]');
    expect(script).not.toBeNull();
    p.post({ type: 'setComposition', composition: comp({ tracks: [] }), seq: 4 });
    await new Promise((r) => setTimeout(r, 50));
    expect(p.sent.some((m) => m.type === 'compositionApplied')).toBe(false);
    Object.defineProperty(p.w, DRAFT_PARSER_KEY, { value: { parseDraft } });
    script!.dispatchEvent(new p.w.Event('load'));
    await p.until(() => p.sent.some((m) => m.type === 'compositionApplied' && m.seq === 4));
    expect(p.boxes()).toEqual([]);
    const r = preview(comp(), 'render', undefined, false);
    await r.api.ready();
    expect(r.w.document.querySelector('script[src="preview.js"]')).toBeNull();
  });

  it('without keepTime the new composition starts at 0; a selected clip that no longer exists is dropped', async () => {
    const p = preview(comp());
    await p.until(() => p.sent.some((m) => m.type === 'ready'));
    p.post({ type: 'seek', t: 2 });
    p.post({ type: 'select', clipId: 'late' });
    await p.until(() => p.sent.some((m) => m.type === 'clipBounds' && m.clipId === 'late'));
    p.sent.length = 0;
    p.post({ type: 'setComposition', composition: comp({ tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'card', type: 'shape', start: 0, duration: 4, props: {} }] }] }), seq: 1 });
    await p.until(() => p.sent.some((m) => m.type === 'compositionApplied'));
    expect(p.sent.filter((m) => m.type === 'time').at(-1)).toMatchObject({ t: 0 });
    expect(p.sent.filter((m) => m.type === 'clipBounds').at(-1)).toMatchObject({ clipId: null, bounds: null });
  });

  it('an asset the session cannot serve is reported in compositionApplied, never a crash; the next valid draft still applies', async () => {
    const p = preview(comp());
    await p.until(() => p.sent.some((m) => m.type === 'ready'));
    const proto = p.w.HTMLImageElement.prototype as unknown as { decode: () => Promise<void> };
    proto.decode = () => Promise.reject(new Error('404'));
    p.post({ type: 'setComposition', seq: 2, composition: comp({ tracks: [{ id: 't', kind: 'visual', clips: [
      { id: 'pic', type: 'image', src: 'assets/lib/missing.png', start: 0, duration: 4, props: {} },
    ] }] }) });
    await p.until(() => p.sent.some((m) => m.type === 'compositionApplied'));
    const applied = p.sent.find((m) => m.type === 'compositionApplied') as { seq: number; errors: Array<{ code: string; clipId?: string }> };
    expect(applied.seq).toBe(2);
    expect(applied.errors).toEqual([expect.objectContaining({ code: 'assetLoadFailed', clipId: 'pic' })]);
    // Load errors of a draft go in its compositionApplied only (not one error message each).
    expect(p.sent.filter((m) => m.type === 'error')).toEqual([]);
    expect(p.boxes()).toEqual(['pic']);
    p.post({ type: 'setComposition', seq: 3, composition: comp() });
    await p.until(() => p.sent.some((m) => m.type === 'compositionApplied' && m.seq === 3));
    expect(p.boxes()).toEqual(['card', 'late']);
  });

  it('coalesces drafts that arrive during a re-mount: the latest wins', async () => {
    const p = preview(comp());
    await p.until(() => p.sent.some((m) => m.type === 'ready'));
    for (let i = 1; i <= 5; i++) {
      p.post({ type: 'setComposition', seq: i, composition: comp({ tracks: [{ id: 't', kind: 'visual', clips: [{ id: `c${i}`, type: 'shape', start: 0, duration: 4, props: {} }] }] }) });
    }
    await p.until(() => p.sent.some((m) => m.type === 'compositionApplied' && m.seq === 5));
    const seqs = p.sent.filter((m) => m.type === 'compositionApplied').map((m) => m.seq);
    expect(seqs.length).toBeLessThan(5);
    expect(seqs.at(-1)).toBe(5);
    expect(p.boxes()).toEqual(['c5']);
    expect(p.w.document.querySelectorAll('.ms-stage')).toHaveLength(1);
  });

  it('ignores setComposition from anything but the parent at its origin, and an invalid one', async () => {
    const p = preview(comp());
    await p.until(() => p.sent.some((m) => m.type === 'ready'));
    const other = comp({ tracks: [] });
    p.post({ type: 'setComposition', composition: other, seq: 1 }, {});
    p.post({ type: 'setComposition', composition: other, seq: 2 }, p.parent, 'null');
    p.post({ type: 'setComposition', composition: { ...other, width: 1 }, seq: 3 });
    await new Promise((r) => setTimeout(r, 100));
    expect(p.sent.filter((m) => m.type === 'compositionApplied')).toEqual([]);
    expect(p.boxes()).toEqual(['card', 'late']);
  });

  it("a draft's video clip that names a source the session normalised plays the session media, as the inlined one did", async () => {
    // jsdom loads no media: every element is "loaded", and a seek ends at once.
    const p = preview(comp({ tracks: [{ id: 'v', kind: 'video', clips: [
      { id: 'a', type: 'video', src: 'media/0.mp4', originalSrc: 'assets/clip.mp4', sourceFps: 30, sourceStart: 0, sourceVideoEnd: 4, sourceTrusted: true, audioSrc: 'assets/clip.mp4', audioStart: 0.1, start: 0, duration: 4, props: {} },
    ] }] }), 'preview', (w) => {
      const mp = w.HTMLMediaElement.prototype as unknown as Record<string, unknown>;
      mp.pause = () => {}; mp.load = () => {};
      Object.defineProperty(w.HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 4 });
      const times = new WeakMap<object, number>();
      Object.defineProperty(w.HTMLMediaElement.prototype, 'currentTime', { configurable: true,
        get(this: object) { return times.get(this) ?? 0; },
        set(this: HTMLMediaElement, t: number) { times.set(this, t); setTimeout(() => this.dispatchEvent(new w.Event('seeked')), 0); } });
    });
    try {
      await p.until(() => p.sent.some((m) => m.type === 'ready'));
      p.post({ type: 'setComposition', seq: 1, composition: comp({ tracks: [{ id: 'v', kind: 'video', clips: [
        { id: 'a', type: 'video', src: 'assets/clip.mp4', start: 0, duration: 2, props: {} },
        { id: 'b', type: 'video', src: 'assets/lib/new.mp4', start: 2, duration: 2, props: {} },
      ] }] }) });
      await p.until(() => p.sent.some((m) => m.type === 'compositionApplied'), 10_000);
      const srcs = [...p.w.document.querySelectorAll('video')].map((v) => v.getAttribute('src'));
      const base = 'http://127.0.0.1:9999/tok/v1/compositions/story/';
      expect(srcs).toEqual([`${base}media/0.mp4`, `${base}assets/lib/new.mp4`]);
      expect([...p.w.document.querySelectorAll('audio')].map((a) => a.getAttribute('src'))).toEqual([`${base}assets/clip.mp4`]);
    } finally { /* the window is discarded */ }
  }, 15_000);

  it('render mode ignores setComposition, even from a parent that names itself in the URL', async () => {
    const p = preview(comp(), 'render');
    await p.api.ready();
    p.post({ type: 'setComposition', composition: comp({ tracks: [] }), seq: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(p.sent).toEqual([]);
    expect(p.boxes()).toEqual(['card', 'late']);
  });
});

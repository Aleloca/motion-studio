import type { Composition, SubtitlesClip } from '@motion-studio/shared';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Natives } from '../src/clock.ts';
import { mount } from '../src/mount.ts';
import { parseDraft } from '../src/draft.ts';
import { readCompositionData, renderRuntimePage } from '../src/page.ts';
import { DRAFT_PARSER_KEY } from '../src/preview-bridge.ts';
import { parseIncoming, type RuntimeError } from '../src/protocol.ts';
import { startRuntime } from '../src/runtime-main.ts';
import { activeCue, drawSubtitles, readRuntimeSubtitles, type RuntimeSubtitles } from '../src/subtitles.ts';

const BASE = 'http://127.0.0.1:9999/tok/v1/compositions/story/';
const natives: Natives = {
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
  requestAnimationFrame: (fn) => setTimeout(() => fn(0), 1) as unknown as number,
  performanceNow: () => performance.now(),
};

beforeEach(() => {
  document.body.innerHTML = '<div id="ms-root"></div>';
  (Element.prototype as unknown as { animate: unknown }).animate = function () { return { currentTime: 0, pause() {}, cancel() {} }; };
  (globalThis as unknown as { FontFace: unknown }).FontFace = class { constructor(readonly family: string, readonly src: string) {} load() { return Promise.resolve(this); } };
  Object.defineProperty(document, 'fonts', { value: { add() {}, delete() { return true; } }, configurable: true });
});
afterEach(() => { delete (Element.prototype as unknown as { animate?: unknown }).animate; });

const SUBS: RuntimeSubtitles = {
  lang: 'it',
  cues: [
    { start: 1000, end: 3500, text: 'Ciao a tutti', words: [{ start: 1000, end: 1400, text: 'Ciao' }, { start: 1500, end: 1700, text: 'a' }, { start: 1800, end: 3000, text: 'tutti' }] },
    { start: 4500, end: 5500, text: 'Seconda riga\ncon due righe' },
  ],
};

const subsClip = (props: Partial<SubtitlesClip['props']> = {}, template?: string): SubtitlesClip => ({
  id: 'subs', type: 'subtitles', start: 0, duration: 6, ...(template ? { template } : {}),
  props: { fontSize: 60, color: '#ffffff', position: 'bottom', margin: 40, maxWidth: 0.8, ...props },
});

function comp(clip: SubtitlesClip = subsClip()): Composition {
  return {
    $schema: 'motion-studio/composition@1', width: 1000, height: 500, fps: 30, duration: 6, background: '#000000',
    fonts: [{ family: 'Brand', src: 'assets/brand.woff2' }], scenes: [{ id: 's', start: 0, duration: 6 }],
    tracks: [
      { id: 'bg', kind: 'visual', clips: [{ id: 'card', type: 'shape', start: 0, duration: 6, props: { fill: '#ff0000' } }] },
      { id: 'sub', kind: 'subtitles', clips: [clip] },
    ],
  } as Composition;
}

function run(c: Composition, subtitles: RuntimeSubtitles | null = SUBS, mode: 'render' | 'preview' = 'render') {
  const errors: RuntimeError[] = [];
  const root = document.getElementById('ms-root')!;
  const player = mount(root, c, { mode, base: BASE, natives, report: (e) => errors.push(e), timeouts: { load: 50, seek: 50, layer: 50 }, subtitles });
  const line = () => root.querySelector<HTMLElement>('[data-clip-id="subs"] .ms-subs');
  return { player, errors, root, line };
}

describe('activeCue', () => {
  it('finds the cue whose span holds the time: start inclusive, end exclusive', () => {
    const cues = [{ start: 1000, end: 3500, text: 'a' }];
    expect([999, 1000, 3499, 3500].map((ms) => activeCue(cues, ms))).toEqual([-1, 0, 0, -1]);
  });
  it('binary search over many cues; a gap gives -1; of two overlapping cues the later one shows', () => {
    const cues = Array.from({ length: 1000 }, (_, i) => ({ start: i * 1000, end: i * 1000 + 800, text: String(i) }));
    expect(activeCue(cues, 0)).toBe(0);
    expect(activeCue(cues, 517_500)).toBe(517);
    expect(activeCue(cues, 517_900)).toBe(-1);
    expect(activeCue(cues, 999_799)).toBe(999);
    expect(activeCue([], 10)).toBe(-1);
    const overlap = [{ start: 0, end: 5000, text: 'long' }, { start: 1000, end: 2000, text: 'short' }];
    expect(activeCue(overlap, 1500)).toBe(1);
    expect(activeCue(overlap, 2500)).toBe(0); // the earlier cue still holds it
  });
});

describe('readRuntimeSubtitles and the page data', () => {
  it('accepts a well-formed block and refuses an unsorted, oversized or malformed one', () => {
    expect(readRuntimeSubtitles(SUBS)).toEqual({ ok: true, subtitles: SUBS });
    const bad: unknown[] = [
      { lang: 'it', cues: [{ start: 2000, end: 3000, text: 'b' }, { start: 1000, end: 1500, text: 'a' }] }, // unsorted
      { lang: 'it', cues: [{ start: 1000, end: 900, text: 'a' }] }, // ends before it starts
      { lang: 'it', cues: [{ start: Number.NaN, end: 900, text: 'a' }] },
      { lang: 'it', cues: [{ start: 0, end: 900, text: 'x'.repeat(201) }] },
      { lang: 'it', cues: Array.from({ length: 2001 }, (_, i) => ({ start: i, end: i + 1, text: 'a' })) },
      { lang: 'it', cues: [{ start: 0, end: 900, text: 'a', words: [{ start: 5, end: 1, text: 'a' }] }] },
      { lang: 'it', cues: [{ start: 0, end: 900, text: 'a' }], extra: 1 },
      { lang: 3, cues: [] },
      null,
    ];
    for (const b of bad) expect(readRuntimeSubtitles(b).ok).toBe(false);
  });
  it('readCompositionData drops an unsorted subtitles block with a subtitlesInvalid report, never failing the page', () => {
    const problems: RuntimeError[] = [];
    const unsorted = { lang: 'it', cues: [{ start: 2000, end: 3000, text: 'b' }, { start: 1000, end: 1500, text: 'a' }] };
    const data = readCompositionData(JSON.stringify({ base: './', composition: {}, subtitles: unsorted }), (e) => problems.push(e));
    expect(data).toEqual({ base: './', composition: {} });
    expect(problems.map((e) => e.code)).toEqual(['subtitlesInvalid']);
    const ok = readCompositionData(JSON.stringify({ base: './', composition: {}, subtitles: SUBS }));
    expect(ok).toEqual({ base: './', composition: {}, subtitles: SUBS });
  });
  it('renderRuntimePage inlines the subtitles', () => {
    const html = renderRuntimePage('<!--ms-composition-->', { base: './', composition: {}, subtitles: SUBS });
    const json = html.slice(html.indexOf('>') + 1, html.lastIndexOf('</script>'));
    expect(readCompositionData(json)).toEqual({ base: './', composition: {}, subtitles: SUBS });
  });
});

describe('the subtitles clip in the mount', () => {
  it('shows the cue text at t = 2 s and nothing at 4 s; no unknownClipType', async () => {
    const { player, errors, line } = run(comp());
    await player.seek(2);
    expect(line()!.textContent).toBe('Ciao a tutti');
    expect(line()!.style.display).not.toBe('none');
    await player.seek(4);
    expect(line()!.textContent).toBe('');
    expect(line()!.style.display).toBe('none');
    await player.seek(5);
    expect(line()!.textContent).toBe('Seconda riga\ncon due righe');
    expect(line()!.querySelector<HTMLElement>('.ms-subs-box')!.style.whiteSpace).toBe('pre-line');
    expect(errors.map((e) => e.code)).not.toContain('unknownClipType');
  });

  it('highlight colours the word being spoken (words only), and nothing between words', async () => {
    const { player, line } = run(comp(subsClip({ highlight: { color: '#ffcc00' } })));
    const on = () => [...line()!.querySelectorAll<HTMLElement>('[data-ms-word]')].filter((s) => s.dataset.on === 'true').map((s) => s.textContent);
    await player.seek(1.6);
    expect(on()).toEqual(['a']);
    const word = [...line()!.querySelectorAll<HTMLElement>('[data-ms-word]')][1]!;
    expect(word.style.color).toBe('rgb(255, 204, 0)');
    await player.seek(1.45);
    expect(on()).toEqual([]);
    await player.seek(5); // a cue without words: plain text
    expect(line()!.querySelectorAll('[data-ms-word]')).toHaveLength(0);
    expect(line()!.textContent).toBe('Seconda riga\ncon due righe');
  });

  it('without data, or with a template (Task 17), the built-in drawing shows nothing', async () => {
    const none = run(comp(), null);
    await none.player.seek(2);
    expect(none.line()!.textContent).toBe('');
    document.body.innerHTML = '<div id="ms-root"></div>';
    const tpl = run(comp(subsClip({}, 'layers/subs.html')));
    await tpl.player.seek(2);
    expect(tpl.line()).toBeNull();
    expect(tpl.errors.map((e) => e.code)).not.toContain('unknownClipType');
  });

  it('uses the brand font chain and reports a family not declared, like a text clip', async () => {
    const declared = run(comp());
    await declared.player.seek(2);
    expect(declared.root.querySelector<HTMLElement>('.ms-subs-box')!.style.fontFamily).toBe('"Brand", sans-serif');
    document.body.innerHTML = '<div id="ms-root"></div>';
    const missing = run(comp(subsClip({ fontFamily: 'Nope' })));
    expect(missing.errors).toContainEqual(expect.objectContaining({ code: 'fontMissing', clipId: 'subs' }));
  });

  it('setSubtitles redraws at the current time without a remount', async () => {
    const { player, root, line } = run(comp(), SUBS, 'preview');
    await player.seek(2);
    const stage = root.querySelector('.ms-stage');
    player.setSubtitles({ lang: 'it', cues: [{ start: 1500, end: 2500, text: 'Corretto' }] });
    expect(line()!.textContent).toBe('Corretto');
    expect(root.querySelector('.ms-stage')).toBe(stage);
    player.setSubtitles(null);
    expect(line()!.textContent).toBe('');
  });
});

describe('drawSubtitles', () => {
  const frame = { width: 1000, height: 500, safeZone: { top: 10, bottom: 60, left: 20, right: 30 } };
  it('places the line in the safe zone by position and margin, maxWidth a fraction of the frame', () => {
    const el = document.createElement('div');
    const cue = SUBS.cues[0]!;
    drawSubtitles(el, subsClip({ position: 'bottom', margin: 40, maxWidth: 0.5 }), cue, 2000, frame);
    expect(el.style.bottom).toBe('100px'); // 60 + 40
    expect(el.style.left).toBe('20px');
    expect(el.style.width).toBe('950px');
    expect(el.querySelector<HTMLElement>('.ms-subs-box')!.style.maxWidth).toBe('500px');
    drawSubtitles(el, subsClip({ position: 'top', margin: 15 }), cue, 2000, frame);
    expect(el.style.top).toBe('25px');
    expect(el.style.bottom).toBe('');
  });
  it('box, outline and shadow; the entrance runs over entranceSec from the cue start', () => {
    const el = document.createElement('div');
    const clip = subsClip({ background: '#000000aa', boxPadding: 12, boxRadius: 8, outlineColor: '#000000', outlineWidth: 3, shadow: true, entrance: 'fade', entranceSec: 0.4 });
    const cue = SUBS.cues[0]!;
    drawSubtitles(el, clip, cue, 1100, frame);
    const box = el.querySelector<HTMLElement>('.ms-subs-box')!;
    expect(box.style.padding).toBe('12px');
    expect(box.style.borderRadius).toBe('8px');
    expect(box.style.backgroundColor).not.toBe('');
    expect(box.style.textShadow).not.toBe('');
    expect(Number(box.style.opacity)).toBeCloseTo(1 - 0.75 ** 3, 3); // easeOutCubic(0.25)
    drawSubtitles(el, clip, cue, 1400, frame);
    expect(Number(box.style.opacity)).toBe(1);
    drawSubtitles(el, clip, null, 1400, frame);
    expect(el.style.display).toBe('none');
  });
});

describe('setSubtitles over the preview protocol', () => {
  it('parseIncoming accepts valid subtitles or null and refuses a bad block', () => {
    expect(parseIncoming({ type: 'setSubtitles', subtitles: SUBS })).toEqual({ type: 'setSubtitles', subtitles: SUBS });
    expect(parseIncoming({ type: 'setSubtitles', subtitles: null })).toEqual({ type: 'setSubtitles', subtitles: null });
    expect(parseIncoming({ type: 'setSubtitles', subtitles: { lang: 'it', cues: [{ start: 5, end: 1, text: 'x' }] } })).toBeNull();
    expect(parseIncoming({ type: 'setSubtitles' })).toBeNull();
    expect(parseIncoming({ type: 'setSubtitles', subtitles: null, extra: 1 })).toBeNull();
  });

  it('the runtime page changes the text shown, without a remount, and keeps it across a draft', async () => {
    const ORIGIN = 'http://127.0.0.1:4317';
    const html = renderRuntimePage('<!doctype html><html><head><!--ms-composition--></head><body><div id="ms-root"></div></body></html>', { base: '../v1/compositions/story/', composition: comp(), subtitles: SUBS });
    const w = new JSDOM(html, { url: `http://127.0.0.1:9999/tok/runtime/index.html?mode=preview&parentOrigin=${encodeURIComponent(ORIGIN)}`, pretendToBeVisual: true }).window;
    w.console.warn = () => {};
    (w.Element.prototype as unknown as { animate: unknown }).animate = function () { return { currentTime: 0, pause() {}, cancel() {} }; };
    (w as unknown as { FontFace: unknown }).FontFace = class { load() { return Promise.resolve(this); } };
    Object.defineProperty(w.document, 'fonts', { value: { add() {}, delete() { return true; } }, configurable: true });
    const sent: Array<Record<string, unknown>> = [];
    const parent = { postMessage: (m: Record<string, unknown>, o: string) => { if (o === ORIGIN) sent.push(m); } };
    Object.defineProperty(w, 'parent', { value: parent, configurable: true });
    Object.defineProperty(w, DRAFT_PARSER_KEY, { value: { parseDraft } });
    startRuntime(w as unknown as Window & typeof globalThis);
    const post = (data: unknown) => {
      const ev = new w.Event('message');
      Object.defineProperties(ev, { data: { value: data }, origin: { value: ORIGIN }, source: { value: parent } });
      w.dispatchEvent(ev);
    };
    const until = async (f: () => unknown) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > 5000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } };
    const line = () => w.document.querySelector<HTMLElement>('[data-clip-id="subs"] .ms-subs');
    await until(() => sent.some((m) => m.type === 'ready'));
    post({ type: 'seek', t: 2 });
    await until(() => sent.some((m) => m.type === 'time' && m.t === 2));
    expect(line()!.textContent).toBe('Ciao a tutti');
    const stage = w.document.querySelector('.ms-stage');
    post({ type: 'setSubtitles', subtitles: { lang: 'it', cues: [{ start: 1000, end: 3500, text: 'Ciao a tutte' }] } });
    expect(line()!.textContent).toBe('Ciao a tutte');
    expect(w.document.querySelector('.ms-stage')).toBe(stage);
    post({ type: 'setComposition', composition: comp(), keepTime: true, seq: 1 });
    await until(() => sent.some((m) => m.type === 'compositionApplied'));
    expect(line()!.textContent).toBe('Ciao a tutte');
  });
});

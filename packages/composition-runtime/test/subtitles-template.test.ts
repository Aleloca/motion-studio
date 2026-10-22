import { staticLayerCheck, type Composition, type SubtitlesClip } from '@motion-studio/shared';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Natives } from '../src/clock.ts';
import { startLayerAgent } from '../src/layer-agent.ts';
import { decodeLayerConfig, encodeLayerConfig, type LayerConfig } from '../src/layer-protocol.ts';
import { mount } from '../src/mount.ts';
import type { RuntimeError } from '../src/protocol.ts';
import type { RuntimeSubtitles } from '../src/subtitles.ts';

// Subtitles plan Task 17: a `subtitles` clip with `template` is an html layer fed with the cues.

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
    { start: 4500, end: 5500, text: 'Seconda riga' },
  ],
};

const tplClip = (template = 'layers/subs.html'): SubtitlesClip => ({
  id: 'subs', type: 'subtitles', start: 0, duration: 6, template,
  props: { fontSize: 60, color: '#ffffff', position: 'bottom', margin: 40, maxWidth: 0.8 },
});
const comp = (clip: SubtitlesClip = tplClip()): Composition => ({
  $schema: 'motion-studio/composition@1', width: 1000, height: 500, fps: 30, duration: 6, background: '#000000',
  fonts: [{ family: 'Brand', src: 'assets/brand.woff2' }], scenes: [{ id: 's', start: 0, duration: 6 }],
  tracks: [{ id: 'sub', kind: 'subtitles', clips: [clip] }],
} as Composition);

function run(subtitles: RuntimeSubtitles | null = SUBS, mode: 'render' | 'preview' = 'preview') {
  const errors: RuntimeError[] = [];
  const root = document.getElementById('ms-root')!;
  const player = mount(root, comp(), { mode, base: BASE, natives, report: (e) => errors.push(e), timeouts: { load: 50, seek: 50, layer: 50 }, subtitles });
  const frames = () => [...root.querySelectorAll<HTMLIFrameElement>('[data-clip-id="subs"] iframe')];
  return { player, errors, root, frames };
}
const until = async (f: () => unknown, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } };

describe('the mount: a template is an html layer fed with the cues', () => {
  it('a sandboxed iframe on the template file, with the cues in its configuration; no built-in subtitle box', async () => {
    const { player, frames, root, errors } = run(SUBS, 'render');
    expect(frames()).toHaveLength(1);
    const frame = frames()[0]!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe(`${BASE}layers/subs.html`);
    const config = decodeLayerConfig(frame.name)!;
    expect(config).toMatchObject({ v: 1, mode: 'render', clipId: 'subs', params: {}, fonts: [{ family: 'Brand', url: `${BASE}assets/brand.woff2` }] });
    expect(config.subtitles?.cues.length).toBe(2);
    expect(config.subtitles).toEqual(SUBS);
    await player.ready();
    await player.seek(2);
    expect(root.querySelector('.ms-subs')).toBeNull();
    expect(root.querySelector('.ms-subs-box')).toBeNull();
    expect(errors.map((e) => e.code)).toContain('layerTimeout'); // no layer.js in jsdom: reported like any html layer
  });

  it('without subtitles the template still gets an empty set (an undetermined language)', () => {
    const { frames } = run(null);
    expect(decodeLayerConfig(frames()[0]!.name)!.subtitles).toEqual({ lang: 'und', cues: [] });
  });

  it('preview setSubtitles remounts the template layer with the new cues', async () => {
    const { player, frames } = run(SUBS, 'preview');
    await player.ready();
    const first = frames()[0]!;
    player.setSubtitles({ lang: 'it', cues: [{ start: 1500, end: 2500, text: 'Corretto' }] });
    // The new layer loads under the old one, then replaces it.
    await until(() => frames().length === 1 && frames()[0] !== first);
    expect(first.isConnected).toBe(false);
    expect(decodeLayerConfig(frames()[0]!.name)!.subtitles).toEqual({ lang: 'it', cues: [{ start: 1500, end: 2500, text: 'Corretto' }] });
    player.setSubtitles(null);
    await until(() => decodeLayerConfig(frames()[0]!.name)!.subtitles?.cues.length === 0 && frames().length === 1);
  });

  it('a newer setSubtitles drops a remount still loading; destroy drops it too', async () => {
    const { player, frames, root } = run(SUBS, 'preview');
    await player.ready();
    player.setSubtitles({ lang: 'it', cues: [{ start: 0, end: 100, text: 'uno' }] });
    player.setSubtitles({ lang: 'it', cues: [{ start: 0, end: 100, text: 'due' }] });
    expect(frames().length).toBeLessThanOrEqual(2);
    await until(() => frames().length === 1 && decodeLayerConfig(frames()[0]!.name)!.subtitles?.cues[0]?.text === 'due');
    player.setSubtitles(SUBS);
    player.destroy();
    expect(root.querySelectorAll('iframe')).toHaveLength(0);
  });
});

describe('layer.js: window.msSubtitles and window.msActiveCue', () => {
  const layerWindow = (config: Partial<LayerConfig> = {}) => {
    const w = new JSDOM('<!doctype html><p>x</p>', { pretendToBeVisual: true }).window as unknown as Window & typeof globalThis;
    w.name = encodeLayerConfig({ v: 1, mode: 'render', clipId: 'subs', params: {}, fonts: [], subtitles: SUBS, ...config });
    Object.defineProperty(w.document, 'fonts', { value: [], configurable: true });
    Object.defineProperty(w.document, 'getAnimations', { value: () => [], configurable: true });
    startLayerAgent(w);
    return w as unknown as Window & typeof globalThis & {
      msSubtitles?: RuntimeSubtitles; msActiveCue?: (tMs: number) => { index: number; text: string; words: unknown[]; progress: number } | null;
      msSeek?: (t: number) => unknown;
    };
  };

  it('msSubtitles holds the cues, frozen all the way down', () => {
    const w = layerWindow();
    expect(w.msSubtitles!.cues.length).toBe(2);
    expect(w.msSubtitles).toEqual(SUBS);
    expect(Object.isFrozen(w.msSubtitles)).toBe(true);
    expect(Object.isFrozen(w.msSubtitles!.cues)).toBe(true);
    expect(Object.isFrozen(w.msSubtitles!.cues[0])).toBe(true);
    expect(Object.isFrozen(w.msSubtitles!.cues[0]!.words)).toBe(true);
    expect(Object.isFrozen(w.msSubtitles!.cues[0]!.words![0])).toBe(true);
    expect(() => { (w as unknown as Record<string, unknown>).msSubtitles = null; }).toThrow();
  });

  it('msActiveCue(1500) is the first cue, 20% through its 1000–3500 span', () => {
    const w = layerWindow();
    expect(w.msActiveCue!(1500)).toEqual({ index: 0, text: 'Ciao a tutti', words: SUBS.cues[0]!.words, progress: 0.2 });
    expect(w.msActiveCue!(999)).toBeNull();
    expect(w.msActiveCue!(4000)).toBeNull();
    expect(w.msActiveCue!(5000)).toEqual({ index: 1, text: 'Seconda riga', words: [], progress: 0.5 });
    expect(w.msActiveCue!(Number.NaN)).toBeNull();
  });

  it('frame times land on the same millisecond every time (whole microseconds)', () => {
    const w = layerWindow({ subtitles: { lang: 'it', cues: [{ start: 1000, end: 2000, text: 'x' }] } });
    // 0.1 + 0.9 seconds: a template computing t * 1000 may get 999.9999999999999.
    expect(w.msActiveCue!((0.1 + 0.9) * 1000)?.index).toBe(0);
  });

  it("the template's msSeek is driven like any html layer's, and reads the cue at its time", async () => {
    const w = layerWindow();
    const seen: Array<string | null> = [];
    w.msSeek = (t: number) => { seen.push(w.msActiveCue!(t * 1000)?.text ?? null); };
    const replies = new Map<number, (r: Record<string, unknown>) => void>();
    const port = { onmessage: null as ((m: { data: unknown }) => void) | null, close() {},
      postMessage(m: { id?: number }) { if (typeof m.id === 'number') replies.get(m.id)?.(m as Record<string, unknown>); } };
    const connect = new w.Event('message');
    Object.defineProperties(connect, { source: { value: w.parent }, ports: { value: [port] }, data: { value: { type: 'ms-layer-connect', v: 1 } } });
    w.dispatchEvent(connect);
    const seek = (id: number, t: number) => new Promise<Record<string, unknown>>((resolve) => { replies.set(id, resolve); port.onmessage!({ data: { id, op: 'seek', t } }); });
    expect(await seek(1, 2)).toMatchObject({ ok: true });
    expect(await seek(2, 4)).toMatchObject({ ok: true });
    expect(seen).toEqual(['Ciao a tutti', null]);
  });

  it('a plain html layer gets neither; a malformed subtitles block is left out', () => {
    const plain = layerWindow({ subtitles: undefined });
    expect(plain.msSubtitles).toBeUndefined();
    expect(plain.msActiveCue).toBeUndefined();
    const bad = layerWindow({ subtitles: { lang: 'it', cues: [{ start: 5, end: 1, text: 'x' }] } });
    expect(bad.msSubtitles).toBeUndefined();
  });
});

describe('the same checks as html layers', () => {
  it('a template that fetches the network is flagged by the existing layer check', () => {
    const html = '<!doctype html><script>window.msSeek = async (t) => { const c = msActiveCue(t * 1000); await fetch("https://example.com/log?" + c?.text); };</script>';
    const problems = staticLayerCheck(html, 'layers/subs.html');
    expect(problems.map((p) => p.key)).toEqual(expect.arrayContaining(['composition.layerNetwork']));
    expect(problems[0]).toMatchObject({ params: expect.objectContaining({ file: 'layers/subs.html' }) });
  });
});

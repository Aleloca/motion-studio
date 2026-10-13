import type { Composition } from '@motion-studio/shared';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installVirtualClock, type Natives } from '../src/clock.ts';
import { FrameTimeoutError, twoFrames } from '../src/frames.ts';
import { decodeLayerConfig } from '../src/layer-protocol.ts';
import { mount } from '../src/mount.ts';
import type { RuntimeError } from '../src/protocol.ts';
import { PRE_SEEK_SETTLE_MS } from '../src/timing.ts';

/** jsdom has no WAAPI, FontFace or media loading: minimal stand-ins record what the mount asks for. */
interface FakeAnimation { keyframes: unknown; options: KeyframeAnimationOptions; currentTime: number | null; cancelled: boolean; pause(): void; cancel(): void }
const created: Array<{ el: Element } & FakeAnimation> = [];
/** The FontFaces the mount added to document.fonts and has not deleted. */
const fontSet = new Set<unknown>();
const BASE = 'http://127.0.0.1:9999/tok/v1/compositions/story/';
const natives: Natives = {
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
  requestAnimationFrame: (fn) => setTimeout(() => fn(0), 1) as unknown as number,
  performanceNow: () => performance.now(),
};

beforeEach(() => {
  created.length = 0;
  document.body.innerHTML = '<div id="ms-root"></div>';
  (Element.prototype as unknown as { animate: unknown }).animate = function (this: Element, keyframes: unknown, options: KeyframeAnimationOptions) {
    const a = { el: this, keyframes, options, currentTime: 0 as number | null, cancelled: false, pause() {}, cancel() { a.cancelled = true; } };
    created.push(a);
    return a;
  };
  (globalThis as unknown as { FontFace: unknown }).FontFace = class { constructor(readonly family: string, readonly src: string) {} load() { return Promise.resolve(this); } };
  fontSet.clear();
  Object.defineProperty(document, 'fonts', { value: { add(f: unknown) { fontSet.add(f); }, delete(f: unknown) { return fontSet.delete(f); } }, configurable: true });
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
});
afterEach(() => { delete (Element.prototype as unknown as { animate?: unknown }).animate; });

function comp(over: Partial<Composition> = {}): Composition {
  return {
    $schema: 'motion-studio/composition@1', width: 1000, height: 500, fps: 30, duration: 6, background: '#000000',
    fonts: [{ family: 'Brand', src: 'assets/brand.woff2' }], scenes: [{ id: 's', start: 0, duration: 6 }],
    tracks: [
      { id: 'bg', kind: 'visual', clips: [{ id: 'card', type: 'shape', start: 0, duration: 6, props: { fill: '#ff0000', radius: 8 } }] },
      { id: 'hid', kind: 'visual', hidden: true, clips: [{ id: 'ghost', type: 'shape', start: 0, duration: 6, props: {} }] },
      { id: 'txt', kind: 'text', clips: [
        { id: 'title', type: 'text', start: 1, duration: 2, props: { text: 'Hello', x: 10, y: 20, width: 300, rotation: 5, opacity: 0.5 }, animations: [{ preset: 'fadeIn', duration: 0.5 }, { prop: 'x', from: -50, to: 0, start: 0.25, duration: 1 }] },
        { id: 'other', type: 'text', start: 4, duration: 2, props: { text: 'x', fontFamily: 'Nope' } },
      ] },
      { id: 'aud', kind: 'audio', clips: [{ id: 'music', type: 'audio', src: 'assets/m.wav', start: 0, duration: 6 }] },
    ],
    ...over,
  } as Composition;
}

function run(c: Composition, mode: 'render' | 'preview' = 'render', seek = 50) {
  const errors: RuntimeError[] = [];
  const root = document.getElementById('ms-root')!;
  const player = mount(root, c, { mode, base: BASE, natives, report: (e) => errors.push(e), timeouts: { load: 50, seek, layer: 50 } });
  const box = (id: string) => root.querySelector<HTMLElement>(`[data-clip-id="${id}"]`);
  return { player, errors, root, box };
}

describe('mount', () => {
  it('stacks clips in track order, skips hidden tracks and (in render mode) audio', () => {
    const { root, box } = run(comp());
    const ids = [...root.querySelectorAll<HTMLElement>('.ms-clip')].map((e) => [e.dataset.clipId, Number(e.style.zIndex)]);
    expect(ids).toEqual([['card', 1], ['title', 2], ['other', 3]]);
    expect(box('ghost')).toBeNull();
    expect(root.querySelector('audio')).toBeNull();
  });

  it('puts the static box on the clip element and the animated values on its content', () => {
    const { box } = run(comp());
    const title = box('title')!;
    expect(title.style.left).toBe('10px');
    expect(title.style.width).toBe('300px');
    expect(title.style.opacity).toBe('0.5');
    const content = title.querySelector<HTMLElement>('.ms-content')!;
    expect(content.textContent).toBe('Hello');
    expect(content.style.fontFamily).toContain('Brand'); // fonts[0] when the clip names none
    const anims = created.filter((a) => a.el === content);
    expect(anims.map((a) => [Object.keys((a.keyframes as object[])[0]!)[0], a.options.fill])).toEqual([['opacity', 'both'], ['--ms-x', 'both']]);
    const shape = box('card')!.querySelector<HTMLElement>('.ms-content')!;
    expect(shape.style.backgroundColor).toBe('currentcolor');
  });

  it('reports a font that is not declared and falls back', () => {
    const { errors, box } = run(comp());
    expect(errors).toContainEqual(expect.objectContaining({ code: 'fontMissing', clipId: 'other' }));
    expect(box('other')!.querySelector<HTMLElement>('.ms-content')!.style.fontFamily).toContain('sans-serif');
  });

  it('seek shows clips start-inclusive, end-exclusive and drives the animations by clip-local time', async () => {
    const { player, box } = run(comp());
    const content = box('title')!.querySelector('.ms-content')!;
    const [fade, slide] = created.filter((a) => a.el === content);
    await player.seek(0.999);
    expect(box('title')!.style.display).toBe('none');
    await player.seek(1);
    expect(box('title')!.style.display).toBe('');
    await player.seek(1.5);
    expect(fade!.currentTime).toBeCloseTo(500, 6);
    expect(slide!.currentTime).toBeCloseTo(250, 6);
    await player.seek(3);
    expect(box('title')!.style.display).toBe('none');
    await player.seek(6);
    expect(box('other')!.style.display).toBe(''); // ends with the composition: visible at the very end
    expect(box('card')!.style.display).toBe('');
    expect(player.time).toBe(6);
    await player.seek(99);
    expect(player.time).toBe(6);
  });

  it('a still shows every clip at t = 0 and ignores animations and audio', async () => {
    const { player, box, root } = run(comp({ duration: 0, scenes: [] }), 'preview');
    expect(created).toHaveLength(0);
    expect(root.querySelector('audio')).toBeNull();
    await player.seek(3);
    expect(player.time).toBe(0);
    for (const id of ['card', 'title', 'other']) expect(box(id)!.style.display).toBe('');
  });

  it('rejects asset paths that leave the composition folder', () => {
    const c = comp({ tracks: [{ id: 'v', kind: 'visual', clips: [
      { id: 'a', type: 'image', src: 'assets/../../../secret.png', start: 0, duration: 1, props: {} },
      { id: 'b', type: 'image', src: 'http://evil.test/x.png', start: 0, duration: 1, props: {} },
      { id: 'c', type: 'image', src: 'assets/ok.png', start: 0, duration: 1, props: {} },
    ] }] } as Partial<Composition>);
    const { errors, root } = run(c);
    expect(errors.filter((e) => e.code === 'assetPathRejected').map((e) => e.clipId)).toEqual(['a', 'b']);
    expect([...root.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([`${BASE}assets/ok.png`]);
  });

  it('a video clip may use a core media path (media/<id>.mp4, README "normalised media"); nothing else may', () => {
    const c = comp({ tracks: [{ id: 'v', kind: 'video', clips: [
      { id: 'v1', type: 'video', src: 'media/0.mp4', start: 0, duration: 1, props: {} },
      { id: 'v2', type: 'video', src: 'media/../../x.mp4', start: 0, duration: 1, props: {} },
      { id: 'i1', type: 'image', src: 'media/0.png', start: 0, duration: 1, props: {} },
    ] }] } as Partial<Composition>);
    const { errors, root } = run(c, 'preview');
    expect(errors.filter((e) => e.code === 'assetPathRejected').map((e) => e.clipId)).toEqual(['v2', 'i1']);
    expect([...root.querySelectorAll('video')].map((v) => v.getAttribute('src'))).toEqual([`${BASE}media/0.mp4`]);
  });

  it('preview: mute silences every video and audio clip; unmute restores each one\'s own setting (Task 8, Compare)', () => {
    const c = comp({ tracks: [{ id: 'v', kind: 'video', clips: [
      { id: 'n', type: 'video', src: 'media/0.mp4', audioSrc: 'assets/v.mp4', start: 0, duration: 5, props: {} },
      { id: 'plain', type: 'video', src: 'assets/w.mp4', start: 0, duration: 5, props: {} },
    ] }, { id: 'aud', kind: 'audio', clips: [{ id: 'music', type: 'audio', src: 'assets/m.wav', start: 0, duration: 5 }] }] } as unknown as Partial<Composition>);
    const { player, root } = run(c, 'preview');
    const [norm, plain] = [...root.querySelectorAll('video')];
    const audios = [...root.querySelectorAll('audio')];
    expect([norm!.muted, plain!.muted]).toEqual([true, false]);
    player.setMuted(true);
    expect([norm!.muted, plain!.muted]).toEqual([true, true]);
    expect(audios.every((a) => a.muted)).toBe(true);
    player.setMuted(false);
    expect([norm!.muted, plain!.muted]).toEqual([true, false]);
    expect(audios.every((a) => !a.muted)).toBe(true);
  });

  it('preview: a normalised video plays muted, its sound comes from the original asset in an <audio> at audioStart + trimStart', async () => {
    const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
    const saved = { play: proto.play, pause: proto.pause, paused: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'paused') };
    const played: HTMLMediaElement[] = [];
    const state = new WeakMap<HTMLMediaElement, boolean>();
    proto.play = function (this: HTMLMediaElement) { played.push(this); state.set(this, false); return Promise.resolve(); };
    proto.pause = function (this: HTMLMediaElement) { state.set(this, true); };
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get(this: HTMLMediaElement) { return state.get(this) ?? true; } });
    try {
      const c = comp({ tracks: [{ id: 'v', kind: 'video', clips: [
        { id: 'n', type: 'video', src: 'media/0.mp4', audioSrc: 'assets/v.mp4', audioStart: 0.1, trimStart: 0.5, volume: 0.8, start: 0, duration: 5, props: {} },
        { id: 'plain', type: 'video', src: 'assets/w.mp4', start: 0, duration: 5, props: {} },
      ] }] } as unknown as Partial<Composition>);
      const { player, root } = run(c, 'preview');
      const [norm, plain] = [...root.querySelectorAll('video')];
      expect(norm!.muted).toBe(true);
      expect(plain!.muted).toBe(false);
      const audios = [...root.querySelectorAll('audio')];
      expect(audios.map((a) => a.getAttribute('src'))).toEqual([`${BASE}assets/v.mp4`]);
      player.play();
      await new Promise((r) => setTimeout(r, 30));
      player.pause();
      expect(played).toContain(audios[0]);
      // The first video frame of the original sits at 0.1 s on its timeline; trimStart 0.5 → 0.6 + the time played.
      expect(audios[0]!.currentTime).toBeGreaterThanOrEqual(0.6);
      expect(audios[0]!.currentTime).toBeLessThan(0.7);
      expect(audios[0]!.volume).toBeCloseTo(0.8, 5);
      // Render mode: no <audio> (the core mixes the sound).
      document.body.innerHTML = '<div id="ms-root"></div>';
      const r = run(c, 'render');
      expect(r.root.querySelectorAll('audio')).toHaveLength(0);
    } finally {
      proto.play = saved.play; proto.pause = saved.pause;
      if (saved.paused) Object.defineProperty(HTMLMediaElement.prototype, 'paused', saved.paused);
    }
  });

  it('preview: a derived sound that cannot load is the warning clipAudioFailed and holds ready() at most ~3 s', async () => {
    const vproto = HTMLVideoElement.prototype as unknown as object;
    const saved = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState');
    Object.defineProperty(vproto, 'readyState', { configurable: true, get: () => 4 }); // videos are loaded, audio never
    try {
      const c = comp({ fonts: [], tracks: [{ id: 'v', kind: 'video', clips: [
        { id: 'n', type: 'video', src: 'media/0.mp4', audioSrc: 'assets/v.mp4', audioStart: 0, start: 0, duration: 5, props: {} },
      ] }] } as unknown as Partial<Composition>);
      const errors: RuntimeError[] = [];
      const root = document.getElementById('ms-root')!;
      const player = mount(root, c, { mode: 'preview', base: BASE, natives, report: (e) => errors.push(e), timeouts: { load: 20_000, seek: 50, layer: 50 } });
      const t0 = Date.now();
      await player.ready();
      expect(Date.now() - t0).toBeLessThan(6000);
      expect(errors.filter((e) => e.code === 'clipAudioFailed').map((e) => e.clipId)).toEqual(['n']);
      expect(errors.some((e) => e.code === 'assetLoadFailed')).toBe(false);
    } finally {
      delete (vproto as Record<string, unknown>).readyState;
      if (saved) Object.defineProperty(HTMLMediaElement.prototype, 'readyState', saved);
    }
  }, 15_000);

  it('html layers are sandboxed iframes that get their params and fonts through window.name', () => {
    const c = comp({ tracks: [{ id: 'v', kind: 'visual', clips: [
      { id: 'outro', type: 'html', src: 'layers/outro.html', start: 0, duration: 2, props: {}, params: {
        headline: { type: 'text', value: 'Thanks' }, accent: { type: 'color', value: '#fbbf24' }, n: { type: 'number', value: 3 },
        photo: { type: 'image', value: 'assets/p.jpg' },
      } },
    ] }] } as Partial<Composition>);
    const { root } = run(c, 'preview');
    const frame = root.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe(`${BASE}layers/outro.html`);
    expect(decodeLayerConfig(frame.name)).toEqual({
      v: 1, mode: 'preview', clipId: 'outro',
      params: { headline: 'Thanks', accent: '#fbbf24', n: 3, photo: `${BASE}assets/p.jpg` },
      fonts: [{ family: 'Brand', url: `${BASE}assets/brand.woff2` }],
      frameTimeoutMs: 25, // half the layer timeout: the layer fails its own frame wait before the runtime gives up on it
    });
  });

  it('a layer without the bootstrap is reported, and seeking does not hang', async () => {
    const c = comp({ tracks: [{ id: 'v', kind: 'visual', clips: [{ id: 'l', type: 'html', src: 'layers/x.html', start: 0, duration: 2, props: {} }] }] } as Partial<Composition>);
    const { player, errors } = run(c);
    await player.ready();
    expect(errors.map((e) => e.code)).toEqual(expect.arrayContaining(['layerTimeout']));
  });
});

describe('a layer the host cannot reach (C8)', () => {
  it('is reported as layerError in both modes and the seek still resolves: the renderer fails the render from the report', async () => {
    const layerComp = () => comp({ tracks: [{ id: 'v', kind: 'visual', clips: [{ id: 'l', type: 'html', src: 'layers/x.html', start: 0, duration: 2, props: {} }] }] } as Partial<Composition>);
    for (const mode of ['render', 'preview'] as const) {
      const r = run(layerComp(), mode);
      await r.player.ready();
      await expect(r.player.seek(1)).resolves.toBeUndefined();
      expect(r.errors.map((e) => e.code), mode).toContain('layerError');
    }
  });
});

describe('frames under the virtual clock', () => {
  it('the two frames after a seek use native time, so they resolve while the clock is frozen', async () => {
    const w = new JSDOM('<!doctype html>', { pretendToBeVisual: true }).window;
    const clock = installVirtualClock(w);
    let fired = false;
    w.requestAnimationFrame(() => { fired = true; }); // frozen: never fires until the clock advances
    await expect(twoFrames(clock.native, { strict: false, timeoutMs: 20 })).resolves.toBeUndefined();
    expect(fired).toBe(false);
  });
});

describe('render mode never captures an unpainted frame', () => {
  const silent: Natives = { ...natives, requestAnimationFrame: () => 0 }; // a native rAF that never fires

  it('strict frame waits reject with frameTimeout; preview waits fall back', async () => {
    await expect(twoFrames(silent, { strict: true, timeoutMs: 20 })).rejects.toBeInstanceOf(FrameTimeoutError);
    await expect(twoFrames(silent, { strict: false, timeoutMs: 20 })).resolves.toBeUndefined();
  });

  it('a render seek with no animation frame fails and reports frameTimeout', async () => {
    const errors: RuntimeError[] = [];
    const root = document.getElementById('ms-root')!;
    const player = mount(root, comp(), { mode: 'render', base: BASE, natives: silent, report: (e) => errors.push(e), timeouts: { load: 50, seek: 30, layer: 50 } });
    await expect(player.seek(1)).rejects.toBeInstanceOf(FrameTimeoutError);
    expect(errors.map((e) => e.code)).toContain('frameTimeout');
  });

  it('preview: a play that arrives while a seek runs is reported as playing when the seek ends (A5, never a false end)', async () => {
    const root = document.getElementById('ms-root')!;
    const c = comp({ tracks: [{ id: 'bg', kind: 'visual', clips: [{ id: 'card', type: 'shape', start: 0, duration: 6, props: {} }] }] } as Partial<Composition>);
    const player = mount(root, c, { mode: 'preview', base: BASE, natives, report: () => {}, timeouts: { load: 50, seek: 50, layer: 50 } });
    await player.ready();
    const times: Array<[number, boolean]> = [];
    player.onTime = (t, playing) => times.push([t, playing]);
    // The parent restores a frame near the end of a loop, then plays (CompositionMedia on `ready`).
    const seeking = player.seek(5.99);
    player.play({ loop: true, rate: 1 });
    await seeking;
    const atSeekEnd = times.find(([, p]) => !p);
    expect(atSeekEnd).toBeUndefined();
    expect(player.playing).toBe(true);
    player.pause();
  });

  it('the same in preview resolves after the short fallback', async () => {
    const root = document.getElementById('ms-root')!;
    const player = mount(root, comp(), { mode: 'preview', base: BASE, natives: silent, report: () => {}, timeouts: { load: 50, seek: 30, layer: 50 } });
    await expect(player.seek(1)).resolves.toBeUndefined();
  });
});

describe('render mode video frames (fake VideoFrame)', () => {
  /** The frame the fake video holds (µs), whatever its currentTime: a decoder that never moves. */
  let held = { timestamp: 0, duration: 33_333 };
  /** Called when a seek sets currentTime (the decoder moving to another frame), before `seeked`. */
  let onSeek: (() => void) | null = null;
  const restore: Array<() => void> = [];
  const define = (proto: object, key: string, desc: PropertyDescriptor) => {
    const old = Object.getOwnPropertyDescriptor(proto, key);
    Object.defineProperty(proto, key, { configurable: true, ...desc });
    restore.push(() => { if (old) Object.defineProperty(proto, key, old); else delete (proto as Record<string, unknown>)[key]; });
  };
  beforeEach(() => {
    held = { timestamp: 0, duration: 33_333 };
    onSeek = null;
    const times = new WeakMap<HTMLMediaElement, number>();
    define(HTMLMediaElement.prototype, 'readyState', { get: () => 4 });
    define(HTMLMediaElement.prototype, 'duration', { get: () => 10 });
    define(HTMLCanvasElement.prototype, 'getContext', { value: () => null, writable: true });
    define(HTMLMediaElement.prototype, 'currentTime', {
      get(this: HTMLMediaElement) { return times.get(this) ?? 0; },
      set(this: HTMLMediaElement, t: number) { times.set(this, t); onSeek?.(); setTimeout(() => this.dispatchEvent(new Event('seeked')), 1); },
    });
    (globalThis as unknown as { VideoFrame: unknown }).VideoFrame = class {
      timestamp = held.timestamp; duration = held.duration; displayWidth = 16; displayHeight = 16; close() {}
    };
    restore.push(() => { delete (globalThis as { VideoFrame?: unknown }).VideoFrame; });
  });
  afterEach(() => { while (restore.length) restore.pop()!(); });

  const videoComp = (extra: Record<string, unknown>) => comp({
    fonts: [], tracks: [{ id: 'v', kind: 'video', clips: [{ id: 'vid', type: 'video', src: 'assets/v.mp4', start: 0, duration: 6, sourceFps: 30, ...extra, props: {} }] }],
  } as unknown as Partial<Composition>);

  it('trusted source: a stale frame is never drawn and the seek fails fast with videoSeekTimeout', async () => {
    const { player, errors } = run(videoComp({ sourceTrusted: true, sourceVideoEnd: 6 }));
    await expect(player.seek(1)).rejects.toThrow(/videoSeekTimeout/);
    expect(errors.find((e) => e.code === 'videoSeekTimeout')?.message).toMatch(/still showed the frame at 0\.000 s \(stale\)/);
    expect(errors.some((e) => e.code === 'videoFrameMismatch')).toBe(false);
  });

  it('sourceTrusted without sourceVideoEnd is untrusted: the lenient rule draws the stable frame with a warning', async () => {
    const { player, errors } = run(videoComp({ sourceTrusted: true }));
    await player.seek(0);
    held = { timestamp: 400_000, duration: 33_333 };
    await player.seek(0.5);
    expect(errors.map((e) => e.code)).toEqual(['videoFrameMismatch']);
  });

  it('untrusted source: the same stable frame is drawn with a videoFrameMismatch warning, the seek resolves', async () => {
    const { player, errors } = run(videoComp({}));
    await player.seek(0); // the first seek: the load frame (ts 0) covers the target
    // The seek moves the decoder to a frame that does not cover the target: e.g. a WebM frame whose real duration is
    // longer than reported.
    onSeek = () => { held = { timestamp: 400_000, duration: 33_333 }; };
    await player.seek(0.5);
    expect(errors.map((e) => e.code)).toEqual(['videoFrameMismatch']);
    expect(errors[0]!.message).not.toMatch(/seek deadline/); // drawn at once, not a stall
  });

  it('untrusted source: the frame shown before the seek, still handed out after it, is waited out for the settle window, then drawn with a warning', async () => {
    const { player, errors } = run(videoComp({}), 'render', 10_000);
    await player.seek(0);
    held = { timestamp: 400_000, duration: 33_333 };
    await player.seek(0.4); // the frame at 0.4 s is shown (and covers the target)
    expect(errors).toEqual([]);
    const t0 = performance.now();
    await player.seek(0.6); // the decoder never moves: the pre-seek frame is held, not drawn on stability
    const waited = performance.now() - t0;
    expect(errors.map((e) => e.code)).toEqual(['videoFrameMismatch']);
    expect(errors[0]!.message).toMatch(/frame at 0\.400 s drawn for 0\.617 s/);
    expect(errors[0]!.message).not.toMatch(/seek deadline/); // released by the settle window, far before the 10 s deadline
    expect(waited).toBeGreaterThanOrEqual(PRE_SEEK_SETTLE_MS - 50);
    expect(waited).toBeLessThan(5_000);
  });

  it('untrusted source: a frame once held out for the window is not held again in that video (a legitimately repeated frame); the race fix still works for other frames', async () => {
    const { player, errors } = run(videoComp({}), 'render', 10_000);
    await player.seek(0);
    held = { timestamp: 400_000, duration: 33_333 };
    await player.seek(0.4);
    let t0 = performance.now();
    await player.seek(0.5); // the frame at 0.4 s stays (its real duration is longer than reported): held out once
    expect(performance.now() - t0).toBeGreaterThanOrEqual(PRE_SEEK_SETTLE_MS - 50);
    t0 = performance.now();
    await player.seek(0.6); // the same frame again: drawn on stability, no second window
    expect(performance.now() - t0).toBeLessThan(PRE_SEEK_SETTLE_MS / 2);
    expect(errors.map((e) => e.code)).toEqual(['videoFrameMismatch', 'videoFrameMismatch']);
    // Another frame: the decoder moves to 0.7 s, then Chrome is late by 100 ms on the next seek: still waited out, no warning.
    onSeek = () => { held = { timestamp: 700_000, duration: 33_333 }; };
    await player.seek(0.7);
    onSeek = () => { setTimeout(() => { held = { timestamp: 733_333, duration: 33_333 }; }, 100); };
    await player.seek(0.74);
    expect(errors.map((e) => e.code)).toEqual(['videoFrameMismatch', 'videoFrameMismatch']);
  });

  it('untrusted source: a pre-seek frame replaced by the seek\'s frame within the window is never drawn', async () => {
    const { player, errors } = run(videoComp({}), 'render', 10_000);
    await player.seek(0);
    held = { timestamp: 400_000, duration: 33_333 };
    await player.seek(0.4);
    onSeek = () => { setTimeout(() => { held = { timestamp: 600_000, duration: 33_333 }; }, 100); }; // Chrome late by 100 ms
    await player.seek(0.6);
    expect(errors).toEqual([]);
  });

  it('trusted source: the pre-seek rule does not apply (a stale frame still fails fast)', async () => {
    const { player, errors } = run(videoComp({ sourceTrusted: true, sourceVideoEnd: 6 }), 'render', 2_500);
    await player.seek(0);
    held = { timestamp: 400_000, duration: 33_333 };
    await player.seek(0.4);
    const t0 = performance.now();
    await expect(player.seek(0.6)).rejects.toThrow(/videoSeekTimeout/);
    expect(performance.now() - t0).toBeGreaterThan(PRE_SEEK_SETTLE_MS + 500); // its own deadline, never the settle window
    expect(errors.some((e) => e.code === 'videoFrameMismatch')).toBe(false);
  }, 20_000);

  it('untrusted source: a load frame far before the target is held to the deadline, then drawn with a warning', async () => {
    const { player, errors } = run(videoComp({}));
    await player.seek(2);
    expect(errors.map((e) => e.code)).toEqual(['videoFrameMismatch']);
    expect(errors[0]!.message).toMatch(/, held until the seek deadline$/); // the stall is visible in the warning (M1)
  });
});

describe('visibility: hidden clips and tracks, muted tracks', () => {
  const visComp = () => comp({ tracks: [
    { id: 'v', kind: 'visual', clips: [
      { id: 'shown', type: 'shape', start: 0, duration: 6, props: {} },
      { id: 'gone', type: 'shape', start: 0, duration: 6, hidden: true, props: {} },
      { id: 'vid', type: 'video', src: 'assets/v.mp4', start: 0, duration: 6, hidden: true, props: {} },
    ] },
    { id: 'ht', kind: 'visual', hidden: true, clips: [{ id: 'in-hidden-track', type: 'shape', start: 0, duration: 6, props: {} }] },
    { id: 'a', kind: 'audio', clips: [
      { id: 'heard', type: 'audio', src: 'assets/a.wav', start: 0, duration: 6 },
      { id: 'hidden-audio', type: 'audio', src: 'assets/b.wav', start: 0, duration: 6, hidden: true },
    ] },
    { id: 'm', kind: 'audio', muted: true, clips: [{ id: 'quiet', type: 'audio', src: 'assets/c.wav', start: 0, duration: 6 }] },
    { id: 'ha', kind: 'audio', hidden: true, clips: [{ id: 'in-hidden-audio-track', type: 'audio', src: 'assets/d.wav', start: 0, duration: 6 }] },
  ] } as Partial<Composition>);

  for (const mode of ['render', 'preview'] as const) {
    it(`${mode}: a hidden clip or a clip of a hidden track is not mounted at all`, async () => {
      const { root, box, player } = run(visComp(), mode);
      expect(box('shown')).not.toBeNull();
      for (const id of ['gone', 'vid', 'in-hidden-track']) expect(box(id)).toBeNull();
      expect(root.querySelector('video')).toBeNull();
      await player.ready();
      expect(box('shown')!.style.display).toBe('');
    });
  }

  it('preview: a hidden audio clip and the clips of a hidden track are silent (no element); a muted track plays muted', () => {
    const { root } = run(visComp(), 'preview');
    const srcs = [...root.querySelectorAll('audio')].map((a) => a.getAttribute('src'));
    expect(srcs).toEqual([`${BASE}assets/a.wav`, `${BASE}assets/c.wav`]);
  });
});

describe('load (a re-mount seeks straight to its time)', () => {
  it('loads fonts and media without showing a frame; ready() is load then t = 0', async () => {
    const shown: number[] = [];
    const { player, box } = run(comp(), 'preview');
    player.onTime = (t) => shown.push(t);
    await player.load();
    expect(shown).toEqual([]);
    expect(box('card')!.style.display).toBe('none');
    await player.seek(2);
    expect(shown).toEqual([2]);
    expect(box('title')!.style.display).toBe('');
  });
});

describe('play from (a re-mount resumes where the old mount had got to, M5)', () => {
  it('starts at `from`, not at the time last shown', async () => {
    const times: Array<[number, boolean]> = [];
    const { player } = run(comp({ tracks: [{ id: 'v', kind: 'visual', clips: [{ id: 'card', type: 'shape', start: 0, duration: 6, props: {} }] }] } as Partial<Composition>), 'preview');
    await player.load();
    await player.seek(1);
    player.onTime = (t, playing) => times.push([t, playing]);
    player.play({ from: 2.5 });
    await new Promise((r) => setTimeout(r, 30));
    player.pause();
    const first = times.find(([, p]) => p)!;
    expect(first[0]).toBeGreaterThanOrEqual(2.5);
    expect(first[0]).toBeLessThan(2.7);
  });
});

describe('destroy (the re-mount of setComposition)', () => {
  // jsdom implements no media loading: pause and load are stand-ins here (they only print "not implemented").
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  const saved = { pause: proto.pause, load: proto.load };
  beforeEach(() => { proto.pause = () => {}; proto.load = () => {}; });
  afterEach(() => { proto.pause = saved.pause; proto.load = saved.load; });
  const full = () => comp({ tracks: [
    { id: 'v', kind: 'video', clips: [
      { id: 'n', type: 'video', src: 'media/0.mp4', audioSrc: 'assets/v.mp4', start: 0, duration: 6, props: {}, animations: [{ preset: 'fadeIn', duration: 0.5 }] },
    ] },
    { id: 'l', kind: 'visual', clips: [
      { id: 'layer', type: 'html', src: 'layers/x.html', start: 0, duration: 6, props: {} },
      { id: 'pic', type: 'image', src: 'assets/p.png', start: 0, duration: 6, props: { kenBurns: { from: { scale: 1 }, to: { scale: 1.2 } } } },
    ] },
    { id: 't', kind: 'text', clips: [{ id: 'title', type: 'text', start: 0, duration: 6, props: { text: 'Hi' }, animations: [{ preset: 'fadeIn', duration: 0.5 }] }] },
    { id: 'a', kind: 'audio', clips: [{ id: 'music', type: 'audio', src: 'assets/m.wav', start: 0, duration: 6 }] },
  ] } as unknown as Partial<Composition>);

  it('removes every element, cancels every animation, releases media and layer frames, deletes its fonts', () => {
    const root = document.getElementById('ms-root')!;
    const before = root.childNodes.length;
    const { player } = run(full(), 'preview');
    const medias = [...root.querySelectorAll<HTMLMediaElement>('video, audio')];
    const frames = [...root.querySelectorAll('iframe')];
    expect(medias.length).toBe(3); // the video, its derived sound and the music
    expect(frames.length).toBe(1);
    expect(created.length).toBeGreaterThan(0);
    expect(fontSet.size).toBe(1);
    player.destroy();
    expect(root.childNodes.length).toBe(before);
    expect(created.every((a) => a.cancelled)).toBe(true);
    expect(medias.every((m) => !m.hasAttribute('src') && !m.isConnected)).toBe(true);
    expect(frames.every((f) => !f.hasAttribute('src') && !f.isConnected)).toBe(true);
    expect(fontSet.size).toBe(0);
    player.destroy(); // idempotent
  });

  it('a destroyed player reports nothing more, ignores commands and never calls back', async () => {
    const { player, errors } = run(full(), 'preview');
    const calls: string[] = [];
    player.onTime = () => calls.push('time');
    player.onBounds = () => calls.push('bounds');
    player.destroy();
    const n = errors.length;
    player.play();
    player.select('title');
    player.setScale(2);
    player.setMuted(true);
    await player.seek(1);
    await new Promise((r) => setTimeout(r, 120)); // past every load and layer timeout of run()
    expect(calls).toEqual([]);
    expect(errors.length).toBe(n);
    expect(player.playing).toBe(false);
  });

  it('many mounts and destroys leave the root, fonts and live animations as they were', () => {
    const root = document.getElementById('ms-root')!;
    const before = root.childNodes.length;
    for (let i = 0; i < 50; i++) run(full(), 'preview').player.destroy();
    expect(root.childNodes.length).toBe(before);
    expect(fontSet.size).toBe(0);
    expect(created.filter((a) => !a.cancelled)).toEqual([]);
  });
});

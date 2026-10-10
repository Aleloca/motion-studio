// useSyncedMedia (spec §3.2): the left player leads, the right one follows play, pause, rate and seek, drift beyond one
// frame is corrected on `timeupdate` at most every 250 ms, the shorter video holds its last frame, and a failing side
// leaves the other working. Fake media elements and a fake clock: nothing here depends on wall-clock time.
import { act, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRIFT_THROTTLE_MS, FRAME_SEC, useSyncedMedia, type SyncMedia } from '../src/ui/useSyncedMedia.ts';

/** A media element whose time, duration and paused state the test controls. */
class FakeMedia extends EventTarget implements SyncMedia {
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  error: unknown = null;
  /** Listeners currently attached, by type. */
  listeners = new Map<string, number>();
  play = vi.fn(() => { this.paused = false; return Promise.resolve(); });
  pause = vi.fn(() => { this.paused = true; });
  override addEventListener(type: string, l: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) {
    this.listeners.set(type, (this.listeners.get(type) ?? 0) + 1);
    super.addEventListener(type, l, o);
  }
  override removeEventListener(type: string, l: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) {
    this.listeners.set(type, (this.listeners.get(type) ?? 0) - 1);
    super.removeEventListener(type, l, o);
  }
  attached() { return [...this.listeners.values()].reduce((a, b) => a + b, 0); }
  /** The metadata arrives. */
  load(duration: number) { this.duration = duration; this.dispatchEvent(new Event('loadedmetadata')); }
  fire(type: string) { this.dispatchEvent(new Event(type)); }
}

let now = 0;
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
beforeEach(() => {
  now = 1000;
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { nextFrame += 1; frames.set(nextFrame, cb); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
});
afterEach(() => { vi.unstubAllGlobals(); });
/** Runs the animation frames that are due (they may ask for the next one). */
const flushFrame = () => { const due = [...frames.values()]; frames.clear(); for (const cb of due) cb(0); };

function setup(a: FakeMedia | null, b: FakeMedia | null, opts: { loop?: boolean; rate?: number; durations?: [number | null, number | null] } = {}, wrapper?: (p: { children: ReactNode }) => ReactNode) {
  return renderHook((p: { a: FakeMedia | null; b: FakeMedia | null; loop?: boolean; rate?: number }) =>
    useSyncedMedia(p.a, p.b, { now: () => now, loop: p.loop, rate: p.rate, durations: opts.durations }), { initialProps: { a, b, ...opts }, wrapper });
}

const loaded = (da: number, db: number) => {
  const a = new FakeMedia();
  const b = new FakeMedia();
  a.load(da);
  b.load(db);
  return { a, b };
};

describe('useSyncedMedia', () => {
  it('the follower mirrors play and pause of the shared transport', async () => {
    const { a, b } = loaded(6, 6);
    const { result } = setup(a, b);
    await act(async () => { result.current.play(); });
    expect(a.play).toHaveBeenCalledOnce();
    expect(b.play).toHaveBeenCalledOnce();
    expect(result.current.playing).toBe(true);
    a.currentTime = 2;
    b.currentTime = 2;
    act(() => { result.current.pause(); });
    expect(a.paused && b.paused).toBe(true);
    expect(result.current.playing).toBe(false);
    expect(result.current.clock.get().time).toBe(2);
    act(() => { result.current.toggle(); });
    expect(a.play).toHaveBeenCalledTimes(2);
    expect(b.play).toHaveBeenCalledTimes(2);
  });

  it('a seek moves both, and frame steps are 1/30 s on the shared time', () => {
    const { a, b } = loaded(6, 6);
    const { result } = setup(a, b);
    act(() => { result.current.seek(3.2); });
    expect(a.currentTime).toBe(3.2);
    expect(b.currentTime).toBe(3.2);
    expect(result.current.clock.get()).toEqual({ time: 3.2, settled: 3.2 });
    act(() => { result.current.step(1); });
    expect(a.currentTime).toBeCloseTo(97 / 30, 6);
    expect(b.currentTime).toBeCloseTo(97 / 30, 6);
    act(() => { result.current.step(-1); });
    act(() => { result.current.step(-1); });
    expect(b.currentTime).toBeCloseTo(95 / 30, 6);
    // Clamped to the timeline.
    act(() => { result.current.seek(-4); });
    expect(a.currentTime).toBe(0);
    act(() => { result.current.seek(99); });
    expect(a.currentTime).toBe(6);
  });

  it('the rate goes to both players', () => {
    const { a, b } = loaded(6, 6);
    const { rerender } = setup(a, b, { rate: 1 });
    rerender({ a, b, rate: 1.5 });
    expect([a.playbackRate, b.playbackRate, a.defaultPlaybackRate, b.defaultPlaybackRate]).toEqual([1.5, 1.5, 1.5, 1.5]);
  });

  it('corrects drift beyond one frame on timeupdate, leaves it within the threshold, at most every 250 ms', async () => {
    const { a, b } = loaded(10, 10);
    const { result } = setup(a, b);
    await act(async () => { result.current.play(); });
    now += DRIFT_THROTTLE_MS;
    // Within one frame: left alone.
    a.currentTime = 1;
    b.currentTime = 1 + FRAME_SEC * 0.9;
    act(() => a.fire('timeupdate'));
    expect(b.currentTime).toBe(1 + FRAME_SEC * 0.9);
    // Beyond: the follower jumps to the leader.
    a.currentTime = 2;
    b.currentTime = 2 - FRAME_SEC * 2;
    act(() => a.fire('timeupdate'));
    expect(b.currentTime).toBe(2);
    // Again 100 ms later: throttled.
    now += 100;
    a.currentTime = 2.1;
    b.currentTime = 1.9;
    act(() => a.fire('timeupdate'));
    expect(b.currentTime).toBe(1.9);
    // 250 ms after the last correction: corrected.
    now += DRIFT_THROTTLE_MS - 100;
    a.currentTime = 2.35;
    act(() => a.fire('timeupdate'));
    expect(b.currentTime).toBe(2.35);
  });

  it('never corrects while paused', () => {
    const { a, b } = loaded(10, 10);
    setup(a, b);
    now += 10_000;
    a.currentTime = 3;
    b.currentTime = 1;
    act(() => a.fire('timeupdate'));
    expect(b.currentTime).toBe(1);
  });

  it('the scrub bar spans the longer video; the shorter one holds its last frame', async () => {
    const { a, b } = loaded(4, 6);
    const { result } = setup(a, b);
    expect(result.current.duration).toBe(6);
    // A seek past the left's end: the left holds its last frame, paused; the right goes there.
    act(() => { result.current.seek(5); });
    expect(a.currentTime).toBe(4);
    expect(b.currentTime).toBe(5);
    await act(async () => { result.current.play(); });
    expect(a.play).not.toHaveBeenCalled();
    expect(b.play).toHaveBeenCalledOnce();
    // The right one now drives the time.
    b.currentTime = 5.5;
    act(flushFrame);
    expect(result.current.clock.get().time).toBe(5.5);
    // Back before the left's end while playing: the left plays again from there.
    act(() => { result.current.seek(1); });
    expect(a.currentTime).toBe(1);
    expect(a.play).toHaveBeenCalledOnce();
  });

  it('when the leader ends first, it holds and the longer follower keeps going to the end', async () => {
    const { a, b } = loaded(4, 6);
    const { result } = setup(a, b);
    await act(async () => { result.current.play(); });
    a.currentTime = 4;
    b.currentTime = 4;
    act(() => { a.paused = true; a.fire('ended'); });
    expect(result.current.playing).toBe(true);
    expect(b.pause).not.toHaveBeenCalled();
    // The end of the longer one ends playback (no loop).
    b.currentTime = 6;
    act(() => { b.paused = true; b.fire('ended'); });
    expect(result.current.playing).toBe(false);
    expect(result.current.clock.get().time).toBe(6);
  });

  it('when the follower is shorter it holds on its last frame while the leader plays on', async () => {
    const { a, b } = loaded(6, 3);
    const { result } = setup(a, b);
    await act(async () => { result.current.play(); });
    now += DRIFT_THROTTLE_MS;
    a.currentTime = 3.4;
    b.currentTime = 3;
    act(() => a.fire('timeupdate'));
    // No "correction" past its end: it holds.
    expect(b.currentTime).toBe(3);
    expect(b.paused).toBe(true);
    expect(result.current.playing).toBe(true);
  });

  it('with loop, the end of the longer one starts both again', async () => {
    const { a, b } = loaded(4, 6);
    const { result } = setup(a, b, { loop: true });
    await act(async () => { result.current.play(); });
    a.currentTime = 4;
    act(() => { a.paused = true; a.fire('ended'); });
    b.currentTime = 6;
    act(() => { b.paused = true; b.fire('ended'); });
    expect(result.current.playing).toBe(true);
    expect(a.currentTime).toBe(0);
    expect(b.currentTime).toBe(0);
    expect(a.play).toHaveBeenCalledTimes(2);
    expect(b.play).toHaveBeenCalledTimes(2);
  });

  it('play at the end starts over', async () => {
    const { a, b } = loaded(5, 5);
    const { result } = setup(a, b);
    act(() => { result.current.seek(5); });
    await act(async () => { result.current.play(); });
    expect(a.currentTime).toBe(0);
    expect(b.currentTime).toBe(0);
  });

  it('a side that fails is marked; the other keeps playing alone', async () => {
    const { a, b } = loaded(6, 6);
    const { result } = setup(a, b);
    act(() => { b.error = { code: 4 }; b.fire('error'); });
    expect(result.current.failed).toEqual([false, true]);
    await act(async () => { result.current.play(); });
    expect(a.play).toHaveBeenCalledOnce();
    expect(b.play).not.toHaveBeenCalled();
    act(() => { result.current.seek(2); });
    expect(a.currentTime).toBe(2);
    expect(result.current.clock.get().time).toBe(2);
  });

  it('a failing leader leaves the follower in charge of the time', async () => {
    const a = new FakeMedia();
    a.error = { code: 4 };
    const b = new FakeMedia();
    b.load(5);
    const { result } = setup(a, b);
    expect(result.current.failed).toEqual([true, false]);
    expect(result.current.duration).toBe(5);
    await act(async () => { result.current.play(); });
    expect(b.play).toHaveBeenCalledOnce();
    b.currentTime = 1.25;
    act(flushFrame);
    expect(result.current.clock.get().time).toBe(1.25);
  });

  it('known durations stand in until the metadata arrives', () => {
    const a = new FakeMedia();
    const b = new FakeMedia();
    const { result } = setup(a, b, { durations: [3, 7] });
    expect(result.current.duration).toBe(7);
    act(() => b.load(8));
    expect(result.current.duration).toBe(8);
  });

  it('a play that the browser refuses stops the transport', async () => {
    const { a, b } = loaded(6, 6);
    a.play.mockImplementationOnce(() => Promise.reject(new Error('NotAllowedError')));
    const { result } = setup(a, b);
    await act(async () => { result.current.play(); });
    expect(result.current.playing).toBe(false);
    expect(b.paused).toBe(true);
  });

  it('removes every listener and the frame loop on unmount (StrictMode included)', async () => {
    const { a, b } = loaded(6, 6);
    const { result, unmount } = setup(a, b, {}, ({ children }) => <StrictMode>{children}</StrictMode>);
    expect(a.attached()).toBeGreaterThan(0);
    await act(async () => { result.current.play(); });
    expect(frames.size).toBe(1);
    // StrictMode mounted twice: still one set of listeners per element.
    const perType = [...a.listeners.values()];
    expect(perType.every((n) => n === 1)).toBe(true);
    unmount();
    expect(a.attached()).toBe(0);
    expect(b.attached()).toBe(0);
    expect(frames.size).toBe(0);
    // Events after unmount do nothing.
    a.currentTime = 3;
    b.currentTime = 0;
    now += 10_000;
    a.fire('timeupdate');
    expect(b.currentTime).toBe(0);
  });

  it('new elements (another version) start paused at 0 with fresh listeners on the old ones removed', async () => {
    const { a, b } = loaded(6, 6);
    const { result, rerender } = setup(a, b);
    await act(async () => { result.current.play(); });
    const c = new FakeMedia();
    c.load(6);
    rerender({ a, b: c });
    expect(b.attached()).toBe(0);
    expect(result.current.playing).toBe(false);
    expect(a.paused).toBe(true);
    expect(result.current.clock.get().time).toBe(0);
  });
});

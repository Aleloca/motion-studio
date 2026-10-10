// Two media elements under one transport (spec §3.2, Compare): the left one leads, the right one follows play, pause,
// rate and seek. Browsers drift apart while playing, so on the leader's `timeupdate` the follower is put back on the
// leader's time when they differ by more than one frame, at most every 250 ms (a seek costs a decoder flush). The
// timeline spans the longer video: past its own end a video holds its last frame (paused), and when the leader is the
// one holding, the follower carries the time. A side whose media fails is left out; the other keeps working.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClock, type Clock } from './clock.ts';

/** One frame at 30 fps: the drift that is corrected, and the ←/→ step. */
export const FRAME_SEC = 1 / 30;
/** At most one drift correction in this many milliseconds. */
export const DRIFT_THROTTLE_MS = 250;
/** Within half a frame of its end a video counts as ended. */
const EPS = FRAME_SEC / 2;
/** A held video shows the frame this long before its end. */
const HOLD_BEFORE_END = 0.001;

/** What the hook uses of a media element (a `<video>`, or a fake in tests). */
export interface SyncMedia {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  playbackRate: number;
  defaultPlaybackRate: number;
  readonly error?: unknown;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface SyncedMediaOptions {
  /** Durations known before the metadata arrives (the outputs' `durationSec`), left and right. */
  durations?: readonly [number | null | undefined, number | null | undefined];
  /** Playback rate of both (default 1). */
  rate?: number;
  /** At the end of the longer video both start again. */
  loop?: boolean;
  /** Milliseconds clock for the drift throttle (tests pass a fake one). */
  now?: () => number;
}

export interface SyncedMedia {
  /** The shared time: every frame while playing, settled on seeks, pauses and `timeupdate`. */
  clock: Clock;
  playing: boolean;
  /** The longer of the two (the working ones), in seconds; 0 while unknown. */
  duration: number;
  /** Left and right: that side's media failed to load. */
  failed: readonly [boolean, boolean];
  play(): void;
  pause(): void;
  toggle(): void;
  seek(time: number): void;
  /** One frame (1/30 s) back or forward, paused. */
  step(dir: 1 | -1): void;
}

type Pair<T> = [T, T];
const SIDES = [0, 1] as const;
const known = (d: number) => Number.isFinite(d) && d > 0;

/** The longer duration of the sides that are there and work. */
function spanOf(present: Pair<boolean>, failed: readonly [boolean, boolean], durOf: (i: 0 | 1) => number): number {
  return Math.max(0, ...SIDES.filter((i) => present[i] && !failed[i]).map(durOf));
}

interface Env {
  clock: Clock;
  now(): number;
  hint(i: 0 | 1): number;
  rate(): number;
  loop(): boolean;
  onPlaying(on: boolean): void;
  onMeta(meta: Pair<number>): void;
  onFailed(failed: Pair<boolean>): void;
}

interface Controller {
  play(): void;
  pause(): void;
  seek(time: number): void;
  step(dir: 1 | -1): void;
  isPlaying(): boolean;
  applyRate(): void;
  dispose(): void;
}

function attach(els: Pair<SyncMedia | null>, env: Env): Controller {
  const meta: Pair<number> = [Number.NaN, Number.NaN];
  const failed: Pair<boolean> = [false, false];
  let playing = false;
  let time = 0;
  let lastFix = Number.NEGATIVE_INFINITY;
  let raf = 0;
  let alive = true;

  const durOf = (i: 0 | 1) => (known(meta[i]) ? meta[i] : env.hint(i));
  const usable = (i: 0 | 1) => els[i] !== null && !failed[i];
  const total = () => spanOf([els[0] !== null, els[1] !== null], failed, durOf);
  /** Timeline time `t` is past side i's end: it holds its last frame there. */
  const past = (i: 0 | 1, t: number) => { const d = durOf(i); return d > 0 && t >= d - EPS; };
  /** Whose time is the timeline's: the leader while it runs, else the follower. */
  // When every side is past its end (the very end of the timeline), the longer one keeps the time: falling back to the
  // leader would show the shorter one's end for a frame.
  const longest = (): 0 | 1 | null => SIDES.filter(usable).reduce<0 | 1 | null>((best, i) => (best === null || durOf(i) > durOf(best) ? i : best), null);
  const driver = (): 0 | 1 | null => SIDES.find((i) => usable(i) && !past(i, time)) ?? longest();
  const read = () => {
    const d = driver();
    if (d !== null) time = els[d]!.currentTime;
    return d;
  };
  /**
   * Puts side i at timeline time t; past its end it holds its last frame, paused (just before `duration`: some browsers
   * show nothing at exactly the end). A held side already there is not sought again. Says whether it runs there.
   */
  const place = (i: 0 | 1, t: number) => {
    const e = els[i]!;
    const d = durOf(i);
    const held = d > 0 && t >= d - EPS;
    if (held) {
      const at = Math.max(0, d - HOLD_BEFORE_END);
      if (Math.abs(e.currentTime - at) > HOLD_BEFORE_END) e.currentTime = at;
      if (!e.paused) e.pause();
    } else if (e.currentTime !== t) e.currentTime = t;
    return !held;
  };
  const start = (i: 0 | 1) => {
    const e = els[i]!;
    if (!e.paused) return;
    const r = e.play();
    if (r && typeof r.catch === 'function') r.catch(() => { if (alive && playing) pause(); });
  };
  const tick = () => {
    raf = 0;
    if (!alive || !playing) return;
    read();
    env.clock.set(time, false);
    raf = requestAnimationFrame(tick);
  };
  const setPlaying = (on: boolean) => {
    if (playing === on) return;
    playing = on;
    env.onPlaying(on);
    if (on && !raf) raf = requestAnimationFrame(tick);
    if (!on && raf) { cancelAnimationFrame(raf); raf = 0; }
  };

  function seek(to: number) {
    const span = total();
    const t = Math.max(0, span ? Math.min(span, to) : to);
    time = t;
    lastFix = env.now();
    for (const i of SIDES) if (usable(i) && place(i, t) && playing) start(i);
    env.clock.set(t, true);
  }
  function play() {
    if (playing || !SIDES.some(usable)) return;
    const span = total();
    if (span && time >= span - EPS) seek(0);
    else for (const i of SIDES) if (usable(i)) place(i, time);
    setPlaying(true);
    for (const i of SIDES) if (usable(i) && !past(i, time)) start(i);
  }
  function pause() {
    for (const e of els) if (e && !e.paused) e.pause();
    read();
    setPlaying(false);
    env.clock.set(time, true);
  }
  /** The longer one reached its end: again from the start (loop) or stop there. */
  const finish = () => {
    if (env.loop()) { seek(0); return; }
    for (const e of els) if (e && !e.paused) e.pause();
    time = total();
    setPlaying(false);
    env.clock.set(time, true);
  };

  const onTime = (i: 0 | 1) => () => {
    if (!playing) return;
    const d = read();
    // A side that reached its end while the other plays on holds its last frame.
    for (const j of SIDES) if (j !== d && usable(j) && past(j, time)) place(j, time);
    // Drift: the follower goes back on the leader's time, at most every DRIFT_THROTTLE_MS.
    if (i === 0 && d === 0 && usable(1) && !past(1, time)) {
      const f = els[1]!;
      const at = env.now();
      if (Math.abs(f.currentTime - time) > FRAME_SEC && at - lastFix >= DRIFT_THROTTLE_MS) {
        f.currentTime = time;
        lastFix = at;
      }
    }
    env.clock.set(time, true);
  };
  const onEnded = (i: 0 | 1) => () => {
    if (!playing) return;
    read();
    const other = i === 0 ? 1 : 0;
    // The shorter one stops on its last frame by itself; the other plays on.
    if (usable(other) && !past(other, time)) return;
    finish();
  };
  const onMeta = (i: 0 | 1) => () => {
    const e = els[i]!;
    meta[i] = e.duration;
    e.defaultPlaybackRate = env.rate();
    e.playbackRate = env.rate();
    env.onMeta([...meta]);
  };
  const onError = (i: 0 | 1) => () => {
    if (failed[i]) return;
    failed[i] = true;
    env.onFailed([...failed]);
    if (playing && !SIDES.some((j) => usable(j) && !past(j, time))) pause();
  };

  const bound: Array<[SyncMedia, string, EventListener]> = [];
  for (const i of SIDES) {
    const e = els[i];
    if (!e) continue;
    const on = (type: string, l: EventListener) => { e.addEventListener(type, l); bound.push([e, type, l]); };
    on('timeupdate', onTime(i));
    on('ended', onEnded(i));
    on('loadedmetadata', onMeta(i));
    on('durationchange', onMeta(i));
    on('error', onError(i));
    if (known(e.duration)) meta[i] = e.duration;
    if (e.error) failed[i] = true;
    // A fresh pair starts paused at 0.
    if (!e.paused) e.pause();
    if (e.currentTime !== 0) e.currentTime = 0;
  }
  env.onMeta([...meta]);
  env.onFailed([...failed]);

  const controller: Controller = {
    play, pause, seek,
    step(dir) {
      if (playing) pause();
      seek(Math.round((time + dir * FRAME_SEC) * 30) / 30);
    },
    isPlaying: () => playing,
    applyRate() {
      for (const e of els) if (e) { e.defaultPlaybackRate = env.rate(); e.playbackRate = env.rate(); }
    },
    dispose() {
      alive = false;
      for (const [e, type, l] of bound) e.removeEventListener(type, l);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
  controller.applyRate();
  return controller;
}

/**
 * The shared transport of two media elements (pass the elements, e.g. from callback refs; null when a side has none).
 * New elements start a fresh pair: paused at 0.
 */
export function useSyncedMedia(leader: SyncMedia | null, follower: SyncMedia | null, options: SyncedMediaOptions = {}): SyncedMedia {
  const [clock] = useState(createClock);
  const [playing, setPlaying] = useState(false);
  const [meta, setMeta] = useState<Pair<number>>([Number.NaN, Number.NaN]);
  const [failed, setFailed] = useState<Pair<boolean>>([false, false]);
  const opts = useRef(options);
  opts.current = options;
  const ctl = useRef<Controller | null>(null);

  useEffect(() => {
    const c = attach([leader, follower], {
      clock,
      now: () => (opts.current.now ?? (() => performance.now()))(),
      hint: (i) => opts.current.durations?.[i] ?? 0,
      rate: () => opts.current.rate ?? 1,
      loop: () => Boolean(opts.current.loop),
      onPlaying: setPlaying,
      onMeta: (m) => setMeta((prev) => (Object.is(prev[0], m[0]) && Object.is(prev[1], m[1]) ? prev : m)),
      onFailed: (f) => setFailed((prev) => (prev[0] === f[0] && prev[1] === f[1] ? prev : f)),
    });
    ctl.current = c;
    setPlaying(false);
    clock.set(0, true);
    return () => {
      c.dispose();
      if (ctl.current === c) ctl.current = null;
    };
  }, [leader, follower, clock]);
  const rate = options.rate ?? 1;
  useEffect(() => { ctl.current?.applyRate(); }, [rate, leader, follower]);

  const durations = options.durations;
  const duration = spanOf([leader !== null, follower !== null], failed, (i) => (known(meta[i]) ? meta[i] : durations?.[i] ?? 0));
  const play = useCallback(() => ctl.current?.play(), []);
  const pause = useCallback(() => ctl.current?.pause(), []);
  const toggle = useCallback(() => { const c = ctl.current; if (c) { if (c.isPlaying()) c.pause(); else c.play(); } }, []);
  const seek = useCallback((t: number) => ctl.current?.seek(t), []);
  const step = useCallback((dir: 1 | -1) => ctl.current?.step(dir), []);
  return useMemo(() => ({ clock, playing, duration, failed, play, pause, toggle, seek, step }), [clock, playing, duration, failed, play, pause, toggle, seek, step]);
}

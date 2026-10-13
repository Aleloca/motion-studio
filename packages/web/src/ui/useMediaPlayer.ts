// State of an audio or video element behind the in-house players: no native controls, so the element is driven from here.
// Time is read on the element's events and, while it plays, on every animation frame (a clock read, not an animation).
import { useCallback, useEffect, useRef, useState } from 'react';

export interface MediaPlayerState { playing: boolean; time: number; duration: number; failed: boolean }

const finite = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

export function useMediaPlayer<T extends HTMLMediaElement>(known?: number | null) {
  const ref = useRef<T>(null);
  const [state, setState] = useState<MediaPlayerState>({ playing: false, time: 0, duration: finite(known ?? 0), failed: false });
  const read = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setState((p) => {
      const duration = finite(el.duration) || p.duration;
      const next = { ...p, time: finite(el.currentTime), duration, playing: !el.paused && !el.ended };
      return next.time === p.time && next.duration === p.duration && next.playing === p.playing ? p : next;
    });
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const events = ['loadedmetadata', 'durationchange', 'timeupdate', 'seeked', 'play', 'playing', 'pause', 'ended'];
    for (const e of events) el.addEventListener(e, read);
    const fail = () => setState((p) => ({ ...p, failed: true, playing: false }));
    el.addEventListener('error', fail);
    read();
    return () => { for (const e of events) el.removeEventListener(e, read); el.removeEventListener('error', fail); };
  }, [read]);
  useEffect(() => {
    if (!state.playing) return;
    let id = requestAnimationFrame(function tick() { read(); id = requestAnimationFrame(tick); });
    return () => cancelAnimationFrame(id);
  }, [state.playing, read]);

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (el.paused || el.ended) void Promise.resolve(el.play()).catch(() => setState((p) => ({ ...p, failed: true, playing: false })));
    else el.pause();
  }, []);
  const seek = useCallback((to: number) => {
    const el = ref.current;
    if (!el) return;
    const max = finite(el.duration) || state.duration;
    const t = Math.min(max || to, Math.max(0, to));
    el.currentTime = t;
    setState((p) => ({ ...p, time: t }));
  }, [state.duration]);
  return { ref, ...state, toggle, seek };
}

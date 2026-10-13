// Playback of the editor's stage player (Phase 10b): the playhead clock, play / pause, seek and frame step, driven by the
// `CompositionMedia` events as the format view does. Tasks 6 and 7 (handles, timeline) read it through `useEditor()`.
import { useCallback, useEffect, useState } from 'react';
import type { CompositionMedia } from '../../components/CompositionPlayer.tsx';
import { createClock, type Clock } from '../../ui/clock.ts';

export interface PlayerControls {
  clock: Clock;
  playing: boolean;
  /** The frame reported its duration: controls may drive it. */
  ready: boolean;
  duration: number;
  seek(t: number): void;
  pause(): void;
  toggle(): void;
  /** One frame forward or back, paused. */
  step(dir: 1 | -1): void;
}

export function usePlayerControls(player: CompositionMedia | null, resetKey: string, fps: number): PlayerControls {
  const [clock] = useState(createClock);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(0);

  useEffect(() => { setPlaying(false); setReady(false); clock.set(0, true); }, [resetKey, clock]);
  useEffect(() => {
    if (!player) { setReady(false); setPlaying(false); return; }
    const off: Array<() => void> = [];
    const on = (type: string, f: () => void) => { player.addEventListener(type, f); off.push(() => player.removeEventListener(type, f)); };
    const meta = () => {
      if (Number.isFinite(player.duration)) setDuration(player.duration);
      setReady(true);
    };
    on('timeupdate', () => clock.set(player.currentTime, true));
    on('loadedmetadata', meta);
    on('durationchange', meta);
    on('play', () => setPlaying(true));
    on('pause', () => setPlaying(false));
    on('ended', () => setPlaying(false));
    if (Number.isFinite(player.duration)) { meta(); clock.set(player.currentTime, true); }
    return () => { for (const f of off) f(); };
  }, [player, clock]);
  // The playhead follows the picture smoothly while playing (timeupdate fires only a few times a second).
  useEffect(() => {
    if (!playing || !player) return;
    let raf = 0;
    const tick = () => { clock.set(player.currentTime, false); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, player, clock]);

  const seek = useCallback((to: number) => {
    if (!player) return;
    const next = Math.max(0, Number.isFinite(player.duration) ? Math.min(player.duration, to) : to);
    player.currentTime = next;
    clock.set(next, true);
  }, [player, clock]);
  const pause = useCallback(() => {
    player?.pause();
    setPlaying(false);
    if (player) clock.set(player.currentTime, true);
  }, [player, clock]);
  const toggle = useCallback(() => {
    if (!player || !ready) return;
    if (playing) { pause(); return; }
    if (duration && player.currentTime >= duration - 1 / fps / 2) seek(0);
    setPlaying(true);
    void player.play().catch(() => setPlaying(false));
  }, [player, ready, playing, pause, duration, fps, seek]);
  const step = useCallback((dir: 1 | -1) => {
    if (!player || !ready) return;
    if (playing) pause();
    seek(Math.round((player.currentTime + dir / fps) * fps) / fps);
  }, [player, ready, playing, pause, seek, fps]);
  return { clock, playing, ready, duration, seek, pause, toggle, step };
}

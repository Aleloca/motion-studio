import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useT } from '../i18n.tsx';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import type { MediaPlayerState } from './useMediaPlayer.ts';

/** `m:ss` (or `h:mm:ss`), the player's time. */
export function clockText(sec: number): string {
  const s = Math.max(0, Math.floor(sec + 1e-6));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
const round3 = (v: number) => Math.round(v * 1000) / 1000;
/** Arrow keys move the position by this many seconds; PageUp / PageDown by twice as much. */
export const SEEK_STEP = 5;

/**
 * The controls both players share, on the Phase 7 transport styles (round play button, mono time, scrub bar with a head):
 * play/pause (a button, so Space and Enter work), the time, and a scrub bar (role="slider") that takes the pointer and the
 * keys: ← → 5 s, PageUp / PageDown 10 s, Home / End, Space plays or pauses. `peaks` (0..1, up to 400) draw a waveform behind
 * the bar, the played part in the accent colour.
 */
export function PlayerControls({ player, peaks, className }: {
  player: MediaPlayerState & { toggle(): void; seek(to: number): void };
  peaks?: readonly number[] | null;
  className?: string;
}) {
  const t = useT();
  const p = t.web.player;
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const { playing, time, duration, failed } = player;
  const off = failed || duration <= 0;
  const pct = duration ? Math.min(100, Math.max(0, (time / duration) * 100)) : 0;
  const at = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !r.width || !duration) return null;
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (off || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragging.current = true;
    const s = at(e.clientX);
    if (s !== null) player.seek(s);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const s = at(e.clientX);
    if (s !== null) player.seek(s);
  };
  const up = () => { dragging.current = false; };
  const keys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (off || e.metaKey || e.ctrlKey || e.altKey) return;
    const to = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? time + SEEK_STEP
      : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? time - SEEK_STEP
        : e.key === 'PageUp' ? time + SEEK_STEP * 2 : e.key === 'PageDown' ? time - SEEK_STEP * 2
          : e.key === 'Home' ? 0 : e.key === 'End' ? duration : null;
    if (e.key === ' ') { e.preventDefault(); player.toggle(); return; }
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    player.seek(to);
  };
  const bars = peaks && peaks.length > 0 ? peaks : null;
  const wave = (cls: string) => (
    <svg className={cls} viewBox={`0 0 ${bars!.length} 1`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {bars!.map((v, i) => { const h = Math.max(0.04, v); return <rect key={i} x={i + 0.15} y={(1 - h) / 2} width={0.7} height={h} />; })}
    </svg>
  );
  return (
    <div className={cx('ms-player-controls', className)}>
      <button type="button" className="ms-player-play" aria-label={playing ? p.pause : p.play} aria-keyshortcuts="Space" disabled={failed} onClick={player.toggle}>
        <Icon name={playing ? 'pause' : 'play'} size={13} fill={!playing} strokeWidth={playing ? 2 : 1.4} />
      </button>
      <span className="ms-player-tc">{clockText(time)}<span className="ms-player-total"> / {clockText(duration)}</span></span>
      <div ref={track} className={cx('ms-player-scrub', bars && 'ms-wave', off && 'ms-off')} role="slider" tabIndex={off ? -1 : 0} aria-label={p.position}
        aria-disabled={off || undefined} aria-valuemin={0} aria-valuemax={round3(duration)} aria-valuenow={round3(time)}
        aria-valuetext={p.positionText({ time: clockText(time), total: clockText(duration) })}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={keys}>
        {bars ? <>{wave('ms-player-wave')}<span className="ms-player-played" style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}>{wave('ms-player-wave')}</span></> : null}
        {bars ? null : <div className="ms-player-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>}
        <span className="ms-player-head" style={{ left: `${pct}%` }} aria-hidden="true" />
      </div>
      {failed ? <span className="ms-player-err" role="status">{p.unplayable}</span> : null}
    </div>
  );
}

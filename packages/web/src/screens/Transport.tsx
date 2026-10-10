// The video transport under a player (format view, Compare): play/pause (Space), the timecode, frame by frame (←/→,
// 1/30 s), loop and speed (visual test point 39), and the scrub bar with a ruler and the comment markers.
import type { Pin } from '@motion-studio/shared';
import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from 'react';
import { formatNumber, useLocale, useT } from '../i18n.tsx';
import { useClock, type Clock } from '../ui/clock.ts';
import { Button, Icon, Select, cx } from '../ui/index.ts';
import './format.css';

/** Frame step of ←/→ (spec: 1/30 s). */
export const FPS = 30;
/** The player's own controls: Space on them is the shortcut itself, not a click. */
export const PLAYER_CONTROLS = '.ms-fv-play, .ms-fv-scrub';
export const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** `00:04.50` (prototype timecode: minutes, seconds, hundredths). */
export function timecode(s: number): string {
  const v = Math.max(0, s);
  const cs = Math.floor(round3(v) * 100 + 1e-6);
  const mm = Math.floor(cs / 6000);
  const ss = Math.floor((cs % 6000) / 100);
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}


/** A pending comment of this format with its number among the comments that go out (the chips use the same). */
export interface Mark { pin: Pin; number: number }

/**
 * Under the player: play/pause, the timecode, frame by frame and the scrub bar with a ruler and the comment markers
 * (a marker seeks to its comment). Dragging pauses and resumes afterwards if it was playing. The playhead follows
 * every frame; the slider's value for assistive technology only the settled time.
 */
export const SPEEDS = ['0.5', '1', '1.5', '2'] as const;
export type Speed = (typeof SPEEDS)[number];

export function Transport({ clock, duration, playing, disabled, marks = [], hint, onToggle, onStep, onSeek, onPause, onResume, loop, onLoop, speed, onSpeed }: {
  clock: Clock; duration: number; playing: boolean; disabled: boolean; marks?: Mark[];
  /** The keys line at the end of the controls. */
  hint: string;
  onToggle(): void; onStep(dir: 1 | -1): void; onSeek(t: number): void; onPause(): void; onResume(): void;
  loop: boolean; onLoop(on: boolean): void; speed: Speed; onSpeed(s: Speed): void;
}) {
  const t = useT();
  const f = t.web.formatView;
  const locale = useLocale();
  const { time, settled } = useClock(clock);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ resume: boolean } | null>(null);
  const pct = (s: number) => (duration ? Math.min(100, Math.max(0, (s / duration) * 100)) : 0);
  const at = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !r.width || !duration) return null;
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { resume: playing };
    if (playing) onPause();
    const s = at(e.clientX);
    if (s !== null) onSeek(s);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const s = at(e.clientX);
    if (s !== null) onSeek(s);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.resume) onResume();
  };
  const keys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === 'Home') { e.preventDefault(); onSeek(0); }
    if (e.key === 'End') { e.preventDefault(); onSeek(duration); }
    if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); onSeek(clock.get().time + (e.key === 'PageUp' ? 1 : -1)); }
  };
  // Ruler: at most ~10 labels; the last one would be cut by the end of the bar.
  const every = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => duration / s <= 10) ?? 600;
  const ticks = duration ? Array.from({ length: Math.floor(duration / every + 1e-6) + 1 }, (_, i) => i * every).filter((s) => s / duration <= 0.94) : [];
  return (
    <section className="ms-fv-transport" aria-label={f.transport} data-part="b">
      <div className="ms-fv-controls">
        <button type="button" className="ms-fv-play" aria-label={playing ? f.pause : f.play} aria-keyshortcuts="Space" disabled={disabled} onClick={onToggle}>
          <Icon name={playing ? 'pause' : 'play'} size={13} fill={!playing} strokeWidth={playing ? 2 : 1.4} />
        </button>
        <span className="ms-fv-tc">{timecode(time)}<span className="ms-faint"> / {timecode(duration)}</span></span>
        <Button size="sm" variant="outline" icon aria-label={f.prevFrame} title={f.prevFrame} aria-keyshortcuts="ArrowLeft" disabled={disabled} onClick={() => onStep(-1)}><Icon name="back" size={13} /></Button>
        <Button size="sm" variant="outline" icon aria-label={f.nextFrame} title={f.nextFrame} aria-keyshortcuts="ArrowRight" disabled={disabled} onClick={() => onStep(1)}><Icon name="forward" size={13} /></Button>
        <span className="ms-fv-sep" aria-hidden="true" />
        <Button size="sm" variant="outline" icon className={cx('ms-fv-loop', loop && 'ms-on')} aria-label={f.loop} title={f.loop} aria-pressed={loop} onClick={() => onLoop(!loop)}><Icon name="refresh" size={13} /></Button>
        <Select className="ms-fv-speed" variant="pill" label={f.speed} value={speed} onChange={onSpeed}
          options={SPEEDS.map((v) => ({ value: v, label: f.speedValue({ n: formatNumber(locale, Number(v)) }) }))} />
        <span className="ms-grow" />
        <span className="ms-fv-keys">{hint}</span>
      </div>
      <div className="ms-fv-scrubwrap">
        <div ref={track} className={cx('ms-fv-scrub', disabled && 'ms-off')} role="slider" tabIndex={disabled ? -1 : 0} aria-label={f.position} aria-disabled={disabled || undefined}
          aria-valuemin={0} aria-valuemax={round3(duration)} aria-valuenow={round3(settled)} aria-valuetext={f.positionText({ time: timecode(settled), total: timecode(duration) })}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={keys}>
          <div className="ms-fv-ruler" aria-hidden="true">
            {ticks.map((s) => <span key={s} style={{ left: `${pct(s)}%` }}>{t.web.canvas.seconds({ n: formatNumber(locale, s) })}</span>)}
          </div>
          <div className="ms-fv-track" aria-hidden="true"><i style={{ width: `${pct(time)}%` }} /></div>
          <span className="ms-fv-head" style={{ left: `${pct(time)}%` }} aria-hidden="true" />
        </div>
        <div className="ms-fv-marks">
          {marks.filter((m) => m.pin.timeSec !== null).map(({ pin, number }) => (
            <button key={number} type="button" className="ms-fv-mark" style={{ left: `${pct(pin.timeSec!)}%` }} title={pin.note}
              aria-label={f.marker({ n: number, time: timecode(pin.timeSec!) })} disabled={disabled} onClick={() => { if (playing) onPause(); onSeek(pin.timeSec!); }}>
              {number}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

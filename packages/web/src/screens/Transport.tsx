// The video transport under a player (format view, Compare): play/pause (Space), the timecode, frame by frame (←/→,
// 1/30 s), loop and speed (visual test point 39), and the scrub bar with a ruler and the comment markers.
import type { Pin } from '@motion-studio/shared';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from 'react';
import { formatNumber, useLocale, useT } from '../i18n.tsx';
import { useClock, type Clock } from '../ui/clock.ts';
import { Button, Icon, Select, cx } from '../ui/index.ts';
import { MIN_RANGE, rangeTimes } from './pinModel.ts';
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


/** The bubble's centre (px) for a band centred at `frac` of the bar: on the band, kept 8 px inside the bar. Pure, so the Chrome layout test runs the same function. */
export function bubbleLeft(total: number, width: number, frac: number): number {
  return Math.min(total - 8 - width / 2, Math.max(8 + width / 2, 16 + (total - 32) * frac));
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

export function Transport({ clock, duration, playing, disabled, marks = [], onRange, blocked, extra, hint, onToggle, onStep, onSeek, onPause, onResume, loop, onLoop, speed, onSpeed }: {
  clock: Clock; duration: number; playing: boolean; disabled: boolean; marks?: Mark[];
  /** The band picked with a drag on the ruler (or Shift + drag on the track) was confirmed with the bubble's Comment (seconds): a range comment. Absent: no band can be picked; Shift + drag scrubs. */
  onRange?(r: { start: number; end: number }): void;
  /** Another overlay (the range dialog, a comment draft) is open: a picked band is dropped and none can be started. */
  blocked?: boolean;
  /** Compact controls next to the timecode (the clip and range comment buttons in the format view). */
  extra?: ReactNode;
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
  const drag = useRef<{ resume: boolean; from?: number; px?: number; ruler?: boolean } | null>(null);
  /** The range being picked with Shift + drag. */
  const [picking, setPicking] = useState<{ a: number; b: number } | null>(null);
  /** The band picked and released: it stays, with a Comment bubble, until it is used, replaced or cancelled (Esc). */
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const bubbleBtn = useRef<HTMLButtonElement>(null);
  const bubbleEl = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const cv = t.web.conversation;
  const cancelRange = () => { drag.current = null; setPicking(null); setSel(null); };
  useEffect(() => { if (disabled || !onRange || blocked) { setPicking(null); setSel(null); } }, [disabled, onRange, blocked]);
  useEffect(() => {
    if (!picking && !sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Esc belongs to a dialog or a text field when it is typed there.
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('[role="dialog"], [aria-modal="true"], dialog, input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      const focusTrack = sel !== null && document.activeElement === bubbleBtn.current;
      cancelRange();
      if (focusTrack) track.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking, sel]);
  useEffect(() => { if (sel) bubbleBtn.current?.focus(); }, [sel]);
  const pct = (s: number) => (duration ? Math.min(100, Math.max(0, (s / duration) * 100)) : 0);
  const at = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !r.width || !duration) return null;
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || blocked || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setSel(null);
    // A drag on the ruler, or Shift + drag anywhere on the bar, picks a band; a short press on the ruler still seeks.
    const ruler = Boolean((e.target as Element).closest?.('.ms-fv-ruler'));
    if (onRange && (e.shiftKey || ruler)) {
      const a = at(e.clientX);
      if (a === null) return;
      drag.current = { resume: false, from: a, px: e.clientX, ruler: ruler && !e.shiftKey };
      setPicking({ a, b: a });
      return;
    }
    drag.current = { resume: playing };
    if (playing) onPause();
    const s = at(e.clientX);
    if (s !== null) onSeek(s);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const s = at(e.clientX);
    if (drag.current.from !== undefined) { if (s !== null) setPicking({ a: drag.current.from, b: s }); return; }
    if (s !== null) onSeek(s);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d?.from !== undefined) {
      const b = e.type === 'pointerup' ? at(e.clientX) ?? d.from : d.from;
      setPicking(null);
      if (e.type !== 'pointerup') return;
      // A press, or a drag too short to be a range, on the ruler seeks like a click.
      if (d.ruler && (Math.abs(e.clientX - (d.px ?? e.clientX)) < 3 || Math.abs(b - d.from) < MIN_RANGE)) { onSeek(b); return; }
      if (Math.abs(b - d.from) >= MIN_RANGE) setSel({ start: Math.min(b, d.from), end: Math.max(b, d.from) });
      return;
    }
    if (d?.resume) onResume();
  };
  const keys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === 'Home') { e.preventDefault(); onSeek(0); }
    if (e.key === 'End') { e.preventDefault(); onSeek(duration); }
    if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); onSeek(clock.get().time + (e.key === 'PageUp' ? 1 : -1)); }
  };
  /** The band shown: the one being dragged, else the released one. */
  const bandKey = picking ? `${picking.a}:${picking.b}` : sel ? `${sel.start}:${sel.end}` : '';
  const band = picking ? { start: Math.min(picking.a, picking.b), end: Math.max(picking.a, picking.b) } : sel;
  // The bubble is centred on the band and kept inside the bar, whatever its width.
  useLayoutEffect(() => {
    const el = bubbleEl.current; const sec = section.current;
    if (!el || !sec || !band) return;
    const w = el.offsetWidth; const total = sec.clientWidth;
    if (!w || !total) return;
    el.style.left = `${bubbleLeft(total, w, pct((band.start + band.end) / 2) / 100)}px`;
  }, [bandKey, sel !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  // Ruler: at most ~10 labels; the last one would be cut by the end of the bar.
  const every = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => duration / s <= 10) ?? 600;
  const ticks = duration ? Array.from({ length: Math.floor(duration / every + 1e-6) + 1 }, (_, i) => i * every).filter((s) => s / duration <= 0.94) : [];
  return (
    <section ref={section} className="ms-fv-transport" aria-label={f.transport} data-part="b">
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
        {extra}
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
        <div className="ms-fv-spans">
          {band ? <span className="ms-fv-span ms-picking" aria-hidden="true" style={{ left: `${pct(band.start)}%`, width: `${pct(band.end - band.start)}%` }} /> : null}
          {marks.filter((m) => m.pin.range).map(({ pin, number }) => {
            const { a, b } = rangeTimes(locale, pin.range!);
            return <span key={number} className="ms-fv-span" role="img" aria-label={cv.rangeSpan({ a, b, note: pin.note ?? '' })}
              style={{ left: `${pct(pin.range!.start)}%`, width: `${pct(pin.range!.end - pin.range!.start)}%` }} />;
          })}
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
        {band ? (
          sel ? (
            <div ref={bubbleEl} className="ms-fv-rangebubble" role="group" aria-label={cv.rangeBubble} style={{ left: `calc(16px + (100% - 32px) * ${pct((band.start + band.end) / 2) / 100})` }}>
              <span className="ms-fv-rangetc">{timecode(band.start)} – {timecode(band.end)}</span>
              <Button ref={bubbleBtn} size="sm" variant="ink" onClick={() => { const r = sel; setSel(null); onRange?.(r); }}><Icon name="comment" size={12} />{cv.rangeBubbleAction}</Button>
              <span className="ms-fv-rangeesc">{cv.rangeBubbleEsc}</span>
            </div>
          ) : (
            <div ref={bubbleEl} className="ms-fv-rangebubble ms-live" aria-hidden="true" style={{ left: `calc(16px + (100% - 32px) * ${pct((band.start + band.end) / 2) / 100})` }}>
              <span className="ms-fv-rangetc">{timecode(band.start)} – {timecode(band.end)}</span>
            </div>
          )
        ) : null}
    </section>
  );
}

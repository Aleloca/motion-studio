import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { cx } from './cx.ts';

export interface SliderProps {
  value: number; min: number; max: number; step?: number; onChange: (value: number) => void;
  /** The accessible name. */
  label: string;
  /** What assistive technology reads instead of the bare number (e.g. "4.5×"). */
  valueText?: string;
  disabled?: boolean; className?: string;
}

/**
 * A slider (role="slider"), drawn here: no native range input. The pointer drags the thumb along the track, ← → ↓ ↑ move by
 * `step`, PageUp / PageDown by ten steps, Home / End to the ends.
 */
export function Slider({ value, min, max, step = 1, onChange, label, valueText, disabled, className }: SliderProps) {
  const track = useRef<HTMLDivElement>(null);
  const off = useRef<() => void>(() => {});
  useEffect(() => () => off.current(), []);
  const span = max - min;
  const pct = span > 0 ? Math.min(100, Math.max(0, ((value - min) / span) * 100)) : 0;
  const snap = (v: number) => Math.min(max, Math.max(min, Math.round((v - min) / step) * step + min));
  const at = (clientX: number): number | null => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !r.width) return null;
    return snap(min + ((clientX - r.left) / r.width) * span);
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    const first = at(e.clientX);
    if (first !== null) onChange(first);
    const move = (m: PointerEvent) => { const v = at(m.clientX); if (v !== null) onChange(v); };
    off.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      off.current = () => {};
    };
    const end = () => off.current();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || e.metaKey || e.ctrlKey || e.altKey) return;
    const to = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? value + step
      : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? value - step
        : e.key === 'PageUp' ? value + step * 10 : e.key === 'PageDown' ? value - step * 10
          : e.key === 'Home' ? min : e.key === 'End' ? max : null;
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(snap(to));
  };
  return (
    <div ref={track} className={cx('ms-slider', disabled && 'ms-off', className)} role="slider" tabIndex={disabled ? -1 : 0} aria-label={label}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={valueText} aria-disabled={disabled || undefined}
      onPointerDown={down} onKeyDown={key}>
      <i className="ms-slider-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
      <i className="ms-slider-thumb" style={{ left: `${pct}%` }} aria-hidden="true" />
    </div>
  );
}

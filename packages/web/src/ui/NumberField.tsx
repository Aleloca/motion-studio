import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from './cx.ts';

export interface NumberFieldProps {
  /** The value; null when the property is unset (the field is empty and arrows start from `startAt`). */
  value: number | null;
  /** Called with a value already clamped to [min, max] and rounded to `decimals`. */
  onChange(value: number): void;
  /** The accessible name. */
  label: string;
  /** The short mono tag inside the field (`X`, `IN`…). */
  prefix?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Digits kept after the point (default 3). */
  decimals?: number;
  /** Where arrows start when the value is null. */
  startAt?: number;
  disabled?: boolean;
  invalid?: boolean;
  /** Id of the text that explains a problem. */
  describedBy?: string;
  /** Enter, Escape or leaving the field: the end of an edit (the caller closes its undo step). */
  onEnd?(): void;
  className?: string;
}

const round = (n: number, d: number) => { const f = 10 ** d; return Math.round(n * f) / f; };
const show = (n: number | null, d: number) => (n === null || !Number.isFinite(n) ? '' : String(round(n, d)));

/**
 * A number field (role="spinbutton"), drawn here: ↑ ↓ step by `step` (Shift ×10), PageUp / PageDown by ten steps, typing
 * then Enter or leaving commits, Escape drops what was typed. Everything that leaves is clamped to [min, max].
 */
export function NumberField({ value, onChange, label, prefix, unit, min = -Infinity, max = Infinity, step = 1, decimals = 3, startAt = 0, disabled, invalid, describedBy, onEnd, className }: NumberFieldProps) {
  const uid = useId();
  const [text, setText] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const clamp = (n: number) => round(Math.min(max, Math.max(min, n)), decimals);
  const parse = (s: string): number | null => {
    const t = s.trim().replace(',', '.');
    if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const emit = (n: number) => { const c = clamp(n); if (c !== value) onChange(c); return c; };
  const commit = () => {
    if (text === null) return;
    const n = parse(text);
    setText(null);
    if (n !== null) emit(n);
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled || e.metaKey || e.ctrlKey || e.altKey) return;
    const big = e.shiftKey ? 10 : 1;
    const dir = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : e.key === 'PageUp' ? 10 : e.key === 'PageDown' ? -10 : 0;
    if (dir !== 0) {
      e.preventDefault();
      const base = (text !== null ? parse(text) : null) ?? value ?? startAt;
      const c = emit(base + dir * step * (Math.abs(dir) === 10 ? 1 : big));
      setText(String(c));
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); commit(); onEnd?.(); input.current?.select(); return; }
    if (e.key === 'Escape') { if (text !== null) { e.preventDefault(); e.stopPropagation(); setText(null); } onEnd?.(); }
  };
  const shown = text ?? show(value, decimals);
  return (
    <label className={cx('ms-field', disabled && 'ms-off', invalid && 'ms-invalid', className)}>
      {prefix ? <small aria-hidden="true">{prefix}</small> : null}
      <input ref={input} id={uid} type="text" inputMode="decimal" role="spinbutton" autoComplete="off" spellCheck={false}
        aria-label={label} aria-valuenow={value ?? undefined} aria-valuemin={Number.isFinite(min) ? min : undefined} aria-valuemax={Number.isFinite(max) ? max : undefined}
        aria-invalid={invalid || undefined} aria-describedby={describedBy} disabled={disabled} value={shown} placeholder="—"
        onFocus={() => setText(show(value, decimals))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={key}
        onBlur={() => { commit(); setText(null); onEnd?.(); }} />
      {unit ? <span className="ms-field-unit" aria-hidden="true">{unit}</span> : null}
    </label>
  );
}

import { cx } from './cx.ts';
import { ICONS } from './icons.ts';

export interface CheckProps {
  on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean; className?: string;
  /** Report 48: some of a group are on (a dash, `aria-checked="mixed"`); a click turns them all on. */
  mixed?: boolean;
}

/** Checkbox (role="checkbox") replacing the native one; fill in 200 ms, the tick springs in (T16). */
export function Check({ on, onChange, label, disabled, className, mixed = false }: CheckProps) {
  const half = mixed && !on;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={half ? 'mixed' : on}
      aria-label={label}
      disabled={disabled}
      className={cx('ms-check', on && 'ms-on', half && 'ms-mixed', className)}
      onClick={(e) => { e.stopPropagation(); onChange(half || !on); }}
    >
      <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={half ? ICONS.minus : ICONS.check} /></svg>
    </button>
  );
}

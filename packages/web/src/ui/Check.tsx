import { cx } from './cx.ts';
import { ICONS } from './icons.ts';

export interface CheckProps { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean; className?: string }

/** Checkbox (role="checkbox") replacing the native one; fill in 200 ms, the tick springs in (T16). */
export function Check({ on, onChange, label, disabled, className }: CheckProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={cx('ms-check', on && 'on', className)}
      onClick={(e) => { e.stopPropagation(); onChange(!on); }}
    >
      <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={ICONS.check} /></svg>
    </button>
  );
}

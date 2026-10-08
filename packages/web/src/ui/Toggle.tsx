import { cx } from './cx.ts';

export interface ToggleProps { on: boolean; onChange: (on: boolean) => void; label: string; size?: 'sm' | 'md'; disabled?: boolean; className?: string }

/** Switch (role="switch"): the knob moves with a spring, the fill fades in 200 ms (T16). */
export function Toggle({ on, onChange, label, size = 'md', disabled, className }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={cx('ms-toggle', on && 'ms-on', size === 'sm' && 'ms-sm', className)}
      // Toggles often sit inside clickable cards: the switch must not also open the card.
      onClick={(e) => { e.stopPropagation(); onChange(!on); }}
    >
      <i aria-hidden="true" />
    </button>
  );
}

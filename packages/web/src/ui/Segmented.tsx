import { useRef, type KeyboardEvent } from 'react';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import type { IconName } from './icons.ts';
import { rovingIndex } from './roving.ts';

/** `accent`: the count is a state that needs the user (e.g. "Needs you"): shown as the orange count badge. */
export interface SegmentedOption<V extends string> {
  value: V; label: string; icon?: IconName; count?: number; accent?: boolean;
  /** This option alone cannot be chosen (e.g. a provider without its key): arrows skip it; `title` says why. */
  disabled?: boolean; title?: string;
}

export interface SegmentedProps<V extends string> {
  options: readonly SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Accessible name of the group. */
  label: string;
  className?: string;
  /** Turns every option off (e.g. a setting that does not apply right now); the value stays visible. */
  disabled?: boolean;
  /** Id of the visible text that explains the group (e.g. why it is off). */
  describedBy?: string;
}

/** Segmented control (role="radiogroup"): replaces radios and small selects; arrows move and select, wrapping. */
export function Segmented<V extends string>({ options, value, onChange, label, className, disabled, describedBy }: SegmentedProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(0, options.findIndex((o) => o.value === value));
  // The Tab stop: the selected option, or the first choosable one when the selected one cannot be chosen any more.
  const current = options[selected]?.disabled ? Math.max(0, options.findIndex((o) => !o.disabled)) : selected;

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = rovingIndex(e.key, i, options.length);
    if (next === null) return;
    e.preventDefault();
    // Skip the options that cannot be chosen, in the key's direction (Home moves forward, End backward).
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'End';
    for (let n = 0; n < options.length && options[next]?.disabled; n++) next = (next + (back ? -1 : 1) + options.length) % options.length;
    if (options[next]?.disabled) return;
    const opt = options[next];
    if (!opt) return;
    refs.current[next]?.focus();
    if (opt.value !== value) onChange(opt.value);
  };

  return (
    <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} aria-describedby={describedBy} className={cx('ms-seg', className)}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === current ? 0 : -1}
            disabled={disabled || o.disabled}
            title={o.title}
            className={cx(on && 'ms-on', o.disabled && 'ms-unavail')}
            onClick={() => { if (!on) onChange(o.value); }}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {o.icon ? <Icon name={o.icon} size={13} /> : null}
            <span>{o.label}</span>
            {o.count !== undefined ? <span className={cx('ms-n', o.accent && o.count > 0 && 'ms-accent')}>{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

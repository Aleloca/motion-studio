import { useRef, type KeyboardEvent } from 'react';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import type { IconName } from './icons.ts';
import { rovingIndex } from './roving.ts';

export interface SegmentedOption<V extends string> { value: V; label: string; icon?: IconName; count?: number }

export interface SegmentedProps<V extends string> {
  options: readonly SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Accessible name of the group. */
  label: string;
  className?: string;
}

/** Segmented control (role="radiogroup"): replaces radios and small selects; arrows move and select, wrapping. */
export function Segmented<V extends string>({ options, value, onChange, label, className }: SegmentedProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(0, options.findIndex((o) => o.value === value));

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = rovingIndex(e.key, i, options.length);
    if (next === null) return;
    e.preventDefault();
    const opt = options[next];
    if (!opt) return;
    refs.current[next]?.focus();
    if (opt.value !== value) onChange(opt.value);
  };

  return (
    <div role="radiogroup" aria-label={label} className={cx('ms-seg', className)}>
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
            className={cx(on && 'on')}
            onClick={() => { if (!on) onChange(o.value); }}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {o.icon ? <Icon name={o.icon} size={13} /> : null}
            <span>{o.label}</span>
            {o.count !== undefined ? <span className="n">{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

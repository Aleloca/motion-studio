import { useRef, type KeyboardEvent } from 'react';
import { cx } from './cx.ts';
import { rovingIndex } from './roving.ts';

export interface TabItem<V extends string> { value: V; label: string; count?: number; /** id of the tab panel it controls */ controls?: string; /** Listed but not choosable (arrows skip it). */ disabled?: boolean }

export interface TabsProps<V extends string> {
  tabs: readonly TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** `panel`: underlined tabs of side panels (prototype .ptabs); `bar`: rounded tabs of the top bar (.tab). */
  variant?: 'panel' | 'bar';
  className?: string;
}

/** Tab list (role="tablist"), arrows/Home/End move and activate. */
export function Tabs<V extends string>({ tabs, value, onChange, label, variant = 'panel', className }: TabsProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(0, tabs.findIndex((t) => t.value === value));

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = rovingIndex(e.key, i, tabs.length);
    if (next === null) return;
    e.preventDefault();
    // Skip the tabs that cannot be chosen, going the way the key went.
    const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'End' ? -1 : 1;
    for (let n = 0; n < tabs.length && tabs[next]?.disabled; n++) next = (next + dir + tabs.length) % tabs.length;
    const tab = tabs[next];
    if (!tab || tab.disabled) return;
    refs.current[next]?.focus();
    if (tab.value !== value) onChange(tab.value);
  };

  return (
    <div role="tablist" aria-label={label} className={cx('ms-tabs', `ms-${variant}`, className)}>
      {tabs.map((t, i) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            aria-selected={on}
            disabled={t.disabled}
            aria-controls={t.controls}
            tabIndex={i === current && !t.disabled ? 0 : -1}
            className={cx('ms-tab', on && 'ms-on')}
            onClick={() => { if (!on) onChange(t.value); }}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
            {t.count !== undefined ? <span className="ms-tag ms-n">{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

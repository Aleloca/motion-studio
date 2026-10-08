import { useRef, type KeyboardEvent } from 'react';
import { cx } from './cx.ts';
import { rovingIndex } from './roving.ts';

export interface TabItem<V extends string> { value: V; label: string; count?: number; /** id of the tab panel it controls */ controls?: string }

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
    const next = rovingIndex(e.key, i, tabs.length);
    if (next === null) return;
    e.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    refs.current[next]?.focus();
    if (tab.value !== value) onChange(tab.value);
  };

  return (
    <div role="tablist" aria-label={label} className={cx('ms-tabs', variant, className)}>
      {tabs.map((t, i) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={t.controls}
            tabIndex={i === current ? 0 : -1}
            className={cx('ms-tab', on && 'on')}
            onClick={() => { if (!on) onChange(t.value); }}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
            {t.count !== undefined ? <span className="ms-tag n">{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

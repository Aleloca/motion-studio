import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import { Popover } from './Popover.tsx';
import { rovingIndex } from './roving.ts';

export interface SelectOption<T extends string> { value: T; label: string }

export interface SelectProps<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange(v: T): void;
  /** Accessible name of the trigger and of the list. */
  label: string;
  className?: string;
  /** The value stays visible; the list cannot open (e.g. a read-only brand kit). */
  disabled?: boolean;
}

/**
 * Drop-down in a popover, replacing the native <select> (spec §4.3): a button showing the value opens a listbox;
 * arrows / Home / End move, Enter or Space choose, a letter jumps, Esc closes. Focus goes back to the button.
 */
export function Select<T extends string>({ value, options, onChange, label, className, disabled }: SelectProps<T>) {
  const uid = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const selected = Math.max(0, options.findIndex((o) => o.value === value));
  const current = options[selected];
  const optId = (i: number) => `${uid}-o${i}`;

  const show = () => {
    setActive(selected);
    const w = trigger.current?.offsetWidth ?? 0;
    setWidth(Math.max(180, w));
    setOpen(true);
  };
  const choose = (i: number) => {
    const o = options[i];
    setOpen(false);
    if (o && o.value !== value) onChange(o.value);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      if (!open) show();
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = rovingIndex(e.key, active, options.length);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
      document.getElementById(optId(next))?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(active);
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const n = options.length;
      for (let step = 1; step <= n; step++) {
        const i = (active + step) % n;
        if (options[i]!.label.toLowerCase().startsWith(k)) { setActive(i); break; }
      }
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={cx('ms-select', open && 'ms-open', className)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${uid}-l ${uid}-v`}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onTriggerKey}
      >
        <span id={`${uid}-l`} className="ms-sr">{label}</span>
        <span id={`${uid}-v`} className="ms-select-value">{current?.label ?? ''}</span>
        <Icon name="chevron" size={14} className="ms-select-chev" />
      </button>
      <Popover open={open && !disabled} onClose={() => setOpen(false)} anchor={trigger} width={width}>
        <div
          role="listbox"
          aria-label={label}
          tabIndex={0}
          aria-activedescendant={options.length ? optId(active) : undefined}
          className="ms-listbox"
          onKeyDown={onListKey}
        >
          {options.map((o, i) => {
            const on = i === selected;
            return (
              <div
                key={o.value}
                id={optId(i)}
                role="option"
                aria-selected={on}
                data-row=""
                className={cx('ms-option', i === active && 'ms-active', on && 'ms-on')}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => { if (i !== active) setActive(i); }}
                onClick={() => choose(i)}
              >
                <span className="ms-option-label">{o.label}</span>
                {on ? <Icon name="check" size={14} strokeWidth={2} /> : null}
              </div>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

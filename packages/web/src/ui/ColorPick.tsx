import { useEffect, useRef } from 'react';
import { useT } from '../i18n.tsx';
import { cx } from './cx.ts';

/** `#rrggbb` for the native colour input from any hex colour the fields hold (#rgb, #rgba, #rrggbb, #rrggbbaa); black when unset. */
export function pickerHex(value: string | undefined): string {
  const h = (value ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3,4}$/.test(h)) return `#${[...h.slice(0, 3)].map((c) => c + c).join('')}`.toLowerCase();
  if (/^[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(h)) return `#${h.slice(0, 6)}`.toLowerCase();
  return '#000000';
}

/** The picked `#rrggbb` carrying the alpha of the colour it replaces (the native input has none): #rgba and #rrggbbaa keep theirs. */
export function withAlphaOf(picked: string, previous: string | undefined): string {
  const h = (previous ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{4}$/.test(h)) return `${picked}${h[3]}${h[3]}`;
  if (/^[0-9a-fA-F]{8}$/.test(h)) return `${picked}${h.slice(6)}`;
  return picked;
}

/**
 * The free colour picker: the colour chip is a native colour input, so any colour can be chosen besides the swatches (the hex
 * field next to it stays the exact way to type one). Keyboard: it is a focusable control like any other. It reports when the
 * choice is made (the native `change`, i.e. when the picker closes), not on every drag step.
 */
export function ColorPick({ value, onPick, disabled, className, size = 28 }: { value: string | undefined; onPick(hex: string): void; disabled?: boolean; className?: string; size?: number }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const hex = pickerHex(value);
  useEffect(() => { if (input.current && input.current.value !== hex) input.current.value = hex; }, [hex]);
  useEffect(() => {
    const el = input.current;
    if (!el) return undefined;
    const on = () => pick.current(el.value);
    el.addEventListener('change', on);
    return () => el.removeEventListener('change', on);
  }, []);
  return (
    <label className={cx('ms-color-pick', disabled && 'ms-off', className)} style={{ width: size, height: size }}>
      <span className="ms-color-chip" aria-hidden="true" style={value ? { background: value } : undefined} />
      <input ref={input} type="color" className="ms-color-native" aria-label={t.web.ui.pickColor} defaultValue={hex} disabled={disabled} />
    </label>
  );
}

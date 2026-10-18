import { useState, type KeyboardEvent } from 'react';
import { cx } from './cx.ts';
import { ColorPick, withAlphaOf } from './ColorPick.tsx';

export interface ColorSwatchGroup { label: string; colors: readonly string[] }

export interface ColorFieldProps {
  /** A hex colour (#rgb, #rgba, #rrggbb, #rrggbbaa), or undefined when unset. */
  value: string | undefined;
  onChange(hex: string): void;
  /** The accessible name of the hex input. */
  label: string;
  /** Swatches by origin (the brand palette, the composition's colours). */
  groups?: readonly ColorSwatchGroup[];
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onEnd?(): void;
  className?: string;
}

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** What a typed colour means: a leading # is optional; null when it is not a hex colour. */
export function normalizeHex(s: string): string | null {
  const t = s.trim();
  const h = t.startsWith('#') ? t : `#${t}`;
  return HEX.test(h) ? h : null;
}

/**
 * A colour field: a free picker (a native colour input on the chip), a hex input and swatches. Enter or leaving the input commits a valid hex;
 * Escape drops what was typed; a swatch is a toggle button that chooses its colour.
 */
export function ColorField({ value, onChange, label, groups = [], disabled, invalid, describedBy, onEnd, className }: ColorFieldProps) {
  const [text, setText] = useState<string | null>(null);
  const typed = text !== null ? normalizeHex(text) : undefined;
  const bad = invalid || (text !== null && text.trim() !== '' && typed === null);
  const commit = () => {
    if (text === null) return;
    const hex = normalizeHex(text);
    setText(null);
    if (hex && hex.toLowerCase() !== value?.toLowerCase()) onChange(hex);
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); onEnd?.(); } else if (e.key === 'Escape') { if (text !== null) { e.preventDefault(); e.stopPropagation(); setText(null); } onEnd?.(); }
  };
  const shown = text ?? (value ?? '');
  const chip = typed ?? value;
  return (
    <div className={cx('ms-color', className)}>
      <div className="ms-color-top">
        <ColorPick value={chip} disabled={disabled} onPick={(picked) => { const hex = withAlphaOf(picked, value); setText(null); if (hex.toLowerCase() !== value?.toLowerCase()) onChange(hex); onEnd?.(); }} />
        <label className={cx('ms-field', disabled && 'ms-off', bad && 'ms-invalid')}>
          <input type="text" autoComplete="off" spellCheck={false} aria-label={label} aria-invalid={bad || undefined} aria-describedby={describedBy}
            disabled={disabled} value={shown} placeholder="#rrggbb" maxLength={9}
            onFocus={() => setText(value ?? '')} onChange={(e) => setText(e.target.value)} onKeyDown={key}
            onBlur={() => { commit(); setText(null); onEnd?.(); }} />
        </label>
      </div>
      <ColorSwatches groups={groups} value={value} disabled={disabled} onPick={(hex) => { if (value?.toLowerCase() !== hex.toLowerCase()) onChange(hex); onEnd?.(); }} />
    </div>
  );
}

/** The swatches of a colour field by origin, each a toggle button that chooses its colour (shared by fields that show one palette for several colours). */
export function ColorSwatches({ groups, value, disabled, onPick }: { groups: readonly ColorSwatchGroup[]; value: string | undefined; disabled?: boolean | undefined; onPick(hex: string): void }) {
  return (
    <>
      {groups.filter((g) => g.colors.length > 0).map((g) => (
        <div key={g.label} role="group" aria-label={g.label} className="ms-color-group">
          <span className="ms-color-cap">{g.label}</span>
          <div className="ms-color-swatches">
            {g.colors.map((hex) => (
              <button key={hex} type="button" className="ms-color-swatch" aria-label={hex} aria-pressed={value?.toLowerCase() === hex.toLowerCase()} disabled={disabled}
                style={{ background: hex }} onClick={() => onPick(hex)} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

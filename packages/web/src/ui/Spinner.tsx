import { useT } from '../i18n.tsx';
import { cx } from './cx.ts';

export interface SpinnerProps { size?: number; label?: string; decorative?: boolean; className?: string }

/** Rotating arc. Announces "Loading" (or `label`) unless `decorative`, e.g. inside a busy button or a pill with text. */
export function Spinner({ size = 14, label, decorative, className }: SpinnerProps) {
  const t = useT();
  const svg = (
    <svg className={cx('ms-spin', className)} width={size} height={size} viewBox="0 0 16 16" fill="none" strokeWidth={2} aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.5" className="ms-spin-track" />
      <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" className="ms-spin-arc" strokeLinecap="round" />
    </svg>
  );
  if (decorative) return svg;
  return <span className="ms-spinner" role="status" aria-label={label ?? t.web.ui.loading}>{svg}</span>;
}

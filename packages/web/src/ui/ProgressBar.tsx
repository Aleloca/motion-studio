import { useT } from '../i18n.tsx';
import { cx } from './cx.ts';

export interface ProgressBarProps { value: number; label?: string; className?: string }

/** Thin orange progress bar, value in percent (clamped to 0–100). */
export function ProgressBar({ value, label, className }: ProgressBarProps) {
  const t = useT();
  const v = Math.round(Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0)));
  return (
    <div className={cx('ms-progress', className)} role="progressbar" aria-label={label ?? t.web.ui.progress} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v}>
      <i style={{ width: `${v}%` }} />
    </div>
  );
}

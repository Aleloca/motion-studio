import type { ReactNode } from 'react';
import { cx } from './cx.ts';
import { Spinner } from './Spinner.tsx';

export type PillTone = 'ok' | 'warn' | 'neutral' | 'accent';

export interface PillProps { tone?: PillTone; dot?: boolean; spinner?: boolean; children: ReactNode; className?: string }

/** Status pill: ok (green), warn (needs you), neutral (working), accent; optional dot or spinner. */
export function Pill({ tone = 'neutral', dot, spinner, children, className }: PillProps) {
  return (
    <span className={cx('ms-pill', `ms-${tone}`, className)}>
      {spinner ? <Spinner decorative size={11} /> : dot ? <span className="ms-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

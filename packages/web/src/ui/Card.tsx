import type { ComponentPropsWithRef } from 'react';
import { cx } from './cx.ts';

export interface CardProps extends ComponentPropsWithRef<'div'> {
  /** Lifts on hover (clickable cards). */
  hoverable?: boolean;
}

/** Panel with a 1 px hairline and 14 px radius. */
export function Card({ hoverable, className, ...rest }: CardProps) {
  return <div {...rest} className={cx('ms-card', hoverable && 'hov', className)} />;
}

import type { ReactNode } from 'react';
import { cx } from './cx.ts';

export interface TagProps { children: ReactNode; mono?: boolean; className?: string; title?: string }

/** Small 20 px label on --field (formats, roles, domains). */
export function Tag({ children, mono, className, title }: TagProps) {
  return <span className={cx('ms-tag', mono && 'ms-mono', className)} title={title}>{children}</span>;
}

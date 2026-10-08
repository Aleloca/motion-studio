import type { ReactNode } from 'react';
import { cx } from './cx.ts';

export interface FieldProps { prefix?: string; children: ReactNode; className?: string }

/** Compact 28 px inspector field with an inner mono label (`X`, `IN`, `DUR`…); a label, so the prefix focuses the input. */
export function Field({ prefix, children, className }: FieldProps) {
  return (
    <label className={cx('ms-field', className)}>
      {prefix ? <small>{prefix}</small> : null}
      {children}
    </label>
  );
}

import type { ComponentPropsWithRef } from 'react';
import { cx } from './cx.ts';

/** 36 px text field on --field with the orange focus ring. */
export function Input({ className, ...rest }: ComponentPropsWithRef<'input'>) {
  return <input {...rest} className={cx('ms-input', className)} />;
}

/** Multi-line field: height set by `rows` (default 3), no native resize handle. */
export function Textarea({ className, rows = 3, ...rest }: ComponentPropsWithRef<'textarea'>) {
  return <textarea {...rest} rows={rows} className={cx('ms-input', 'ms-textarea', className)} />;
}

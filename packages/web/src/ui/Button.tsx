import type { ComponentPropsWithRef } from 'react';
import { cx } from './cx.ts';
import { Spinner } from './Spinner.tsx';

export type ButtonVariant = 'default' | 'ink' | 'accent' | 'ghost' | 'outline' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Square icon-only button: give it an `aria-label`. */
  icon?: boolean;
  /** Disables the button and shows a spinner (in place of the content for icon buttons). */
  loading?: boolean;
}

/** Sizes sm 28 / md 32 / lg 38; press scale(.97). Defaults to type="button" so it never submits by accident. */
export function Button({ variant = 'default', size = 'md', icon, loading, disabled, className, type = 'button', children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx('ms-btn', variant !== 'default' && variant, size !== 'md' && size, icon && 'icon', loading && 'busy', className)}
    >
      {loading ? <Spinner decorative size={size === 'sm' ? 12 : 14} /> : null}
      {loading && icon ? null : children}
    </button>
  );
}

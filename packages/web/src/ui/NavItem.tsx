import type { ComponentPropsWithRef } from 'react';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import type { IconName } from './icons.ts';

export interface NavItemProps extends ComponentPropsWithRef<'button'> {
  on?: boolean;
  icon?: IconName;
  count?: number;
}

/** Side-navigation row: icon, label and an optional count; the current one carries aria-current="page". */
export function NavItem({ on, icon, count, className, children, type = 'button', ...rest }: NavItemProps) {
  return (
    <button {...rest} type={type} aria-current={on ? 'page' : undefined} className={cx('ms-navitem', on && 'on', className)}>
      {icon ? <Icon name={icon} /> : null}
      <span className="ms-navitem-label">{children}</span>
      {count !== undefined ? <span className="n">{count}</span> : null}
    </button>
  );
}

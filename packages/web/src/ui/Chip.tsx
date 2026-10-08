import type { ReactNode } from 'react';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import type { IconName } from './icons.ts';

export interface ChipProps { on?: boolean; onClick?: () => void; icon?: IconName; children: ReactNode; className?: string; title?: string }

/** Rounded chip: a button when clickable (a toggle with aria-pressed when `on` is given), plain text otherwise. */
export function Chip({ on, onClick, icon, children, className, title }: ChipProps) {
  const cls = cx('ms-chip', on && 'ms-on', className);
  const content = <>{icon ? <Icon name={icon} size={11} /> : null}{children}</>;
  if (!onClick) return <span className={cls} title={title}>{content}</span>;
  return <button type="button" className={cls} aria-pressed={on} onClick={onClick} title={title}>{content}</button>;
}

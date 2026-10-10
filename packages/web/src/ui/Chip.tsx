import { useId, type ReactNode } from 'react';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import type { IconName } from './icons.ts';

export interface ChipProps {
  on?: boolean; onClick?: () => void; icon?: IconName; children: ReactNode; className?: string; title?: string;
  /** Not choosable: stays focusable (so its `title` explains why) but does nothing (aria-disabled). */
  disabled?: boolean;
}

/** Rounded chip: a button when clickable (a toggle with aria-pressed when `on` is given), plain text otherwise. */
export function Chip({ on, onClick, icon, children, className, title, disabled }: ChipProps) {
  const cls = cx('ms-chip', on && 'ms-on', disabled && 'ms-disabled', className);
  const why = useId();
  const content = <>{icon ? <Icon name={icon} size={11} /> : null}{children}</>;
  if (!onClick) return <span className={cls} title={title}>{content}</span>;
  // A disabled chip's reason (its title) is also its accessible description, not only a mouse tooltip.
  const described = disabled && title;
  return (
    <>
      <button type="button" className={cls} aria-pressed={on} aria-disabled={disabled || undefined} aria-describedby={described ? why : undefined}
        onClick={disabled ? undefined : onClick} title={title}>{content}</button>
      {described ? <span id={why} hidden>{title}</span> : null}
    </>
  );
}

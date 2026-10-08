import type { ReactNode } from 'react';
import { useT } from '../i18n.tsx';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import type { IconName } from './icons.ts';

export interface EmptyProps { icon?: IconName; title?: string; sub?: ReactNode; action?: ReactNode; className?: string }

/** Designed empty state: icon tile, title, one line of help and (per spec) an action. */
export function Empty({ icon = 'sparkle', title, sub, action, className }: EmptyProps) {
  const t = useT();
  return (
    <div className={cx('ms-empty', className)}>
      <span className="ms-empty-icon"><Icon name={icon} size={16} /></span>
      <b>{title ?? t.web.ui.emptyTitle}</b>
      {sub ? <span className="ms-empty-sub">{sub}</span> : null}
      {action ? <div className="ms-empty-action">{action}</div> : null}
    </div>
  );
}

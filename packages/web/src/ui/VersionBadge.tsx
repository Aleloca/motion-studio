import { useT } from '../i18n.tsx';
import { cx } from './cx.ts';

export interface VersionBadgeProps { n: number; star?: boolean; onClick?: () => void; className?: string }

/** "v3" badge; "★ v3" for the chosen version. A button when clickable (opens the version list). */
export function VersionBadge({ n, star, onClick, className }: VersionBadgeProps) {
  const t = useT();
  const name = star ? t.web.ui.chosenVersion({ n }) : t.web.ui.version({ n });
  const text = `${star ? '★ ' : ''}v${n}`;
  const cls = cx('ms-vbadge', star && 'star', className);
  if (onClick) return <button type="button" className={cls} aria-label={name} onClick={onClick}>{text}</button>;
  return <span className={cls} aria-label={name} role="img">{text}</span>;
}

import { cx } from './cx.ts';

export interface AvatarProps { name: string; size?: 26 | 28 | 32; onClick?: () => void; label?: string; className?: string }

/** Initials of the first two words, e.g. "Ada Lovelace" → "AL". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words[1]!].map((w) => [...w][0] ?? '') : [...(words[0] ?? '')].slice(0, 2);
  return letters.join('').toUpperCase();
}

/** Round orange avatar with initials; a button (named by `label`) when clickable. */
export function Avatar({ name, size = 28, onClick, label, className }: AvatarProps) {
  const cls = cx('ms-avatar', size !== 28 && `s${size}`, className);
  if (onClick) return <button type="button" className={cls} aria-label={label ?? name} onClick={onClick}>{initials(name)}</button>;
  return <span className={cls} role="img" aria-label={name}>{initials(name)}</span>;
}

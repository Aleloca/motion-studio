import { ICONS, type IconName } from './icons.ts';

export interface IconProps { name: IconName; size?: number; className?: string }

/** Decorative stroke icon (stroke 1.4, currentColor). Give the parent control its accessible name. */
export function Icon({ name, size = 15, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  );
}

import { ICONS, type IconName } from './icons.ts';

export interface IconProps {
  name: IconName;
  size?: number;
  /** Stroke width; 1.4 by default (the set's standard), heavier for small glyphs such as a check tick. */
  strokeWidth?: number;
  /** Fill the shape with the current colour (e.g. a solid play button). Colour always comes from currentColor. */
  fill?: boolean;
  className?: string;
}

/** Decorative stroke icon (currentColor). Give the parent control its accessible name. */
export function Icon({ name, size = 15, strokeWidth = 1.4, fill = false, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  );
}

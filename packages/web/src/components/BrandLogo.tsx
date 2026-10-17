import { useEffect, useState } from 'react';
import logoDark from '../assets/logo-dark.svg';
import logoLight from '../assets/logo.svg';
import horizontalDark from '../assets/logo-horizontal-dark.svg';
import horizontalLight from '../assets/logo-horizontal.svg';
import markDark from '../assets/logo-mark-dark.svg';
import markLight from '../assets/logo-mark.svg';

/** The theme in force: the `data-theme` attribute theme.ts sets (light/dark), else the OS preference (system). */
function resolvedTheme(): 'light' | 'dark' {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced === 'light' || forced === 'dark') return forced;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function useResolvedTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(resolvedTheme);
  useEffect(() => {
    const update = () => setTheme(resolvedTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    media?.addEventListener?.('change', update);
    update();
    return () => { observer.disconnect(); media?.removeEventListener?.('change', update); };
  }, []);
  return theme;
}

/** Shape of the logo: `stacked` (the original, "Studio" under "Motion"), `horizontal` ("Motion Studio" on one line) or `mark` (the squares only). */
export type BrandLogoVariant = 'stacked' | 'horizontal' | 'mark';

/** Source and viewBox size of each shape and theme (the viewBoxes are in the SVG files). */
const SHAPES: Record<BrandLogoVariant, { light: string; dark: string; w: number; h: number }> = {
  stacked: { light: logoLight, dark: logoDark, w: 883.73, h: 360 },
  horizontal: { light: horizontalLight, dark: horizontalDark, w: 1720, h: 322 },
  mark: { light: markLight, dark: markDark, w: 362, h: 322 },
};

/**
 * The logo (three squares, play triangle and wordmark). Its dark ink is invisible on the dark theme, so the dark
 * theme gets the light-ink variant; orange and white are the same in both.
 */
export function BrandLogo({ height = 24, className, variant = 'stacked', decorative = false }: { height?: number; className?: string; variant?: BrandLogoVariant; decorative?: boolean }) {
  const theme = useResolvedTheme();
  const shape = SHAPES[variant];
  return <img className={className} src={shape[theme]} data-variant={theme} alt={decorative ? '' : 'Motion Studio'} height={height} width={Math.round((height * shape.w) / shape.h)} draggable={false} />;
}

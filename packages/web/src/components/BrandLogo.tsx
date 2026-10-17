import { useEffect, useState } from 'react';
import logoDark from '../assets/logo-dark.svg';
import logoLight from '../assets/logo.svg';

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

/**
 * The full logo (three squares, play triangle and wordmark). Its dark ink is invisible on the dark theme, so the dark
 * theme gets the light-ink variant; orange and white are the same in both.
 */
export function BrandLogo({ height = 24, className }: { height?: number; className?: string }) {
  const theme = useResolvedTheme();
  // viewBox -30 -30 883.73 360: the width follows from the height.
  return <img className={className} src={theme === 'dark' ? logoDark : logoLight} data-variant={theme} alt="Motion Studio" height={height} width={Math.round((height * 883.73) / 360)} draggable={false} />;
}

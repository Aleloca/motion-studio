// Integrated desktop title bar: the native window controls sit inside the app's top bar. In the desktop app every top bar
// is a drag region (its controls are not: shell.css), with room kept for the macOS traffic lights (left, except in full
// screen, where they are gone) or the Windows/Linux controls overlay (right). In a plain browser nothing changes.
import { useEffect, useState } from 'react';
import { desktop } from './desktop.ts';

/** Classes for a top bar: `ms-titlebar` (drag region) plus the room for the window controls. Empty in the browser. */
export function titleBarClass(platform: string | null, fullscreen: boolean): string {
  if (platform === null) return '';
  if (platform === 'darwin') return fullscreen ? 'ms-titlebar' : 'ms-titlebar ms-tb-mac';
  return 'ms-titlebar ms-tb-overlay';
}

/** The classes for the current window, following its full-screen state. */
export function useTitleBarClass(): string {
  const bridge = desktop();
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const off = bridge?.onFullscreenChange?.((v) => { setFullscreen(v === true); });
    return typeof off === 'function' ? off : undefined;
  }, [bridge]);
  return titleBarClass(bridge?.platform ?? null, fullscreen);
}

/** The theme on screen: the forced one (data-theme, theme.ts) or the system's. */
function resolvedTheme(mq: MediaQueryList | null): 'light' | 'dark' {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced === 'light' || forced === 'dark') return forced;
  return mq?.matches ? 'dark' : 'light';
}

/**
 * Keeps the window's controls overlay (Windows, Linux) and background in the page's theme: reports the resolved theme
 * now and on every change (the stored theme or the system's), once per change. Returns the stop. No-op in the browser
 * and in desktop builds without the bridge call.
 */
export function watchTitleBarTheme(): () => void {
  const bridge = desktop();
  if (typeof bridge?.setTitleBarTheme !== 'function') return () => {};
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let last: 'light' | 'dark' | null = null;
  const report = () => {
    const theme = resolvedTheme(mq);
    if (theme === last) return;
    last = theme;
    // A refusal (older main process) only leaves the overlay in its first colours.
    try { void Promise.resolve(bridge.setTitleBarTheme!(theme)).catch(() => {}); } catch { /* same */ }
  };
  report();
  mq?.addEventListener('change', report);
  const observer = new MutationObserver(report);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => { mq?.removeEventListener('change', report); observer.disconnect(); };
}

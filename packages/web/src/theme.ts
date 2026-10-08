import type { WorkspaceSettings } from '@motion-studio/shared';

export type Theme = WorkspaceSettings['theme'];

/** Applies the stored theme: `system` follows the OS, `light`/`dark` force it (theme.css reads data-theme). */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

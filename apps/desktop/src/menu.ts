import type { MenuItemConstructorOptions } from 'electron';
import type { t } from '@motion-studio/core';

type Messages = ReturnType<typeof t>;

/** The application menu as data (pure: no Electron runtime), in the language of `m`. `restart` enables the update entry. */
export function menuTemplate(m: Messages, opts: { mac: boolean; restart?: () => void; openRepo: () => void }): MenuItemConstructorOptions[] {
  const d = m.desktop.menu;
  return [
    ...(opts.mac ? [{ role: 'appMenu' as const }] : []),
    { label: d.edit, submenu: [{ role: 'undo', label: d.undo }, { role: 'redo', label: d.redo }, { type: 'separator' }, { role: 'cut', label: d.cut }, { role: 'copy', label: d.copy }, { role: 'paste', label: d.paste }, { role: 'selectAll', label: d.selectAll }] },
    { label: d.view, submenu: [{ role: 'reload', label: d.reload }, { role: 'togglefullscreen', label: d.fullScreen }, { type: 'separator' }, { role: 'resetZoom', label: d.resetZoom }, { role: 'zoomIn', label: d.zoomIn }, { role: 'zoomOut', label: d.zoomOut }] },
    { label: d.window, submenu: [{ role: 'minimize', label: d.minimize }, { role: 'close', label: d.close }] },
    { label: d.help, submenu: [{ label: d.restartToUpdate, enabled: !!opts.restart, click: () => opts.restart?.() }, { type: 'separator' }, { label: d.github, click: opts.openRepo }] },
  ];
}

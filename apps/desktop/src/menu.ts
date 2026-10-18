import type { MenuItemConstructorOptions } from 'electron';
import type { t } from '@motion-studio/core';
import type { ZoomKind } from './zoom.ts';

type Messages = ReturnType<typeof t>;

/**
 * The application menu as data (pure: no Electron runtime), in the language of `m`. `restart` enables the update entry.
 * `zoom` (decision 1055): the View menu's zoom items call it instead of the window roles (the page decides what zooms).
 */
export function menuTemplate(m: Messages, opts: { mac: boolean; restart?: () => void; openRepo: () => void; zoom?: (kind: ZoomKind) => void }): MenuItemConstructorOptions[] {
  const d = m.desktop.menu;
  const z = opts.zoom;
  const zoomItems: MenuItemConstructorOptions[] = z ? [
    { label: d.resetZoom, accelerator: 'CommandOrControl+0', click: () => z('reset') },
    { label: d.zoomIn, accelerator: 'CommandOrControl+Plus', click: () => z('in') },
    // ⌘= without Shift, as the role accepted it.
    { label: d.zoomIn, accelerator: 'CommandOrControl+=', visible: false, acceleratorWorksWhenHidden: true, click: () => z('in') },
    { label: d.zoomOut, accelerator: 'CommandOrControl+-', click: () => z('out') },
  ] : [{ role: 'resetZoom', label: d.resetZoom }, { role: 'zoomIn', label: d.zoomIn }, { role: 'zoomOut', label: d.zoomOut }];
  return [
    ...(opts.mac ? [{ role: 'appMenu' as const }] : []),
    { label: d.edit, submenu: [{ role: 'undo', label: d.undo }, { role: 'redo', label: d.redo }, { type: 'separator' }, { role: 'cut', label: d.cut }, { role: 'copy', label: d.copy }, { role: 'paste', label: d.paste }, { role: 'selectAll', label: d.selectAll }] },
    { label: d.view, submenu: [{ role: 'reload', label: d.reload }, { role: 'togglefullscreen', label: d.fullScreen }, { type: 'separator' }, ...zoomItems] },
    { label: d.window, submenu: [{ role: 'minimize', label: d.minimize }, { role: 'close', label: d.close }] },
    { label: d.help, submenu: [{ label: d.restartToUpdate, enabled: !!opts.restart, click: () => opts.restart?.() }, { type: 'separator' }, { label: d.github, click: opts.openRepo }] },
  ];
}

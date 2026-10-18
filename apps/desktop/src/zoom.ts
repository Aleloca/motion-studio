// The View menu's zoom (decision 1055). On macOS a menu accelerator wins over the page's keydown, so the menu's own
// zoom roles would zoom the whole window on ⌘+ / ⌘− / ⌘0 even on the creative canvas, which zooms itself. The menu items
// send the kind to the page instead; the page zooms its canvas, or asks the window zoom back (the old behaviour) for the
// rest of the app. A window that does not show the app zooms as before.

export type ZoomKind = 'in' | 'out' | 'reset';
/** Main → page: a zoom item of the View menu. */
export const ZOOM_MENU = 'ms:zoom';
/** Page → main: zoom the window (the page does not take it). */
export const ZOOM_WINDOW = 'ms:zoom-window';

export const isZoomKind = (v: unknown): v is ZoomKind => v === 'in' || v === 'out' || v === 'reset';

/** Chromium's zoom levels the roles stepped through: ±0.5 a step, 0 is 100%, kept within -8…9. */
export function nextZoomLevel(level: number, kind: ZoomKind): number {
  if (kind === 'reset') return 0;
  return Math.min(9, Math.max(-8, level + (kind === 'in' ? 0.5 : -0.5)));
}

export interface ZoomWindowTarget { isDestroyed(): boolean; getZoomLevel(): number; setZoomLevel(level: number): void }

/** The old behaviour of the zoom roles, on one window. */
export function applyWindowZoom(wc: ZoomWindowTarget, kind: ZoomKind): void {
  if (wc.isDestroyed()) return;
  wc.setZoomLevel(nextZoomLevel(wc.getZoomLevel(), kind));
}

export interface ZoomTarget { isDestroyed(): boolean; getURL(): string; send(channel: string, kind: ZoomKind): void }

/** Hands the kind to the page, only while the window shows the app itself; nothing else goes with it. Returns whether it was sent. */
export function sendZoom(wc: ZoomTarget, kind: ZoomKind, isApp: (url: string) => boolean): boolean {
  if (wc.isDestroyed() || !isApp(wc.getURL())) return false;
  wc.send(ZOOM_MENU, kind);
  return true;
}

/** The page's request for the window zoom: a trusted sender (the app's own page) and a valid kind, else nothing. */
export function registerZoomWindow(ipc: { handle(channel: string, fn: (e: unknown, arg: unknown) => unknown): void },
  d: { trusted(e: unknown): boolean; apply(kind: ZoomKind): void }): void {
  ipc.handle(ZOOM_WINDOW, (e, arg) => { if (d.trusted(e) && isZoomKind(arg)) d.apply(arg); });
}

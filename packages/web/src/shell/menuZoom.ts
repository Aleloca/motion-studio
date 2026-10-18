// The desktop View menu's zoom (decision 1055). On macOS the menu's shortcuts (⌘+ / ⌘− / ⌘0) never reach the page as
// keys, so the desktop sends them over the bridge: the creative canvas zooms itself while it is the page shown (the same
// path as its keyboard shortcuts), and anywhere else the window zooms as the menu always did. In a plain browser there is
// no bridge: the canvas's keyboard shortcuts do it all.
import { desktop } from '../desktop.ts';

export type MenuZoomKind = 'in' | 'out' | 'reset';
type Handler = (kind: MenuZoomKind) => void;

let handler: Handler | null = null;

/** The canvas takes the menu's zoom while registered; returns the release (a stale one never drops a newer handler). */
export function setMenuZoomHandler(h: Handler): () => void {
  handler = h;
  return () => { if (handler === h) handler = null; };
}

function onMenuZoom(kind: MenuZoomKind): void {
  if (handler) { handler(kind); return; }
  const d = desktop();
  if (typeof d?.zoomWindow !== 'function') return;
  try { void Promise.resolve(d.zoomWindow(kind)).catch(() => { /* an older main process */ }); } catch { /* the same */ }
}

/** Listens to the menu's zoom (the app does it once); returns the unsubscribe. Nothing without the bridge. */
export function installMenuZoom(): () => void {
  const d = desktop();
  if (typeof d?.onZoom !== 'function') return () => {};
  try { return d.onZoom(onMenuZoom); } catch { return () => {}; }
}

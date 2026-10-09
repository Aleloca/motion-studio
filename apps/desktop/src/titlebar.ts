// Integrated title bar: the native window controls sit inside the app's own top bar. macOS draws its traffic lights over
// the page (hiddenInset); Windows and Linux draw a Window Controls Overlay in the bar's colours, which the page keeps in
// step with its theme through ms:titlebar-theme. Main → page, ms:fullscreen says when the traffic lights go away.
import type { IpcMainInvokeEvent, TitleBarOverlay } from 'electron';

export type TitleBarTheme = 'light' | 'dark';

/**
 * The web theme tokens the window needs, per theme (main cannot read CSS): `background` = --bg (the window behind the
 * page), `bar` = --panel (the top bar, so the overlay blends in), `symbol` = --text (the overlay's glyphs). Keep these
 * equal to packages/web/src/theme.css: test/window.test.ts compares them.
 */
export const TITLEBAR_COLORS = {
  light: { background: '#F5F5F4', bar: '#FFFFFF', symbol: '#171717' },
  dark: { background: '#0F0F0F', bar: '#171717', symbol: '#EDEDED' },
} as const satisfies Record<TitleBarTheme, { background: string; bar: string; symbol: string }>;

/** Height of the app's top bar (.ms-topbar in packages/web/src/shell/shell.css; the test compares them). */
export const TITLEBAR_HEIGHT = 52;
/** Height of the macOS traffic-light buttons, to centre them in the bar. */
export const TRAFFIC_LIGHT_SIZE = 14;
/** Left inset of the traffic lights; the page leaves room for them (packages/web/src/shell/shell.css .ms-tb-mac). */
export const TRAFFIC_LIGHT_X = 18;

export function overlayOptions(theme: TitleBarTheme): TitleBarOverlay {
  const c = TITLEBAR_COLORS[theme];
  return { color: c.bar, symbolColor: c.symbol, height: TITLEBAR_HEIGHT };
}

/** Exactly 'light' or 'dark', else null. */
export function titleBarThemeArg(arg: unknown): TitleBarTheme | null {
  return arg === 'light' || arg === 'dark' ? arg : null;
}

export interface TitleBarDeps {
  /** The IPC origin guard shared with the other handlers (ipcSenderTrusted). */
  trusted(e: IpcMainInvokeEvent): boolean;
  platform: string;
  /** win.setTitleBarOverlay (Windows and Linux only). */
  setOverlay(o: TitleBarOverlay): void;
  /** win.setBackgroundColor. */
  setBackground(color: string): void;
  invalid(): Error;
}

export function registerTitleBar(ipc: { handle(channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => unknown): void }, d: TitleBarDeps): void {
  ipc.handle('ms:titlebar-theme', (e, arg) => {
    const theme = d.trusted(e) ? titleBarThemeArg(arg) : null;
    if (!theme) throw d.invalid();
    if (d.platform !== 'darwin') d.setOverlay(overlayOptions(theme));
    d.setBackground(TITLEBAR_COLORS[theme].background);
  });
}

/** Main → page: the window entered (true) or left (false) full screen. */
export const FULLSCREEN = 'ms:fullscreen';

export interface FullscreenTarget { isDestroyed(): boolean; getURL(): string; send(channel: string, value: boolean): void }

/** Sends the full-screen state, only while the window shows the app itself; nothing but the boolean goes with it. */
export function sendFullscreen(wc: FullscreenTarget, value: boolean, isApp: (url: string) => boolean): boolean {
  if (wc.isDestroyed() || !isApp(wc.getURL())) return false;
  wc.send(FULLSCREEN, value === true);
  return true;
}

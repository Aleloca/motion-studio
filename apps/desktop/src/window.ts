import type { BrowserWindowConstructorOptions } from 'electron';
import { overlayOptions, TITLEBAR_COLORS, TITLEBAR_HEIGHT, TRAFFIC_LIGHT_SIZE, TRAFFIC_LIGHT_X } from './titlebar.ts';

/**
 * The window controls live in the app's own top bar: on macOS the traffic lights are inset and vertically centred in
 * it; on Windows and Linux the system draws its buttons as an overlay as tall as the bar, in the theme's colours.
 */
export function windowOptions(preloadPath: string, dark = true, platform: string = process.platform): BrowserWindowConstructorOptions {
  const theme = dark ? 'dark' : 'light';
  const frame: BrowserWindowConstructorOptions = platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: (TITLEBAR_HEIGHT - TRAFFIC_LIGHT_SIZE) / 2 } }
    : { titleBarStyle: 'hidden', titleBarOverlay: overlayOptions(theme) };
  return {
    width: 1440, height: 900, minWidth: 1024, minHeight: 700, title: 'Motion Studio', show: false,
    backgroundColor: TITLEBAR_COLORS[theme].background,
    ...frame,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, preload: preloadPath },
  };
}

/** Same origin only (protocol + host + port); the fragment never matters, so `#t=` and `#/p/acme` navigation stays allowed. */
export function isAppUrl(url: string, origin: string): boolean {
  try { return new URL(url).origin === new URL(origin).origin; } catch { return false; }
}

export interface IpcSender { sender: unknown; senderFrame: { url: string } | null | undefined }

/**
 * The IPC origin guard: only `wc`'s own main frame, showing the core's origin, may call the app's handlers. Dev and
 * packaged builds both load the UI from the core's http origin (http://127.0.0.1:<port>), so one check covers both.
 */
export function ipcSenderTrusted(e: IpcSender, wc: { mainFrame: unknown }, origin: string): boolean {
  return e.sender === wc && e.senderFrame != null && e.senderFrame === wc.mainFrame && isAppUrl(e.senderFrame.url, origin);
}

export function externalUrlAllowed(url: string): boolean {
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol); } catch { return false; }
}

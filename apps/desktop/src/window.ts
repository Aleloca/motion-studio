import type { BrowserWindowConstructorOptions } from 'electron';

export function windowOptions(preloadPath: string, dark = true): BrowserWindowConstructorOptions {
  return {
    width: 1440, height: 900, minWidth: 1024, minHeight: 700, title: 'Motion Studio', show: false,
    backgroundColor: dark ? '#0E0F12' : '#F4F4F1',
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

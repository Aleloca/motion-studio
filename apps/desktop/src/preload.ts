import { contextBridge, ipcRenderer } from 'electron';

// Full-screen state from the main process (ms:fullscreen). Remembered from the start, so a page that subscribes after
// the main process spoke (a reload while in full screen) still learns it.
let fullscreen: boolean | null = null;
ipcRenderer.on('ms:fullscreen', (_e: unknown, value: unknown) => { if (typeof value === 'boolean') fullscreen = value; });

contextBridge.exposeInMainWorld('motionStudio', {
  isDesktop: true,
  platform: process.platform,
  pickFolder: (title: string, defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('ms:pick-folder', { title, defaultPath }),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('ms:reveal', path),
  // Approval signals (spec §6.3): the main process validates both and shows them only for the app's own page.
  // Answers what the system did with it: { shown: true } or { shown: false, reason, detail? }.
  notify: (p: { title: string; body: string; sound?: boolean }): Promise<unknown> => ipcRenderer.invoke('ms:notify', { title: p?.title, body: p?.body, sound: p?.sound }),
  notifyStatus: (): Promise<{ supported: boolean }> => ipcRenderer.invoke('ms:notify-status'),
  setBadge: (n: number): Promise<void> => ipcRenderer.invoke('ms:badge', n),
  // A click on one of the app's notifications (the main process sends it only to the app's own page). The page gets
  // a plain call: never the IPC event or its sender. Returns the unsubscribe.
  onAttentionClick: (cb: () => void): (() => void) => {
    if (typeof cb !== 'function') return () => {};
    const listener = () => { try { cb(); } catch { /* the page's own error */ } };
    ipcRenderer.on('ms:attention-click', listener);
    return () => { ipcRenderer.removeListener('ms:attention-click', listener); };
  },
  // Integrated title bar: the page's resolved theme ('light' | 'dark', validated by the main process) recolours the
  // window controls overlay (Windows, Linux) and the window background.
  setTitleBarTheme: (theme: 'light' | 'dark'): Promise<void> => ipcRenderer.invoke('ms:titlebar-theme', theme),
  // Calls `cb` with true or false when the window enters or leaves full screen (and at once with the state already
  // known). Only a boolean reaches the page, never the IPC event. Returns the unsubscribe.
  onFullscreenChange: (cb: (fullscreen: boolean) => void): (() => void) => {
    if (typeof cb !== 'function') return () => {};
    const call = (v: boolean) => { try { cb(v); } catch { /* the page's own error */ } };
    const listener = (_e: unknown, value: unknown) => { if (typeof value === 'boolean') call(value); };
    ipcRenderer.on('ms:fullscreen', listener);
    if (fullscreen !== null) call(fullscreen);
    return () => { ipcRenderer.removeListener('ms:fullscreen', listener); };
  },
});

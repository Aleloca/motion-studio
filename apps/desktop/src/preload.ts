import { contextBridge, ipcRenderer } from 'electron';

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
});

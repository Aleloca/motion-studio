import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('motionStudio', {
  isDesktop: true,
  platform: process.platform,
  pickFolder: (title: string, defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('ms:pick-folder', { title, defaultPath }),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('ms:reveal', path),
  // Approval signals (spec §6.3): the main process validates both and shows them only for the app's own page.
  notify: (p: { title: string; body: string }): Promise<void> => ipcRenderer.invoke('ms:notify', { title: p?.title, body: p?.body }),
  setBadge: (n: number): Promise<void> => ipcRenderer.invoke('ms:badge', n),
});

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('motionStudio', {
  isDesktop: true,
  platform: process.platform,
  pickFolder: (title: string, defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('ms:pick-folder', { title, defaultPath }),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('ms:reveal', path),
});

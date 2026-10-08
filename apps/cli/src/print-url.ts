import { defaultConfigDir, isProcessAlive, readServerInfo, readUiToken, uiUrl } from '@motion-studio/core';

export const NOT_RUNNING = 'Motion Studio non è in esecuzione: avvialo con motion-studio';

/** The address (with the UI token) of the Motion Studio already running for this config folder, or null. Starts nothing. */
export async function runningUrl(configDir = defaultConfigDir(), alive: (pid: number) => boolean = isProcessAlive): Promise<string | null> {
  const [info, token] = await Promise.all([readServerInfo(configDir), readUiToken(configDir)]);
  if (!info || !token || !alive(info.pid)) return null;
  return uiUrl(info.port, token);
}

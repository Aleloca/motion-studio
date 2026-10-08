import { answersHealth, defaultConfigDir, isProcessAlive, readServerInfo, readUiToken, uiUrl } from '@motion-studio/core';

export { answersHealth };

export const NOT_RUNNING = 'Motion Studio non è in esecuzione: avvialo con motion-studio';

/** Printed when `motion-studio` finds another live instance for the same config folder (the address is the --print-url one). */
export const alreadyRunningMessage = (appUrl: string) => `Motion Studio è già avviato: ${appUrl}`;

/** The address (with the UI token) of the Motion Studio already running for this config folder, or null. Starts nothing. */
export async function runningUrl(
  configDir = defaultConfigDir(),
  alive: (pid: number) => boolean = isProcessAlive,
  healthy: (port: number) => Promise<boolean> = answersHealth,
): Promise<string | null> {
  const [info, token] = await Promise.all([readServerInfo(configDir), readUiToken(configDir)]);
  if (!info || !token || !alive(info.pid) || !(await healthy(info.port))) return null;
  return uiUrl(info.port, token);
}

import { answersHealth, defaultConfigDir, isProcessAlive, readServerInfo, readUiToken, t, uiUrl } from '@motion-studio/core';

export { answersHealth };

export const notRunningMessage = () => t().cli.notRunning;

/** Printed when `motion-studio` finds another live instance for the same config folder (the address is the --print-url one). */
export const alreadyRunningMessage = (appUrl: string) => t().cli.alreadyRunning({ url: appUrl });

/** The address (with the UI token) of the Motion Studio already running for this config folder, or null. Starts nothing. */
export async function runningUrl(
  configDir = defaultConfigDir(),
  alive: (pid: number) => boolean = isProcessAlive,
  healthy: (port: number, pid: number) => Promise<boolean> = (port, pid) => answersHealth(port, 1500, pid),
): Promise<string | null> {
  const [info, token] = await Promise.all([readServerInfo(configDir), readUiToken(configDir)]);
  if (!info || !token || !alive(info.pid) || !(await healthy(info.port, info.pid))) return null;
  return uiUrl(info.port, token);
}

import { defaultConfigDir, isProcessAlive, readServerInfo, readUiToken, uiUrl } from '@motion-studio/core';

export const NOT_RUNNING = 'Motion Studio non è in esecuzione: avvialo con motion-studio';

/** True when Motion Studio answers on that port within the timeout (the pid alone may have been reused). */
export async function answersHealth(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return res.ok && body?.ok === true;
  } catch {
    return false;
  }
}

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

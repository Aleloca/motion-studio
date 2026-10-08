import { isProcessAlive, readServerInfo, readUiToken, uiUrl } from './ui-token.ts';

/**
 * True when Motion Studio answers on that port within the timeout and, when `pid` is given, reports that pid
 * (the recorded pid alone may have been reused by an unrelated process, and the port by another server).
 */
export async function answersHealth(port: number, timeoutMs = 1500, pid?: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => null)) as { ok?: unknown; pid?: unknown } | null;
    return res.ok && body?.ok === true && (pid === undefined || body.pid === pid);
  } catch {
    return false;
  }
}

export interface RunningInstance { port: number; pid: number; appUrl: string }

/**
 * The Motion Studio already running for this config folder (run/server.json with a live pid whose port answers /api/health
 * with that same pid within the timeout), or null. `appUrl` carries the UI token when its file is readable, else it is the bare address.
 */
export async function findRunningInstance(
  configDir: string,
  opts: { healthTimeoutMs?: number; alive?: (pid: number) => boolean } = {},
): Promise<RunningInstance | null> {
  const info = await readServerInfo(configDir);
  if (!info || info.pid === process.pid || !(opts.alive ?? isProcessAlive)(info.pid)) return null;
  if (!(await answersHealth(info.port, opts.healthTimeoutMs ?? 3000, info.pid))) return null;
  const token = await readUiToken(configDir);
  return { port: info.port, pid: info.pid, appUrl: token ? uiUrl(info.port, token) : `http://127.0.0.1:${info.port}/` };
}

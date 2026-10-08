import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureRunDir } from '../agent/launcher.ts';
import { isProcessAlive } from './ui-token.ts';

const LOCK_FILE = 'boot.lock';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BootLock { release(): Promise<void> }

/** Pid recorded in the lock, or null when it is missing; NaN when it is unreadable garbage. */
async function lockPid(path: string): Promise<number | null> {
  const text = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : ''));
  if (text === null) return null;
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;
}

/**
 * `<configDir>/run/boot.lock` (created exclusively, holding our pid): one boot at a time per config folder, from the
 * running-instance check to server.json. Resolves with the lock, or with 'waited' when another live boot held it for the
 * whole wait (or until it released it): the caller re-checks for a running instance and, if needed, tries once more.
 */
export async function acquireBootLock(
  configDir: string,
  opts: { waitMs?: number; pollMs?: number; alive?: (pid: number) => boolean } = {},
): Promise<BootLock | 'waited'> {
  const path = join(await ensureRunDir(configDir), LOCK_FILE);
  const alive = opts.alive ?? isProcessAlive;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, String(process.pid), { flag: 'wx', mode: 0o600 });
      return {
        release: async () => { if ((await lockPid(path)) === process.pid) await rm(path, { force: true }).catch(() => {}); },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const pid = await lockPid(path);
    if (pid === null) continue; // released in the meantime
    if (Number.isNaN(pid) || !alive(pid)) { await rm(path, { force: true }); continue; } // stale: retry once
    // Another boot is in progress: wait for it to go away.
    const deadline = Date.now() + (opts.waitMs ?? 5000);
    while (Date.now() < deadline && (await lockPid(path)) === pid && alive(pid)) await sleep(opts.pollMs ?? 100);
    return 'waited';
  }
  return 'waited';
}

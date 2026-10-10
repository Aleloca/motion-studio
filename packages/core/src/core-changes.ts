import { lstat } from 'node:fs/promises';

/**
 * The identity (inode) and times a folder had right after the core itself last changed its entries (created, renamed or
 * removed something in it), so the post-run check (run-tripwire.ts) can tell its own changes from someone else's
 * (decisions log 141). Recorded from the folder's own `lstat`, never from the wall clock, so it does not depend on clock
 * resolution or on a networked filesystem's clock (FP7). In memory only: a run's arm and check are both in this process.
 * Keys are the paths as the core spells them (`<project>/creatives`, …).
 */
export interface DirStamp { ino: number; mtimeMs: number; ctimeMs: number }
const lastChange = new Map<string, DirStamp>();

/** Call right after the change, awaited: it lstats the folder and stores what it reads. A folder that cannot be read is skipped. */
export async function noteCoreChange(dir: string): Promise<void> {
  const st = await lstat(dir).catch(() => null);
  if (st) lastChange.set(dir, { ino: st.ino, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
}

export function lastCoreChange(dir: string): DirStamp | undefined {
  return lastChange.get(dir);
}

export function clearCoreChangesForTests(): void { lastChange.clear(); }

/**
 * When the core itself last changed the entries of a folder (created, renamed or removed something in it), so a check after
 * an agent run can tell its own changes from someone else's (decisions log 141). In memory only: the check compares a run's
 * start and end, both in this process. Keys are the paths as the core spells them (`<project>/creatives`, …).
 */
const lastChange = new Map<string, number>();

/** Call right after the change: the recorded time is never earlier than the folder's new mtime/ctime. */
export function noteCoreChange(dir: string): void {
  lastChange.set(dir, Date.now());
}

export function lastCoreChange(dir: string): number | undefined {
  return lastChange.get(dir);
}

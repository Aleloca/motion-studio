import { resolve } from 'node:path';
import { KeyedMutex } from './keyed-mutex.ts';

/**
 * One process-wide lock per metadata file (keys are `resolve()`d absolute paths), shared by every
 * BrandStore/LibraryStore instance and by the brand jobs that guard those files during an agent turn.
 * Each app write bumps a per-path counter, so a guard can tell "the agent changed this file" from
 * "the app wrote it meanwhile".
 */
const MUTEX = new KeyedMutex();
const writes = new Map<string, number>();

export const fileLock = {
  run<T>(path: string, fn: () => Promise<T>): Promise<T> { return MUTEX.run(resolve(path), fn); },
  /** Call while holding the lock, right after the app wrote the file. */
  noteWrite(path: string): void { const k = resolve(path); writes.set(k, (writes.get(k) ?? 0) + 1); },
  writeCount(path: string): number { return writes.get(resolve(path)) ?? 0; },
};

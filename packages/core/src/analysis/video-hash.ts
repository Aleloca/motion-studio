import { lstat, realpath } from 'node:fs/promises';
import type { SidecarHeader } from '@motion-studio/shared';
import { hashRegularFile } from '../safe-read.ts';

/**
 * The content hash of a video (spec §4: a sidecar is fresh while its `sha256` matches the file). Read in bounded chunks, never
 * through a link or from a non-regular file; remembered in memory by real path, size, mtime and inode, so a video that did not
 * change is not read again.
 */
const MAX_CACHED = 500;
const cache = new Map<string, { sha256: string; bytes: number }>();

export class VideoHashError extends Error {
  constructor(readonly reason: 'missing' | 'link' | 'special') {
    super(`video ${reason}`);
    this.name = 'VideoHashError';
  }
}

export async function hashVideo(absPath: string): Promise<{ sha256: string; bytes: number }> {
  const st = await lstat(absPath).catch(() => null);
  if (!st) throw new VideoHashError('missing');
  if (st.isSymbolicLink()) throw new VideoHashError('link');
  if (!st.isFile()) throw new VideoHashError('special');
  const real = await realpath(absPath).catch(() => absPath);
  const key = `${real}\0${st.size}\0${st.mtimeMs}\0${st.ino}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return { ...hit };
  }
  const r = await hashRegularFile(absPath);
  if (r.kind !== 'file') throw new VideoHashError(r.kind);
  const out = { sha256: r.sha, bytes: st.size };
  cache.set(key, out);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return { ...out };
}

/** A sidecar is fresh while it describes the same content. */
export const isFresh = (header: Pick<SidecarHeader, 'sha256'>, hash: { sha256: string }): boolean => header.sha256 === hash.sha256;

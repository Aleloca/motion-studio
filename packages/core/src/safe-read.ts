import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

/**
 * Bounded, non-blocking reads of files the agent may have shaped (decisions log 141, final review B1). A plain `readFile`
 * follows a link and blocks forever in `open()` on a FIFO, or grows without bound on `/dev/zero`. Here:
 * - the path is `lstat`-ed first: a missing entry, a link and any non-regular file are reported, never opened;
 * - the file is opened with `O_NOFOLLOW | O_NONBLOCK` (a FIFO swapped in after the lstat cannot block the open) and its
 *   `fstat` must be the same regular file;
 * - reads stop at `maxBytes` (contents) or at the size `fstat` reported (hashes).
 */
export type SafeFile =
  | { kind: 'missing' }
  | { kind: 'link' }
  | { kind: 'special' }
  | { kind: 'too-large'; size: number }
  | { kind: 'file'; data: Buffer };

const isMissing = (e: unknown) => { const c = (e as NodeJS.ErrnoException).code; return c === 'ENOENT' || c === 'ENOTDIR'; };
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

type Handle = Awaited<ReturnType<typeof open>>;
/** Opens `path` only if it is (still) the regular file `lstat` saw; otherwise says what it is. Other errors throw. */
async function openRegular(path: string): Promise<{ fh: Handle; size: number } | Exclude<SafeFile, { kind: 'file' } | { kind: 'too-large' }>> {
  let st;
  try { st = await lstat(path); } catch (e) { if (isMissing(e)) return { kind: 'missing' }; throw e; }
  if (st.isSymbolicLink()) return { kind: 'link' };
  if (!st.isFile()) return { kind: 'special' };
  let fh: Handle;
  try { fh = await open(path, FLAGS); } catch (e) {
    const c = (e as NodeJS.ErrnoException).code;
    if (c === 'ELOOP') return { kind: 'link' };
    if (isMissing(e)) return { kind: 'missing' };
    throw e;
  }
  const fs = await fh.stat().catch(async (e: unknown) => { await fh.close(); throw e; });
  if (!fs.isFile() || fs.ino !== st.ino || fs.dev !== st.dev) { await fh.close(); return { kind: 'special' }; }
  return { fh, size: fs.size };
}

/** The contents of a regular file of at most `maxBytes`; anything else is reported, never read. */
export async function readRegularFile(path: string, maxBytes: number): Promise<SafeFile> {
  const r = await openRegular(path);
  if (!('fh' in r)) return r;
  const { fh, size } = r;
  try {
    if (size > maxBytes) return { kind: 'too-large', size };
    const buf = Buffer.alloc(maxBytes + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n > maxBytes) return { kind: 'too-large', size: n };
    return { kind: 'file', data: buf.subarray(0, n) };
  } finally { await fh.close(); }
}

/** sha256 of a regular file's first `fstat` size bytes (memory stays bounded); a link or a non-regular file is reported. */
export async function hashRegularFile(path: string): Promise<{ kind: 'file'; sha: string } | Exclude<SafeFile, { kind: 'file' } | { kind: 'too-large' }>> {
  const r = await openRegular(path);
  if (!('fh' in r)) return r;
  const { fh, size } = r;
  try {
    const hash = createHash('sha256');
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return { kind: 'file', sha: hash.digest('hex') };
  } finally { await fh.close(); }
}

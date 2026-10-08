import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename, rm, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileLock } from '../file-locks.ts';

/** The project's live metadata: brand jobs' agents work on copies and must never write these. */
export const GUARDED_FILES = ['brand/brand-kit.json', 'brand/guidelines.md', 'brand/sources.json', 'assets/assets.json', 'references/references.json'] as const;

const absOf = (projectDir: string, rel: string) => join(projectDir, ...rel.split('/'));

/** Absolute paths of the guarded files, also under the project's real path when it differs (the policy denies edits on them). */
export async function guardedPaths(projectDir: string): Promise<string[]> {
  const real = await realpath(projectDir).catch(() => projectDir);
  const roots = real === projectDir ? [projectDir] : [projectDir, real];
  return roots.flatMap((r) => GUARDED_FILES.map((f) => absOf(r, f)));
}

interface GuardedFile { rel: string; abs: string; bytes: Buffer | null | undefined; writes: number }
export type GuardSnapshot = GuardedFile[];

/** Bytes (null = missing, undefined = unreadable, never restored) and app-write counter of each guarded file, read under its lock. */
export function snapshotGuarded(projectDir: string): Promise<GuardSnapshot> {
  return Promise.all(GUARDED_FILES.map((rel) => {
    const abs = absOf(projectDir, rel);
    return fileLock.run(abs, async () => ({
      rel, abs, writes: fileLock.writeCount(abs),
      bytes: await readFile(abs).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : undefined)),
    }));
  }));
}

async function sameContent(abs: string, bytes: Buffer | null): Promise<boolean> {
  const info = await lstat(abs).catch(() => null);
  if (!info) return bytes === null;
  if (!info.isFile() || bytes === null) return false;
  return (await readFile(abs)).equals(bytes);
}

/** The file's folder is a real directory (not a symlink) whose real path is inside the project. */
async function confinedParent(abs: string, projectDir: string): Promise<boolean> {
  const parent = dirname(abs);
  const info = await lstat(parent).catch(() => null);
  if (!info?.isDirectory()) return false;
  const [real, realProject] = await Promise.all([realpath(parent).catch(() => null), realpath(projectDir).catch(() => null)]);
  return real !== null && realProject !== null && real.startsWith(realProject + sep);
}

export const tamperNote = (rel: string) => `L'agente ha provato a modificare direttamente ${rel}: modifica annullata`;
export const unrestorableNote = (rel: string) => `L'agente ha provato a modificare direttamente ${rel}: modifica non annullabile`;

/**
 * Puts back the pre-turn bytes of every guarded file the agent changed (an interpreter can bypass the deny rules).
 * Under each file's lock, and only when the app did not write the file meanwhile: an app write is the user's,
 * built on what was on disk at that moment, and wins. Never writes through a folder that is no longer a real
 * directory inside the project (e.g. replaced by a symlink): that file is reported as not restorable.
 * Returns one note per changed file.
 */
export async function restoreGuarded(snapshot: GuardSnapshot, projectDir: string): Promise<string[]> {
  const notes: string[] = [];
  for (const g of snapshot) {
    if (g.bytes === undefined) continue;
    const bytes = g.bytes;
    await fileLock.run(g.abs, async () => {
      if (fileLock.writeCount(g.abs) !== g.writes || await sameContent(g.abs, bytes)) return;
      if (!(await confinedParent(g.abs, projectDir))) {
        // A missing folder with nothing to put back is no change at all.
        if (bytes !== null || (await lstat(dirname(g.abs)).catch(() => null))) notes.push(unrestorableNote(g.rel));
        return;
      }
      const info = await lstat(g.abs).catch(() => null);
      if (info && !info.isFile() && !info.isSymbolicLink()) await rm(g.abs, { recursive: true, force: true });
      if (bytes === null) await rm(g.abs, { force: true });
      else {
        // A symlink in its place is replaced, never followed.
        const tmp = `${g.abs}.${randomBytes(6).toString('hex')}.tmp`;
        try { await writeFile(tmp, bytes, { flag: 'wx' }); await rename(tmp, g.abs); }
        catch (err) { await unlink(tmp).catch(() => {}); throw err; }
      }
      notes.push(tamperNote(g.rel));
    });
  }
  return notes;
}

export const MAX_AGENT_FILE_BYTES = 1024 * 1024;
export type AgentFile = { text: string } | { skipped: string } | null;

/** A file the agent wrote: only a regular file (no symlink) up to the size limit is read; null when missing. */
export async function readAgentFile(path: string, maxBytes = MAX_AGENT_FILE_BYTES): Promise<AgentFile> {
  const info = await lstat(path).catch(() => null);
  if (!info) return null;
  if (!info.isFile()) return { skipped: 'non è un file regolare' };
  if (info.size > maxBytes) return { skipped: 'file troppo grande' };
  return { text: await readFile(path, 'utf8') };
}

/**
 * Reads a project file on behalf of the agent from the (unsandboxed) core: never through a symlink, only a regular file
 * whose real path stays inside the project, up to `maxBytes`. Opened non-blocking so a FIFO cannot hang the core.
 * null when missing; `{ skipped }` when refused.
 */
export async function readConfinedFile(projectDir: string, rel: string, maxBytes = MAX_AGENT_FILE_BYTES): Promise<AgentFile> {
  const abs = absOf(projectDir, rel);
  let fh: FileHandle;
  try {
    fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : { skipped: 'non leggibile' };
  }
  try {
    const info = await fh.stat();
    if (!info.isFile()) return { skipped: 'non è un file regolare' };
    // A hard link made by the agent can point at any file of the user's on the same volume.
    if (info.nlink > 1) return { skipped: 'file collegato non consentito' };
    if (info.size > maxBytes) return { skipped: 'file troppo grande' };
    // A symlinked parent folder could lead out of the project: the opened file must be the one under the project's real path.
    const [real, realProject] = await Promise.all([realpath(abs).catch(() => null), realpath(projectDir).catch(() => null)]);
    if (!real || !realProject || !real.startsWith(realProject + sep)) return { skipped: 'fuori dal progetto' };
    const check = await stat(real).catch(() => null);
    if (!check || check.ino !== info.ino || check.dev !== info.dev) return { skipped: 'fuori dal progetto' };
    // Bounded read: the file may grow after the size check.
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) return { skipped: 'file troppo grande' };
    }
    return { text: buf.subarray(0, total).toString('utf8') };
  } finally {
    await fh.close().catch(() => {});
  }
}

export const MAX_AGENT_BYTES = 50 * 1024 * 1024;

/** Same checks as readConfinedFile, for binary files (e.g. reference images): the bytes, or `{ skipped }` / null when missing. */
export async function readConfinedBytes(projectDir: string, rel: string, maxBytes = MAX_AGENT_BYTES): Promise<{ bytes: Buffer } | { skipped: string } | null> {
  const abs = absOf(projectDir, rel);
  let fh: FileHandle;
  try {
    fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : { skipped: 'non leggibile' };
  }
  try {
    const info = await fh.stat();
    if (!info.isFile()) return { skipped: 'non è un file regolare' };
    // A hard link made by the agent can point at any file of the user's on the same volume.
    if (info.nlink > 1) return { skipped: 'file collegato non consentito' };
    if (info.size > maxBytes) return { skipped: 'file troppo grande' };
    const [real, realProject] = await Promise.all([realpath(abs).catch(() => null), realpath(projectDir).catch(() => null)]);
    if (!real || !realProject || !real.startsWith(realProject + sep)) return { skipped: 'fuori dal progetto' };
    const check = await stat(real).catch(() => null);
    if (!check || check.ino !== info.ino || check.dev !== info.dev) return { skipped: 'fuori dal progetto' };
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(Math.min(1024 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await fh.read(buf, 0, buf.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) return { skipped: 'file troppo grande' };
      chunks.push(buf.subarray(0, bytesRead));
    }
    return { bytes: Buffer.concat(chunks) };
  } finally {
    await fh.close().catch(() => {});
  }
}

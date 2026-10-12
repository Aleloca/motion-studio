import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { noteCoreChange } from '../core-changes.ts';
import { noteCoreTemp } from '../core-temps.ts';

/**
 * Safe core writes into the project's protected cache (Task 5b fix I1). The core runs outside the sandbox, so a file it
 * writes must never land through a link: every folder of the path is a real directory (created one level at a time, never
 * followed when it is a link) whose real path is exactly the expected one, and the file is written to a fresh temp name
 * (`wx` / O_EXCL) and renamed into place (a rename replaces an entry, it never follows it).
 */

/**
 * `<base>/<rels…>` as a chain of real directories, created when missing; null when any of them is a link, not a folder, or
 * resolves elsewhere. `base` itself must be a real directory. Created folders are noted as the core's own changes.
 */
export async function realDirChain(base: string, rels: readonly string[]): Promise<string | null> {
  const st = await lstat(base).catch(() => null);
  if (!st?.isDirectory()) return null;
  const realBase = await realpath(base).catch(() => null);
  if (!realBase) return null;
  let dir = base;
  let real = realBase;
  for (const r of rels) {
    const next = join(dir, r);
    let info = await lstat(next).catch(() => null);
    if (!info) {
      await mkdir(next).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
      await noteCoreChange(dir);
      info = await lstat(next).catch(() => null);
    }
    if (!info?.isDirectory()) return null; // a symlink is not a directory for lstat
    real = join(real, r);
    if ((await realpath(next).catch(() => null)) !== real) return null;
    dir = next;
  }
  return dir;
}

/**
 * Whether `<base>/<rels…>` exists as a chain of real directories (no link anywhere, real path exactly the expected one).
 * Nothing is created. For folders the agent writes (a composition folder during its turn, fix minor 1).
 */
export async function isRealDirChain(base: string, rels: readonly string[]): Promise<'ok' | 'missing' | 'unsafe'> {
  const realBase = await realpath(base).catch(() => null);
  if (!realBase || !(await lstat(base).catch(() => null))?.isDirectory()) return 'unsafe';
  let dir = base;
  let real = realBase;
  for (const r of rels) {
    dir = join(dir, r);
    real = join(real, r);
    const info = await lstat(dir).catch(() => null);
    if (!info) return 'missing';
    if (!info.isDirectory() || (await realpath(dir).catch(() => null)) !== real) return 'unsafe';
  }
  return 'ok';
}

/**
 * Writes `dir/name` through a fresh temp file: `write(temp)` must create `temp` (with `wx`, or a tool writing that new
 * name), which must then be a regular single-linked file; it is renamed over `name`. False when nothing was written.
 */
export async function writeThroughTemp(dir: string, name: string, write: (temp: string) => Promise<boolean>): Promise<boolean> {
  const temp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  noteCoreTemp(temp);
  try {
    if (!(await write(temp))) return false;
    const st = await lstat(temp).catch(() => null);
    if (!st?.isFile() || st.nlink !== 1) return false;
    await rename(temp, join(dir, name));
    await noteCoreChange(dir);
    return true;
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

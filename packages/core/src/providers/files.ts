import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { claimName, sanitizeFileName } from '../library/upload.ts';
import { ProviderError } from './http.ts';

export type GeneratedDir = 'generated' | 'audio' | 'stock' | 'fonts';

const INVALID = 'Cartella degli asset non valida';

/** Creates the directory if missing and refuses symlinks or non-directories. */
async function plainDir(path: string): Promise<void> {
  let st = await lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
  if (!st) {
    await mkdir(path).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
    st = await lstat(path);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ProviderError(400, INVALID);
}

export async function saveGeneratedFile(projectDir: string, dir: GeneratedDir, name: string, bytes: Buffer): Promise<string> {
  const assets = join(projectDir, 'assets');
  const target = join(assets, dir);
  await plainDir(assets);
  await plainDir(target);
  const root = await realpath(projectDir);
  if (!(await realpath(target)).startsWith(root + sep)) throw new ProviderError(400, INVALID);
  const clean = sanitizeFileName(name);
  const tmp = join(target, `.${clean}.${randomBytes(4).toString('hex')}.part`);
  try {
    await writeFile(tmp, bytes, { flag: 'wx' });
    return `${dir}/${await claimName(target, tmp, clean)}`;
  } finally {
    await rm(tmp, { force: true });
  }
}

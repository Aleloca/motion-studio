import { access, constants, copyFile, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import type { VersionEntry } from '@motion-studio/shared';
import { WorkspaceError } from '../workspace-store.ts';

export interface ExportResult { destination: string; files: Array<{ from: string; to: string }> }

const isInside = (p: string, base: string) => p === base || p.startsWith(base.endsWith(sep) ? base : base + sep);

async function copyUnique(from: string, dir: string, stem: string, ext: string): Promise<string> {
  for (let i = 1; ; i++) {
    const to = join(dir, i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`);
    try { await copyFile(from, to, constants.COPYFILE_EXCL); return to; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
}

/** Real path of `p` even when it does not exist yet: the deepest existing ancestor is resolved, the rest appended. */
async function resolveLoose(p: string): Promise<string> {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try { return join(await realpath(cur), ...tail.reverse()); }
    catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Copies the outputs of a version into `destination` using channel names (`<slug>-<format>-v<n>.<ext>`), never overwriting.
 * `forbiddenRoot`: destinations inside it are refused (exports are meant for delivery outside the workspace).
 */
export async function exportVersion(opts: { creativeDir: string; version: VersionEntry; destination: string; slug: string; forbiddenRoot?: string }): Promise<ExportResult> {
  const dest = opts.destination.trim();
  if (!isAbsolute(dest)) throw new WorkspaceError(400, 'Scegli una cartella di destinazione (percorso assoluto)');
  if (opts.forbiddenRoot) {
    const root = await resolveLoose(opts.forbiddenRoot);
    if (isInside(await resolveLoose(dest), root)) throw new WorkspaceError(400, 'Scegli una cartella fuori dal workspace di Motion Studio');
  }
  const info = await lstat(dest).catch(() => null);
  if (info && !info.isDirectory() && !info.isSymbolicLink()) throw new WorkspaceError(400, 'La destinazione è un file, non una cartella');
  try { await mkdir(dest, { recursive: true }); await access(dest, constants.W_OK); }
  catch { throw new WorkspaceError(400, `Impossibile scrivere nella cartella ${dest}`); }
  if (!(await stat(dest)).isDirectory()) throw new WorkspaceError(400, 'La destinazione è un file, non una cartella');
  const n = opts.version.n;
  const outDir = join(opts.creativeDir, 'outputs', `v${n}`);
  const realOutDir = await realpath(outDir).catch(() => null);
  const realCreative = await realpath(opts.creativeDir).catch(() => null);
  const files: ExportResult['files'] = [];
  if (realOutDir && realCreative && isInside(realOutDir, join(realCreative, 'outputs'))) {
    for (const o of opts.version.outputs) {
      if (!o.file || o.file === '.' || o.file === '..' || o.file !== basename(o.file) || o.file.includes('\\') || o.file.includes('/')) continue;
      const from = join(outDir, o.file);
      if (!(await lstat(from).catch(() => null))?.isFile()) continue;
      const realFrom = await realpath(from).catch(() => null);
      if (!realFrom || !isInside(realFrom, realOutDir + sep)) continue;
      const ext = extname(o.file).toLowerCase();
      files.push({ from, to: await copyUnique(from, dest, `${opts.slug}-${o.format}-v${n}`, ext) });
    }
  }
  if (!files.length) throw new WorkspaceError(404, `Nessun output da esportare per v${n}`);
  return { destination: dest, files };
}

import { access, constants, copyFile, lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import type { VersionEntry } from '@motion-studio/shared';
import { WorkspaceError } from '../workspace-store.ts';

export interface ExportResult { destination: string; files: Array<{ from: string; to: string }>; skipped: string[] }

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
const fold = (p: string) => (CASE_INSENSITIVE ? p.toLowerCase() : p);
const isInside = (p: string, base: string) => {
  const a = fold(p);
  const b = fold(base);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/** A file-name segment: only [A-Za-z0-9._-], no leading dots. */
const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || '_';

type CopyFn = (from: string, to: string, mode: number) => Promise<void>;

/** Copies without overwriting; null when the computed target would not be a direct child of `dir`. */
async function copyUnique(copy: CopyFn, from: string, dir: string, stem: string, ext: string): Promise<string | null> {
  for (let i = 1; ; i++) {
    const to = join(dir, i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`);
    if (dirname(to) !== dir) return null;
    try { await copy(from, to, constants.COPYFILE_EXCL); return to; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { (e as { target?: string }).target = to; throw e; }
    }
  }
}

function reasonOf(e: unknown): string {
  switch ((e as NodeJS.ErrnoException).code) {
    case 'ENOSPC': return 'spazio su disco esaurito';
    case 'EACCES': case 'EPERM': case 'EROFS': return 'permesso negato';
    case 'EDQUOT': return 'quota di spazio esaurita';
    case 'ENAMETOOLONG': return 'nome del file troppo lungo';
    default: return 'errore di scrittura';
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
export async function exportVersion(opts: { creativeDir: string; version: VersionEntry; destination: string; slug: string; forbiddenRoot?: string; copy?: CopyFn }): Promise<ExportResult> {
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
  const skipped: string[] = [];
  const copy = opts.copy ?? ((f, t, m) => copyFile(f, t, m));
  const slug = safeSegment(opts.slug);
  const canRead = Boolean(realOutDir && realCreative && isInside(realOutDir, join(realCreative, 'outputs')));
  for (const o of opts.version.outputs) {
    if (!canRead || !realOutDir) { skipped.push(o.file); continue; }
    if (!o.file || o.file === '.' || o.file === '..' || o.file !== basename(o.file) || o.file.includes('\\') || o.file.includes('/')) { skipped.push(o.file); continue; }
    const from = join(outDir, o.file);
    if (!(await lstat(from).catch(() => null))?.isFile()) { skipped.push(o.file); continue; }
    const realFrom = await realpath(from).catch(() => null);
    if (!realFrom || !isInside(realFrom, realOutDir + sep)) { skipped.push(o.file); continue; }
    const rawExt = extname(o.file).slice(1).toLowerCase();
    const ext = rawExt ? `.${rawExt.replace(/[^a-z0-9]/g, '_')}` : '';
    try {
      const to = await copyUnique(copy, from, dest, `${slug}-${safeSegment(o.format)}-v${n}`, ext);
      if (to) files.push({ from, to }); else skipped.push(o.file);
    } catch (e) {
      const target = (e as { target?: string }).target;
      if (target) await rm(target, { force: true }).catch(() => undefined);
      throw new WorkspaceError(500, `Esportazione interrotta: ${reasonOf(e)}. File già copiati: ${files.length} in ${dest}`);
    }
  }
  if (!files.length) throw new WorkspaceError(404, `Nessun output da esportare per v${n}`);
  return { destination: dest, files, skipped };
}

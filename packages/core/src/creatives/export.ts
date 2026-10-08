import { access, constants, copyFile, lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import type { VersionEntry } from '@motion-studio/shared';
import { slugify, WorkspaceError } from '../workspace-store.ts';
import { t } from '../i18n.ts';

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

/** File-name base from the creative title: slug cut to 40 characters, null when the title has no usable characters. */
function titleBase(title: string | undefined): string | null {
  if (!title || !/[a-z0-9]/.test(title.normalize('NFKD').toLowerCase())) return null;
  const s = slugify(title).slice(0, 40).replace(/-+$/, '');
  return s || null;
}

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
    case 'ENOSPC': return t().export.diskFull;
    case 'EACCES': case 'EPERM': case 'EROFS': return t().export.permissionDenied;
    case 'EDQUOT': return t().export.quotaExceeded;
    case 'ENAMETOOLONG': return t().export.nameTooLong;
    default: return t().export.writeError;
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
export async function exportVersion(opts: { creativeDir: string; version: VersionEntry; destination: string; slug: string; title?: string; formats?: string[]; forbiddenRoot?: string; copy?: CopyFn }): Promise<ExportResult> {
  const wanted = opts.formats === undefined ? null : new Set(opts.formats);
  if (wanted) {
    if (!wanted.size) throw new WorkspaceError(400, t().export.invalidFormats);
    const present = new Set(opts.version.outputs.map((o) => o.format));
    const missing = [...wanted].filter((f) => !present.has(f));
    if (missing.length) throw new WorkspaceError(400, t().export.formatsNotInVersion({ list: missing.join(', ') }));
  }
  const dest = opts.destination.trim();
  if (!isAbsolute(dest)) throw new WorkspaceError(400, t().export.absoluteDestination);
  if (opts.forbiddenRoot) {
    const root = await resolveLoose(opts.forbiddenRoot);
    if (isInside(await resolveLoose(dest), root)) throw new WorkspaceError(400, t().export.outsideWorkspace);
  }
  const info = await lstat(dest).catch(() => null);
  if (info && !info.isDirectory() && !info.isSymbolicLink()) throw new WorkspaceError(400, t().export.destinationIsFile);
  try { await mkdir(dest, { recursive: true }); await access(dest, constants.W_OK); }
  catch { throw new WorkspaceError(400, t().export.cannotWrite({ path: dest })); }
  if (!(await stat(dest)).isDirectory()) throw new WorkspaceError(400, t().export.destinationIsFile);
  const n = opts.version.n;
  const outDir = join(opts.creativeDir, 'outputs', `v${n}`);
  const realOutDir = await realpath(outDir).catch(() => null);
  const realCreative = await realpath(opts.creativeDir).catch(() => null);
  const files: ExportResult['files'] = [];
  const skipped: string[] = [];
  const copy = opts.copy ?? ((f, t, m) => copyFile(f, t, m));
  const slug = safeSegment(titleBase(opts.title) ?? opts.slug);
  const canRead = Boolean(realOutDir && realCreative && isInside(realOutDir, join(realCreative, 'outputs')));
  for (const o of opts.version.outputs) {
    if (wanted && !wanted.has(o.format)) continue;
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
      throw new WorkspaceError(500, t().export.interrupted({ reason: reasonOf(e), count: files.length, path: dest }));
    }
  }
  if (!files.length) throw new WorkspaceError(404, t().export.nothingToExport({ n }));
  return { destination: dest, files, skipped };
}

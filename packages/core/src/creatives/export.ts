import { access, constants, lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { DEFAULT_EXPORT_NAME_PATTERN, exportExtension, exportNameCollisions, exportNameVars, followerMatches, followerVersion, renderName, starOf, type FormatPreset, type VersionEntry } from '@motion-studio/shared';
import { copyConfinedFile, probeConfinedFile } from '../brand/agent-guard.ts';
import { CodedError, WorkspaceError } from '../workspace-store.ts';
import { t } from '../i18n.ts';

export interface ExportResult { destination: string; files: Array<{ from: string; to: string }>; skipped: string[] }

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
const fold = (p: string) => (CASE_INSENSITIVE ? p.toLowerCase() : p);
const isInside = (p: string, base: string) => {
  const a = fold(p);
  const b = fold(base);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/**
 * Copies `from` to `to` without overwriting (EEXIST when `to` exists). On a failure after creating `to`, the error carries
 * `targetCreated: true` so the export removes the partial file; without it nothing is removed.
 */
type CopyFn = (from: string, to: string, mode: number) => Promise<void>;

/** Copies without overwriting; null when the computed target would not be a direct child of `dir`. */
async function copyUnique(copy: CopyFn, from: string, dir: string, stem: string, ext: string): Promise<string | null> {
  for (let i = 1; ; i++) {
    const to = join(dir, i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`);
    if (dirname(to) !== dir) return null;
    try { await copy(from, to, constants.COPYFILE_EXCL); return to; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      // Only a file this copy created may be removed: never one that was already there (e.g. the source was refused
      // before the target was opened).
      if ((e as { targetCreated?: boolean }).targetCreated) (e as { target?: string }).target = to;
      throw e;
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
 * One file to export: the output `file` of `format` in version `n`. `v` is the number the name's `{v}` shows when it
 * differs from `n`: a follower is named after its primary's version (decisions log 140), whose file is byte-identical.
 */
interface ExportItem { format: string; n: number; v?: number; file: string; width: number; height: number }

interface ExportCommon {
  creativeDir: string;
  destination: string;
  slug: string;
  title?: string;
  /** Destinations inside it are refused (exports are meant for delivery outside the workspace). */
  forbiddenRoot?: string;
  presets?: FormatPreset[];
  /** The name pattern (`renderName`); the default `{title}-{format}-v{v}` when omitted. */
  pattern?: string;
  /** The export date (`{date}`): a Date (local day) or `YYYY-MM-DD`; now when omitted. */
  now?: Date | string;
  /** A format's display name in messages; its id when omitted. */
  label?: (format: string) => string;
  copy?: CopyFn;
}

const plainName = (f: string) => Boolean(f) && f !== '.' && f !== '..' && f === basename(f) && !f.includes('\\') && !f.includes('/');

/**
 * Copies the files of `items` into `destination`, named with the pattern, never overwriting (`-2`, `-3`…).
 * `missing`: a file missing on disk, refused by the confined read (symlink, hard link, not regular, outside its version
 * folder) or with an unsafe name is `'refuse'`d (409 `export-file-missing`, nothing copied) or `'skip'`ped (listed in
 * `skipped`; 404 when nothing is left). Names that collide (case-insensitively) are refused before any copy.
 */
async function runExport(items: ExportItem[], opts: ExportCommon, missing: 'refuse' | 'skip', emptyN: number): Promise<ExportResult> {
  const dest = opts.destination.trim();
  if (!isAbsolute(dest)) throw new CodedError(400, t().export.absoluteDestination, 'export-invalid-destination');
  if (opts.forbiddenRoot) {
    const root = await resolveLoose(opts.forbiddenRoot);
    if (isInside(await resolveLoose(dest), root)) throw new WorkspaceError(400, t().export.outsideWorkspace);
  }
  const label = opts.label ?? ((f: string) => f);
  const skipped: string[] = [];
  const bad: ExportItem[] = [];
  const ok: ExportItem[] = [];
  for (const it of items) {
    const usable = plainName(it.file) && (await probeConfinedFile(opts.creativeDir, `outputs/v${it.n}/${it.file}`)) === true;
    if (usable) ok.push(it); else if (missing === 'skip') skipped.push(it.file); else bad.push(it);
  }
  if (bad.length) {
    throw new CodedError(409, t().export.filesMissing({ list: bad.map((b) => `${label(b.format)} v${b.n}`).join(', ') }), 'export-file-missing');
  }
  if (!ok.length) throw new WorkspaceError(404, t().export.nothingToExport({ n: emptyN }));
  const date = opts.now ?? new Date();
  const pattern = opts.pattern ?? DEFAULT_EXPORT_NAME_PATTERN;
  const named = ok.map((it) => {
    const r = renderName(pattern, exportNameVars({ title: opts.title, slug: opts.slug, format: it.format, preset: opts.presets?.find((p) => p.id === it.format),
      size: { width: it.width, height: it.height }, version: it.v ?? it.n, date }));
    if (!r.ok) throw new CodedError(400, t().export.nameEmpty, 'export-name-empty');
    return { ...it, stem: r.name, ext: exportExtension(it.file) };
  });
  const collisions = exportNameCollisions(named.map((x) => `${x.stem}${x.ext}`));
  if (collisions.length) throw new CodedError(400, t().export.nameCollision({ list: collisions.join(', ') }), 'export-name-collision');

  const info = await lstat(dest).catch(() => null);
  if (info && !info.isDirectory() && !info.isSymbolicLink()) throw new WorkspaceError(400, t().export.destinationIsFile);
  try { await mkdir(dest, { recursive: true }); await access(dest, constants.W_OK); }
  catch { throw new WorkspaceError(400, t().export.cannotWrite({ path: dest })); }
  if (!(await stat(dest)).isDirectory()) throw new WorkspaceError(400, t().export.destinationIsFile);
  const copy: CopyFn = opts.copy ?? ((from, to) => copyConfinedFile(opts.creativeDir, relative(opts.creativeDir, from).split(sep).join('/'), to));
  const files: ExportResult['files'] = [];
  for (const it of named) {
    const from = join(opts.creativeDir, 'outputs', `v${it.n}`, it.file);
    try {
      const to = await copyUnique(copy, from, dest, it.stem, it.ext);
      if (to) files.push({ from, to }); else skipped.push(it.file);
    } catch (e) {
      const target = (e as { target?: string }).target;
      if (target) await rm(target, { force: true }).catch(() => undefined);
      throw new WorkspaceError(500, t().export.interrupted({ reason: reasonOf(e), count: files.length, path: dest }));
    }
  }
  if (!files.length) throw new WorkspaceError(404, t().export.nothingToExport({ n: emptyN }));
  return { destination: dest, files, skipped };
}

const isVersionNumber = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

/**
 * Exports the ★ versions (spec §3.3): `picks` gives the version of each format; `follow` lists followers, exported with
 * their own file (`outputs/vN/<follower file>`, named after the follower). The primary version is the primary's pick in
 * this export, else its stored ★ (`storedPicks`, default rule); the follower's version is `followerVersion` of it (decisions
 * log 140: the latest version with the follower's file and an identical primary file). As a record, `follow` carries the
 * follower version the client showed, which must satisfy that rule for the primary version. `{v}` in the name is the
 * primary's version number. Refused (coded errors, nothing copied):
 * - `export-invalid-picks` (400): no format, a version that is not a positive integer, a `follow` entry that is not a follower;
 * - `export-pick-follower` (400): a pick for a follower (its version is its primary's);
 * - `export-pick-no-file` (400): the version does not exist or has no file of the format;
 * - `export-follow-mismatch` (400): a follower version (record) whose primary file differs from the primary version exported;
 * - `export-file-missing` (409): the file is missing on disk or refused by the confined read;
 * - `export-name-empty`, `export-name-collision` (400): the pattern gives an empty name, or the same name twice.
 */
export async function exportPicks(opts: ExportCommon & { versions: VersionEntry[]; picks: Record<string, number>; follow?: string[] | Record<string, number>;
  links?: Record<string, string>; storedPicks?: Record<string, number> }): Promise<ExportResult> {
  const links = opts.links ?? {};
  const label = opts.label ?? ((f: string) => f);
  // `follow` as a record carries the version the client showed for each follower; a list (older clients) lets the core
  // resolve it from the primary.
  const shown: Record<string, number> | null = Array.isArray(opts.follow) || opts.follow === undefined ? null : opts.follow;
  const follow = shown ? Object.keys(shown) : [...new Set(opts.follow as string[] | undefined ?? [])];
  const pickIds = Object.keys(opts.picks);
  if (!pickIds.length && !follow.length) throw new CodedError(400, t().export.invalidPicks, 'export-invalid-picks');
  const items: ExportItem[] = [];
  const itemOf = (format: string, n: number) => {
    const o = opts.versions.find((v) => v.n === n)?.outputs.find((x) => x.format === format);
    return o ? { format, n, file: o.file, width: o.width, height: o.height } : null;
  };
  for (const format of pickIds) {
    const n = opts.picks[format];
    if (!isVersionNumber(n)) throw new CodedError(400, t().export.invalidPicks, 'export-invalid-picks');
    if (Object.hasOwn(links, format)) {
      throw new CodedError(400, t().export.pickFollower({ format: label(format), primary: label(links[format]!) }), 'export-pick-follower');
    }
    const it = itemOf(format, n);
    if (!it) throw new CodedError(400, t().export.pickNoFile({ format: label(format), n }), 'export-pick-no-file');
    items.push(it);
  }
  for (const format of follow) {
    if (Object.hasOwn(opts.picks, format)) continue; // already refused above when it is a follower
    const primary = Object.hasOwn(links, format) ? links[format]! : null;
    if (primary === null) throw new CodedError(400, t().export.invalidPicks, 'export-invalid-picks');
    // The primary version exported: its pick in this export, else its stored ★ (manual pick or default rule).
    const primaryN = Object.hasOwn(opts.picks, primary) ? opts.picks[primary]! : starOf(opts.versions, primary, opts.storedPicks, links).version;
    let n: number | null;
    if (shown) {
      n = shown[format]!;
      if (!isVersionNumber(n)) throw new CodedError(400, t().export.invalidPicks, 'export-invalid-picks');
      if (!opts.versions.some((v) => v.n === n)) throw new CodedError(400, t().export.pickNoFile({ format: label(format), n }), 'export-pick-no-file');
    } else {
      // Decisions log 140: the latest version with the follower's own file and a primary identical to `primaryN`.
      n = followerVersion(opts.versions, format, primaryN, links);
    }
    const it = n === null ? null : itemOf(format, n);
    // No version holds the follower with this primary file (e.g. the primary's ★ predates the follower): nothing to copy.
    if (!it) throw new CodedError(409, t().export.filesMissing({ list: `${label(format)}${(n ?? primaryN) === null ? '' : ` v${n ?? primaryN}`}` }), 'export-file-missing');
    // A version the client showed must still carry the primary file exported now (the ★ may have changed since).
    if (primaryN === null) throw new CodedError(409, t().export.filesMissing({ list: `${label(format)} v${it.n}` }), 'export-file-missing');
    if (shown && !followerMatches(opts.versions, format, it.n, primaryN, links)) {
      throw new CodedError(400, t().export.followMismatch({ format: label(format), primary: label(primary), n: it.n, p: primaryN }), 'export-follow-mismatch');
    }
    // Named after the primary's version: "Reel v2" and "TikTok v2" are the same bytes.
    items.push(primaryN !== it.n ? { ...it, v: primaryN } : it);
  }
  return runExport(items, opts, 'refuse', Math.max(0, ...items.map((i) => i.n)));
}

/**
 * Phase 7 export of one version (the `/versions/:n/export` route, kept for older clients): every output of the version (or
 * the chosen `formats`), each with its own file, default name pattern unless one is given; unusable files are skipped.
 */
export async function exportVersion(opts: ExportCommon & { version: VersionEntry; formats?: string[] }): Promise<ExportResult> {
  const wanted = opts.formats === undefined ? null : new Set(opts.formats);
  if (wanted) {
    if (!wanted.size) throw new WorkspaceError(400, t().export.invalidFormats);
    const present = new Set(opts.version.outputs.map((o) => o.format));
    const missing = [...wanted].filter((f) => !present.has(f));
    if (missing.length) throw new WorkspaceError(400, t().export.formatsNotInVersion({ list: missing.join(', ') }));
  }
  const n = opts.version.n;
  const items = opts.version.outputs.filter((o) => !wanted || wanted.has(o.format))
    .map((o) => ({ format: o.format, n, file: o.file, width: o.width, height: o.height }));
  return runExport(items, opts, 'skip', n);
}

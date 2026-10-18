import { access, constants, lstat, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { DEFAULT_EXPORT_NAME_PATTERN, exportExtension, exportNameCollisions, exportNameVars, followerMatches, followerVersion, hasFormat, isDefaultProfile, localizedStem, profileApplies, profileFor, DEFAULT_EXPORT_QUALITY, recordedQuality, renderName, renderState, separateInstanceNames, starOf, type FormatPreset, type RenderProfile, type VersionEntry } from '@motion-studio/shared';
import { copyConfinedFile, probeConfinedFile } from '../brand/agent-guard.ts';
import { findPreset } from '../formats/format-catalog.ts';
import { CodedError, WorkspaceError } from '../workspace-store.ts';
import { t } from '../i18n.ts';

export interface ExportResult {
  destination: string; files: Array<{ from: string; to: string }>; skipped: string[];
  /** v2 formats rendered first because their ★ had no current render (Task 5b), by version. */
  rendered?: Array<{ version: number; formats: string[] }>;
}

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
export type CopyFn = (from: string, to: string, mode: number) => Promise<void>;

/** Copies without overwriting; null when the computed target would not be a direct child of `dir`. */
export async function copyUnique(copy: CopyFn, from: string, dir: string, stem: string, ext: string): Promise<string | null> {
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

/**
 * Copies an identity set into a new folder `<dest>/<name>` (`-2`, `-3`… when taken), keeping its sub-folders. A failure
 * removes the folder it created.
 */
async function copySet(copy: CopyFn, creativeDir: string, n: number, set: { dir: string; files: string[] }, dest: string, name: string): Promise<Array<{ from: string; to: string }>> {
  let folder = '';
  for (let i = 1; ; i++) {
    folder = join(dest, i === 1 ? name : `${name}-${i}`);
    if (dirname(folder) !== dest) throw new Error('bad set folder name');
    try { await mkdir(folder); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  const out: Array<{ from: string; to: string }> = [];
  try {
    for (const f of set.files) {
      const parts = f.split('/');
      if (parts.length > 1) await mkdir(join(folder, ...parts.slice(0, -1)), { recursive: true });
      const from = join(creativeDir, 'outputs', `v${n}`, set.dir, ...parts);
      const to = join(folder, ...parts);
      await copy(from, to, constants.COPYFILE_EXCL);
      out.push({ from, to });
    }
  } catch (e) {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  return out;
}

/**
 * Copies a file of the core's own (a render made for the export) without overwriting (review #2): the source is opened first,
 * then the target with `O_CREAT | O_EXCL | O_NOFOLLOW` (EEXIST when anything is there, a link included); only a failure after
 * that open says `targetCreated`, so a source-side failure never removes a file that was already at the destination.
 */
export const copyOwn: CopyFn = async (from, to) => {
  const src = await open(from, 'r');
  try {
    const dst = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      await pipeline(src.createReadStream(), dst.createWriteStream());
    } catch (e) {
      (e as { targetCreated?: boolean }).targetCreated = true;
      throw e;
    } finally {
      await dst.close().catch(() => {});
    }
  } finally {
    await src.close().catch(() => {});
  }
};

/** The export's text for a failed write (disk full, permission, quota, name too long, other). */
export function reasonOf(e: unknown): string {
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
export interface ExportItem { format: string; n: number; v?: number; file: string; width: number; height: number;
  /** Phase 15 (group export): the folder of the creative the file lives in, when it is not `ExportCommon.creativeDir` (a sister). */
  creativeDir?: string;
  /** The language of the file (Phase 12): the `{locale}` of its name; absent for a creative without extra languages. */
  locale?: string;
  /** A translated render (not the primary language's file). */
  localized?: boolean;
  /** A translated render's own problems (its checks and the browser's overflow measure, Phase 12 Rulings I and J). */
  problems?: string[];
  /**
   * An identity format's file set (Phase 14, spec §4.4): `dir` under `outputs/vN/`, `files` the paths inside it. Exported
   * as a folder named like the file (without its extension), next to it.
   */
  set?: { dir: string; files: string[] };
  /**
   * Decision 974: the file is a render made for this export at another quality or size, in the core's own temp folder (an
   * absolute path, never from a request), copied in place of `outputs/vN/<file>`; `file` then names its extension.
   */
  source?: string }

/** A set path the export accepts: one or two plain segments (`favicon.ico`, `mipmap-mdpi/ic_launcher.png`). */
const setPathOk = (p: string) => { const parts = p.split('/'); return parts.length <= 2 && parts.every(plainName); };

/** The export item fields of an output's identity set, if it has one. */
export const setOf = (o: { identitySet?: { dir: string; files: Array<{ path: string }> } }): Pick<ExportItem, 'set'> =>
  (o.identitySet ? { set: { dir: o.identitySet.dir, files: o.identitySet.files.map((f) => f.path) } } : {});

export interface ExportCommon {
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

/** A plain file name (no folder part, not `.`/`..`). */
export const plainName = (f: string) => Boolean(f) && f !== '.' && f !== '..' && f === basename(f) && !f.includes('\\') && !f.includes('/');

/**
 * Copies the files of `items` into `destination`, named with the pattern, never overwriting (`-2`, `-3`…).
 * `missing`: a file missing on disk, refused by the confined read (symlink, hard link, not regular, outside its version
 * folder) or with an unsafe name is `'refuse'`d (409 `export-file-missing`, nothing copied) or `'skip'`ped (listed in
 * `skipped`; 404 when nothing is left). Names that collide (case-insensitively) are refused before any copy.
 */
/**
 * The export destination rules, before anything is written: an absolute path (400 `export-invalid-destination`), never inside
 * `forbiddenRoot` (the workspace), links resolved. Returns the trimmed destination.
 */
export async function checkDestination(destination: string, forbiddenRoot?: string): Promise<string> {
  const dest = destination.trim();
  if (!isAbsolute(dest)) throw new CodedError(400, t().export.absoluteDestination, 'export-invalid-destination');
  if (forbiddenRoot) {
    const root = await resolveLoose(forbiddenRoot);
    if (isInside(await resolveLoose(dest), root)) throw new WorkspaceError(400, t().export.outsideWorkspace);
  }
  return dest;
}

/** Creates the (checked) destination folder when needed and makes sure it is a writable folder (400 otherwise). */
export async function ensureDestination(dest: string): Promise<void> {
  const info = await lstat(dest).catch(() => null);
  if (info && !info.isDirectory() && !info.isSymbolicLink()) throw new WorkspaceError(400, t().export.destinationIsFile);
  try { await mkdir(dest, { recursive: true }); await access(dest, constants.W_OK); }
  catch { throw new WorkspaceError(400, t().export.cannotWrite({ path: dest })); }
  if (!(await stat(dest)).isDirectory()) throw new WorkspaceError(400, t().export.destinationIsFile);
}

async function runExport(items: ExportItem[], opts: ExportCommon, missing: 'refuse' | 'skip', emptyN: number): Promise<ExportResult> {
  const dest = await checkDestination(opts.destination, opts.forbiddenRoot);
  const label = opts.label ?? ((f: string) => f);
  const skipped: string[] = [];
  const bad: ExportItem[] = [];
  const ok: ExportItem[] = [];
  for (const it of items) {
    const dir = it.creativeDir ?? opts.creativeDir;
    // A render made for this export is the core's own file (decision 974): only that it is still a regular file.
    let usable = it.source !== undefined ? plainName(it.file) && (await lstat(it.source).catch(() => null))?.isFile() === true
      : plainName(it.file) && (await probeConfinedFile(dir, `outputs/v${it.n}/${it.file}`)) === true;
    if (usable && it.set) {
      usable = plainName(it.set.dir) && it.set.files.every(setPathOk);
      for (const f of it.set.files) if (usable) usable = (await probeConfinedFile(dir, `outputs/v${it.n}/${it.set.dir}/${f}`)) === true;
    }
    if (usable) ok.push(it); else if (missing === 'skip') skipped.push(it.file); else bad.push(it);
  }
  if (bad.length) {
    throw new CodedError(409, t().export.filesMissing({ list: bad.map((b) => `${label(b.format)} v${b.n}`).join(', ') }), 'export-file-missing');
  }
  if (!ok.length) throw new WorkspaceError(404, t().export.nothingToExport({ n: emptyN }));
  const date = opts.now ?? new Date();
  const pattern = opts.pattern ?? DEFAULT_EXPORT_NAME_PATTERN;
  const named = ok.map((it) => {
    const r = renderName(pattern, exportNameVars({ title: opts.title, slug: opts.slug, format: it.format, preset: opts.presets ? findPreset(opts.presets, it.format) : undefined,
      size: { width: it.width, height: it.height }, version: it.v ?? it.n, date, ...(it.locale !== undefined ? { locale: it.locale } : {}) }));
    if (!r.ok) throw new CodedError(400, t().export.nameEmpty, 'export-name-empty');
    return { ...it, stem: r.name, ext: exportExtension(it.file) };
  });
  // Languages (Phase 12, final review I2): a pattern without `{locale}` names each translated file with its language, also
  // when it is exported alone, so a translation is never named like the original; the primary language's file keeps its name.
  for (const x of named) x.stem = localizedStem(pattern, x.stem, x.locale, x.localized === true);
  // Format instances (Phase 12, Ruling C): two files that would share a name (a pattern without `{format}`, or a preset id
  // equal to an instance's slug, `foo-2` and `foo@2`) keep them apart with the instance's slugged id on each k > 1 instance;
  // a bare instance's name never changes. What still collides is refused below, as before.
  const stems = separateInstanceNames(named);
  named.forEach((x, i) => { x.stem = stems[i]!; });
  const collisions = exportNameCollisions(named.map((x) => `${x.stem}${x.ext}`));
  if (collisions.length) throw new CodedError(400, t().export.nameCollision({ list: collisions.join(', ') }), 'export-name-collision');

  await ensureDestination(dest);
  const copyIn = (dir: string): CopyFn => opts.copy ?? ((from, to) => copyConfinedFile(dir, relative(dir, from).split(sep).join('/'), to));
  const files: ExportResult['files'] = [];
  for (const it of named) {
    const dir = it.creativeDir ?? opts.creativeDir;
    const copy = it.source !== undefined ? opts.copy ?? copyOwn : copyIn(dir);
    const from = it.source ?? join(dir, 'outputs', `v${it.n}`, it.file);
    try {
      const to = await copyUnique(copy, from, dest, it.stem, it.ext);
      if (to) files.push({ from, to }); else skipped.push(it.file);
      if (to && it.set) files.push(...await copySet(copy, dir, it.n, it.set, dest, basename(to).slice(0, basename(to).length - it.ext.length)));
    } catch (e) {
      const target = (e as { target?: string }).target;
      if (target) await rm(target, { force: true }).catch(() => undefined);
      throw new WorkspaceError(500, t().export.interrupted({ reason: reasonOf(e), count: files.length, path: dest }));
    }
  }
  if (!files.length) throw new WorkspaceError(404, t().export.nothingToExport({ n: emptyN }));
  return { destination: dest, files, skipped };
}

/**
 * The translated files of export `items` in `locales` (Phase 12, spec §3.5): for each item (a format in a version) and
 * language, its row's render when it is current (made from the row's overlay and the version's composition of that format,
 * still a usable file); `missing`: no translation at all; `stale`: a translation whose render is not current (to render first).
 */
export async function resolveLocalizedItems(creativeDir: string, versions: VersionEntry[], items: ExportItem[], locales: readonly string[],
  /** Whether the file still has its recorded content (`renderFileMatches`); absent: only that it is a usable file. */
  matches?: (n: number, file: string, sha256: string) => Promise<boolean>,
  /**
   * Ruling L: whether the voice and font files the row recorded are still the ones it recorded; when not, the render is not
   * current (rendering it again records the problem and fails, so the export says so). Absent: not checked.
   */
  assetsOk?: (n: number, row: NonNullable<VersionEntry['localizations']>[number]) => Promise<boolean>):
  Promise<{ items: ExportItem[]; missing: Array<{ format: string; n: number; locale: string }>; pending: Map<number, { formats: string[]; locales: string[] }> }> {
  const out: ExportItem[] = [];
  const missing: Array<{ format: string; n: number; locale: string }> = [];
  const pending = new Map<number, { formats: string[]; locales: string[] }>();
  for (const it of items) {
    const v = versions.find((x) => x.n === it.n);
    const comp = v?.compositions?.find((c) => c.format === it.format);
    for (const locale of locales) {
      const row = v?.localizations?.find((r) => r.locale === locale && r.instanceId === it.format);
      if (!v || !comp || !row) { missing.push({ format: it.format, n: it.n, locale }); continue; }
      const r = row.render;
      const current = r !== undefined && r.overlayHash === row.hash && r.fromComposition === comp.hash && plainName(r.file)
        && (await probeConfinedFile(creativeDir, `outputs/v${it.n}/${r.file}`)) === true && (!matches || await matches(it.n, r.file, r.sha256))
        && (!assetsOk || await assetsOk(it.n, row));
      if (!current) {
        const p = pending.get(it.n) ?? { formats: [], locales: [] };
        if (!p.formats.includes(it.format)) p.formats.push(it.format);
        if (!p.locales.includes(locale)) p.locales.push(locale);
        pending.set(it.n, p);
        continue;
      }
      out.push({ format: it.format, n: it.n, ...(it.v !== undefined ? { v: it.v } : {}), file: r.file, width: r.width, height: r.height, locale, localized: true,
        ...(r.problems?.length ? { problems: r.problems } : {}) });
    }
  }
  return { items: out, missing, pending };
}

const isVersionNumber = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

/**
 * Exports the ★ versions (spec §3.3): `picks` gives the version of each format; `follow` lists followers, exported with
 * their own file (`outputs/vN/<follower file>`, named after the follower). The primary version is the primary's pick in
 * this export, else its stored ★ (`storedPicks`, default rule); the follower's version is `followerVersion` of it (decisions
 * log 140: the latest version whose follower file is byte-identical to the primary's ★ file). As a record, `follow` carries the
 * follower version the client showed, which must satisfy that rule for the primary version. `{v}` in the name is the
 * primary's version number. Refused (coded errors, nothing copied):
 * - `export-invalid-picks` (400): no format, a version that is not a positive integer, a `follow` entry that is not a follower;
 * - `export-pick-follower` (400): a pick for a follower (its version is its primary's);
 * - `export-pick-no-file` (400): the version does not exist or has no file of the format;
 * - `export-follow-mismatch` (400): a follower version (record) whose follower file is not byte-identical to the primary file exported;
 * - `export-file-missing` (409): the file is missing on disk or refused by the confined read;
 * - `export-name-empty`, `export-name-collision` (400): the pattern gives an empty name, or the same name twice.
 */
export type PicksOptions = ExportCommon & { versions: VersionEntry[]; picks: Record<string, number>; follow?: string[] | Record<string, number>;
  links?: Record<string, string>; storedPicks?: Record<string, number> };

export async function exportPicks(opts: PicksOptions): Promise<ExportResult> {
  const items = resolveExportPicks(opts);
  return runExport(items, opts, 'refuse', Math.max(0, ...items.map((i) => i.n)));
}

/** Copies already resolved items (`resolveExportPicks`), with the strict rules of a ★ export. */
export function exportResolved(items: ExportItem[], opts: ExportCommon): Promise<ExportResult> {
  return runExport(items, opts, 'refuse', Math.max(0, ...items.map((i) => i.n)));
}

/**
 * The v2 items that need a render before export (Task 5b), by version: a composition whose render is not current
 * (`renderState` is not `rendered`) or whose rendered file is not usable on disk any more. Legacy items never do (their
 * media is the result).
 */
export async function pendingRenders(creativeDir: string, versions: VersionEntry[], items: ExportItem[], o: ExportProfileOptions = {}): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  for (const it of items) {
    const v = versions.find((x) => x.n === it.n);
    if (!v?.compositions?.some((c) => c.format === it.format)) continue;
    // Decision 974: an item at another quality or size is rendered for the export alone (`profiledRenders`).
    const preset = o.presets ? findPreset(o.presets, it.format) : undefined;
    if (o.profile && !isDefaultProfile(profileFor(preset, it.format, o.profile))) continue;
    // At the default profile a video render made before the quality choice (`standard`) is rendered again, at `high`.
    const stale = o.profile !== undefined && profileApplies(preset, it.format) && recordedQuality(v.outputs.find((x) => x.format === it.format)) !== DEFAULT_EXPORT_QUALITY;
    const fresh = !stale && renderState(v, it.format) === 'rendered' && it.file !== '' && plainName(it.file)
      && (await probeConfinedFile(creativeDir, `outputs/v${it.n}/${it.file}`)) === true;
    if (!fresh) out.set(it.n, [...(out.get(it.n) ?? []), it.format]);
  }
  return out;
}

/**
 * Whether the version's current render of `format` was made at `wanted` (its size, and the quality it recorded: `standard`
 * for a render made before the choice), so an export at that profile copies it as it is.
 */
export function recordedMatches(v: VersionEntry, format: string, wanted: RenderProfile): boolean {
  return wanted.short === undefined && renderState(v, format) === 'rendered' && recordedQuality(v.outputs.find((x) => x.format === format)) === wanted.quality;
}

/** The profile of an export (decision 974) and the presets that say which formats take it. Absent: the files as they are. */
export interface ExportProfileOptions { profile?: RenderProfile; presets?: FormatPreset[] }

/**
 * Decision 974: the v2 items an export at `profile` renders for itself (another quality or size than the version's own
 * render), by version. A legacy item (no composition) is copied as it is: there is nothing to render it from.
 */
export function profiledRenders(versions: VersionEntry[], items: ExportItem[], o: Required<ExportProfileOptions>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const it of items) {
    if (it.localized) continue;
    const v = versions.find((x) => x.n === it.n);
    if (!v?.compositions?.some((c) => c.format === it.format)) continue;
    const wanted = profileFor(findPreset(o.presets, it.format), it.format, o.profile);
    if (isDefaultProfile(wanted) || recordedMatches(v, it.format, wanted)) continue;
    out.set(it.n, [...(out.get(it.n) ?? []), it.format]);
  }
  return out;
}

/**
 * The items a ★ export copies (the rules and refusals below), without copying anything. A v2 format without a render yet
 * is an item with an empty `file` (`pendingRenders` lists it; the route renders it first).
 */
export function resolveExportPicks(opts: PicksOptions): ExportItem[] {
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
    const v = opts.versions.find((x) => x.n === n);
    const o = v?.outputs.find((x) => x.format === format);
    if (o) return { format, n, file: o.file, width: o.width, height: o.height, ...setOf(o) };
    // A v2 composition with no render yet: exported once rendered.
    return v && v.compositions?.some((c) => c.format === format) && hasFormat(v, format) ? { format, n, file: '', width: 0, height: 0 } : null;
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
      // Decisions log 140: the latest version whose follower file is byte-identical to the primary's file in `primaryN`.
      n = followerVersion(opts.versions, format, primaryN, links);
    }
    const it = n === null ? null : itemOf(format, n);
    // No version holds a copy of this primary file under the follower's name (e.g. the ★ predates the follower, or the
    // follower was rendered on its own): nothing to copy.
    if (!it) throw new CodedError(409, t().export.filesMissing({ list: `${label(format)}${(n ?? primaryN) === null ? '' : ` v${n ?? primaryN}`}` }), 'export-file-missing');
    // A version the client showed must still hold a copy of the primary file exported now (the ★ may have changed since).
    if (primaryN === null) throw new CodedError(409, t().export.filesMissing({ list: `${label(format)} v${it.n}` }), 'export-file-missing');
    if (shown && !followerMatches(opts.versions, format, it.n, primaryN, links)) {
      throw new CodedError(400, t().export.followMismatch({ format: label(format), primary: label(primary), n: it.n, p: primaryN }), 'export-follow-mismatch');
    }
    // Named after the primary's version: "Reel v2" and "TikTok v2" are the same bytes.
    items.push(primaryN !== it.n ? { ...it, v: primaryN } : it);
  }
  return items;
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
    .map((o) => ({ format: o.format, n, file: o.file, width: o.width, height: o.height, ...setOf(o) }));
  return runExport(items, opts, 'skip', n);
}

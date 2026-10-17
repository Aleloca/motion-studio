import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  assetKindOf, COMPOSITION_MAX_BYTES, isCompositionPath, messages, relativeFileSchema,
  type Composition, type EditorCompositionView, type EditorFontOption, type FormatPreset, type Locale, type StagedAsset, type VersionEntry,
} from '@motion-studio/shared';
import { hashConfinedFile, withConfinedFile } from '../brand/agent-guard.ts';
import { checkVectorSvg, MAX_VECTOR_SVG_BYTES } from '../identity/svg-check.ts';
import { BrandStore } from '../brand/brand-store.ts';
import { loadComposition } from '../compositions/composition-files.ts';
import { EDITOR_STAGING, stagingIdOf } from '../compositions/composition-server.ts';
import { noteCoreChange } from '../core-changes.ts';
import { noteCoreTemp } from '../core-temps.ts';
import { findPreset } from '../formats/format-catalog.ts';
import { LibraryStore } from '../library/library-store.ts';
import { sanitizeFileName } from '../library/upload.ts';
import { NoMediaTools, type MediaTools } from '../media/media-tools.ts';
import { probeFontWeights } from '../media/font-probe.ts';
import { svgSize } from '../media/svg-size.ts';
import { CodedError } from '../workspace-store.ts';
import { isRealDirChain, realDirChain } from './core-files.ts';

/**
 * The editor's data in the core (Phase 10b, Task 3): the composition view a draft starts from, and the **staging overlay**.
 *
 * A draft may use files the version does not have: a library asset (an image, SVG, video or audio replacement, also one
 * just uploaded through the library's own upload route) or a brand font file. The core copies such a file into a staging
 * folder of the live preview session the editor shows, `<project>/.studio/cache/editor-staging/<creative>/<id>/assets/lib/
 * <sha8>-<name>` (`id`: the first 128 bits of the session token's sha256, so the folder name never reveals the token), and
 * the composition server serves it under that session's token when the composition folder has no such file (the base
 * always wins). At save (Task 4) the files the draft uses are copied into the new version.
 *
 * - **Sources:** only a file registered in the project library (`assets/assets.json`) or the file of a brand kit font, both
 *   under the project's `assets/` folder; read with the confined-read checks (`withConfinedFile`, exact real path: no link
 *   anywhere, a regular single-linked file), never a raw client path. Every folder written is a real directory
 *   (`realDirChain`); the copy goes to a fresh temp file (O_EXCL, O_NOFOLLOW), hashed while copied, then renamed.
 * - **Names:** `<first 8 hex of the copy's sha256>-<sanitised name>`. The same name with other content (in the composition
 *   folder, or already staged) is a collision: the next free name (`-2`, `-3`, …) is taken. The same content reuses its name.
 * - **Probe:** images and videos through `MediaTools.probe`, audio through `MediaTools.probeAudio` (both the single
 *   ffprobe helper), SVG through `svg-size`, fonts by their signature and then their weights (`font-probe.ts`, bounded). A file that is not what its name says is refused.
 * - **Limits:** 500 MB per file (as a composition folder), 20 files per session.
 * - **Edited SVGs** (SVG inner editor, `stageSvgEdit`): the text the editor made from a clip's SVG, checked with
 *   `checkVectorSvg` (refused: 400 `svg-edit-refused`, the reasons as `problems`), written under
 *   `assets/lib/<base stem>-e<sha8>.svg`, so the composition server and the save treat it as any staged file. Their own
 *   limit, {@link STAGING_MAX_SVG_EDITS} per session: every colour change of a draft makes one.
 * - **Lifetime:** removed when the session is revoked, evicted or expires (`PreviewService`), and by the cache sweep
 *   (`sweepEditorStaging`) when older than 24 h.
 */

/** Largest staged file (the composition folder's limit). */
export const STAGING_MAX_FILE_BYTES = COMPOSITION_MAX_BYTES;
/** Most files staged for one preview session. */
export const STAGING_MAX_FILES = 20;
/** The sweep removes staging folders older than this (and never one a live session uses). */
export const STAGING_MAX_AGE_MS = 24 * 3600 * 1000;
/** Most edited SVGs staged for one preview session (each at most 512 KB: 100 MB at worst). */
export const STAGING_MAX_SVG_EDITS = 200;
/** Collision candidates tried for one name. */
const MAX_NAME_TRIES = 50;

export { stagingIdOf };
/** `<project>/.studio/cache/editor-staging/<creative>/<id>`. */
export const stagingDirOf = (projectDir: string, creativeSlug: string, token: string): string =>
  join(projectDir, ...EDITOR_STAGING, creativeSlug, stagingIdOf(token));

export type StageSource = { kind: 'library'; file: string } | { kind: 'brandFont'; id: string };
/** An SVG edited in the editor: the clip, the `src` it starts from (a file of the base or staged), the whole new text. */
export type SvgEditSource = { kind: 'svgEdit'; clipId: string; baseSrc: string; content: string };
type StagedKind = StagedAsset['kind'];
const STAGEABLE = new Set<string>(['image', 'svg', 'video', 'audio', 'font']);
const FONT_EXT = new Set(['.ttf', '.otf', '.woff', '.woff2']);

const err = (locale: Locale) => messages(locale).editor;

/** The file to copy: the folder it is confined to, its path there, how it is named to the user, and its kind. */
async function resolveSource(projectDir: string, from: StageSource, locale: Locale): Promise<{ base: string; rel: string; label: string; kind: StagedKind }> {
  const e = err(locale);
  const assetsDir = join(projectDir, 'assets');
  if (from.kind === 'library') {
    const file = from.file;
    // A path that is not a plain relative one (`..`, absolute, backslash) is never looked up.
    if (!relativeFileSchema.safeParse(file).success) throw new CodedError(400, e.stageNotRegistered({ file: String(file).slice(0, 300) }), 'editor-not-registered');
    const registered = (await new LibraryStore(projectDir, NoMediaTools).listAssets().catch(() => [])).some((a) => a.file === file);
    if (!registered) throw new CodedError(400, e.stageNotRegistered({ file }), 'editor-not-registered');
    const kind = assetKindOf(file);
    if (!STAGEABLE.has(kind)) throw new CodedError(400, e.stageUnsupported({ file }), 'editor-unsupported');
    return { base: assetsDir, rel: file, label: file, kind: kind as StagedKind };
  }
  const kit = await new BrandStore(projectDir).readKit().catch(() => null);
  const font = kit?.fonts.find((f) => f.id === from.id);
  if (!font) throw new CodedError(404, e.stageUnknownBrandFont, 'editor-unknown-brand-font');
  if (!font.file) throw new CodedError(400, e.stageBrandFontNoFile({ family: font.family }), 'editor-brand-font-no-file');
  // A brand font file is a project file under assets/ (the only place the UI and the compositions read fonts from).
  const rel = font.file.startsWith('assets/') ? font.file.slice('assets/'.length) : null;
  if (!rel || !relativeFileSchema.safeParse(rel).success) throw new CodedError(400, e.stageUnreadable({ file: font.file }), 'editor-unreadable');
  if (!FONT_EXT.has(extname(rel).toLowerCase())) throw new CodedError(400, e.stageUnsupported({ file: font.file }), 'editor-unsupported');
  return { base: assetsDir, rel, label: font.file, kind: 'font' };
}

/**
 * Copies the confined source into a fresh temp file of `dir`, hashing it on the way. The copy never exceeds the size the
 * opened file had (a file that grows meanwhile is refused, never cut), nor the staging limit.
 */
async function copyToTemp(base: string, rel: string, dir: string): Promise<{ temp: string; sha256: string; size: number } | { refused: 'missing' | 'too-large' | 'unsafe' }> {
  const temp = join(dir, `.stage.${randomBytes(6).toString('hex')}.tmp`);
  noteCoreTemp(temp);
  const r = await withConfinedFile(base, rel, true, async (fh: FileHandle, info: Stats) => {
    if (info.size > STAGING_MAX_FILE_BYTES) return { skipped: 'too-large' as const };
    const out = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
    const hash = createHash('sha256');
    let total = 0;
    try {
      const buf = Buffer.alloc(1024 * 1024);
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > info.size) return { skipped: 'too-large' as const };
        hash.update(buf.subarray(0, bytesRead));
        await out.write(buf, 0, bytesRead);
      }
    } finally {
      await out.close().catch(() => {});
    }
    return { sha256: hash.digest('hex'), size: total };
  }).catch(async (e: unknown) => { await rm(temp, { force: true }).catch(() => {}); throw e; });
  if (r === null) return { refused: 'missing' };
  if ('skipped' in r) {
    await rm(temp, { force: true }).catch(() => {});
    return { refused: r.skipped === 'too-large' ? 'too-large' : 'unsafe' };
  }
  return { temp, ...r };
}

/** `<sha8>-<name>`, then `<sha8>-<stem>-2.<ext>`, …: the i-th candidate (1-based). */
function candidate(name: string, i: number): string {
  if (i === 1) return name;
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)}-${i}${ext}`;
}

/** Whether `rel` under `base` holds exactly `sha256`: 'same', 'missing', or 'other' (other content, or refused). */
async function sameContent(base: string, rel: string, sha256: string): Promise<'same' | 'missing' | 'other'> {
  const exists = await lstat(join(base, ...rel.split('/'))).then(() => true, () => false);
  if (!exists) return 'missing';
  const h = await hashConfinedFile(base, rel).catch(() => null);
  return h && !('skipped' in h) && h.sha256 === sha256 ? 'same' : 'other';
}

/** A font file by its first four bytes: TrueType, OpenType (CFF), WOFF or WOFF2. */
async function isFontFile(file: string): Promise<boolean> {
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!fh) return false;
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    const tag = buf.toString('latin1');
    return tag === 'wOF2' || tag === 'wOFF' || tag === 'OTTO' || tag === 'true' || buf.readUInt32BE(0) === 0x00010000;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** The probe data of a staged file; null when it is not what its kind says. */
async function probeStaged(file: string, kind: StagedKind, media: MediaTools): Promise<Pick<StagedAsset, 'width' | 'height' | 'durationSec' | 'fontWeights'> | null> {
  switch (kind) {
    case 'svg': {
      const s = await svgSize(file);
      return s ? { width: s.width, height: s.height } : null;
    }
    case 'font': {
      if (!(await isFontFile(file))) return null;
      const weights = await probeFontWeights(file);
      return weights ? { fontWeights: weights } : {};
    }
    case 'audio': {
      if (!media.available || !media.probeAudio) return { durationSec: null };
      const a = await media.probeAudio(file);
      return a ? { durationSec: a.durationSec } : null;
    }
    default: {
      if (!media.available) return kind === 'video' ? { durationSec: null } : {};
      const p = await media.probe(file);
      if (!p) return null;
      return { width: p.width, height: p.height, ...(kind === 'video' ? { durationSec: p.durationSec } : {}) };
    }
  }
}

/**
 * Gives the temp copy `temp` (content `sha256`) its staged name in `libDir`: `name`, then `-2`, `-3`, … while the name holds
 * other content (in the composition folder, which wins when serving, or already staged). The same content reuses its
 * name. A new file is refused (409 `editor-too-many`) when `max` staged files that `counts` are there already. The temp
 * file is always gone afterwards.
 */
async function placeTemp(o: {
  compDir: string; libDir: string; temp: string; sha256: string; name: string; staged: ReadonlyMap<string, StagedAsset>;
  max: number; counts: (a: StagedAsset) => boolean; unplaced: () => Error; locale: Locale;
}): Promise<{ path: string; created: boolean }> {
  const e = err(o.locale);
  const full = (rel: string) => !o.staged.has(rel) && [...o.staged.values()].filter(o.counts).length >= o.max;
  let created = false;
  let path: string | null = null;
  try {
    for (let i = 1; i <= MAX_NAME_TRIES && path === null; i++) {
      const cand = candidate(o.name, i);
      const rel = `assets/lib/${cand}`;
      if (!isCompositionPath(rel)) break;
      // The composition folder wins when serving: a file of its own under this name must be this very content.
      if ((await sameContent(o.compDir, rel, o.sha256)) === 'other') continue;
      const here = await sameContent(o.libDir, cand, o.sha256);
      if (here === 'other') continue;
      if (here === 'missing') {
        if (full(rel)) throw new CodedError(409, e.stageTooMany({ max: o.max }), 'editor-too-many');
        await rename(o.temp, join(o.libDir, cand));
        await noteCoreChange(o.libDir);
        created = true;
      }
      path = rel;
    }
    if (path === null) throw o.unplaced();
    if (full(path)) throw new CodedError(409, e.stageTooMany({ max: o.max }), 'editor-too-many');
  } finally {
    await rm(o.temp, { force: true }).catch(() => {});
  }
  return { path, created };
}

export interface StageFileOptions {
  projectDir: string;
  creativeSlug: string;
  token: string;
  /** The session's composition folder (the base): a staged name must not shadow one of its files with other content. */
  compDir: string;
  from: StageSource;
  media: MediaTools;
  locale: Locale;
  /** The session's staged files so far, by path (the count limit; a file staged again is not counted twice). */
  staged: ReadonlyMap<string, StagedAsset>;
}

/**
 * Copies one source into the session's staging folder (see the module comment) and probes it. Returns the staged asset
 * and the staging folder (`<…>/<id>`, a real directory). Throws a translated `CodedError` when refused. The caller holds
 * the session's lock (one staging at a time per session).
 */
export async function stageFile(o: StageFileOptions): Promise<{ asset: StagedAsset; root: string; created: boolean }> {
  const e = err(o.locale);
  const src = await resolveSource(o.projectDir, o.from, o.locale);
  const id = stagingIdOf(o.token);
  const libDir = await realDirChain(o.projectDir, [...EDITOR_STAGING, o.creativeSlug, id, 'assets', 'lib']);
  if (!libDir) throw new Error('editor staging: the staging folder is not a real folder of the project');
  const root = dirname(dirname(libDir));
  const copy = await copyToTemp(src.base, src.rel, libDir);
  if ('refused' in copy) {
    if (copy.refused === 'too-large') throw new CodedError(413, e.stageTooLarge({ file: src.label, maxMB: Math.round(STAGING_MAX_FILE_BYTES / (1024 * 1024)) }), 'editor-too-large');
    throw new CodedError(400, e.stageUnreadable({ file: src.label }), 'editor-unreadable');
  }
  const name = `${copy.sha256.slice(0, 8)}-${sanitizeFileName(basename(src.rel))}`;
  const { path, created } = await placeTemp({
    compDir: o.compDir, libDir, temp: copy.temp, sha256: copy.sha256, name, staged: o.staged, max: STAGING_MAX_FILES,
    counts: (a) => a.svgEdit !== true, unplaced: () => new CodedError(400, e.stageUnreadable({ file: src.label }), 'editor-unreadable'), locale: o.locale,
  });
  const file = join(libDir, path.slice('assets/lib/'.length));
  const probed = await probeStaged(file, src.kind, o.media);
  if (!probed) {
    if (created && !o.staged.has(path)) { await rm(file, { force: true }).catch(() => {}); await noteCoreChange(libDir); }
    throw new CodedError(400, e.stageNotMedia({ file: src.label }), 'editor-not-media');
  }
  return { asset: { path, size: copy.size, kind: src.kind, ...probed }, root, created };
}

export interface StageSvgEditOptions extends Omit<StageFileOptions, 'from' | 'media'> {
  from: SvgEditSource;
}

/** `<stem>` of a staged edit's name: the base's file name without `.svg` and without an earlier edit's `-e<sha8>`. */
const editStem = (baseSrc: string) => basename(baseSrc).replace(/\.svg$/i, '').replace(/-e[0-9a-f]{8}$/, '');

/**
 * Stages an SVG edited in the editor (see the module comment) for the session: checked with `checkVectorSvg` first (400
 * `svg-edit-refused`, the reasons as `problems`); `baseSrc` must be an SVG file of the base composition folder or one
 * already staged in this session (400 `svg-edit-bad-base`). Returns the staged asset (`svgEdit: true`), the check's
 * warnings and the staging folder. The caller holds the session's lock.
 */
export async function stageSvgEdit(o: StageSvgEditOptions): Promise<{ asset: StagedAsset; warnings: string[]; root: string; created: boolean }> {
  const m = messages(o.locale);
  const { baseSrc, content } = o.from;
  const check = checkVectorSvg(content);
  if (!check.ok) {
    const refused = new CodedError(400, m.composition.svgRefusedSummary({ file: basename(baseSrc), count: check.reasons.length }), 'svg-edit-refused');
    refused.problems = check.reasons;
    throw refused;
  }
  const badBase = () => new CodedError(400, m.editor.stageSvgBadBase({ file: baseSrc.slice(0, 300) }), 'svg-edit-bad-base');
  if (!/\.svg$/i.test(baseSrc) || !baseSrc.startsWith('assets/') || !isCompositionPath(baseSrc)) throw badBase();
  if (!o.staged.has(baseSrc)) {
    const st = await lstat(join(o.compDir, ...baseSrc.split('/'))).catch(() => null);
    if (!st?.isFile()) throw badBase();
  }
  const id = stagingIdOf(o.token);
  const libDir = await realDirChain(o.projectDir, [...EDITOR_STAGING, o.creativeSlug, id, 'assets', 'lib']);
  if (!libDir) throw new Error('editor staging: the staging folder is not a real folder of the project');
  const root = dirname(dirname(libDir));
  const bytes = Buffer.from(content, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const temp = join(libDir, `.stage.${randomBytes(6).toString('hex')}.tmp`);
  noteCoreTemp(temp);
  const fh = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
  try {
    await fh.writeFile(bytes);
  } catch (e) {
    await fh.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw e;
  }
  await fh.close();
  const name = `${sanitizeFileName(editStem(baseSrc)).slice(0, 80)}-e${sha256.slice(0, 8)}.svg`;
  const { path, created } = await placeTemp({
    compDir: o.compDir, libDir, temp, sha256, name, staged: o.staged, max: STAGING_MAX_SVG_EDITS,
    counts: (a) => a.svgEdit === true, unplaced: badBase, locale: o.locale,
  });
  const size = await svgSize(join(libDir, path.slice('assets/lib/'.length))).catch(() => null);
  return {
    asset: { path, size: bytes.length, kind: 'svg', ...(size ? { width: size.width, height: size.height } : {}), svgEdit: true },
    warnings: check.warnings, root, created,
  };
}

/**
 * Reads the SVG `path` a clip of the session shows, for the editor to edit (SVG inner editor): a file of the composition
 * folder (which wins, as when serving), else one staged in this session. Read with the confined-read checks and checked
 * with `checkVectorSvg`, so the editor only ever gets, and draws inline, text the check accepted: 400 `svg-edit-refused`
 * with the reasons (the text itself is not sent), 400 `svg-edit-bad-base` when `path` is not such an SVG.
 */
export async function readSvgForEdit(o: {
  compDir: string; stagingRoot: string | null; staged: ReadonlyMap<string, StagedAsset>; path: string; locale: Locale;
}): Promise<{ path: string; content: string; warnings: string[] }> {
  const m = messages(o.locale);
  const badBase = () => new CodedError(400, m.editor.stageSvgBadBase({ file: o.path.slice(0, 300) }), 'svg-edit-bad-base');
  if (!/\.svg$/i.test(o.path) || !o.path.startsWith('assets/') || !isCompositionPath(o.path)) throw badBase();
  const readFrom = (base: string) => withConfinedFile(base, o.path, true, async (fh: FileHandle, info: Stats) => {
    if (info.size > MAX_VECTOR_SVG_BYTES) return { tooLarge: true as const };
    return { text: (await fh.readFile()).toString('utf8') };
  });
  let got = await readFrom(o.compDir);
  if (got === null && o.stagingRoot && o.staged.has(o.path)) got = await readFrom(o.stagingRoot);
  if (got === null || 'skipped' in got) throw badBase();
  const check = 'tooLarge' in got ? { ok: false as const, reasons: [`the SVG is over ${MAX_VECTOR_SVG_BYTES / 1024} KB`] } : checkVectorSvg(got.text);
  if (!check.ok || 'tooLarge' in got) {
    const reasons = check.ok ? [] : check.reasons;
    const refused = new CodedError(400, m.composition.svgRefusedSummary({ file: basename(o.path), count: reasons.length }), 'svg-edit-refused');
    refused.problems = reasons;
    throw refused;
  }
  return { path: o.path, content: got.text, warnings: check.warnings };
}

/** Removes a session's staging folder (a real folder at exactly that place; a link there is removed as an entry only). */
export async function removeStaging(root: string): Promise<void> {
  const st = await lstat(root).catch(() => null);
  if (!st) return;
  if (st.isDirectory() && (await realpath(root).catch(() => null)) !== join(await realpath(dirname(root)).catch(() => ''), basename(root))) return;
  await rm(root, { recursive: true, force: true }).catch(() => {});
  await noteCoreChange(dirname(root)).catch(() => {});
}

// ---------- the composition view ----------

const weightOf = (w: number | 'normal' | 'bold' | undefined): number => (w === 'bold' ? 700 : typeof w === 'number' ? w : 400);

/** The fonts the inspector offers: the composition's families (their declared weights), then brand fonts not declared. */
export function editorFonts(c: Pick<Composition, 'fonts'>, brand: ReadonlyArray<{ id: string; family: string; weights: number[] }>): EditorFontOption[] {
  const byFamily = new Map<string, Set<number>>();
  for (const f of c.fonts) {
    const set = byFamily.get(f.family) ?? new Set<number>();
    set.add(weightOf(f.weight));
    byFamily.set(f.family, set);
  }
  const out: EditorFontOption[] = [...byFamily].map(([family, w]) => ({ family, weights: [...w].sort((a, b) => a - b), source: 'composition', staged: false }));
  const declared = new Set([...byFamily.keys()].map((f) => f.toLowerCase()));
  for (const b of brand) {
    if (declared.has(b.family.toLowerCase())) continue;
    declared.add(b.family.toLowerCase());
    out.push({ family: b.family, weights: [...b.weights].sort((a, c2) => a - c2), source: 'brand', brandFontId: b.id, staged: false });
  }
  return out;
}

/**
 * The view of `format` in a saved v2 version (see `EditorCompositionView`): the primary's composition, re-hashed and
 * validated (it must still be the recorded one), its files, and the fonts. 404 for a version without compositions (a legacy
 * one) or without that format; 409 when the composition is no longer the recorded, valid one.
 */
export async function editorCompositionView(o: { projectDir: string; creativeDir: string; version: VersionEntry; format: string; presets: FormatPreset[]; locale: Locale }): Promise<EditorCompositionView> {
  const e = messages(o.locale).errors;
  const n = o.version.n;
  const entry = o.version.compositions?.find((c) => c.format === o.format);
  if (!entry) throw new CodedError(404, e.compositionNotFound({ format: o.format, n }), 'composition-not-found');
  const folder = entry.dir.slice('compositions/'.length);
  const unusable = () => new CodedError(409, e.compositionUnusable({ format: o.format, n }), 'composition-unusable');
  const preset = findPreset(o.presets, folder);
  if (!preset || (await isRealDirChain(o.creativeDir, ['outputs', `v${n}`, 'compositions', folder])) !== 'ok') throw unusable();
  const loaded = await loadComposition(join(o.creativeDir, 'outputs', `v${n}`, 'compositions', folder), preset);
  if (!loaded.ok || loaded.hash !== entry.hash) throw unusable();
  const brand = (await new BrandStore(o.projectDir).readKit().catch(() => null))?.fonts ?? [];
  return {
    n, format: o.format, primaryFormat: folder, hash: entry.hash, composition: loaded.composition,
    files: loaded.folder.files.map((f) => ({ path: f.path, size: f.size })),
    fonts: editorFonts(loaded.composition, brand),
  };
}

import { createHash, randomBytes } from 'node:crypto';
import { lstat, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyLocalization, localizableEntries, LOCALIZATION_SCHEMA_ID, LocalizationMismatch, localizationSchema, messages,
  type Composition, type FormatPreset, type Locale, type LocaleTag, type Localization, type LocalizationIssue, type LocalizationRow, type VersionComposition, type VersionEntry,
} from '@motion-studio/shared';
import { readConfinedBytes, readConfinedFile } from '../brand/agent-guard.ts';
import { LibraryStore } from '../library/library-store.ts';
import { NoMediaTools, type MediaTools } from '../media/media-tools.ts';
import { loadComposition, type CompositionFolder } from '../compositions/composition-files.ts';
import { noteCoreTemp } from '../core-temps.ts';
import { findPreset } from '../formats/format-catalog.ts';
import { isRealDirChain, realDirChain } from '../creatives/core-files.ts';
import { noteCoreOutputWrite } from '../creatives/carry-over.ts';
import type { CreativeStore } from '../creatives/creative-store.ts';
import { ensureFallbackFont, FallbackFontUnavailable, type ProjectRef } from './fallback-fonts.ts';
import { checkLocalizedComposition, clipLabel, fitTexts, FITS, measuredByBrowser, staleIds, voiceFileOk } from './validate.ts';

/**
 * The localization store (Phase 12, spec §3.1): one overlay per language and instance,
 * `outputs/vN/locales/<locale>/<instanceId>.json` (`motion-studio/localization@1`), written by the core only (the PUT route
 * and, Task 4, `submit_localization`), atomically (a fresh temp file, then a rename) and only while the caller holds the
 * creative's lock (`CreativeTurnService.runLocked`). Its row in `VersionEntry.localizations` (hash of the file, origin,
 * stale ids, voice choice, problems) is written in the same lock. The locale and instance segments reach a path only after
 * `checkedLocale` / `checkedInstance` (or, for the core's own carry-over, from a parsed row).
 */

/** Largest overlay file read (texts are capped by the schema; this bounds the read itself). */
const MAX_OVERLAY_BYTES = 4 * 1024 * 1024;

export const overlayRel = (n: number, locale: LocaleTag, instanceId: string) => `outputs/v${n}/locales/${locale}/${instanceId}.json`;

/** One instance's composition in a version, re-hashed and valid (still the recorded one). */
export interface InstanceComposition {
  entry: VersionComposition;
  /** The composition folder (a follower's is its primary's). */
  compDir: string;
  /** The preset of the folder (the primary's for a follower): what the composition was validated against. */
  preset: FormatPreset;
  composition: Composition;
  folder: CompositionFolder;
}

/** The composition `instanceId` shows in `version`; null when it has none or it is no longer the recorded, valid one. */
export async function instanceComposition(creativeDir: string, version: VersionEntry, instanceId: string, presets: readonly FormatPreset[]): Promise<InstanceComposition | null> {
  const entry = version.compositions?.find((c) => c.format === instanceId);
  if (!entry) return null;
  const folder = entry.dir.slice('compositions/'.length);
  const preset = findPreset(presets, folder);
  if (!preset || (await isRealDirChain(creativeDir, ['outputs', `v${version.n}`, 'compositions', folder])) !== 'ok') return null;
  const compDir = join(creativeDir, 'outputs', `v${version.n}`, 'compositions', folder);
  const loaded = await loadComposition(compDir, preset);
  if (!loaded.ok || loaded.hash !== entry.hash) return null;
  return { entry, compDir, preset, composition: loaded.composition, folder: loaded.folder };
}

/** The overlay of `locale` and `instanceId` in version `n` and the sha256 of its file; null when missing or unreadable. */
export async function readOverlay(creativeDir: string, n: number, locale: LocaleTag, instanceId: string): Promise<{ overlay: Localization; hash: string } | null> {
  const r = await readConfinedFile(creativeDir, overlayRel(n, locale, instanceId), MAX_OVERLAY_BYTES).catch(() => null);
  if (!r || !('text' in r)) return null;
  let raw: unknown;
  try { raw = JSON.parse(r.text); } catch { return null; }
  const parsed = localizationSchema.safeParse(raw);
  if (!parsed.success || parsed.data.locale !== locale || parsed.data.instanceId !== instanceId) return null;
  return { overlay: parsed.data, hash: createHash('sha256').update(r.text).digest('hex') };
}

/**
 * Where an overlay's voice files may live (Phase 12, Task 4): the instance's composition folder, then the project (the
 * voices a localize turn generates are project assets, `assets/audio/…`). A path the folder has wins, everywhere: the checks,
 * the preview and the localized render's private copy.
 */
export const voiceRootsOf = (ic: Pick<InstanceComposition, 'compDir'>, projectDir: string): string[] => [ic.compDir, projectDir];

/**
 * The asset hashes a row keeps (Ruling L), for the voice and font files its overlay uses: a voice the core just wrote
 * (`fresh`, hashed from the bytes it wrote), else the hash the row already had (`old`, kept verbatim through carry-over and
 * edits, never recomputed from a folder an agent may write). Nothing else is hashed here: a fallback font is hashed only when
 * the core attaches it (`attachedFontHashes`). Undefined when empty.
 */
export function rowAssetHashes(o: { overlay: Localization; old?: Record<string, string>; fresh?: Record<string, string> }): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const p of [...o.overlay.fonts.flatMap((f) => f.files), ...Object.values(o.overlay.voices).map((v) => v.src)]) {
    const sha = o.fresh?.[p] ?? o.old?.[p];
    if (sha) out[p] = sha;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The hashes of the fallback-font files the core attaches now (`resolveFallbackFont`: files of the project it installed or
 * reused), for the paths the row has no hash for yet (`old`): a recorded hash is never replaced by today's file.
 */
export async function attachedFontHashes(projectDir: string, fallback: FallbackResult | undefined, old?: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!fallback || 'unavailable' in fallback) return out;
  for (const p of fallback.files) {
    if (old?.[p]) continue;
    const h = await confinedHash(projectDir, p);
    if (h) out[p] = h.sha;
  }
  return out;
}

/** Whether `problem` is an `assetChanged` problem (in either language) of one of `paths`. */
export function isAssetChangedProblem(problem: string, paths: Iterable<string>): boolean {
  for (const file of paths) for (const l of ['en', 'it'] as const) if (problem === messages(l).variants.assetChanged({ file })) return true;
  return false;
}

/**
 * The recorded asset files of `row` whose content is no longer the recorded one (Ruling L), as they would be used: the file
 * at `<root>/<path>` for each root in order (a render's private copy, or the composition folder then the project), missing
 * counted as changed. Only the paths `used` (the localized composition's files) are checked.
 */
export async function changedAssets(roots: readonly string[], row: Pick<LocalizationRow, 'assetHashes'>, used?: ReadonlySet<string>): Promise<string[]> {
  const out: string[] = [];
  for (const [p, sha] of Object.entries(row.assetHashes ?? {})) {
    if (used && !used.has(p)) continue;
    let found: { sha: string } | null = null;
    for (const root of roots) {
      if (!(await lstat(join(root, ...p.split('/'))).catch(() => null))?.isFile()) continue;
      found = await confinedHash(root, p);
      break;
    }
    if (found?.sha !== sha) out.push(p);
  }
  return out;
}

/** The project files a localized composition takes from its overlay: font files, and voices when they are applied. */
export function overlayAssetPaths(overlay: Localization, row: Pick<LocalizationRow, 'voice' | 'stale'>): Set<string> {
  const out = new Set(overlay.fonts.flatMap((f) => f.files));
  if (row.voice === 'translated') for (const [id, v] of Object.entries(overlay.voices)) if (!row.stale.includes(id)) out.add(v.src);
  return out;
}

/** Largest voice file hashed to find its tts description. */
const MAX_VOICE_HASH_BYTES = 50 * 1024 * 1024;

async function confinedHash(dir: string, rel: string): Promise<{ sha: string; size: number } | null> {
  const r = await readConfinedBytes(dir, rel, MAX_VOICE_HASH_BYTES).catch(() => null);
  if (!r || !('bytes' in r)) return null;
  return { sha: createHash('sha256').update(r.bytes).digest('hex'), size: r.bytes.length };
}

/**
 * The known script of each voice clip of `ic` (spec §3.1): its `script`, else the description of the project asset generated
 * by `tts` with the very same bytes (a generated audio asset of the library: same size and sha256). Clips with neither are
 * absent: they cannot be translated.
 */
export async function knownVoiceScripts(ic: Pick<InstanceComposition, 'compDir' | 'composition'>, projectDir: string, media: MediaTools = NoMediaTools): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const voices = localizableEntries(ic.composition).voices;
  const missing: Array<{ clipId: string; src: string }> = [];
  for (const v of voices) {
    if (v.script !== null) { out.set(v.clipId, v.script); continue; }
    const clip = ic.composition.tracks.flatMap((t) => t.clips).find((c) => c.id === v.clipId);
    if (clip?.type === 'audio') missing.push({ clipId: v.clipId, src: clip.src });
  }
  if (missing.length === 0) return out;
  const assets = (await new LibraryStore(projectDir, media).listAssets().catch(() => []))
    .filter((a) => a.kind === 'audio' && a.origin === 'generated' && a.description.trim() !== '');
  if (assets.length === 0) return out;
  const hashes = new Map<string, { sha: string; size: number } | null>();
  for (const m of missing) {
    const own = await confinedHash(ic.compDir, m.src);
    if (!own) continue;
    for (const a of assets) {
      if (a.bytes !== undefined && a.bytes !== own.size) continue;
      if (!hashes.has(a.file)) hashes.set(a.file, await confinedHash(projectDir, `assets/${a.file}`));
      const h = hashes.get(a.file);
      if (h && h.sha === own.sha) { out.set(m.clipId, a.description.slice(0, 5000)); break; }
    }
  }
  return out;
}

/** The bytes an overlay is stored as. */
export const overlayText = (o: Localization) => `${JSON.stringify(o, null, 2)}\n`;

/**
 * Writes the overlay into `outputs/v<n>/locales/<locale>/<instanceId>.json`: every folder a real one (created when missing,
 * never through a link), a fresh temp file (`wx`), noted as the core's own write, then renamed into place. Returns the
 * sha256 of the bytes written. The caller holds the creative's lock.
 */
export async function writeOverlay(creativeDir: string, n: number, overlay: Localization): Promise<string> {
  const parsed = localizationSchema.parse(overlay);
  const dir = await realDirChain(creativeDir, ['outputs', `v${n}`, 'locales', parsed.locale]);
  if (!dir) throw new Error(`outputs/v${n}/locales/${parsed.locale} is not a real folder of the creative`);
  const text = overlayText(parsed);
  const rel = overlayRel(n, parsed.locale, parsed.instanceId);
  const temp = join(dir, `.${parsed.instanceId}.json.${randomBytes(6).toString('hex')}.tmp`);
  noteCoreTemp(temp);
  try {
    await writeFile(temp, text, { flag: 'wx' });
    const st = await lstat(temp);
    if (!st.isFile() || st.nlink !== 1) throw new Error('overlay temp file is not a regular file');
    await noteCoreOutputWrite(creativeDir, rel, temp);
    await rename(temp, join(dir, `${parsed.instanceId}.json`));
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  // The folders' own entries changed too: noted, so a turn's check of earlier versions leaves them out.
  for (const d of [`outputs/v${n}/locales/${parsed.locale}`, `outputs/v${n}/locales`, `outputs/v${n}`]) await noteCoreOutputWrite(creativeDir, d);
  return createHash('sha256').update(text).digest('hex');
}

/** Sets (adds or replaces) the row of `row.locale` and `row.instanceId` in version `n` (under the versions.json lock). */
export function setLocalizationRow(store: CreativeStore, slug: string, n: number, row: LocalizationRow): Promise<VersionEntry> {
  return store.updateVersion(slug, n, (v) => {
    const rows = (v.localizations ?? []).filter((r) => !(r.locale === row.locale && r.instanceId === row.instanceId));
    return { ...v, localizations: [...rows, row] };
  });
}

/** An empty overlay of `locale` for `instanceId`. */
export const emptyOverlay = (locale: LocaleTag, instanceId: string): Localization => ({
  $schema: LOCALIZATION_SCHEMA_ID, locale, instanceId, texts: {}, params: {}, voices: {}, fit: {}, fonts: [],
});

/** The files a localized composition may use besides its folder's: the overlay's fonts (project files) and voice files. */
async function extraFiles(o: { projectDir: string; voiceRoots: readonly string[] }, overlay: Localization, base: Map<string, { size: number }>): Promise<Map<string, { size: number }>> {
  const files = new Map(base);
  for (const f of overlay.fonts) {
    for (const p of f.files) {
      if (files.has(p)) continue;
      const st = await lstat(join(o.projectDir, ...p.split('/'))).catch(() => null);
      if (st?.isFile()) files.set(p, { size: st.size });
    }
  }
  for (const v of Object.values(overlay.voices)) {
    if (files.has(v.src)) continue;
    for (const root of o.voiceRoots) {
      const st = await lstat(join(root, ...v.src.split('/'))).catch(() => null);
      if (st?.isFile() && !st.isSymbolicLink()) { files.set(v.src, { size: st.size }); break; }
    }
  }
  return files;
}

/** `warnings`: advisory (the html layers' static checks), never stored as problems, as in a turn. */
/** A language's fallback font: its family and files, `unavailable` (offline), or null when its script needs none. */
export type FallbackResult = { family: string; files: string[] } | { unavailable: string } | null;

/**
 * The fallback font of `locale` (`ensureFallbackFont`), as `finishOverlay` takes it: offline it is `unavailable` (a problem,
 * the overlay goes on); a request whose client went away (`signal` aborted) throws, never recorded as unavailable.
 */
export async function resolveFallbackFont(project: ProjectRef, locale: LocaleTag, signal: AbortSignal): Promise<FallbackResult> {
  try {
    return await ensureFallbackFont(project, locale, signal);
  } catch (e) {
    if (signal.aborted) throw e;
    if (e instanceof FallbackFontUnavailable) return { unavailable: e.family };
    throw e;
  }
}

export interface FinishedOverlay {
  overlay: Localization; stale: string[]; problems: string[]; /** The same problems with their code and clip, plus the outdated entries (Ruling M). */ issues: LocalizationIssue[]; warnings: string[];
  /** With `measure`: the browser-measured clips that overflow at their final fit; null when the browser did not measure. */
  measured: string[] | null;
}

/** The browser's measure of a localized composition: the text clip ids that overflow their box, or null when it cannot run now. */
export type TextMeasure = (localized: Composition) => Promise<string[] | null>;

/**
 * The fits of `overlay` decided by the browser (final wave P5): for each clip of `chooseFit` the browser measures (translated,
 * not stale), the largest fit from 1 down to 0.7 at which it lays the text out inside its box, above or below the estimate's
 * choice; a text that overflows even at 0.7 keeps 0.7. Returns the overlay with those fits and the measured clips that still
 * overflow, or null when the browser cannot measure (the estimate stands). One measure per fit tried, all clips at once.
 */
async function browserFit(base: Composition, overlay: Localization, stale: readonly string[], chooseFit: ReadonlySet<string>,
  voiceMode: LocalizationRow['voice'], measure: TextMeasure): Promise<{ overlay: Localization; overflowing: string[] } | null> {
  const measured = new Set(Object.keys(overlay.texts).filter((id) => !stale.includes(id) && measuredByBrowser(base, id)));
  const fit = { ...overlay.fit };
  let pending = [...chooseFit].filter((id) => measured.has(id));
  let last: string[] | null = null;
  for (const f of FITS) {
    for (const id of pending) { if (f === 1) delete fit[id]; else fit[id] = f; }
    let localized: Composition;
    try { localized = applyLocalization(base, { ...overlay, fit }, { stale, voiceMode }); } catch { return null; }
    last = await measure(localized);
    if (last === null) return null;
    const over = new Set(last);
    pending = pending.filter((id) => over.has(id));
    if (pending.length === 0) break;
  }
  return { overlay: { ...overlay, fit }, overflowing: (last ?? []).filter((id) => measured.has(id)) };
}

/**
 * Completes an overlay against its composition before it is stored (shared by the PUT route, the carry-over and Task 4):
 * the stale ids (`staleIds`), the fallback font of the language (`ensureFallbackFont`, once per project; offline it is a
 * problem and the overlay goes on without it), the text fits (`fitTexts`: `chooseFit` clips get the core's fit; a text that
 * still overflows at 0.7 is a problem, never refused, never cut) and the composition checks on the localized composition.
 * Problems are translated texts.
 */
export async function finishOverlay(o: {
  overlay: Localization; base: InstanceComposition; voice: LocalizationRow['voice']; chooseFit: ReadonlySet<string>; uiLocale: Locale;
  projectDir: string; voiceRoots: readonly string[];
  /** Ids outdated for another reason (carry-over: a voice file the new version does not have). */
  extraStale?: readonly string[];
  /** The known voice scripts (`knownVoiceScripts`); absent: computed here. */
  scripts?: ReadonlyMap<string, string>;
  /**
   * The language's fallback font, resolved beforehand (`resolveFallbackFont`, outside the creative's lock: it may download);
   * absent: the fonts the overlay has are kept as they are.
   */
  fallback?: FallbackResult;
  /**
   * The browser's measure (Ruling I, final wave P5), when a renderer can run it: for the clips it measures it decides both
   * the core's fit (`browserFit`) and the overflow (`textOverflowMeasured`), in place of the glyph-width estimate. Absent, or
   * null from it: the estimate decides.
   */
  measure?: TextMeasure;
}): Promise<FinishedOverlay> {
  const v = messages(o.uiLocale).variants;
  const problems: string[] = [];
  const issues: LocalizationIssue[] = [];
  const add = (code: LocalizationIssue['code'], message: string, clipId?: string) => {
    if (problems.includes(message)) return;
    problems.push(message);
    issues.push({ code, message, ...(clipId !== undefined ? { clipId } : {}) });
  };
  let overlay = o.overlay;
  const scripts = o.scripts ?? await knownVoiceScripts(o.base, o.projectDir);
  const stale = [...new Set([...staleIds(overlay, o.base.composition, scripts), ...(o.extraStale ?? [])])];
  const font = o.fallback;
  // Outdated entries are issues too (the row keeps their ids in `stale`): the clip is the entry's clip.
  for (const id of stale) {
    const clipId = id.split('.')[0]!;
    issues.push({ code: 'stale', clipId, message: v.staleEntry({ clip: clipLabel(o.base.composition, clipId) }) });
  }
  if (font && 'unavailable' in font) add('fallbackFontUnavailable', v.fallbackFontUnavailable({ family: font.unavailable }));
  else if (font) overlay = { ...overlay, fonts: [...overlay.fonts.filter((f) => f.family !== font.family), { family: font.family, files: font.files }] };
  const fitted = fitTexts(o.base.composition, overlay, stale, o.chooseFit);
  const browser = o.measure ? await browserFit(o.base.composition, fitted.overlay, stale, o.chooseFit, o.voice, o.measure) : null;
  overlay = browser?.overlay ?? fitted.overlay;
  for (const id of fitted.overflowing) {
    if (browser && measuredByBrowser(o.base.composition, id)) continue; // the browser decides for it
    add('textOverflow', v.textOverflow({ clip: clipLabel(o.base.composition, id) }), id);
  }
  for (const id of browser?.overflowing ?? []) {
    add('textOverflowMeasured', v.textOverflowMeasured({ clip: clipLabel(o.base.composition, id), fit: Math.round((overlay.fit[id] ?? 1) * 100) }), id);
  }
  for (const [id, voice] of Object.entries(overlay.voices)) {
    if (!stale.includes(id) && !(await voiceFileOk(o.voiceRoots, voice.src))) add('voiceFileInvalid', v.voiceFileInvalid({ clip: clipLabel(o.base.composition, id) }), id);
  }
  let localized: Composition | null = null;
  try {
    localized = applyLocalization(o.base.composition, overlay, { stale, voiceMode: o.voice });
  } catch (e) {
    if (!(e instanceof LocalizationMismatch)) throw e;
    add('invalid', e.reason === 'tooManyFonts' || e.reason === 'tooManyFallbacks' ? v.tooManyFonts : v.localizationMismatch({ entry: e.entry.slice(0, 100) }));
  }
  let warnings: string[] = [];
  if (localized) {
    const files = await extraFiles(o, overlay, new Map(o.base.folder.sizes));
    const checked = await checkLocalizedComposition(localized, { preset: o.base.preset, compDir: o.base.compDir, folder: o.base.folder, files, uiLocale: o.uiLocale });
    for (const p of checked.problems) add('invalid', p);
    warnings = checked.warnings;
  }
  return { overlay, stale, problems, issues, warnings, measured: browser?.overflowing ?? null };
}

/** The localized composition shown and rendered for a row: stale ids keep the source (Review Focus 2); null when it no longer applies. */
export function localizedComposition(base: Composition, overlay: Localization, row: Pick<LocalizationRow, 'stale' | 'voice'>): Composition | null {
  try {
    return applyLocalization(base, overlay, { stale: row.stale, voiceMode: row.voice });
  } catch (e) {
    if (e instanceof LocalizationMismatch) return null;
    throw e;
  }
}

import { createHash, randomBytes } from 'node:crypto';
import { lstat, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyLocalization, localizableEntries, LOCALIZATION_SCHEMA_ID, LocalizationMismatch, localizationSchema, messages,
  type Composition, type FormatPreset, type Locale, type LocaleTag, type Localization, type LocalizationRow, type VersionComposition, type VersionEntry,
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
import { checkLocalizedComposition, clipLabel, fitTexts, staleIds, voiceFileOk } from './validate.ts';

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

export interface FinishedOverlay { overlay: Localization; stale: string[]; problems: string[]; warnings: string[] }

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
}): Promise<FinishedOverlay> {
  const v = messages(o.uiLocale).variants;
  const problems: string[] = [];
  const add = (t: string) => { if (!problems.includes(t)) problems.push(t); };
  let overlay = o.overlay;
  const scripts = o.scripts ?? await knownVoiceScripts(o.base, o.projectDir);
  const stale = [...new Set([...staleIds(overlay, o.base.composition, scripts), ...(o.extraStale ?? [])])];
  const font = o.fallback;
  if (font && 'unavailable' in font) add(v.fallbackFontUnavailable({ family: font.unavailable }));
  else if (font) overlay = { ...overlay, fonts: [...overlay.fonts.filter((f) => f.family !== font.family), { family: font.family, files: font.files }] };
  const fitted = fitTexts(o.base.composition, overlay, stale, o.chooseFit);
  overlay = fitted.overlay;
  for (const id of fitted.overflowing) add(v.textOverflow({ clip: clipLabel(o.base.composition, id) }));
  for (const [id, voice] of Object.entries(overlay.voices)) {
    if (!stale.includes(id) && !(await voiceFileOk(o.voiceRoots, voice.src))) add(v.voiceFileInvalid({ clip: clipLabel(o.base.composition, id) }));
  }
  let localized: Composition | null = null;
  try {
    localized = applyLocalization(o.base.composition, overlay, { stale, voiceMode: o.voice });
  } catch (e) {
    if (!(e instanceof LocalizationMismatch)) throw e;
    add(e.reason === 'tooManyFonts' || e.reason === 'tooManyFallbacks' ? v.tooManyFonts : v.localizationMismatch({ entry: e.entry.slice(0, 100) }));
  }
  let warnings: string[] = [];
  if (localized) {
    const files = await extraFiles(o, overlay, new Map(o.base.folder.sizes));
    const checked = await checkLocalizedComposition(localized, { preset: o.base.preset, compDir: o.base.compDir, folder: o.base.folder, files, uiLocale: o.uiLocale });
    for (const p of checked.problems) add(p);
    warnings = checked.warnings;
  }
  return { overlay, stale, problems, warnings };
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

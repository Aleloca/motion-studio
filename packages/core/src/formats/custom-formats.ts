import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { creativeFileSchema, customFormatInputSchema, customPreset, customPresetId, isCustomPreset, issuesText, presetOf, sameCustomName, versionsFileSchema, type FormatPreset } from '@motion-studio/shared';
import { isCreativeFolderShape } from '../creatives/creative-store.ts';
import { currentLocale, t } from '../i18n.ts';
import { JsonFileError, readJsonFile } from '../json-file.ts';
import { CodedError, SLUG_RE, WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import type { CatalogState, FormatCatalog } from './format-catalog.ts';

/**
 * Report 59: the custom formats of New creative, one preset per call. Each change is read and written under the catalog's lock
 * (`FormatCatalog.mutate`), so two windows never lose each other's change. Whether creatives use a preset is scanned BEFORE the
 * lock (renders and previews load the catalog and must not wait for a scan) and brought up to date inside it, reading again
 * only the creatives whose files changed meanwhile.
 */

/**
 * What one creative folder says: the presets it uses with the longest duration it uses each at; null: it cannot be read.
 * `mtimeMs`: when it was last written (an unreadable one written before a preset existed cannot use it).
 */
interface FolderUse { stamp: string; mtimeMs: number; uses: Map<string, number> | null }
/** A scan of every creative of the workspace. `failed`: the folders whose creatives could not be listed. */
export interface UsageScan { folders: Map<string, FolderUse>; failed: number }
export interface PresetUsage {
  /** Creatives that use the preset, in their brief or in a version (archived ones and variant sisters too). */
  creatives: number;
  /**
   * Creatives (or whole folders of them) that could not be read and might use it: written since the preset was added (every
   * one, for a preset without `createdAt`).
   */
  unreadable: number;
  /** The longest duration (s) a creative uses it at: its brief's, or a version's file's. */
  longestSec: number;
}

const missing = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/** Every creative folder of every slug-shaped folder of the workspace (with or without a readable project.json). */
async function creativeFolders(root: string): Promise<{ folders: string[]; failed: number }> {
  const folders: string[] = [];
  let failed = 0;
  let projects: Dirent[];
  try { projects = await readdir(root, { withFileTypes: true }); } catch { return { folders, failed: 1 }; }
  for (const p of projects) {
    if (!p.isDirectory() || !SLUG_RE.test(p.name)) continue;
    const dir = join(root, p.name, 'creatives');
    try {
      for (const e of await readdir(dir, { withFileTypes: true })) if (e.isDirectory() && isCreativeFolderShape(e.name)) folders.push(join(dir, e.name));
    } catch (err) {
      // No creatives folder: a project without creatives (or a folder that is no project). Anything else: they might use it.
      if (!missing(err)) failed++;
    }
  }
  return { folders, failed };
}

/**
 * The identity of a folder's two files (an atomic write is a new inode): equal stamps, same contents; and when the folder was
 * last written (a file that cannot be stat'ed counts as now).
 */
async function stampOf(dir: string): Promise<{ stamp: string; mtimeMs: number }> {
  const parts: string[] = [];
  let mtimeMs = 0;
  for (const f of ['creative.json', 'versions.json']) {
    try {
      const s = await stat(join(dir, f));
      parts.push(`${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`);
      mtimeMs = Math.max(mtimeMs, s.mtimeMs);
    } catch (err) {
      parts.push(missing(err) ? '-' : `?${Math.random()}`);
      if (!missing(err)) mtimeMs = Infinity;
    }
  }
  return { stamp: parts.join('|'), mtimeMs };
}

/** Reads creative.json and versions.json once (nothing else: no covers, no stills); undefined: not a creative. */
async function readFolder(dir: string, { stamp, mtimeMs }: { stamp: string; mtimeMs: number }): Promise<FolderUse | undefined> {
  try {
    const c = await readJsonFile(join(dir, 'creative.json'), creativeFileSchema);
    let versions: Array<{ outputs: Array<{ format: string; durationSec: number | null }>; compositions?: Array<{ format: string; userDuration?: { durationSec: number } }> }> = [];
    try { versions = (await readJsonFile(join(dir, 'versions.json'), versionsFileSchema)).versions; } catch (err) { if (!(err instanceof JsonFileError && err.reason === 'missing')) throw err; }
    const uses = new Map<string, number>();
    const add = (format: string, sec: number | null | undefined) => { const id = presetOf(format); uses.set(id, Math.max(uses.get(id) ?? 0, sec ?? 0)); };
    for (const f of c.brief.formats) add(f, c.brief.durationSec);
    for (const v of versions) {
      for (const o of v.outputs) add(o.format, o.durationSec);
      // A composition's own length (one the user chose in the editor) counts too.
      for (const k of v.compositions ?? []) add(k.format, k.userDuration?.durationSec);
    }
    return { stamp, mtimeMs, uses };
  } catch (err) {
    if (err instanceof JsonFileError && err.reason === 'missing') return undefined;
    return { stamp, mtimeMs, uses: null };
  }
}

/** Scans the workspace's creatives; with `prev`, a folder whose files did not change is not read again (a stat only). */
export async function scanUsage(ws: Pick<WorkspaceStore, 'root'>, prev?: UsageScan): Promise<UsageScan> {
  const { folders, failed } = await creativeFolders(ws.root);
  const out = new Map<string, FolderUse>();
  for (const dir of folders) {
    const st = await stampOf(dir);
    const before = prev?.folders.get(dir);
    const use = before && before.stamp === st.stamp ? before : await readFolder(dir, st);
    if (use) out.set(dir, use);
  }
  return { folders: out, failed };
}

/** The use of `preset`: an unreadable creative counts only when written since the preset was added (always, without `createdAt`). */
export function usageOf(scan: UsageScan, preset: Pick<FormatPreset, 'id' | 'createdAt'>): PresetUsage {
  const id = preset.id;
  const since = preset.createdAt ? Date.parse(preset.createdAt) : -Infinity;
  let creatives = 0;
  // A folder that cannot be listed always counts: its date changes when a creative is added, not when one is rewritten.
  let unreadable = scan.failed;
  let longestSec = 0;
  for (const f of scan.folders.values()) {
    if (f.uses === null) { if (f.mtimeMs >= since) unreadable++; continue; }
    const sec = f.uses.get(id);
    if (sec === undefined) continue;
    creatives++;
    longestSec = Math.max(longestSec, sec);
  }
  return { creatives, unreadable, longestSec };
}
const inUse = (u: PresetUsage) => u.creatives + u.unreadable > 0;

export interface CustomFormatDeps {
  catalog: FormatCatalog;
  ws: Pick<WorkspaceStore, 'root'>;
  /** The scan (tests slow it down to show the catalog is not locked meanwhile). */
  scan?: typeof scanUsage;
}

const parseInput = (body: unknown) => {
  const r = customFormatInputSchema.safeParse(body ?? {});
  if (!r.success) throw new WorkspaceError(400, t().errors.invalidRequestDetail({ detail: issuesText(r.error, currentLocale()) }));
  return r.data;
};
/** A name another (visible) custom format has: two tiles with one name could not be told apart. */
const assertNameFree = (presets: readonly FormatPreset[], name: string, except?: string) => {
  if (presets.some((p) => isCustomPreset(p) && !p.hidden && p.id !== except && sameCustomName(p.name, name))) {
    throw new CodedError(409, t().errors.customFormatNameTaken({ name: name.trim() }), 'custom-format-name-taken');
  }
};
/** The custom preset `id` of the catalog: 404 when absent or hidden (deleted), 403 for a shipped or hand-made one. */
const customAt = (presets: readonly FormatPreset[], id: string): number => {
  const at = presets.findIndex((p) => p.id === id);
  const p = presets[at];
  if (!p || p.hidden) throw new CodedError(404, t().errors.customFormatNotFound({ id }), 'custom-format-not-found');
  if (!isCustomPreset(p)) throw new CodedError(403, t().errors.customFormatNotCustom({ id }), 'custom-format-not-custom');
  return at;
};

/** Hidden presets no creative uses any more (none unreadable either): taken out, and their ids remembered as deleted. */
function purgeHidden(presets: FormatPreset[], scan: UsageScan | null, deleted: Set<string>): FormatPreset[] {
  if (!scan) return presets;
  return presets.filter((p) => {
    if (!p.hidden || inUse(usageOf(scan, p))) return true;
    deleted.add(p.id);
    return false;
  });
}

/** A scan before the lock (only when `needed`), and the same scan brought up to date inside it (or a full one, when none was made). */
function scanner(d: CustomFormatDeps) {
  const scan = d.scan ?? scanUsage;
  let before: UsageScan | null = null;
  return {
    early: async (needed: boolean) => { if (needed) before = await scan(d.ws); },
    inside: () => scan(d.ws, before ?? undefined),
    scanned: () => before !== null,
  };
}

export interface CustomFormatResult { preset: FormatPreset; catalog: CatalogState }

/**
 * Adds a custom preset at the end of the catalog, with an id derived from its name: unique among every id of the catalog
 * (hidden ones too) and every custom id ever deleted from it. Hidden presets no creative uses any more go at the same time.
 */
export async function addCustomFormat(d: CustomFormatDeps, body: unknown): Promise<CustomFormatResult> {
  const input = parseInput(body);
  const s = scanner(d);
  await s.early((await d.catalog.load()).presets.some((p) => p.hidden));
  let preset: FormatPreset | null = null;
  const state = await d.catalog.mutate(async (presets, deleted) => {
    assertNameFree(presets, input.name);
    // Only a scan already made is brought up to date here: an add never waits for a full scan under the lock.
    const kept = s.scanned() ? purgeHidden(presets, await s.inside(), deleted) : presets;
    preset = { ...customPreset(input, customPresetId(input.name, new Set([...presets.map((p) => p.id), ...deleted]))), createdAt: new Date().toISOString() };
    return [...kept, preset];
  });
  return { preset: preset!, catalog: state };
}

/**
 * Changes a custom preset; its id stays (creatives name it). One that creatives use (or might: one that cannot be read) keeps
 * its kind and size (409): their compositions and files are made for them. Its maximum duration never drops below the longest
 * duration a creative uses it at (409). Its name changes freely.
 */
export async function editCustomFormat(d: CustomFormatDeps, id: string, body: unknown): Promise<CustomFormatResult> {
  const input = parseInput(body);
  const changes = (before: FormatPreset) => ({
    shape: input.kind !== before.kind || input.width !== before.width || input.height !== before.height,
    shorter: input.kind === 'video' && input.maxDurationSec !== undefined && (before.maxDurationSec === undefined || input.maxDurationSec < before.maxDurationSec),
  });
  const now = (await d.catalog.load()).presets.find((p) => p.id === id);
  const c0 = now ? changes(now) : null;
  const s = scanner(d);
  await s.early(!!c0 && (c0.shape || c0.shorter));
  let preset: FormatPreset | null = null;
  const state = await d.catalog.mutate(async (presets) => {
    const at = customAt(presets, id);
    const before = presets[at]!;
    assertNameFree(presets, input.name, id);
    const c = changes(before);
    if (c.shape || c.shorter) {
      // Scanned before the lock when the change was visible then; a full scan here only when another window changed it meanwhile.
      const use = usageOf(await s.inside(), before);
      if (c.shape && inUse(use)) {
        // "N creatività usano" counts the creatives that do; the unreadable ones are said apart.
        const text = use.creatives > 0 ? t().errors.customFormatInUse({ count: use.creatives }) : t().errors.customFormatMaybeInUse({ count: use.unreadable });
        throw new CodedError(409, text, 'custom-format-in-use');
      }
      if (c.shorter && input.maxDurationSec! < use.longestSec) {
        throw new CodedError(409, t().errors.customFormatDurationShort({ sec: use.longestSec }), 'custom-format-duration-too-short');
      }
    }
    preset = { ...customPreset(input, id), ...(before.createdAt ? { createdAt: before.createdAt } : {}) };
    return presets.map((p, i) => (i === at ? preset! : p));
  });
  return { preset: preset!, catalog: state };
}

/**
 * Deletes a custom preset: its id is remembered and never given again. One that a creative uses (or might: a creative that
 * cannot be read) is hidden instead: it stays in the catalog so those creatives keep rendering, previewing and exporting, and is
 * offered nowhere any more. Hidden presets no creative uses any more go at the same time.
 */
export async function deleteCustomFormat(d: CustomFormatDeps, id: string): Promise<{ outcome: 'deleted' | 'hidden'; catalog: CatalogState }> {
  customAt((await d.catalog.load()).presets, id);
  const s = scanner(d);
  await s.early(true);
  let outcome: 'deleted' | 'hidden' = 'deleted';
  const state = await d.catalog.mutate(async (presets, deleted) => {
    const target = presets[customAt(presets, id)]!;
    const scan = await s.inside();
    const kept = purgeHidden(presets, scan, deleted);
    if (!inUse(usageOf(scan, target))) { deleted.add(id); return kept.filter((p) => p.id !== id); }
    outcome = 'hidden';
    return kept.map((p) => (p.id === id ? { ...p, hidden: true as const } : p));
  });
  return { outcome, catalog: state };
}

/** The usage the dialog shows before a change (it locks kind and size of a format in use). */
export async function customFormatUsage(d: CustomFormatDeps, id: string): Promise<PresetUsage> {
  const presets = (await d.catalog.load()).presets;
  return usageOf(await (d.scan ?? scanUsage)(d.ws), presets[customAt(presets, id)]!);
}

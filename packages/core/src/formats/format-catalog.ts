import { join } from 'node:path';
import { DEFAULT_FORMATS, formatsFileSchema, instancePreset, issuesText, type FormatPreset } from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { CodedError, WorkspaceError } from '../workspace-store.ts';
import { fileLock } from '../file-locks.ts';
import { currentLocale, t } from '../i18n.ts';

export interface CatalogState { presets: FormatPreset[]; error: string | null; path: string }

/**
 * The preset of a format instance id (Phase 12, `instancePreset`): the catalog preset with the instance id as its `id`, so
 * folders, render files and prompt lines are named after the instance. Every lookup of a brief format goes through here.
 */
export const findPreset = (presets: readonly FormatPreset[], id: string): FormatPreset | undefined => instancePreset(presets, id);

/**
 * The built-in preset ids as of commit 1c6cfb9 (before Phase 14), frozen: a formats.json without `seenDefaults` was written
 * by then and has been offered exactly these. Never edit this list; new defaults are found by `seenDefaults`.
 */
export const LEGACY_DEFAULT_IDS: readonly string[] = Object.freeze([
  'instagram-post-1x1', 'instagram-post-4x5', 'instagram-reel-9x16', 'instagram-image-1x1', 'instagram-image-4x5', 'tiktok-9x16',
  'youtube-16x9', 'youtube-4k-16x9', 'youtube-shorts-9x16', 'youtube-thumbnail', 'facebook-feed-1x1', 'facebook-feed-4x5',
  'facebook-story-9x16', 'facebook-cover', 'linkedin-1x1', 'linkedin-4x5', 'linkedin-16x9', 'linkedin-banner', 'x-16x9', 'x-1x1',
  'pinterest-2x3', 'web-hero-16x9', 'web-banner-300x250', 'web-banner-728x90', 'web-banner-160x600', 'appstore-iphone-69',
  'appstore-iphone-65', 'appstore-ipad-13', 'appstore-preview', 'appstore-icon', 'playstore-feature', 'playstore-phone-9x16',
  'playstore-tablet', 'playstore-icon', 'playstore-promo-16x9',
]);

/** Most `seenDefaults` ids written (the schema's limit): the current defaults first, then other ids the file had. */
const MAX_SEEN_DEFAULTS = 1000;
/** Catalog files whose upgrade write failed in this process (a read-only workspace): not tried again on every load. */
const upgradeFailed = new Set<string>();

export class FormatCatalog {
  private readonly path: string;
  constructor(workspaceRoot: string) { this.path = join(workspaceRoot, '.studio', 'presets', 'formats.json'); }

  /** Load, save and reset of one catalog file run one at a time (the process-wide lock of metadata files). */
  private locked<T>(fn: () => Promise<T>): Promise<T> { return fileLock.run(this.path, fn); }

  load(): Promise<CatalogState> {
    return this.locked(async () => {
      try {
        const { presets, seen, upgraded } = await this.read();
        if (!upgraded) return { presets, error: null, path: this.path };
        // Best effort: a workspace that cannot be written still gets the new presets in memory; after one failed write the
        // file is not written again on every load (only a save or a reset, or a new process, tries again).
        if (upgradeFailed.has(this.path)) return { presets, error: null, path: this.path };
        return await this.write(presets, seenDefaultsOf(seen)).catch(() => {
          upgradeFailed.add(this.path);
          return { presets, error: null, path: this.path };
        });
      } catch (err) {
        if (err instanceof JsonFileError && err.reason === 'missing') return this.write(DEFAULT_FORMATS);
        if (err instanceof JsonFileError) {
          return { presets: DEFAULT_FORMATS, error: t().errors.formatCatalogFallback({ detail: err.message }), path: this.path };
        }
        throw err;
      }
    });
  }

  /**
   * Reads the file, with the defaults it was never offered appended (ruling AK): a default never offered to this file is
   * appended; one offered before and missing now was deleted by the user and stays deleted. `upgraded`: the file needs writing.
   */
  private async read(): Promise<{ presets: FormatPreset[]; seen: Set<string>; upgraded: boolean }> {
    const file = await readJsonFile(this.path, formatsFileSchema);
    const seen = new Set(file.seenDefaults ?? LEGACY_DEFAULT_IDS);
    const have = new Set(file.presets.map((p) => p.id));
    const added = DEFAULT_FORMATS.filter((p) => !have.has(p.id) && !seen.has(p.id));
    const upgraded = added.length > 0 || !DEFAULT_FORMATS.every((p) => seen.has(p.id)) || file.seenDefaults === undefined;
    return { presets: [...file.presets, ...added], seen, upgraded };
  }

  /**
   * Report 59: one change of the catalog, read and written under the file's lock, so two windows changing it at once both land
   * (the client never writes the whole list). The file's `seenDefaults` are kept. A file that cannot be read is never written
   * over (409): the user's catalog would be lost for the defaults.
   */
  mutate(change: (presets: FormatPreset[]) => FormatPreset[] | Promise<FormatPreset[]>): Promise<CatalogState> {
    return this.locked(async () => {
      let current: { presets: FormatPreset[]; seen: Iterable<string> };
      try {
        current = await this.read();
      } catch (err) {
        if (err instanceof JsonFileError && err.reason === 'missing') current = { presets: DEFAULT_FORMATS, seen: DEFAULT_FORMATS.map((p) => p.id) };
        else if (err instanceof JsonFileError) throw new CodedError(409, t().errors.formatCatalogUnreadable({ detail: err.message }), 'format-catalog-unreadable');
        else throw err;
      }
      const parsed = formatsFileSchema.safeParse({ schemaVersion: 1, presets: await change(current.presets) });
      if (!parsed.success) {
        throw new WorkspaceError(400, t().errors.formatCatalogInvalid({ detail: issuesText(parsed.error, currentLocale()) }));
      }
      return this.write(parsed.data.presets, seenDefaultsOf(current.seen));
    });
  }

  async save(presets: FormatPreset[]): Promise<CatalogState> {
    const parsed = formatsFileSchema.safeParse({ schemaVersion: 1, presets });
    if (!parsed.success) {
      throw new WorkspaceError(400, t().errors.formatCatalogInvalid({ detail: issuesText(parsed.error, currentLocale()) }));
    }
    return this.locked(() => this.write(parsed.data.presets));
  }

  resetToDefaults(): Promise<CatalogState> { return this.locked(() => this.write(DEFAULT_FORMATS)); }

  /**
   * Writes the file. `seenDefaults` defaults to every current default id: after a save or a reset the user has seen them
   * all, so a default they removed in the editor is not appended again.
   */
  private async write(presets: FormatPreset[], seenDefaults: string[] = DEFAULT_FORMATS.map((p) => p.id)): Promise<CatalogState> {
    await writeJsonFileAtomic(this.path, { schemaVersion: 1, presets, seenDefaults });
    upgradeFailed.delete(this.path);
    return { presets, error: null, path: this.path };
  }
}

/** The `seenDefaults` to write: every current default id first, then the other ids the file had seen, within the schema's limit. */
export function seenDefaultsOf(seen: Iterable<string>): string[] {
  return [...new Set([...DEFAULT_FORMATS.map((p) => p.id), ...seen])].slice(0, MAX_SEEN_DEFAULTS);
}

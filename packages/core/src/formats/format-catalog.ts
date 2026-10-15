import { join } from 'node:path';
import { DEFAULT_FORMATS, formatsFileSchema, instancePreset, issuesText, type FormatPreset } from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { WorkspaceError } from '../workspace-store.ts';
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

export class FormatCatalog {
  private readonly path: string;
  constructor(workspaceRoot: string) { this.path = join(workspaceRoot, '.studio', 'presets', 'formats.json'); }

  async load(): Promise<CatalogState> {
    try {
      const file = await readJsonFile(this.path, formatsFileSchema);
      // New built-in presets reach existing workspaces (ruling AK): a default never offered to this file is appended; one
      // offered before and missing now was deleted by the user and stays deleted. Written only when something changed.
      const seen = new Set(file.seenDefaults ?? LEGACY_DEFAULT_IDS);
      const have = new Set(file.presets.map((p) => p.id));
      const added = DEFAULT_FORMATS.filter((p) => !have.has(p.id) && !seen.has(p.id));
      const allSeen = DEFAULT_FORMATS.every((p) => seen.has(p.id));
      if (added.length === 0 && allSeen && file.seenDefaults !== undefined) return { presets: file.presets, error: null, path: this.path };
      const presets = [...file.presets, ...added];
      // Best effort: a workspace that cannot be written still gets the new presets in memory, and tries again next load.
      return await this.write(presets, [...new Set([...seen, ...DEFAULT_FORMATS.map((p) => p.id)])]).catch(() => ({ presets, error: null, path: this.path }));
    } catch (err) {
      if (err instanceof JsonFileError && err.reason === 'missing') return this.write(DEFAULT_FORMATS);
      if (err instanceof JsonFileError) {
        return { presets: DEFAULT_FORMATS, error: t().errors.formatCatalogFallback({ detail: err.message }), path: this.path };
      }
      throw err;
    }
  }

  async save(presets: FormatPreset[]): Promise<CatalogState> {
    const parsed = formatsFileSchema.safeParse({ schemaVersion: 1, presets });
    if (!parsed.success) {
      throw new WorkspaceError(400, t().errors.formatCatalogInvalid({ detail: issuesText(parsed.error, currentLocale()) }));
    }
    return this.write(parsed.data.presets);
  }

  resetToDefaults(): Promise<CatalogState> { return this.write(DEFAULT_FORMATS); }

  /**
   * Writes the file. `seenDefaults` defaults to every current default id: after a save or a reset the user has seen them
   * all, so a default they removed in the editor is not appended again.
   */
  private async write(presets: FormatPreset[], seenDefaults: string[] = DEFAULT_FORMATS.map((p) => p.id)): Promise<CatalogState> {
    await writeJsonFileAtomic(this.path, { schemaVersion: 1, presets, seenDefaults });
    return { presets, error: null, path: this.path };
  }
}

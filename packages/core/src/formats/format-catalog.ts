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

export class FormatCatalog {
  private readonly path: string;
  constructor(workspaceRoot: string) { this.path = join(workspaceRoot, '.studio', 'presets', 'formats.json'); }

  async load(): Promise<CatalogState> {
    try {
      const file = await readJsonFile(this.path, formatsFileSchema);
      return { presets: file.presets, error: null, path: this.path };
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

  private async write(presets: FormatPreset[]): Promise<CatalogState> {
    await writeJsonFileAtomic(this.path, { schemaVersion: 1, presets });
    return { presets, error: null, path: this.path };
  }
}

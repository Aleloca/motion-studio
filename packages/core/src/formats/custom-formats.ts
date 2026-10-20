import { customFormatInputSchema, customPreset, customPresetId, isCustomPreset, issuesText, presetOf, type FormatPreset } from '@motion-studio/shared';
import { CreativeStore } from '../creatives/creative-store.ts';
import { currentLocale, t } from '../i18n.ts';
import { CodedError, WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import type { CatalogState, FormatCatalog } from './format-catalog.ts';

/**
 * Report 59: the custom formats of New creative, one preset per call. Each change is read and written under the catalog's lock
 * (`FormatCatalog.mutate`), so two windows never lose each other's change.
 */

/** How many creatives use a preset: in their brief or in a version (archived ones and variant sisters too); `unreadable`: those that could not be read. */
export async function presetUsage(ws: WorkspaceStore, id: string): Promise<{ creatives: number; unreadable: number }> {
  let creatives = 0;
  let unreadable = 0;
  const uses = (format: string) => presetOf(format) === id;
  // Every project folder, one whose project.json cannot be read too: its creatives still hold their formats.
  for (const { slug } of await ws.listProjects()) {
    const store = new CreativeStore(ws.projectDir(slug));
    for (const item of await store.listAll().catch(() => [])) {
      if (!item.ok) { unreadable++; continue; }
      if (item.formats.some(uses)) { creatives++; continue; }
      const versions = await store.readVersions(item.slug).catch(() => null);
      if (versions === null) { unreadable++; continue; }
      if (versions.some((v) => v.outputs.some((o) => uses(o.format)) || (v.compositions ?? []).some((c) => uses(c.format)))) creatives++;
    }
  }
  return { creatives, unreadable };
}

const parseInput = (body: unknown) => {
  const r = customFormatInputSchema.safeParse(body ?? {});
  if (!r.success) throw new WorkspaceError(400, t().errors.invalidRequestDetail({ detail: issuesText(r.error, currentLocale()) }));
  return r.data;
};
const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
/** A name another (visible) custom format has: two tiles with one name could not be told apart. */
const assertNameFree = (presets: readonly FormatPreset[], name: string, except?: string) => {
  if (presets.some((p) => isCustomPreset(p) && !p.hidden && p.id !== except && sameName(p.name, name))) {
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

export interface CustomFormatResult { preset: FormatPreset; catalog: CatalogState }

/** Adds a custom preset at the end of the catalog, with an id derived from its name (unique among every id, hidden ones too). */
export async function addCustomFormat(catalog: FormatCatalog, body: unknown): Promise<CustomFormatResult> {
  const input = parseInput(body);
  let preset: FormatPreset | null = null;
  const state = await catalog.mutate((presets) => {
    assertNameFree(presets, input.name);
    preset = customPreset(input, customPresetId(input.name, new Set(presets.map((p) => p.id))));
    return [...presets, preset];
  });
  return { preset: preset!, catalog: state };
}

/**
 * Changes a custom preset; its id stays (creatives name it). One that creatives use keeps its kind and size (409): their
 * compositions and files are made for them. Its name and maximum duration change freely.
 */
export async function editCustomFormat(catalog: FormatCatalog, ws: WorkspaceStore, id: string, body: unknown): Promise<CustomFormatResult> {
  const input = parseInput(body);
  let preset: FormatPreset | null = null;
  const state = await catalog.mutate(async (presets) => {
    const at = customAt(presets, id);
    const before = presets[at]!;
    assertNameFree(presets, input.name, id);
    if (input.kind !== before.kind || input.width !== before.width || input.height !== before.height) {
      const { creatives } = await presetUsage(ws, id);
      if (creatives > 0) throw new CodedError(409, t().errors.customFormatInUse({ count: creatives }), 'custom-format-in-use');
    }
    preset = customPreset(input, id);
    return presets.map((p, i) => (i === at ? preset! : p));
  });
  return { preset: preset!, catalog: state };
}

/**
 * Deletes a custom preset. One that a creative uses (or might: a creative that cannot be read) is hidden instead: it stays in the
 * catalog so those creatives keep rendering, previewing and exporting, and is offered nowhere any more.
 */
export async function deleteCustomFormat(catalog: FormatCatalog, ws: WorkspaceStore, id: string): Promise<{ outcome: 'deleted' | 'hidden'; catalog: CatalogState }> {
  let outcome: 'deleted' | 'hidden' = 'deleted';
  const state = await catalog.mutate(async (presets) => {
    const at = customAt(presets, id);
    const use = await presetUsage(ws, id);
    if (use.creatives + use.unreadable === 0) return presets.filter((_, i) => i !== at);
    outcome = 'hidden';
    return presets.map((p, i) => (i === at ? { ...p, hidden: true as const } : p));
  });
  return { outcome, catalog: state };
}

/** The usage the dialog shows before a change (it locks kind and size of a format in use). */
export async function customFormatUsage(catalog: FormatCatalog, ws: WorkspaceStore, id: string): Promise<{ creatives: number }> {
  customAt((await catalog.load()).presets, id);
  return { creatives: (await presetUsage(ws, id)).creatives };
}

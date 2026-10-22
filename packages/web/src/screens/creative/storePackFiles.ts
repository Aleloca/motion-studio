// Report 48: the files of a store pack, as the pack export lists them to pick from: by store (App Store, Google Play), then by
// device (one row per screenshot), the preview videos and the feature graphic on their own. Each row has the thumbnail the ★
// export rows have (report 47): the render when it is current, else a still of the composition.
// Report 54 (variant A): the dialog lists the stores and their items on the left and shows one item's files on the right.
import { presetOf, renderState, STORE_DEVICE_PRESET, STORE_PREVIEW_PRESET, type FormatPreset, type Locale, type StoreId, type VersionEntry } from '@motion-studio/shared';
import type { GroupExportPlanItem } from '../../api.ts';
import type { StillRef } from '../../components/compositionStill.ts';
import { instanceName, presetFor, presetNameOf } from '../../instances.ts';
import { outputMedia, type Media } from '../canvasModel.ts';

export type PackThumb = { still: StillRef } | { media: Media };
export interface PackFileRow { id: string; label: string; aspect: number; thumb: PackThumb | null }
/**
 * A device's screenshots, or a single file (the feature graphic, a preview video). `kind`, `width` and `height` describe its
 * files in the list (report 54: "8 screenshots", "video · 886 × 1920", "image · 1024 × 500").
 */
export interface PackDevice { key: string; label: string; single: boolean; kind: 'shots' | 'video' | 'image'; width: number; height: number; rows: PackFileRow[] }
export interface PackStore { store: StoreId; devices: PackDevice[] }

type DeviceKey = 'iphone69' | 'ipad13' | 'phone' | 'tablet' | 'feature';
const DEVICES: Record<string, { store: StoreId; device: DeviceKey | null }> = {
  [STORE_DEVICE_PRESET.appstore['iphone-69']]: { store: 'appstore', device: 'iphone69' },
  [STORE_DEVICE_PRESET.appstore['ipad-13']]: { store: 'appstore', device: 'ipad13' },
  [STORE_DEVICE_PRESET.playstore.phone]: { store: 'playstore', device: 'phone' },
  [STORE_DEVICE_PRESET.playstore.tablet]: { store: 'playstore', device: 'tablet' },
  [STORE_DEVICE_PRESET.playstore.feature]: { store: 'playstore', device: 'feature' },
  [STORE_PREVIEW_PRESET.appstore]: { store: 'appstore', device: null },
  [STORE_PREVIEW_PRESET.playstore]: { store: 'playstore', device: null },
};

/**
 * The pack's `formats` (its instances, in the brief's order) by store and device. `deviceName` names a screenshot device
 * (the wizard's names); a preview video and the feature graphic go by their format's name.
 */
export function packFileGroups(formats: readonly string[], o: {
  presets: readonly FormatPreset[]; labels?: Record<string, string>; locale: Locale;
  deviceName(d: DeviceKey): string; thumbOf(id: string): PackThumb | null;
}): PackStore[] {
  const stores: PackStore[] = [];
  for (const id of formats) {
    const where = DEVICES[presetOf(id)];
    if (!where) continue;
    const preset = presetFor(o.presets, id);
    const name = preset ? presetNameOf(preset, o.locale) : id;
    const single = where.device === null || where.device === 'feature';
    let store = stores.find((s) => s.store === where.store);
    if (!store) stores.push(store = { store: where.store, devices: [] });
    const key = presetOf(id);
    let device = store.devices.find((d) => d.key === key);
    if (!device) {
      const kind = !single ? 'shots' : preset?.kind === 'video' ? 'video' : 'image';
      store.devices.push(device = { key, label: single || !where.device ? name : o.deviceName(where.device), single, kind, width: preset?.width ?? 0, height: preset?.height ?? 0, rows: [] });
    }
    const label = single ? name : o.labels?.[id] ?? instanceName(preset, id, o.locale, o.labels);
    device.rows.push({ id, label, aspect: preset ? preset.width / preset.height : 1, thumb: o.thumbOf(id) });
  }
  return stores;
}

/** A store's or a device's checkbox from the files left out: on when all are in, mixed when some are, with "n/m". */
export function groupCheck(ids: readonly string[], off: ReadonlySet<string>): { n: number; of: number; on: boolean; mixed: boolean } {
  const n = ids.filter((id) => !off.has(id)).length;
  return { n, of: ids.length, on: n === ids.length, mixed: n > 0 && n < ids.length };
}

/** The files left out once `ids` are put in (`include`) or left out; a new set. */
export function withFiles(off: ReadonlySet<string>, ids: readonly string[], include: boolean): Set<string> {
  const next = new Set(off);
  for (const id of ids) { if (include) next.delete(id); else next.add(id); }
  return next;
}

/** Report 54 (variant A): the item the right pane shows: the one chosen while it is in the pack, else the first of the list. */
export function shownItem(stores: readonly PackStore[], key: string | null): PackDevice | null {
  const all = stores.flatMap((s) => s.devices);
  return all.find((d) => d.key === key) ?? all[0] ?? null;
}

/** The grid's columns: four for portrait files, two for landscape ones (the feature graphic, the promo video) so they stay large. */
export function gridColumns(d: PackDevice): number {
  return d.width > d.height ? 2 : 4;
}

/** The item an arrow key moves to in the list (`dir` 1 down, -1 up), stopping at the ends; the first for an unknown one. */
export function stepItem(keys: readonly string[], key: string, dir: 1 | -1): string | undefined {
  const i = keys.indexOf(key);
  if (i < 0) return keys[0];
  return keys[Math.min(keys.length - 1, Math.max(0, i + dir))];
}

/**
 * A single version's thumbnail of `id`: its render when current, else a still of its composition (report 47). `subtitleHashes`:
 * the creative's subtitle sets now; a render that drew a set since changed is not current (subtitles Task 22).
 */
export function versionThumb(slug: string, creative: string, v: VersionEntry | undefined, id: string, subtitleHashes?: Readonly<Record<string, string>>): PackThumb | null {
  if (!v) return null;
  const comp = v.compositions?.find((c) => c.format === id);
  if (comp && renderState(v, id, subtitleHashes) !== 'rendered') return { still: { slug, creative, n: v.n, format: id, hash: comp.hash } };
  const out = v.outputs.find((x) => x.format === id);
  return out ? { media: outputMedia(slug, creative, v.n, out) } : null;
}

/** A variant group's thumbnail of a format: the member and version its selection names (as the group's ★ export). */
export function groupThumb(slug: string, g: GroupExportPlanItem | undefined): PackThumb | null {
  if (!g) return null;
  if (g.state === 'needs-render') return g.hash ? { still: { slug, creative: g.slug, n: g.version, format: g.format, hash: g.hash } } : null;
  if (g.state !== 'ready' || !g.file) return null;
  return { media: outputMedia(slug, g.slug, g.version, { format: g.format, file: g.file, width: g.width, height: g.height, durationSec: null, verified: true, preview: null } as VersionEntry['outputs'][number]) };
}

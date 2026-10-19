// Report 48: the files of a store pack, as the pack export lists them to pick from: by store (App Store, Google Play), then by
// device (one row per screenshot), the preview videos and the feature graphic on their own. Each row has the thumbnail the ★
// export rows have (report 47): the render when it is current, else a still of the composition.
// Report 54: the dialog shows them as a gallery per store, one row per device (`galleryRows`); the helpers below are its logic.
import { presetOf, renderState, STORE_DEVICE_PRESET, STORE_PREVIEW_PRESET, type FormatPreset, type Locale, type StoreId, type VersionEntry } from '@motion-studio/shared';
import type { GroupExportPlanItem } from '../../api.ts';
import type { StillRef } from '../../components/compositionStill.ts';
import { instanceName, presetFor, presetNameOf } from '../../instances.ts';
import { outputMedia, type Media } from '../canvasModel.ts';

export type PackThumb = { still: StillRef } | { media: Media };
export interface PackFileRow { id: string; label: string; aspect: number; thumb: PackThumb | null }
/** A device's screenshots, or a single file (the feature graphic, a preview video): `single` rows have no group checkbox. */
export interface PackDevice { key: string; label: string; single: boolean; rows: PackFileRow[] }
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
    if (!device) store.devices.push(device = { key, label: single || !where.device ? name : o.deviceName(where.device), single, rows: [] });
    const label = single ? name : o.labels?.[id] ?? instanceName(preset, id, o.locale, o.labels);
    device.rows.push({ id, label, aspect: preset ? preset.width / preset.height : 1, thumb: o.thumbOf(id) });
  }
  return stores;
}

/**
 * Report 54: a row of a store's gallery: a device's screenshots (`label` the device's name, `files` the ones its checkbox
 * covers) and, on the store's last row, the single files after them (`tail`: App Preview, feature graphic, promo video).
 */
export interface GalleryRow { key: string; label: string | null; files: PackFileRow[]; tail: PackFileRow[] }

/** A store's rows: one per device with screenshots; the single files at the end of the last one, or alone in a row without a device. */
export function galleryRows(store: PackStore): GalleryRow[] {
  const rows: GalleryRow[] = store.devices.filter((d) => !d.single).map((d) => ({ key: d.key, label: d.label, files: d.rows, tail: [] }));
  const singles = store.devices.filter((d) => d.single).flatMap((d) => d.rows);
  if (!singles.length) return rows;
  const last = rows.at(-1);
  if (last) last.tail = singles; else rows.push({ key: `${store.store}-files`, label: null, files: [], tail: singles });
  return rows;
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

/** Whether a sideways strip has more to show before (`back`) or after (`more`) what is in view; a pixel of rounding is nothing. */
export function scrollEdges(el: { scrollLeft: number; scrollWidth: number; clientWidth: number }): { back: boolean; more: boolean } {
  return { back: el.scrollLeft > 1, more: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 };
}

/** A single version's thumbnail of `id`: its render when current, else a still of its composition (report 47). */
export function versionThumb(slug: string, creative: string, v: VersionEntry | undefined, id: string): PackThumb | null {
  if (!v) return null;
  const comp = v.compositions?.find((c) => c.format === id);
  if (comp && renderState(v, id) !== 'rendered') return { still: { slug, creative, n: v.n, format: id, hash: comp.hash } };
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

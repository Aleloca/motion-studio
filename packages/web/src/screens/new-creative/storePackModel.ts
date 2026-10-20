// The store pack as an entry of the formats list (Phase 14, spec §3): where the entry sits and what it adds to a brief.
import { STORE_PREVIEW_SECONDS, allocatePackInstances, presetOf, storePackFormats, type FormatPreset, type StorePack } from '@motion-studio/shared';

/** The catalog group that holds the pack's entry: the one of the App Store screenshots (the first store group). */
export function packChannel(presets: readonly FormatPreset[]): string | null {
  return presets.find((p) => p.id === 'appstore-iphone-69')?.channel ?? presets.find((p) => p.id.startsWith('appstore-'))?.channel ?? null;
}

/**
 * What a pack adds to a new brief: its instances (the next free ids beside `taken`, the formats already picked), with labels
 * and links, the app screens it uses and its preview length. `pack`: the pack with its `instances`, as the core stores it.
 * `full`: the preset with no free instance left for the pack (report 58), else null.
 */
export function packParts(pack: StorePack | null, presets: readonly FormatPreset[], taken: readonly string[] = []) {
  if (!pack) return { formats: [] as string[], formatLabels: {} as Record<string, string>, links: {} as Record<string, string>, assets: [] as string[], videos: 0, images: 0, durationSec: null as number | null, pack: null as StorePack | null, full: null as string | null };
  const a = allocatePackInstances(pack, new Map(), taken, presets);
  const own = 'full' in a ? { instances: storePackFormats(pack, presets).formats, formatLabels: storePackFormats(pack, presets).formatLabels, links: storePackFormats(pack, presets).links } : a;
  const videos = own.instances.filter((id) => presets.find((p) => p.id === presetOf(id))?.kind === 'video').length;
  const assets = [...new Set(pack.screenshots.flatMap((s) => (s.screen ? [s.screen] : [])))];
  return { formats: own.instances, formatLabels: own.formatLabels, links: own.links, assets, videos, images: own.instances.length - videos, durationSec: pack.preview ? STORE_PREVIEW_SECONDS : null, pack: { ...pack, instances: own.instances } as StorePack | null,
    // Report 58: the preset whose 20 instances the pack and the picked copies go over (the brief cannot be made as it is).
    full: 'full' in a ? a.full : null };
}

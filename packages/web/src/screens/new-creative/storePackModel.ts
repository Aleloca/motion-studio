// The store pack as an entry of the formats list (Phase 14, spec §3): where the entry sits and what it adds to a brief.
import { STORE_PREVIEW_SECONDS, presetOf, storePackFormats, type FormatPreset, type StorePack } from '@motion-studio/shared';

/** The catalog group that holds the pack's entry: the one of the App Store screenshots (the first store group). */
export function packChannel(presets: readonly FormatPreset[]): string | null {
  return presets.find((p) => p.id === 'appstore-iphone-69')?.channel ?? presets.find((p) => p.id.startsWith('appstore-'))?.channel ?? null;
}

/** What a pack adds to a new brief: its instances (with labels and links), the app screens it uses and its preview length. */
export function packParts(pack: StorePack | null, presets: readonly FormatPreset[]) {
  if (!pack) return { formats: [] as string[], formatLabels: {} as Record<string, string>, links: {} as Record<string, string>, assets: [] as string[], videos: 0, images: 0, durationSec: null as number | null };
  const f = storePackFormats(pack, presets);
  const videos = f.formats.filter((id) => presets.find((p) => p.id === presetOf(id))?.kind === 'video').length;
  const assets = [...new Set(pack.screenshots.flatMap((s) => (s.screen ? [s.screen] : [])))];
  return { ...f, assets, videos, images: f.formats.length - videos, durationSec: pack.preview ? STORE_PREVIEW_SECONDS : null };
}

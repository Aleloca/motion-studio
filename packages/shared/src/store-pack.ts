// App Store / Google Play pack (Phase 12, spec §4.1): the choices of the guided flow, kept in `brief.storePack`, and the
// formats (one instance per screenshot and device) they stand for.
import { z } from 'zod';
import { DEFAULT_FORMATS, type FormatPreset } from './formats.ts';
import { instanceIdOf } from './format-instance.ts';
import { assetFilePath } from './localization/schema.ts';

export type StoreId = 'appstore' | 'playstore';
export const STORE_IDS = ['appstore', 'playstore'] as const;
export const APPSTORE_DEVICES = ['iphone-69', 'ipad-13'] as const;
export const PLAYSTORE_DEVICES = ['phone', 'tablet', 'feature'] as const;
/** Screenshots per store (spec §4.1); when both stores are chosen, the narrower range applies. */
export const STORE_SCREENSHOTS = { appstore: { min: 1, max: 10 }, playstore: { min: 2, max: 8 } } as const;

/** Catalog preset of each device. */
export const STORE_DEVICE_PRESET = {
  appstore: { 'iphone-69': 'appstore-iphone-69', 'ipad-13': 'appstore-ipad-13' },
  playstore: { phone: 'playstore-phone-9x16', tablet: 'playstore-tablet', feature: 'playstore-feature' },
} as const;
/** Catalog preset of each store's preview video. */
export const STORE_PREVIEW_PRESET = { appstore: 'appstore-preview', playstore: 'playstore-promo-16x9' } as const;

export const storePackSchema = z.object({
  app: z.object({ name: z.string().trim().min(1).max(60), tagline: z.string().trim().max(120) }).strict(),
  stores: z.array(z.enum(STORE_IDS)).min(1).max(2).refine((s) => new Set(s).size === s.length, 'issue.duplicateStores'),
  devices: z.object({
    appstore: z.array(z.enum(APPSTORE_DEVICES)).max(2).optional(),
    playstore: z.array(z.enum(PLAYSTORE_DEVICES)).max(3).optional(),
  }).strict(),
  /** One per screenshot, in order: its caption and the app screen (a file under `assets/` of the project) it shows, or null. */
  screenshots: z.array(z.object({ caption: z.string().trim().min(1).max(80), screen: assetFilePath.nullable() }).strict()).min(1).max(10),
  preview: z.boolean(),
}).strict().superRefine((p, ctx) => {
  const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: 'custom', message, path });
  const has = (s: StoreId) => p.stores.includes(s);
  if (has('appstore') && !p.devices.appstore?.includes('iphone-69')) issue('issue.storePackIphone', ['devices', 'appstore']);
  if (has('playstore') && !p.devices.playstore?.includes('phone')) issue('issue.storePackPhone', ['devices', 'playstore']);
  const n = p.screenshots.length;
  const min = Math.max(...p.stores.map((s) => STORE_SCREENSHOTS[s].min));
  const max = Math.min(...p.stores.map((s) => STORE_SCREENSHOTS[s].max));
  if (n < min || n > max) issue('issue.storePackScreenshots', ['screenshots']);
});
export type StorePack = z.infer<typeof storePackSchema>;

type SizedPreset = Pick<FormatPreset, 'id' | 'width' | 'height'>;

/**
 * The brief's formats for a pack, in display order: for each chosen store and device one instance per screenshot (the first is
 * the bare preset id), the feature graphic once, then the preview video. `formatLabels`: "N · caption" for a screenshot
 * (language-neutral: the caption is the user's text, and the UI names the preset); the feature graphic and the video have none
 * (the UI shows the preset name). `links` (follower → primary): the same screenshot on a device of the same pixel size as an
 * earlier one. The shipped store devices all have different sizes, so for the shipped presets `links` is always empty (Ruling D):
 * consistency across devices comes from the series prompt. `presets` only exists so the branch can be tested with equal sizes.
 */
export function storePackFormats(p: StorePack, presets: readonly SizedPreset[] = DEFAULT_FORMATS): { formats: string[]; formatLabels: Record<string, string>; links: Record<string, string> } {
  const sizeOf = (presetId: string) => {
    const f = presets.find((x) => x.id === presetId);
    return f ? `${f.width}x${f.height}` : presetId;
  };
  const formats: string[] = [];
  const formatLabels: Record<string, string> = {};
  const links: Record<string, string> = {};
  const firstOfSize = new Map<string, string[]>(); // size → instance ids of the first device with that size, by screenshot index
  const addVideo = (store: StoreId) => {
    if (!p.preview) return;
    const id = STORE_PREVIEW_PRESET[store];
    formats.push(id);
  };
  for (const store of p.stores) {
    const chosen: readonly string[] = p.devices[store] ?? [];
    const order: readonly string[] = store === 'appstore' ? APPSTORE_DEVICES : PLAYSTORE_DEVICES;
    for (const device of order.filter((d) => chosen.includes(d))) {
      const preset = (STORE_DEVICE_PRESET[store] as Record<string, string>)[device]!;
      if (device === 'feature') { formats.push(preset); continue; }
      const size = sizeOf(preset);
      const primaries = firstOfSize.get(size);
      const mine: string[] = [];
      p.screenshots.forEach((shot, i) => {
        const id = instanceIdOf(preset, i + 1);
        formats.push(id);
        mine.push(id);
        formatLabels[id] = `${i + 1} · ${shot.caption}`;
        if (primaries?.[i]) links[id] = primaries[i]!;
      });
      if (!primaries) firstOfSize.set(size, mine);
    }
    addVideo(store);
  }
  return { formats, formatLabels, links };
}

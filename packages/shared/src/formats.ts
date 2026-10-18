import { z } from 'zod';
import { LOCALES, messages, type Locale } from './i18n/index.ts';
import { instanceLabel, instancePreset, presetOf } from './format-instance.ts';
import type { BriefServices } from './services.ts';

export type FormatKind = 'video' | 'image';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const formatPresetSchema = z.object({
  id: z.string().regex(ID_RE),
  channel: z.string().min(1),
  name: z.string().min(1),
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
  kind: z.enum(['video', 'image']),
  extensions: z.array(z.string().regex(/^[a-z0-9]{2,5}$/)).min(1),
  maxDurationSec: z.number().positive().optional(),
  safeZone: z.object({ top: z.number().min(0), bottom: z.number().min(0), left: z.number().min(0), right: z.number().min(0) }).optional(),
  /** A REAL, documented upload limit of the channel (a larger file is a problem), for images and video. Never a recommendation. */
  maxFileMB: z.number().positive().optional(),
  /** Target H.264 bitrate (kbps, 30 fps) the agent aims for; a file whose effective bitrate exceeds 1.5x of it only gets a warning. */
  targetBitrateKbps: z.number().positive().optional(),
  /** Phase 14: an identity format (a vector composition that writes a whole file set, see `IDENTITY_SETS`). */
  identity: z.enum(['logo', 'favicon', 'app-icon']).optional(),
});
export type FormatPreset = z.infer<typeof formatPresetSchema>;

export const formatsFileSchema = z.object({
  schemaVersion: z.literal(1),
  presets: z.array(formatPresetSchema).min(1),
  /**
   * The built-in preset ids this file has already been offered (Phase 14, ruling AK): a default preset not in this list is
   * new and gets appended on load; one in it that the file lacks was deleted by the user and stays deleted. Absent in files
   * written before Phase 14 (the core reads it as the defaults of that time).
   */
  seenDefaults: z.array(z.string().min(1).max(200)).max(1000).optional(),
}).refine((f) => new Set(f.presets.map((p) => p.id)).size === f.presets.length, { message: 'issue.duplicatePresetIds', path: ['presets'] });
export type FormatsFile = z.infer<typeof formatsFileSchema>;

/**
 * Display name of a preset. The id is the stable key: a built-in preset whose stored name is still one of the shipped
 * names (any language) is shown in `locale`; a name the user edited, or a custom preset, is shown as stored.
 * A shipped preset the user renamed to some other text is a custom name on purpose and keeps its stored text; one renamed
 * back to a shipped name follows the language again.
 */
export function formatName(preset: Pick<FormatPreset, 'id' | 'name'>, locale: Locale): string {
  const names = (l: Locale) => messages(l).formats as Record<string, string>;
  if (!Object.hasOwn(names(locale), preset.id)) return preset.name;
  return LOCALES.some((l) => names(l)[preset.id] === preset.name) ? names(locale)[preset.id]! : preset.name;
}

/** `Instagram` → `channels.instagram`, `App Store` → `channels.appStore`; unknown channels are shown as stored. */
export function channelName(channel: string, locale: Locale): string {
  const key = channel.replace(/^./, (c) => c.toLowerCase()).replace(/\s+(\w)/g, (_, c: string) => c.toUpperCase());
  const names = messages(locale).channels as Record<string, string>;
  return Object.hasOwn(names, key) ? names[key]! : channel;
}

/** `Instagram · Post 1:1`. */
export const formatLabel = (preset: Pick<FormatPreset, 'id' | 'name' | 'channel'>, locale: Locale): string =>
  `${channelName(preset.channel, locale)} · ${formatName(preset, locale)}`;

/**
 * What an instance is called in messages and on screen (Phase 12): its label (`brief.formatLabels`), else the preset's
 * `formatLabel` plus `#k` for k > 1; the id itself when its preset is not in the catalog. A bare id without a label gives
 * exactly `formatLabel`.
 */
export function formatDisplayName(presets: readonly FormatPreset[], id: string, locale: Locale, labels?: Record<string, string>): string {
  const p = instancePreset(presets, id);
  return p ? instanceLabel(id, formatLabel({ ...p, id: presetOf(id) }, locale), labels) : id;
}

/**
 * Target H.264 bitrate (kbps) for a video of `width`x`height`. Reference points at 30 fps:
 * portrait 1080x1920 and 1080x1350: 4000; square 1080x1080: 3500; landscape 1920x1080: 5000 and 3840x2160 (4K): 20000.
 * Any other size takes the references of its orientation (portrait: h > w, landscape: w > h, square: w = h), picks the one
 * nearest in pixel count and scales linearly by pixel count (kbps = ref x pixels / refPixels), rounded to 100 kbps.
 * Frame rates above 45 fps get +50%.
 */
const BITRATE_REFS = {
  portrait: [{ w: 1080, h: 1920, kbps: 4000 }, { w: 1080, h: 1350, kbps: 4000 }],
  square: [{ w: 1080, h: 1080, kbps: 3500 }],
  landscape: [{ w: 1920, h: 1080, kbps: 5000 }, { w: 3840, h: 2160, kbps: 20000 }],
};
export function videoTargetBitrateKbps(width: number, height: number, fps = 30): number {
  const refs = BITRATE_REFS[height > width ? 'portrait' : width > height ? 'landscape' : 'square'];
  const px = width * height;
  const ref = refs.reduce((best, r) => (Math.abs(Math.log(px / (r.w * r.h))) < Math.abs(Math.log(px / (best.w * best.h))) ? r : best));
  const base = (ref.kbps * px) / (ref.w * ref.h) * (fps > 45 ? 1.5 : 1);
  return Math.max(100, Math.round(base / 100) * 100);
}

const VIDEO = ['mp4', 'webm', 'mov', 'gif'];
const IMAGE = ['png', 'jpg', 'jpeg', 'webp'];
const v = (id: string, channel: string, name: string, width: number, height: number, extra: Partial<FormatPreset> = {}): FormatPreset =>
  ({ id, channel, name, width, height, kind: 'video', extensions: VIDEO, targetBitrateKbps: videoTargetBitrateKbps(width, height), ...extra });
const i = (id: string, channel: string, name: string, width: number, height: number, extra: Partial<FormatPreset> = {}): FormatPreset =>
  ({ id, channel, name, width, height, kind: 'image', extensions: IMAGE, ...extra });

// Store specs change often: values to re-check against official docs before each release.
const REELS_SAFE = { top: 220, bottom: 420, left: 60, right: 120 };

export const DEFAULT_FORMATS: FormatPreset[] = [
  v('instagram-post-1x1', 'Instagram', 'Post 1:1', 1080, 1080, { maxDurationSec: 60 }),
  v('instagram-post-4x5', 'Instagram', 'Post 4:5', 1080, 1350, { maxDurationSec: 60 }),
  v('instagram-reel-9x16', 'Instagram', 'Story/Reel 9:16', 1080, 1920, { maxDurationSec: 90, safeZone: REELS_SAFE }),
  i('instagram-image-1x1', 'Instagram', 'Image 1:1', 1080, 1080),
  i('instagram-image-4x5', 'Instagram', 'Image 4:5', 1080, 1350),
  v('tiktok-9x16', 'TikTok', 'Video 9:16', 1080, 1920, { maxDurationSec: 180, safeZone: REELS_SAFE }),
  v('youtube-16x9', 'YouTube', 'Video 16:9', 1920, 1080),
  v('youtube-4k-16x9', 'YouTube', 'Video 4K 16:9', 3840, 2160),
  v('youtube-shorts-9x16', 'YouTube', 'Shorts 9:16', 1080, 1920, { maxDurationSec: 60, safeZone: REELS_SAFE }),
  // YouTube: 2 MB thumbnail limit, per YouTube Help; not re-verified 2026-10.
  i('youtube-thumbnail', 'YouTube', 'Thumbnail', 1280, 720, { maxFileMB: 2 }),
  v('facebook-feed-1x1', 'Facebook', 'Feed 1:1', 1080, 1080),
  v('facebook-feed-4x5', 'Facebook', 'Feed 4:5', 1080, 1350),
  v('facebook-story-9x16', 'Facebook', 'Story 9:16', 1080, 1920, { maxDurationSec: 60, safeZone: REELS_SAFE }),
  i('facebook-cover', 'Facebook', 'Cover', 1640, 624),
  v('linkedin-1x1', 'LinkedIn', 'Post 1:1', 1080, 1080),
  v('linkedin-4x5', 'LinkedIn', 'Post 4:5', 1080, 1350),
  v('linkedin-16x9', 'LinkedIn', 'Video 16:9', 1920, 1080),
  i('linkedin-banner', 'LinkedIn', 'Banner', 1584, 396),
  // X: 512 MB is the documented limit for videos uploaded with media_category=amplify_video (X developer docs, media upload).
  v('x-16x9', 'X', 'Video 16:9', 1600, 900, { maxFileMB: 512 }),
  v('x-1x1', 'X', 'Post 1:1', 1080, 1080, { maxFileMB: 512 }),
  i('pinterest-2x3', 'Pinterest', 'Pin 2:3', 1000, 1500),
  i('web-hero-16x9', 'Web', 'Hero 16:9', 1920, 1080),
  i('web-banner-300x250', 'Web', 'Banner 300×250', 300, 250),
  i('web-banner-728x90', 'Web', 'Banner 728×90', 728, 90),
  i('web-banner-160x600', 'Web', 'Banner 160×600', 160, 600),
  // Open Graph preview: 1200x630 is the size sites and networks recommend; 5 MB is the cap Facebook documents for og:image.
  i('og-image-1200x630', 'Web', 'Social preview (Open Graph)', 1200, 630, { extensions: ['png', 'jpg', 'jpeg'], maxFileMB: 5 }),
  // Identity (Phase 14, spec §4.1): vector compositions that write a whole set of files.
  i('identity-logo', 'Identity', 'Logo', 1024, 1024, { extensions: ['png'], identity: 'logo' }),
  i('identity-favicon', 'Identity', 'Website favicon', 1024, 1024, { extensions: ['png'], identity: 'favicon' }),
  i('identity-app-icon', 'Identity', 'App icon', 1024, 1024, { extensions: ['png'], identity: 'app-icon' }),
  // App Store and Google Play (Phase 12, Task 6 Step 0): sizes and limits re-checked on 2026-10-14 against the public pages
  // below (read only, no API): every shipped value still matches, nothing changed. The limits the store pack checks are in
  // `STORE_LIMITS` (end of this file).
  //   https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications/
  //   https://developer.apple.com/help/app-store-connect/reference/app-preview-specifications/
  //   https://support.google.com/googleplay/android-developer/answer/9866151
  i('appstore-iphone-69', 'App Store', 'Screenshot iPhone 6.9"', 1320, 2868),
  i('appstore-iphone-65', 'App Store', 'Screenshot iPhone 6.5"', 1284, 2778),
  i('appstore-ipad-13', 'App Store', 'Screenshot iPad 13"', 2064, 2752),
  // App Store: 500 MB is the documented maximum size of an app preview (App Store Connect help).
  v('appstore-preview', 'App Store', 'App Preview', 886, 1920, { maxDurationSec: 30, extensions: ['mp4', 'mov'], maxFileMB: 500 }),
  i('appstore-icon', 'App Store', 'Icona', 1024, 1024),
  i('playstore-feature', 'Play Store', 'Feature graphic', 1024, 500),
  i('playstore-phone-9x16', 'Play Store', 'Screenshot telefono 9:16', 1080, 1920),
  i('playstore-tablet', 'Play Store', 'Screenshot tablet', 1600, 2560),
  i('playstore-icon', 'Play Store', 'Icona', 512, 512),
  v('playstore-promo-16x9', 'Play Store', 'Video promo 16:9', 1920, 1080),
];

/**
 * The store requirements the App Store pack checks before export (Phase 12, spec §4.2), as documented on the pages named in the
 * comment above the App Store presets, checked on `checkedOn`. Screenshots and the feature graphic: PNG or JPEG, the preset's
 * exact size, no alpha channel (both stores). App Store preview: H.264, `fps` frames per second at most (Motion Studio renders
 * exactly 30), `minSec`–`maxSec` seconds, an audio track (AAC 256 kbps stereo). Google Play takes the promo video as a YouTube
 * link, never as a file.
 */
export const STORE_LIMITS = {
  checkedOn: '2026-10-14',
  sources: [
    'https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications/',
    'https://developer.apple.com/help/app-store-connect/reference/app-preview-specifications/',
    'https://support.google.com/googleplay/android-developer/answer/9866151',
  ],
  appstore: {
    screenshots: { min: 1, max: 10 },
    preview: { minSec: 15, maxSec: 30, fps: 30, codec: 'h264', audioKbps: 256, maxFileMB: 500, maxPerDevice: 3 },
  },
  playstore: {
    screenshots: { min: 2, max: 8, minSide: 320, maxSide: 3840 },
    feature: { width: 1024, height: 500 },
    /** Only the first 30 seconds autoplay on the listing. */
    promoAutoplaySec: 30,
  },
} as const;

/**
 * The brief's services narrowed to what its formats can use (decision 1125), the one rule every "paid services a turn may use"
 * computation shares (the variants card, the agent's tool lines, the bridge): voice, music and sound effects only when some
 * format is a video (a still image or an identity file has no audio track); generated and stock images not at all when every
 * format is an identity output (a vector logo, favicon or app icon embeds no raster image). A format missing from the catalog
 * is not guessed: with none known, the services stay as they are. Choices already `none` stay `none`.
 */
export function servicesForFormats(services: BriefServices | undefined, formatIds: readonly string[], presets: readonly FormatPreset[]): BriefServices | undefined {
  const known = formatIds.map((id) => instancePreset(presets, id));
  if (known.length === 0 || known.some((p) => !p)) return services;
  const ps = known as FormatPreset[];
  const out: BriefServices = { ...services };
  if (!ps.some((p) => p.kind === 'video')) { out.voice = 'none'; out.music = 'none'; out.sfx = 'none'; }
  if (ps.every((p) => p.identity)) out.images = 'none';
  return out;
}

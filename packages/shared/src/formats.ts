import { z } from 'zod';

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
  maxFileMB: z.number().positive().optional(),
});
export type FormatPreset = z.infer<typeof formatPresetSchema>;

export const formatsFileSchema = z.object({
  schemaVersion: z.literal(1),
  presets: z.array(formatPresetSchema).min(1),
}).refine((f) => new Set(f.presets.map((p) => p.id)).size === f.presets.length, { message: 'id dei preset duplicati', path: ['presets'] });
export type FormatsFile = z.infer<typeof formatsFileSchema>;

const VIDEO = ['mp4', 'webm', 'mov', 'gif'];
const IMAGE = ['png', 'jpg', 'jpeg', 'webp'];
const v = (id: string, channel: string, name: string, width: number, height: number, extra: Partial<FormatPreset> = {}): FormatPreset =>
  ({ id, channel, name, width, height, kind: 'video', extensions: VIDEO, ...extra });
const i = (id: string, channel: string, name: string, width: number, height: number, extra: Partial<FormatPreset> = {}): FormatPreset =>
  ({ id, channel, name, width, height, kind: 'image', extensions: IMAGE, ...extra });

// Store specs change often: values to re-check against official docs before each release.
const REELS_SAFE = { top: 220, bottom: 420, left: 60, right: 120 };

export const DEFAULT_FORMATS: FormatPreset[] = [
  v('instagram-post-1x1', 'Instagram', 'Post 1:1', 1080, 1080, { maxDurationSec: 60 }),
  v('instagram-post-4x5', 'Instagram', 'Post 4:5', 1080, 1350, { maxDurationSec: 60 }),
  v('instagram-reel-9x16', 'Instagram', 'Story/Reel 9:16', 1080, 1920, { maxDurationSec: 90, safeZone: REELS_SAFE }),
  i('instagram-image-1x1', 'Instagram', 'Immagine 1:1', 1080, 1080),
  i('instagram-image-4x5', 'Instagram', 'Immagine 4:5', 1080, 1350),
  v('tiktok-9x16', 'TikTok', 'Video 9:16', 1080, 1920, { maxDurationSec: 180, safeZone: REELS_SAFE }),
  v('youtube-16x9', 'YouTube', 'Video 16:9', 1920, 1080),
  v('youtube-4k-16x9', 'YouTube', 'Video 4K 16:9', 3840, 2160),
  v('youtube-shorts-9x16', 'YouTube', 'Shorts 9:16', 1080, 1920, { maxDurationSec: 60, safeZone: REELS_SAFE }),
  i('youtube-thumbnail', 'YouTube', 'Thumbnail', 1280, 720, { maxFileMB: 2 }),
  v('facebook-feed-1x1', 'Facebook', 'Feed 1:1', 1080, 1080),
  v('facebook-feed-4x5', 'Facebook', 'Feed 4:5', 1080, 1350),
  v('facebook-story-9x16', 'Facebook', 'Story 9:16', 1080, 1920, { maxDurationSec: 60, safeZone: REELS_SAFE }),
  i('facebook-cover', 'Facebook', 'Cover', 1640, 624),
  v('linkedin-1x1', 'LinkedIn', 'Post 1:1', 1080, 1080),
  v('linkedin-4x5', 'LinkedIn', 'Post 4:5', 1080, 1350),
  v('linkedin-16x9', 'LinkedIn', 'Video 16:9', 1920, 1080),
  i('linkedin-banner', 'LinkedIn', 'Banner', 1584, 396),
  v('x-16x9', 'X', 'Video 16:9', 1600, 900),
  v('x-1x1', 'X', 'Post 1:1', 1080, 1080),
  i('pinterest-2x3', 'Pinterest', 'Pin 2:3', 1000, 1500),
  i('web-hero-16x9', 'Web', 'Hero 16:9', 1920, 1080),
  i('web-banner-300x250', 'Web', 'Banner 300×250', 300, 250),
  i('web-banner-728x90', 'Web', 'Banner 728×90', 728, 90),
  i('web-banner-160x600', 'Web', 'Banner 160×600', 160, 600),
  i('appstore-iphone-69', 'App Store', 'Screenshot iPhone 6.9"', 1320, 2868),
  i('appstore-iphone-65', 'App Store', 'Screenshot iPhone 6.5"', 1284, 2778),
  i('appstore-ipad-13', 'App Store', 'Screenshot iPad 13"', 2064, 2752),
  v('appstore-preview', 'App Store', 'App Preview', 886, 1920, { maxDurationSec: 30, extensions: ['mp4', 'mov'] }),
  i('appstore-icon', 'App Store', 'Icona', 1024, 1024),
  i('playstore-feature', 'Play Store', 'Feature graphic', 1024, 500),
  i('playstore-phone-9x16', 'Play Store', 'Screenshot telefono 9:16', 1080, 1920),
  i('playstore-tablet', 'Play Store', 'Screenshot tablet', 1600, 2560),
  i('playstore-icon', 'Play Store', 'Icona', 512, 512),
  v('playstore-promo-16x9', 'Play Store', 'Video promo 16:9', 1920, 1080),
];

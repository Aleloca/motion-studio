import { z } from 'zod';
import type { FormatPreset } from './formats.ts';
import { isStorePackFormat } from './store-pack.ts';

/**
 * The quality and resolution of a video render (decision 974, user report 22): what Export offers and what a render records.
 *
 * - **Quality** `standard` (the phase 8 target bitrate, VideoToolbox allowed: the renders before this choice), `high` (the
 *   default: libx264 CRF 18 capped at 1.6x the target, about 8 Mbps at 1080p30 as YouTube recommends) and `max` (libx264
 *   CRF 16 without a cap, PNG frames).
 * - **Resolution** the short side of the output (`EXPORT_RESOLUTIONS`), the format's ratio kept, even sides; absent: the
 *   format's own size. The composition is laid out at its own size and rasterised at the scale (sharp text and shapes).
 * - **Frame rate** (report 39, decision 1233) one of `EXPORT_FPS`, the composition's time sampled at it (t = i / fps);
 *   absent: the composition's own fps.
 * - A version's own render (`outputs/vN/<format>.<ext>`, the one the app plays) is always at the format's size, `high` and
 *   the composition's fps;
 *   another profile is rendered for the export alone. Stills, identity formats and store pack formats have no profile.
 */
export const EXPORT_QUALITIES = ['standard', 'high', 'max'] as const;
export type ExportQuality = (typeof EXPORT_QUALITIES)[number];
export const DEFAULT_EXPORT_QUALITY: ExportQuality = 'high';
/** The short sides Export offers (480p … 2160p). */
export const EXPORT_RESOLUTIONS = [480, 720, 1080, 1440, 2160] as const;
export type ExportResolution = (typeof EXPORT_RESOLUTIONS)[number];

/** The frame rates Export offers (report 39, decision 1233): the values a composition's `fps` may take. */
export const EXPORT_FPS = [24, 25, 30, 50, 60] as const;
export type ExportFps = (typeof EXPORT_FPS)[number];

/**
 * What a render is made with: the quality and, when not the format's own size, the short side; `fps` when asked for (absent:
 * the composition's own fps).
 */
export interface RenderProfile { quality: ExportQuality; short?: number; fps?: ExportFps }
export const DEFAULT_RENDER_PROFILE: RenderProfile = { quality: DEFAULT_EXPORT_QUALITY };

/** The quality multiplier of the target bitrate (`max` has no cap: its value is only the reference for the bitrate warning). */
export const QUALITY_BITRATE_FACTOR: Record<ExportQuality, number> = { standard: 1, high: 1.6, max: 3 };

const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);

/** The output size of `size` at short side `short` (the ratio kept, even sides); the size itself when `short` is absent or its own. */
export function scaledSize(size: { width: number; height: number }, short?: number): { width: number; height: number } {
  const own = Math.min(size.width, size.height);
  if (short === undefined || short === own) return { width: size.width, height: size.height };
  const k = short / own;
  return size.width <= size.height ? { width: short, height: even(size.height * k) } : { width: even(size.width * k), height: short };
}

/** Whether a format takes a profile: a video that is not an identity format or a store pack format (their sizes are fixed). */
export function profileApplies(preset: Pick<FormatPreset, 'kind' | 'identity'> | null | undefined, format: string): boolean {
  return preset?.kind === 'video' && !preset.identity && !isStorePackFormat(format);
}

/** The profile for a format: `short` dropped when it is the format's own short side (or the format takes no profile). */
export function profileFor(preset: Pick<FormatPreset, 'kind' | 'identity' | 'width' | 'height'> | null | undefined, format: string, p: RenderProfile): RenderProfile {
  if (!preset || !profileApplies(preset, format)) return DEFAULT_RENDER_PROFILE;
  const fps = p.fps !== undefined ? { fps: p.fps } : {};
  return p.short === undefined || p.short === Math.min(preset.width, preset.height) ? { quality: p.quality, ...fps } : { quality: p.quality, short: p.short, ...fps };
}

/**
 * The version's own render profile (format size, the default quality, the composition's fps). A profile naming an fps is
 * never the default, even the composition's own: the version's render is reused for it only when its record says that fps.
 */
export const isDefaultProfile = (p: RenderProfile) => p.quality === DEFAULT_EXPORT_QUALITY && p.short === undefined && p.fps === undefined;

/**
 * What a render recorded about itself (`OutputFileInfo.render`, the manifest's `renders[].render`): its quality, its size and
 * the H.264 encoder that ran (null for a still). Renders made before it have none: they count as `standard`. `fps` (report 39,
 * decision 1233): the frame rate it was made at; absent in renders made before it, which are at the composition's fps.
 */
export const renderInfoSchema = z.object({
  quality: z.enum(EXPORT_QUALITIES),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  encoder: z.enum(['libx264', 'h264_videotoolbox']).nullable(),
  fps: z.literal(EXPORT_FPS).optional(),
});
export type RenderInfo = z.infer<typeof renderInfoSchema>;

/** The quality a recorded render was made with (`standard` for one without a record). */
export const recordedQuality = (o: { render?: RenderInfo } | null | undefined): ExportQuality => o?.render?.quality ?? 'standard';

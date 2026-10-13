import { rm } from 'node:fs/promises';
import { presetOf, STORE_DEVICE_PRESET, STORE_PREVIEW_PRESET, type Composition } from '@motion-studio/shared';
import { MP4_DEMUXERS, ownInput } from '../media/ffmpeg-exec.ts';
import { flattenFilter, silentAudioInput } from '../media/ffmpeg-filters.ts';
import { runFfmpeg, type FfmpegInfo } from '../render/encode.ts';
import { readImageInfo } from './requirements.ts';

/**
 * The store steps of a render (Phase 12, spec §4.2):
 * - **Flatten.** A store screenshot or the Play feature graphic must have no alpha channel (both stores refuse one), so the
 *   still the browser captured is drawn onto the composition background and written as RGB (`format=rgb24`): the PNG's IHDR
 *   colour type is 2. Through the ffmpeg helper and the typed filter builders only.
 * - **Store audio.** The App Store preview needs an audio track: the render muxes the mix at 256 kbps AAC (Apple's figure)
 *   and, when the composition has no audio at all, adds a silent stereo AAC track of the video's exact length.
 */

/** Presets whose render is flattened (store screenshots and the Play feature graphic). */
export const STORE_FLATTEN_PRESETS: ReadonlySet<string> = new Set([
  ...Object.values(STORE_DEVICE_PRESET.appstore), 'appstore-iphone-65', ...Object.values(STORE_DEVICE_PRESET.playstore),
]);
/** Presets rendered with the store audio track. */
export const STORE_AUDIO_PRESETS: ReadonlySet<string> = new Set([STORE_PREVIEW_PRESET.appstore]);

/** Audio of a store preview: AAC at this bitrate, 48 kHz stereo. */
export const STORE_AUDIO_KBPS = 256;
const AUDIO_RATE = 48_000;

export interface StoreRenderOptions {
  /** Flatten the still onto this colour (the composition background). */
  flattenOnto?: string;
  /** An App Store preview: audio at 256 kbps, and a silent track when the composition has none. */
  storeAudio?: boolean;
}

/** The store steps for a render of format instance `formatId` of `composition` (none for any other format). */
export function storeRenderOptions(formatId: string, composition: Pick<Composition, 'background' | 'duration'>): StoreRenderOptions {
  const preset = presetOf(formatId);
  const still = !(composition.duration > 0);
  if (still && STORE_FLATTEN_PRESETS.has(preset)) return { flattenOnto: composition.background };
  if (!still && STORE_AUDIO_PRESETS.has(preset)) return { storeAudio: true };
  return {};
}

/**
 * The six lowercase hex digits of the opaque colour a composition background (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) is
 * flattened onto. Ruling O: a background with alpha is mixed with white (fully transparent: white), as the preview shows it.
 */
export function backgroundRgb(color: string): string {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color);
  if (!m) throw new RangeError(`not a composition colour: ${color}`);
  const raw = m[1]!.toLowerCase();
  const hex = raw.length <= 4 ? [...raw].map((x) => x + x).join('') : raw;
  const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return [0, 2, 4].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * alpha + 255 * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}

/**
 * Writes `dst`: the PNG `src` (exactly `width`×`height`) flattened onto `background`, without alpha. Throws when `src` is
 * not a PNG of that size or the result is not an RGB PNG of that size (then `dst` is removed).
 */
export async function flattenPng(ff: FfmpegInfo, src: string, dst: string, o: { width: number; height: number; background: string }, signal?: AbortSignal): Promise<void> {
  const before = await readImageInfo(src);
  if (!before.ok || before.format !== 'png' || before.width !== o.width || before.height !== o.height) {
    throw new Error(`flatten: the capture is not a ${o.width}×${o.height} PNG`);
  }
  try {
    await runFfmpeg(ff, [...ownInput(src, { formats: ['png_pipe'], force: true }),
      flattenFilter(o.width, o.height, backgroundRgb(o.background)), '-map', '[out]', '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', dst], signal ? { signal } : {});
    const after = await readImageInfo(dst);
    if (!after.ok || after.format !== 'png' || after.alpha || after.width !== o.width || after.height !== o.height) throw new Error('flatten: the result is not an RGB PNG of the format size');
  } catch (e) {
    await rm(dst, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Writes `dst`: the video of `src` (copied, not re-encoded) with a silent stereo AAC track of exactly `durationSec`
 * (48 kHz, 256 kbps), `+faststart`. Throws on failure (then `dst` is removed).
 */
export async function withSilentAudio(ff: FfmpegInfo, src: string, dst: string, o: { durationSec: number; container: 'mp4' | 'mov' }, signal?: AbortSignal): Promise<void> {
  const samples = Math.max(1, Math.round(o.durationSec * AUDIO_RATE));
  try {
    await runFfmpeg(ff, [...ownInput(src, { formats: MP4_DEMUXERS }), silentAudioInput(samples, AUDIO_RATE),
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', `${STORE_AUDIO_KBPS}k`, '-ar', String(AUDIO_RATE), '-ac', '2',
      '-movflags', '+faststart', '-f', o.container, dst], signal ? { signal } : {});
  } catch (e) {
    await rm(dst, { force: true }).catch(() => {});
    throw e;
  }
}

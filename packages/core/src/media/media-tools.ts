import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execCommand, type CommandExec } from '../exec.ts';
import { execFfVia, isRegularFileNow, mediaInput, type FfArg } from './ffmpeg-exec.ts';
import { frameScaleFilter, waveformPcmFilter } from './ffmpeg-filters.ts';
import { isSvgName, svgSize } from './svg-size.ts';

export interface MediaInfo { width: number; height: number; durationSec: number | null; /** Average frame rate of the video stream, when known. */ fps?: number;
  /** The video stream's codec (ffprobe name, e.g. `h264`), when known (Phase 12: store checks). */
  videoCodec?: string;
  /** Whether the file has an audio stream (Phase 12: the App Store preview needs one); absent when not probed by ffprobe. */
  audio?: boolean;
  /**
   * Report 70 (round 1): the clockwise rotation a player applies (90, 180 or 270) from the stream's display matrix or its
   * `rotate` tag; absent when none. `width` and `height` stay the coded size (what an encoder makes and the renders check).
   */
  rotation?: 90 | 180 | 270 }

/** The size a player shows: the coded size with its sides swapped at 90 and 270 degrees. */
export const displaySize = (m: Pick<MediaInfo, 'width' | 'height' | 'rotation'>): { width: number; height: number } =>
  (m.rotation === 90 || m.rotation === 270 ? { width: m.height, height: m.width } : { width: m.width, height: m.height });

/** ffprobe's rotation (the display matrix's counter-clockwise degrees, or the older `rotate` tag) as 90/180/270, or undefined. */
function rotationOf(s: { tags?: { rotate?: unknown }; side_data_list?: Array<{ rotation?: unknown }> }): MediaInfo['rotation'] {
  const matrix = s.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation as number | undefined;
  // The display matrix says counter-clockwise (-90 = a quarter turn clockwise), the tag clockwise.
  const deg = matrix !== undefined ? -matrix : Number(s.tags?.rotate ?? 0);
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r === 90 || r === 180 || r === 270 ? r : undefined;
}

export interface MediaTools {
  readonly available: boolean;
  probe(file: string): Promise<MediaInfo | null>;
  /** An audio file's duration (null when unknown); null when it has no audio stream or cannot be read. Optional: test doubles. */
  probeAudio?(file: string): Promise<{ durationSec: number | null } | null>;
  /**
   * Decodes the first audio stream of `file` (at most `maxSec` seconds) to raw mono s16le PCM at `sampleRate` in `out`
   * (a fresh path the caller owns). False when the file has no decodable audio. Optional: test doubles.
   */
  decodePcm?(file: string, out: string, o: { sampleRate: number; maxSec: number }): Promise<boolean>;
  poster(video: string, out: string, atSec?: number): Promise<boolean>;
  /** One frame at `atSec` (or the first one when the clip is shorter). `width`: shrink to at most this width (never enlarge). */
  frame(video: string, out: string, atSec: number, opts?: { width?: number }): Promise<boolean>;
}

export const NoMediaTools: MediaTools = {
  available: false,
  probe: async () => null,
  poster: async () => false,
  frame: async () => false,
};

const STILL_CODECS = new Set(['png', 'mjpeg', 'webp', 'bmp', 'tiff']);

/** The waveforms' decode (`MediaTools.decodePcm`) through `exec`: the first audio stream as mono s16le PCM at `sampleRate`. */
export function decodePcmWith(exec: CommandExec): NonNullable<MediaTools['decodePcm']> {
  return async (file, out, o) => {
    if (isSvgName(file) || !isRegularFileNow(file)) return false;
    const r = await execFfVia(exec, 'ffmpeg', ['-y', '-loglevel', 'error', ...mediaInput({ file }), '-vn', '-map', '0:a:0', '-t', String(Math.max(1, Math.round(o.maxSec))), waveformPcmFilter(o.sampleRate), '-f', 's16le', out], { timeoutMs: 120_000 });
    return r.code === 0 && ((await stat(out).catch(() => null))?.size ?? 0) > 0;
  };
}

export async function createFfmpegTools(exec: CommandExec = execCommand): Promise<MediaTools> {
  const check = await execFfVia(exec, 'ffprobe', ['-version'], { timeoutMs: 10_000 });
  if (check.code !== 0) return NoMediaTools;

  const grab = async (video: string, out: string, atSec: number, opts?: { width?: number }) => {
    // SVG: never given to ffmpeg (final wave P1: no svg_pipe, whose renderer may resolve external references).
    if (isSvgName(video)) return false;
    // Only a regular file is handed to ffmpeg (a FIFO, socket or device would stall it: M6).
    if (!isRegularFileNow(video)) return false;
    await mkdir(dirname(out), { recursive: true });
    // The JPEG muxer is always named: a temp name has no image extension, and the image2 muxer (picked by extension) would
    // read `%` in the output path as a frame-number pattern.
    const fmt: FfArg[] = [...(opts?.width ? [frameScaleFilter(Math.round(opts.width))] : []), '-f', 'mjpeg'];
    // A seek past the end (a still, or a clip shorter than atSec) exits 0 with no frame written: checked on disk.
    const wrote = async () => ((await stat(out).catch(() => null))?.size ?? 0) > 0;
    const r = await execFfVia(exec, 'ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(atSec), ...mediaInput({ file: video }), '-frames:v', '1', '-q:v', '3', ...fmt, out], { timeoutMs: 60_000 });
    if (r.code === 0 && await wrote()) return true;
    if (atSec === 0) return false;
    // Clips shorter than atSec: fall back to the first frame.
    return (await execFfVia(exec, 'ffmpeg', ['-y', '-loglevel', 'error', ...mediaInput({ file: video }), '-frames:v', '1', '-q:v', '3', ...fmt, out], { timeoutMs: 60_000 })).code === 0 && await wrote();
  };

  return {
    available: true,
    async probe(file) {
      // SVG: its size from a plain text scan (svg-size.ts), never ffprobe.
      if (isSvgName(file)) { const s = await svgSize(file); return s ? { ...s, durationSec: null } : null; }
      if (!isRegularFileNow(file)) return null;
      const r = await execFfVia(exec, 'ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', ...mediaInput({ file })], { timeoutMs: 30_000 });
      if (r.code !== 0) return null;
      try {
        const data = JSON.parse(r.stdout) as { streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; tags?: { rotate?: unknown }; side_data_list?: Array<{ rotation?: unknown }> }>; format?: { duration?: string } };
        const s = data.streams?.find((x) => x.codec_type === 'video' && x.width && x.height);
        if (!s?.width || !s.height) return null;
        const still = s.codec_name !== undefined && STILL_CODECS.has(s.codec_name);
        const d = Number(data.format?.duration);
        const [num, den] = (s.avg_frame_rate ?? '').split('/').map(Number);
        const fps = num && den && Number.isFinite(num / den) ? num / den : undefined;
        const rotation = rotationOf(s);
        return { width: s.width, height: s.height, ...(rotation ? { rotation } : {}), durationSec: !still && Number.isFinite(d) && d > 0 ? d : null, ...(fps && !still ? { fps } : {}),
          ...(typeof s.codec_name === 'string' ? { videoCodec: s.codec_name } : {}), audio: data.streams?.some((x) => x.codec_type === 'audio') ?? false };
      } catch {
        return null;
      }
    },
    async probeAudio(file) {
      if (isSvgName(file) || !isRegularFileNow(file)) return null;
      const r = await execFfVia(exec, 'ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', ...mediaInput({ file })], { timeoutMs: 30_000 });
      if (r.code !== 0) return null;
      try {
        const data = JSON.parse(r.stdout) as { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
        if (!data.streams?.some((x) => x.codec_type === 'audio')) return null;
        const d = Number(data.format?.duration);
        return { durationSec: Number.isFinite(d) && d > 0 ? d : null };
      } catch {
        return null;
      }
    },
    decodePcm: decodePcmWith(exec),
    poster: (video, out, atSec = 0.5) => grab(video, out, atSec),
    frame: (video, out, atSec, opts) => grab(video, out, atSec, opts),
  };
}

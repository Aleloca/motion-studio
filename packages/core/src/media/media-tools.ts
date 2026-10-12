import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execCommand, type CommandExec } from '../exec.ts';
import { execFfVia, mediaInput } from './ffmpeg-exec.ts';
import { isSvgName, svgSize } from './svg-size.ts';

export interface MediaInfo { width: number; height: number; durationSec: number | null; /** Average frame rate of the video stream, when known. */ fps?: number }
export interface MediaTools {
  readonly available: boolean;
  probe(file: string): Promise<MediaInfo | null>;
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

export async function createFfmpegTools(exec: CommandExec = execCommand): Promise<MediaTools> {
  const check = await execFfVia(exec, 'ffprobe', ['-version'], { timeoutMs: 10_000 });
  if (check.code !== 0) return NoMediaTools;

  const grab = async (video: string, out: string, atSec: number, opts?: { width?: number }) => {
    // SVG: never given to ffmpeg (final wave P1: no svg_pipe, whose renderer may resolve external references).
    if (isSvgName(video)) return false;
    await mkdir(dirname(out), { recursive: true });
    // The JPEG muxer is always named: a temp name has no image extension, and the image2 muxer (picked by extension) would
    // read `%` in the output path as a frame-number pattern.
    const fmt = [...(opts?.width ? ['-vf', `scale='min(${Math.round(opts.width)},iw)':-2`] : []), '-f', 'mjpeg'];
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
      const r = await execFfVia(exec, 'ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', ...mediaInput({ file })], { timeoutMs: 30_000 });
      if (r.code !== 0) return null;
      try {
        const data = JSON.parse(r.stdout) as { streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }>; format?: { duration?: string } };
        const s = data.streams?.find((x) => x.codec_type === 'video' && x.width && x.height);
        if (!s?.width || !s.height) return null;
        const still = s.codec_name !== undefined && STILL_CODECS.has(s.codec_name);
        const d = Number(data.format?.duration);
        const [num, den] = (s.avg_frame_rate ?? '').split('/').map(Number);
        const fps = num && den && Number.isFinite(num / den) ? num / den : undefined;
        return { width: s.width, height: s.height, durationSec: !still && Number.isFinite(d) && d > 0 ? d : null, ...(fps && !still ? { fps } : {}) };
      } catch {
        return null;
      }
    },
    poster: (video, out, atSec = 0.5) => grab(video, out, atSec),
    frame: (video, out, atSec, opts) => grab(video, out, atSec, opts),
  };
}

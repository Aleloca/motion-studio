import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execCommand, type CommandExec } from '../exec.ts';
import { execFfVia, mediaInput } from './ffmpeg-exec.ts';

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
    await mkdir(dirname(out), { recursive: true });
    // A temp name (`….tmp`, renamed into place by the caller) has no image extension: the JPEG muxer is named explicitly.
    const fmt = [...(opts?.width ? ['-vf', `scale='min(${Math.round(opts.width)},iw)':-2`] : []), ...(out.endsWith('.tmp') ? ['-f', 'mjpeg'] : [])];
    const r = await execFfVia(exec, 'ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(atSec), ...mediaInput({ file: video }), '-frames:v', '1', '-q:v', '3', ...fmt, out], { timeoutMs: 60_000 });
    if (r.code === 0) return true;
    if (atSec === 0) return false;
    // Clips shorter than atSec: fall back to the first frame.
    return (await execFfVia(exec, 'ffmpeg', ['-y', '-loglevel', 'error', ...mediaInput({ file: video }), '-frames:v', '1', '-q:v', '3', ...fmt, out], { timeoutMs: 60_000 })).code === 0;
  };

  return {
    available: true,
    async probe(file) {
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

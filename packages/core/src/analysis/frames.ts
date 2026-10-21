import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FRAME_LONG_SIDE, REDUCED_FRAME_EVERY_SEC, STATIC_FRAME_EVERY_SEC } from '@motion-studio/shared';
import type { CommandExec } from '../exec.ts';
import { execFfVia, isRegularFileNow, mediaInput } from '../media/ffmpeg-exec.ts';
import { longSideScaleFilter, sceneDetectFilter } from '../media/ffmpeg-filters.ts';
import { frameName } from './sidecar.ts';

/** Scene score above which ffmpeg's scene detection marks a cut (decision 1492). */
export const SCENE_THRESHOLD = 0.3;
/** Cuts closer than this (s) are one cut. */
const CUT_MERGE_SEC = 0.5;

/** How long an ffmpeg pass over a whole video may take: twice its duration, at least two minutes. */
export const passTimeoutMs = (durationSec: number) => Math.max(120_000, Math.round(2 * durationSec * 1000));

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError(); };

/** The scene cuts of `video` (seconds, sorted, merged within half a second), from `showinfo`'s `pts_time` on stderr. */
export async function detectScenes(exec: CommandExec, video: string, durationSec: number, signal?: AbortSignal): Promise<number[]> {
  checkAbort(signal);
  if (!isRegularFileNow(video)) throw new Error('not a regular file');
  const r = await execFfVia(exec, 'ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'info', ...mediaInput({ file: video }), '-an', sceneDetectFilter(SCENE_THRESHOLD), '-f', 'null', '-'], { timeoutMs: passTimeoutMs(durationSec), ...(signal ? { signal } : {}) });
  checkAbort(signal);
  if (r.code !== 0) throw new Error(`scene detection failed (${r.code})`);
  const times = [...r.stderr.matchAll(/Parsed_showinfo[^\n]*?pts_time:\s*([0-9.]+)/g)].map((m) => Number(m[1])).filter((t) => Number.isFinite(t) && t > 0);
  const out: number[] = [];
  for (const t of times.sort((a, b) => a - b)) if (out.length === 0 || t - out.at(-1)! >= CUT_MERGE_SEC) out.push(t);
  return out;
}

/**
 * The frame times (decision 1487, no fixed cap): `full`, each scene's start plus one every 10 s inside it (while more than a
 * second of the scene is left); with no cut, one every 10 s. `reduced` (a long video analysed lighter): scene starts only,
 * none within 30 s of the previous one kept; with no cut, one every 30 s. Times are clamped inside the video.
 */
export function planFrames(cuts: number[], durationSec: number, density: 'full' | 'reduced'): number[] {
  const duration = Math.max(0, durationSec);
  const starts = [0, ...cuts.filter((c) => c > 0 && c < duration).sort((a, b) => a - b)];
  const raw: number[] = [];
  if (density === 'reduced') {
    if (starts.length === 1) for (let t = 0; t === 0 || t < duration - 1; t += REDUCED_FRAME_EVERY_SEC) raw.push(t);
    else for (const s of starts) if (raw.length === 0 || s - raw.at(-1)! >= REDUCED_FRAME_EVERY_SEC) raw.push(s);
  } else {
    starts.forEach((s, i) => {
      const end = starts[i + 1] ?? duration;
      for (let t = s; t === s || t < end - 1; t += STATIC_FRAME_EVERY_SEC) raw.push(t);
    });
  }
  const last = Math.max(0, duration - 0.1);
  const out: number[] = [];
  for (const t of raw.map((x) => Math.round(Math.min(x, last) * 1000) / 1000)) if (!out.includes(t)) out.push(t);
  return out;
}

/** One JPEG per time into `outDir` (made 0700), named `frameName(t)`, the long side at most 768 px; the names written. */
export async function extractFrames(exec: CommandExec, video: string, times: number[], outDir: string, signal?: AbortSignal): Promise<string[]> {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  for (const t of times) {
    checkAbort(signal);
    if (!isRegularFileNow(video)) throw new Error('not a regular file');
    const name = frameName(t);
    const out = join(outDir, name);
    // The JPEG muxer is named: the image2 muxer would read `%` in the output path as a pattern.
    const r = await execFfVia(exec, 'ffmpeg', ['-y', '-nostdin', '-loglevel', 'error', '-ss', String(t), ...mediaInput({ file: video }), '-frames:v', '1', longSideScaleFilter(FRAME_LONG_SIDE), '-q:v', '3', '-f', 'mjpeg', out], { timeoutMs: 60_000, ...(signal ? { signal } : {}) });
    if (r.code === 0 && ((await stat(out).catch(() => null))?.size ?? 0) > 0) written.push(name);
  }
  checkAbort(signal);
  return written;
}

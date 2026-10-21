import { stat } from 'node:fs/promises';
import type { CommandExec } from '../exec.ts';
import { execFfVia, isRegularFileNow, mediaInput, ownInput } from '../media/ffmpeg-exec.ts';
import { silenceDetectFilter } from '../media/ffmpeg-filters.ts';
import { abortError, passTimeoutMs } from './frames.ts';

/**
 * The video's first audio track as 16 kHz mono PCM WAV (spec §5.2), for the silence check and the transcription. False when
 * the video has no audio track (or it cannot be decoded).
 */
export async function extractWav(exec: CommandExec, video: string, outWav: string, signal?: AbortSignal, durationSec = 0): Promise<boolean> {
  if (signal?.aborted) throw abortError();
  if (!isRegularFileNow(video)) return false;
  const r = await execFfVia(exec, 'ffmpeg', ['-y', '-loglevel', 'error', '-nostdin', ...mediaInput({ file: video }), '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', outWav], { timeoutMs: passTimeoutMs(durationSec) });
  if (signal?.aborted) throw abortError();
  return r.code === 0 && ((await stat(outWav).catch(() => null))?.size ?? 0) > 44;
}

/**
 * The share (0..1) of `wav` that is silence: the sum of `silencedetect`'s silences (below -50 dB for at least half a second)
 * over the duration; a silence still open at the end counts to the end.
 */
export async function silenceRatio(exec: CommandExec, wav: string, durationSec: number, signal?: AbortSignal): Promise<number> {
  if (durationSec <= 0) return 1;
  const r = await execFfVia(exec, 'ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'info', ...ownInput(wav, { formats: ['wav'], force: true }), silenceDetectFilter(-50, 0.5), '-f', 'null', '-'], { timeoutMs: passTimeoutMs(durationSec) });
  if (signal?.aborted) throw abortError();
  if (r.code !== 0) throw new Error(`silence detection failed (${r.code})`);
  let silent = 0;
  let open: number | null = null;
  for (const m of r.stderr.matchAll(/silence_(start|end):\s*(-?[0-9.]+)/g)) {
    const t = Math.max(0, Number(m[2]));
    if (!Number.isFinite(t)) continue;
    if (m[1] === 'start') open = t;
    else if (open !== null) { silent += Math.max(0, t - open); open = null; }
  }
  if (open !== null) silent += Math.max(0, durationSec - open);
  return Math.min(1, silent / durationSec);
}

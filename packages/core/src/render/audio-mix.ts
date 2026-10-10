import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Composition } from '@motion-studio/shared';
import { copyConfinedFile, withConfinedFile } from '../brand/agent-guard.ts';
import { RenderError } from './chromium-provider.ts';
import { runFfmpeg, type FfmpegInfo } from './encode.ts';

/**
 * The audio of a composition (spec §5.3; spike §5), mixed sample-accurately with ffmpeg:
 * `aresample=48000 → atrim (trimStart, clip duration, in samples) → volume → afade in/out → adelay (samples)` per clip, then
 * `amix normalize=0` (the default divides every input by the input count, so levels would jump when clips start and stop),
 * padded and cut to exactly `duration × 48000` samples, and an `alimiter` on the master (with its lookahead compensated, so
 * it adds no delay). The result is a float WAV that the final mux encodes to AAC 128k.
 *
 * Sources are read through the confined-read checks (no symlink, a single-linked regular file inside the composition
 * folder): ffmpeg gets the already open file descriptors (`-fd N -i fd:`), so a path is never re-resolved by ffmpeg. An
 * ffmpeg without the `fd` protocol gets a confined copy in the render's temp folder instead.
 */

export const AUDIO_RATE = 48_000;

export interface MixClip {
  /** Path inside the composition folder (`assets/…`). */
  src: string;
  /** Composition seconds. */
  start: number;
  duration: number;
  /** Seconds skipped at the start of the source. */
  trimStart: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** A video clip: mixed only when its source has an audio stream. */
  fromVideo: boolean;
}

/** Every audio clip, and every video clip with a volume, of the unmuted tracks, in timeline order; clips past the end are cut. */
export function mixClips(c: Composition): MixClip[] {
  const out: MixClip[] = [];
  if (!(c.duration > 0)) return out;
  for (const track of c.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (clip.type !== 'audio' && clip.type !== 'video') continue;
      const volume = clip.volume ?? 1;
      if (!(volume > 0) || !(clip.duration > 0) || clip.start >= c.duration) continue;
      const duration = Math.min(clip.duration, c.duration - clip.start);
      out.push({
        src: clip.src, start: clip.start, duration, trimStart: clip.trimStart ?? 0, volume,
        fadeIn: clip.type === 'audio' ? Math.min(clip.fadeIn ?? 0, duration) : 0,
        fadeOut: clip.type === 'audio' ? Math.min(clip.fadeOut ?? 0, duration) : 0,
        fromVideo: clip.type === 'video',
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const samples = (sec: number) => Math.max(0, Math.round(sec * AUDIO_RATE));
const num = (n: number) => Number(n.toFixed(6)).toString();

/** The filter graph for `clips` (input i is `[i:a]`), output `[out]` of exactly `totalSamples` samples. */
export function mixGraph(clips: ReadonlyArray<Pick<MixClip, 'start' | 'duration' | 'trimStart' | 'volume' | 'fadeIn' | 'fadeOut'>>, totalSamples: number): string {
  if (clips.length === 0) throw new Error('mixGraph: no clips');
  const parts = clips.map((c, i) => {
    const s0 = samples(c.trimStart);
    const len = samples(c.duration);
    const f = [
      `aresample=${AUDIO_RATE}`, 'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `atrim=start_sample=${s0}:end_sample=${s0 + len}`, 'asetpts=N/SR/TB', `volume=${num(c.volume)}`,
    ];
    const fi = samples(c.fadeIn), fo = samples(c.fadeOut);
    if (fi > 0) f.push(`afade=t=in:start_sample=0:nb_samples=${fi}`);
    if (fo > 0) f.push(`afade=t=out:start_sample=${Math.max(0, len - fo)}:nb_samples=${fo}`);
    f.push(`adelay=delays=${samples(c.start)}S:all=1`);
    return `[${i}:a]${f.join(',')}[a${i}]`;
  });
  const inputs = clips.map((_, i) => `[a${i}]`).join('');
  return `${parts.join(';')};${inputs}amix=inputs=${clips.length}:duration=longest:dropout_transition=0:normalize=0,`
    + `apad=whole_len=${totalSamples},alimiter=limit=0.89:level=false:latency=1,atrim=end_sample=${totalSamples},asetpts=N/SR/TB[out]`;
}

/**
 * Opens `rel` with the confined-read checks and returns a new handle on the same open file (`/dev/fd/N`), positioned at 0:
 * ffmpeg reads the verified inode, never a path. Each ffmpeg run gets its own fresh handle (offsets are shared by dups).
 */
async function openConfined(compDir: string, rel: string): Promise<FileHandle> {
  const r = await withConfinedFile(compDir, rel, true, async (fh) => (await open(`/dev/fd/${fh.fd}`, 'r').catch(() => null)) ?? { skipped: 'unreadable' as const });
  if (!r || 'skipped' in r) throw new RenderError('runtimeErrors', `audio source refused: ${rel}`);
  return r;
}

/** Whether ffmpeg finds an audio stream in the input (`-fd 3 -i fd:` with `fd`, else `file`). */
async function hasAudio(ff: FfmpegInfo, input: { fd: number } | { file: string }, signal: AbortSignal): Promise<boolean> {
  const src = 'fd' in input ? ['-fd', '3', '-i', 'fd:'] : ['-i', input.file];
  return runFfmpeg(ff, [...src, '-map', '0:a:0', '-t', '0', '-f', 'null', '-'], { signal, fds: 'fd' in input ? [input.fd] : [] }).then(() => true, (e) => {
    if (e instanceof RenderError && e.code === 'cancelled') throw e;
    return false;
  });
}

/**
 * Mixes the composition's audio into `outWav` (48 kHz stereo float), `durationSec` long. Returns false when there is no
 * audio to mix (no clip, or only videos without sound): the render then has no audio track.
 */
export async function mixAudio(o: { ff: FfmpegInfo; compDir: string; clips: MixClip[]; durationSec: number; outWav: string; workDir: string; signal: AbortSignal }): Promise<boolean> {
  if (o.clips.length === 0) return false;
  const useFd = o.ff.fdProtocol && process.platform !== 'win32';
  const kept: Array<{ clip: MixClip; copy?: string }> = [];
  for (const [i, clip] of o.clips.entries()) {
    let copy: string | undefined;
    if (!useFd) {
      copy = join(o.workDir, `audio-${i}`);
      await copyConfinedFile(o.compDir, clip.src, copy).catch(() => { throw new RenderError('runtimeErrors', `audio source refused: ${clip.src}`); });
    }
    if (clip.fromVideo) {
      let sound: boolean;
      if (copy) sound = await hasAudio(o.ff, { file: copy }, o.signal);
      else {
        const h = await openConfined(o.compDir, clip.src);
        try { sound = await hasAudio(o.ff, { fd: h.fd }, o.signal); } finally { await h.close().catch(() => {}); }
      }
      if (!sound) continue;
    }
    kept.push({ clip, ...(copy ? { copy } : {}) });
  }
  if (kept.length === 0) return false;
  const handles: FileHandle[] = [];
  try {
    const inputs: string[] = [];
    for (const k of kept) {
      if (k.copy) { inputs.push('-i', k.copy); continue; }
      const h = await openConfined(o.compDir, k.clip.src);
      handles.push(h);
      inputs.push('-fd', String(2 + handles.length), '-i', 'fd:');
    }
    const total = samples(o.durationSec);
    await runFfmpeg(o.ff, [...inputs, '-filter_complex', mixGraph(kept.map((k) => k.clip), total), '-map', '[out]', '-ar', String(AUDIO_RATE), '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'wav', o.outWav],
      { signal: o.signal, fds: handles.map((h) => h.fd) });
    return true;
  } finally {
    for (const h of handles) await h.close().catch(() => {});
  }
}

import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Composition } from '@motion-studio/shared';
import { copyConfinedFile, withConfinedFile } from '../brand/agent-guard.ts';
import { RenderError } from './errors.ts';
import { runFfmpeg, type FfmpegInfo } from './encode.ts';
import { probeJson } from './media-normalize.ts';
import { mediaInput, type FfArg } from '../media/ffmpeg-exec.ts';
import { audioMixFilter, type FilterArg } from '../media/ffmpeg-filters.ts';

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

// Only finite numbers ever reach the filtergraph builder (a non-finite value from a composition counts as 0).
const samples = (sec: number) => (Number.isFinite(sec * AUDIO_RATE) ? Math.max(0, Math.round(sec * AUDIO_RATE)) : 0);

/** The `-filter_complex` of the mix for `clips` (input i is `[i:a]`), output `[out]` of exactly `totalSamples` samples. */
export function mixGraph(clips: ReadonlyArray<Pick<MixClip, 'start' | 'duration' | 'trimStart' | 'volume' | 'fadeIn' | 'fadeOut'>>, totalSamples: number): FilterArg {
  if (clips.length === 0) throw new Error('mixGraph: no clips');
  return audioMixFilter(clips.map((c) => ({
    trimStart: samples(c.trimStart), length: samples(c.duration), volume: Number.isFinite(c.volume) ? c.volume : 0,
    fadeIn: samples(c.fadeIn), fadeOut: samples(c.fadeOut), delay: samples(c.start),
  })), totalSamples, AUDIO_RATE);
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

/**
 * A video clip's time 0 is its source's first VIDEO frame (the runtime's `sourceStart`, the normalised file's first frame),
 * while the mix trims from the first AUDIO sample. When the streams start at different times (`starts`), the audio is
 * offset by `audioStart − videoStart` (M12): trimmed further when the audio starts first, delayed (and shortened) when it
 * starts later. Null when nothing of the clip is left to mix.
 */
export function alignVideoAudio(clip: MixClip, starts: { video: number; audio: number } | null): MixClip | null {
  if (!starts) return clip;
  const pos = clip.trimStart + (starts.video - starts.audio);
  if (pos >= 0) return { ...clip, trimStart: pos };
  const delay = -pos;
  if (delay >= clip.duration) return null;
  return { ...clip, start: clip.start + delay, duration: clip.duration - delay, trimStart: 0 };
}

/** The start times (s) of the first video and the first audio stream of an input; null when unknown. */
async function streamStarts(ff: FfmpegInfo, input: { fd: number } | { file: string }, signal: AbortSignal): Promise<{ video: number; audio: number } | null> {
  const j = await probeJson(ff, ['-show_entries', 'stream=codec_type,start_time', ...mediaInput('fd' in input ? { fd: 3 } : { file: input.file })], { signal, fds: 'fd' in input ? [input.fd] : [] });
  const streams = Array.isArray(j?.streams) ? j.streams as Array<{ codec_type?: string; start_time?: string }> : [];
  const v = Number(streams.find((x) => x.codec_type === 'video')?.start_time);
  const a = Number(streams.find((x) => x.codec_type === 'audio')?.start_time);
  return Number.isFinite(v) && Number.isFinite(a) ? { video: v, audio: a } : null;
}

/** Whether ffmpeg finds an audio stream in the input (`-fd 3 -i fd:` with `fd`, else `file`). */
async function hasAudio(ff: FfmpegInfo, input: { fd: number } | { file: string }, signal: AbortSignal): Promise<boolean> {
  const src = mediaInput('fd' in input ? { fd: 3 } : { file: input.file });
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
    let mixed = clip;
    if (clip.fromVideo) {
      let sound: boolean;
      let starts: { video: number; audio: number } | null;
      if (copy) { sound = await hasAudio(o.ff, { file: copy }, o.signal); starts = sound ? await streamStarts(o.ff, { file: copy }, o.signal) : null; } else {
        const h = await openConfined(o.compDir, clip.src);
        try { sound = await hasAudio(o.ff, { fd: h.fd }, o.signal); } finally { await h.close().catch(() => {}); }
        if (sound) {
          const h2 = await openConfined(o.compDir, clip.src);
          try { starts = await streamStarts(o.ff, { fd: h2.fd }, o.signal); } finally { await h2.close().catch(() => {}); }
        } else starts = null;
      }
      if (!sound) continue;
      const aligned = alignVideoAudio(clip, starts);
      if (!aligned) continue;
      mixed = aligned;
    }
    kept.push({ clip: mixed, ...(copy ? { copy } : {}) });
  }
  if (kept.length === 0) return false;
  const handles: FileHandle[] = [];
  try {
    const inputs: FfArg[] = [];
    for (const k of kept) {
      if (k.copy) { inputs.push(...mediaInput({ file: k.copy })); continue; }
      const h = await openConfined(o.compDir, k.clip.src);
      handles.push(h);
      inputs.push(...mediaInput({ fd: 2 + handles.length }));
    }
    const total = samples(o.durationSec);
    await runFfmpeg(o.ff, [...inputs, mixGraph(kept.map((k) => k.clip), total), '-map', '[out]', '-ar', String(AUDIO_RATE), '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'wav', o.outWav],
      { signal: o.signal, fds: handles.map((h) => h.fd) });
    return true;
  } finally {
    for (const h of handles) await h.close().catch(() => {});
  }
}

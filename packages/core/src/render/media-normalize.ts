import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Composition } from '@motion-studio/shared';
import { copyConfinedFile, withConfinedFile } from '../brand/agent-guard.ts';
import { MEDIA_FILE_RE, type SessionMedia, type SessionMediaFile } from '../compositions/composition-server.ts';
import { noteCoreChange } from '../core-changes.ts';
import { RenderError } from './errors.ts';
import { spawnFfmpeg, type FfmpegInfo } from './encode.ts';
import { killGroup, trackGroup } from './watchdog.ts';

/**
 * Video media normalisation (Task 5, orchestrator decision): before a composition is rendered or previewed, the core makes
 * a render version of every video clip source, so the runtime can apply its strict frame rule to it.
 *
 * - **What:** H.264 `yuv420p`, constant frame rate equal to the composition's (`fps` filter, first frame at 0), no B-frames,
 *   a key frame every half second (all-intra when the source is under 10 s), no audio (the mix reads the ORIGINAL source).
 *   Colour (measured in Chrome 154, README "Colour"): an untagged source is read as BT.709 (what Chrome assumes for it: the
 *   normalised file then shows exactly what the render canvas showed for the original), a tagged one as tagged; the output
 *   is tagged BT.709 matrix and primaries, limited range, and **sRGB transfer** (IEC 61966-2-1): with a BT.709 transfer tag
 *   Chrome's `<video>` path converts the transfer and shows mid-tones up to ~10 levels brighter than the canvas path, which
 *   ignores it; with the sRGB tag the preview `<video>` and the render canvas agree exactly. Its size is what the clip's box needs
 *   at composition size, the clip's `scale` and scale animations included (`clipScaleBound`), never more than the source
 *   (no upscaling) nor `MAX_MEDIA_DIM` on the long side.
 * - **Where:** `<project>/.studio/cache/media/<sha256 of the source>-<fps>-<long side>.mp4`, out of the agent's reach, outside
 *   the versions, regenerable. A new source content is a new name. Written to a hidden temp file, then renamed.
 * - **Trust:** the normalised file is probed with ffprobe and its `sourceFps`, `sourceStart`, `sourceVideoEnd` are given to the
 *   composition server (`SessionMedia`), which injects them with `sourceTrusted: true` into the inlined copy only: the
 *   agent's `composition.json` (versioned, hashed) is never written.
 * - **Failure:** a source that cannot be read (refused by the confined-read checks, or with no video stream) is a hard
 *   error (`mediaUnreadable`); a normalisation that fails otherwise leaves the clip on its original file, untrusted (the
 *   runtime's lenient rule), with a warning.
 * - **Inputs** pass the confined-read checks (regular file, `nlink === 1`, real path exactly inside the composition folder);
 *   ffmpeg and ffprobe get the verified open file (`-fd N -i fd:`), or a confined copy when ffmpeg has no `fd` protocol.
 * - **Processes:** at most `parallel` normalisations at once in the whole normaliser; every ffmpeg/ffprobe leads its own
 *   process group, killed as a group on cancel (the job's signal) or `close()`; temp files are removed.
 */

export const MEDIA_CACHE = ['.studio', 'cache', 'media'] as const;
export const mediaCacheDir = (projectDir: string): string => join(projectDir, ...MEDIA_CACHE);
/** Longest side of a normalised file. */
export const MAX_MEDIA_DIM = 4096;
/** Highest clip scale the size accounts for (a larger zoom is shown softer rather than decoding a huge file). */
export const MAX_CLIP_SCALE = 8;
/** Sources shorter than this are encoded all-intra (every frame a key frame): seeking is then always one decode. */
export const ALL_INTRA_UNDER_SEC = 10;
export const DEFAULT_MEDIA_PARALLEL = 2;
/** A hidden temp file of the media cache (`.<key>.<hex>.tmp`): removed by the startup sweep when old. */
export const MEDIA_TEMP_RE = /^\.[0-9a-f]{64}-\d{1,3}-\d{1,5}\.[0-9a-f]{12}\.tmp$/;
const PROBE_TIMEOUT_MS = 120_000;

type VideoClip = Extract<Composition['tracks'][number]['clips'][number], { type: 'video' }>;

/** popIn overshoots its 1.0 end (cubic-bezier 0.34, 1.56, 0.64, 1): a bound above the overshoot. */
const POP_IN_PEAK = 1.1;

/** The largest on-screen scale of a clip: its `scale` (at least 1) times the largest scale its animations reach (at least 1). */
export function clipScaleBound(clip: { props?: { scale?: number }; animations?: ReadonlyArray<Record<string, unknown>> }): number {
  let anim = 1;
  for (const a of clip.animations ?? []) {
    if (a.preset === 'popIn') anim = Math.max(anim, POP_IN_PEAK);
    if (a.prop !== 'scale') continue;
    const values = [a.from, a.to, ...(Array.isArray(a.keyframes) ? a.keyframes.map((k) => (k as { v?: unknown }).v) : [])];
    for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) anim = Math.max(anim, Math.abs(v));
  }
  return Math.min(MAX_CLIP_SCALE, Math.max(1, clip.props?.scale ?? 1) * anim);
}

/**
 * What each video source must cover, in pixels: per `src`, the largest box (composition pixels, the composition being the
 * format's size) times its scale bound, over every video clip of the visible tracks that uses it.
 */
export function videoNeeds(c: Composition): Map<string, { width: number; height: number }> {
  const out = new Map<string, { width: number; height: number }>();
  for (const track of c.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.type !== 'video') continue;
      const v = clip as VideoClip;
      const s = clipScaleBound(v as never);
      const w = (v.props.width ?? c.width) * s, h = (v.props.height ?? c.height) * s;
      const prev = out.get(v.src);
      out.set(v.src, { width: Math.max(prev?.width ?? 0, w), height: Math.max(prev?.height ?? 0, h) });
    }
  }
  return out;
}

const even = (x: number) => Math.max(2, 2 * Math.round(x / 2));

/**
 * The size of the normalised file: the source scaled (aspect kept) so that a cover crop of it still holds `need` pixels
 * (`max` of the two ratios), never upscaled, the long side at most `MAX_MEDIA_DIM`; even sides (`yuv420p`).
 */
export function targetSize(source: { width: number; height: number }, need: { width: number; height: number }): { width: number; height: number } {
  let f = Math.min(1, Math.max(need.width / source.width, need.height / source.height, 16 / Math.max(source.width, source.height)));
  f = Math.min(f, MAX_MEDIA_DIM / Math.max(source.width, source.height));
  return { width: even(source.width * f), height: even(source.height * f) };
}

/** The ffmpeg arguments of a normalisation (input given separately), into `out` (an mp4). */
export function normalizeArgs(o: { fps: number; width: number; height: number; allIntra: boolean; untagged?: boolean; preset?: string }): string[] {
  const gop = o.allIntra ? 1 : Math.max(1, Math.round(o.fps / 2));
  const input = o.untagged ? 'in_color_matrix=bt709:in_range=tv:' : '';
  return [
    '-map', '0:v:0', '-an', '-sn', '-dn',
    // round=up: output frame j (at j/fps) shows the source frame on screen at that time (the last one starting at or before
    // it), the frame the runtime would pick from the source itself; the default (near) can show the next one early.
    '-vf', `setpts=PTS-STARTPTS,fps=fps=${o.fps}:round=up,scale=${o.width}:${o.height}:flags=lanczos:${input}out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1,`
      + 'setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv',
    '-c:v', 'libx264', '-preset', o.preset ?? 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-bf', '0',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-color_range', 'tv',
    '-video_track_timescale', '90000', '-movflags', '+faststart', '-f', 'mp4',
  ];
}

// ---------- ffprobe ----------

const probePath = (ff: FfmpegInfo) => {
  const p = join(dirname(ff.path), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return existsSync(p) ? p : 'ffprobe';
};

/** Runs ffprobe (own process group, killed on abort) and parses its JSON; null when it fails or prints no JSON. */
export function probeJson(ff: FfmpegInfo, args: string[], o: { fds?: number[]; signal: AbortSignal }): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) return reject(new RenderError('cancelled', 'cancelled'));
    const proc = spawn(probePath(ff), ['-v', 'error', ...args, '-of', 'json'], { stdio: ['ignore', 'pipe', 'ignore', ...(o.fds ?? [])], detached: true });
    const untrack = proc.pid ? trackGroup(proc.pid) : () => {};
    let out = '';
    let cancelled = false;
    const kill = () => { if (proc.exitCode === null && proc.signalCode === null) { if (proc.pid) killGroup(proc.pid); else proc.kill('SIGKILL'); } };
    const onAbort = () => { cancelled = true; kill(); };
    o.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(kill, PROBE_TIMEOUT_MS);
    proc.stdout!.on('data', (d: Buffer) => { if (out.length < 4 * 1024 * 1024) out += d.toString('utf8'); });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
      untrack();
      if (cancelled) return reject(new RenderError('cancelled', 'cancelled'));
      if (code !== 0) return resolve(null);
      try { const v = JSON.parse(out) as unknown; resolve(typeof v === 'object' && v !== null ? v as Record<string, unknown> : null); } catch { resolve(null); }
    };
    proc.once('error', () => finish(-1));
    proc.once('close', (code) => finish(code));
  });
}

interface ProbeStream {
  codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; sample_aspect_ratio?: string;
  r_frame_rate?: string; start_time?: string; duration?: string; nb_read_packets?: string;
  color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string;
  side_data_list?: Array<{ rotation?: number }>; tags?: Record<string, string>;
}
const streamsOf = (j: Record<string, unknown> | null): ProbeStream[] => (Array.isArray(j?.streams) ? j.streams as ProbeStream[] : []);
const ratio = (r: string | undefined): number | null => {
  const [a, b] = (r ?? '').split('/').map(Number);
  return a && b && Number.isFinite(a / b) && a / b > 0 ? a / b : null;
};

export interface SourceInfo {
  width: number; height: number; durationSec: number | null;
  /** No colour matrix in the stream: read as BT.709, Chrome's assumption. */
  untagged: boolean;
}

/** Display size (sample aspect ratio and a 90° rotation applied) and duration of a source's first video stream. */
export function sourceInfoOf(j: Record<string, unknown> | null): SourceInfo | null {
  const v = streamsOf(j).find((s) => s.codec_type === 'video' && (s.width ?? 0) > 0 && (s.height ?? 0) > 0);
  if (!v) return null;
  const sar = ratio(v.sample_aspect_ratio?.replace(':', '/')) ?? 1;
  let w = v.width! * (sar > 0.1 && sar < 10 ? sar : 1), h = v.height!;
  const rot = Number(v.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? v.tags?.rotate ?? 0);
  if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
  const d = Number(v.duration ?? (j?.format as { duration?: string } | undefined)?.duration);
  const untagged = !v.color_space || v.color_space === 'unknown' || v.color_space === 'unspecified';
  return { width: Math.round(w), height: Math.round(h), durationSec: Number.isFinite(d) && d > 0 ? d : null, untagged };
}

/**
 * The trusted source fields of a normalised file, or the reason it is not what was asked: one H.264 `yuv420p` video
 * stream at `fps` and the expected size, tagged BT.709, no audio, at least one frame. `sourceVideoEnd` is the first
 * frame's time plus the frame count over the (constant) rate.
 */
export function normalisedFieldsOf(j: Record<string, unknown> | null, want: { fps: number; width: number; height: number }): Omit<SessionMediaFile, 'file'> | { problem: string } {
  const streams = streamsOf(j);
  const v = streams.filter((s) => s.codec_type === 'video');
  if (v.length !== 1) return { problem: `${v.length} video streams` };
  if (streams.some((s) => s.codec_type === 'audio')) return { problem: 'an audio stream' };
  const s = v[0]!;
  if (s.codec_name !== 'h264' || s.pix_fmt !== 'yuv420p') return { problem: `${s.codec_name}/${s.pix_fmt}` };
  if (s.width !== want.width || s.height !== want.height) return { problem: `${s.width}×${s.height}, not ${want.width}×${want.height}` };
  const fps = ratio(s.r_frame_rate);
  if (fps === null || Math.abs(fps - want.fps) > 1e-6) return { problem: `frame rate ${s.r_frame_rate}` };
  if (s.color_primaries !== 'bt709' || s.color_transfer !== 'iec61966-2-1' || s.color_space !== 'bt709' || s.color_range !== 'tv') return { problem: 'colour tags' };
  const frames = Number(s.nb_read_packets);
  const start = Number(s.start_time ?? 0);
  if (!(frames > 0) || !Number.isFinite(start) || start < 0) return { problem: 'no frames' };
  return { sourceFps: want.fps, sourceStart: start, sourceVideoEnd: start + frames / want.fps };
}

const NORMALISED_PROBE = ['-count_packets', '-show_entries',
  'stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,start_time,nb_read_packets,color_primaries,color_transfer,color_space,color_range'];
const SOURCE_PROBE = ['-show_entries', 'stream=codec_type,width,height,sample_aspect_ratio,duration,color_space:stream_side_data=rotation:stream_tags=rotate:format=duration'];

// ---------- inputs ----------

interface Identity { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
const sameFile = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const unreadable = (src: string, why: string) => new RenderError('mediaUnreadable', `video source ${src} cannot be read (${why})`);

/**
 * Runs `use` with an open, verified source: a fresh open file description each time (its own offset at 0) passed to the child
 * as fd 3, after the confined-read checks; `expect` (from the hash) must still match it.
 */
async function withSource<T>(compDir: string, src: string, expect: Identity | null, use: (input: string[], fds: number[], id: Identity) => Promise<T>): Promise<T> {
  let failure: RenderError | null = null;
  const r = await withConfinedFile(compDir, src, true, async (fh, info) => {
    const id: Identity = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
    if (expect && !sameFile(expect, id)) { failure = unreadable(src, 'it changed while it was being prepared'); return { skipped: 'outside' as const }; }
    // A second handle on the same open file: the child gets it as fd 3 (`/dev/fd/N` dups the verified descriptor).
    let dup: FileHandle;
    try { dup = await open(`/dev/fd/${fh.fd}`, 'r'); } catch { return { skipped: 'unreadable' as const }; }
    try { return { value: await use(['-fd', '3', '-i', 'fd:'], [dup.fd], id) }; } finally { await dup.close().catch(() => {}); }
  });
  if (failure) throw failure;
  if (r === null) throw unreadable(src, 'missing');
  if ('skipped' in r) throw unreadable(src, String(r.skipped));
  return (r as { value: T }).value;
}

/** sha256 of a source, by identity (dev, inode, size, times): a source is hashed once per state in this process. */
const hashMemo = new Map<string, string>();
const memoKey = (id: Identity) => `${id.dev}:${id.ino}:${id.size}:${id.mtimeMs}:${id.ctimeMs}`;
async function hashSource(compDir: string, src: string): Promise<{ sha256: string; id: Identity }> {
  const r = await withConfinedFile(compDir, src, true, async (fh, info) => {
    const id: Identity = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
    const known = hashMemo.get(memoKey(id));
    if (known) return { sha256: known, id };
    const h = createHash('sha256');
    // Positional reads: the descriptor's offset is never moved.
    await pipeline(fh.createReadStream({ start: 0, autoClose: false }), h);
    const sha256 = h.digest('hex');
    if (hashMemo.size > 500) hashMemo.delete(hashMemo.keys().next().value!);
    hashMemo.set(memoKey(id), sha256);
    return { sha256, id };
  });
  if (r === null) throw unreadable(src, 'missing');
  if ('skipped' in r) throw unreadable(src, r.skipped);
  return r;
}

// ---------- the normaliser ----------

export interface PrepareMediaOptions {
  projectDir: string;
  /** The composition folder (`<creative>/outputs/vN/compositions/<format>`). */
  compDir: string;
  /** The normalised, validated composition (its `fps` and its video clips). */
  composition: Composition;
  signal: AbortSignal;
  /** Sources done out of the total ("Preparing media…"). */
  onProgress?(p: { done: number; total: number }): void;
}

export interface MediaWarning { src: string; message: string }

export interface PreparedMedia {
  /** For `mintSession({ media })` (and `renderComposition({ media })`). */
  media: SessionMedia;
  /** Clips left on their original file (untrusted): their normalisation failed. */
  warnings: MediaWarning[];
  /** Sources made now, and found in the cache. */
  made: number;
  cached: number;
}

/** At most `max` tasks at once. */
function limiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try { return await fn(); } finally {
      const next = queue.shift();
      if (next) next(); else active--;
    }
  };
}

export class MediaNormalizer {
  private readonly closing = new AbortController();
  private readonly running = new Set<Promise<unknown>>();
  private readonly slot: ReturnType<typeof limiter>;
  /** Normalisations in flight by final file: two compositions with the same source share one ffmpeg. */
  private readonly inflight = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly o: { ffmpeg: () => Promise<FfmpegInfo | null>; parallel?: number; x264Preset?: string; tempDir?: string }) {
    this.slot = limiter(Math.max(1, Math.min(8, Math.floor(o.parallel ?? DEFAULT_MEDIA_PARALLEL))));
  }

  /** Prepares every video source of a composition (see the module comment). Throws `mediaUnreadable` or `cancelled`. */
  prepare(p: PrepareMediaOptions): Promise<PreparedMedia> {
    if (this.closed) return Promise.reject(new RenderError('cancelled', 'cancelled'));
    const job = this.run(p);
    this.running.add(job);
    void job.catch(() => {}).finally(() => this.running.delete(job));
    return job;
  }

  /** Cancels every running preparation (their ffmpeg/ffprobe groups are killed, temp files removed) and waits for them. */
  async close(): Promise<void> {
    this.closed = true;
    this.closing.abort(new RenderError('cancelled', 'cancelled'));
    await Promise.allSettled([...this.running]);
  }

  private async run(p: PrepareMediaOptions): Promise<PreparedMedia> {
    const signal = AbortSignal.any([p.signal, this.closing.signal]);
    const cacheDir = mediaCacheDir(p.projectDir);
    const needs = videoNeeds(p.composition);
    const clips = new Map<string, SessionMediaFile>();
    const warnings: MediaWarning[] = [];
    const result: PreparedMedia = { media: { dir: cacheDir, clips }, warnings, made: 0, cached: 0 };
    const total = needs.size;
    let done = 0;
    p.onProgress?.({ done, total });
    if (total === 0) return result;
    if (signal.aborted) throw new RenderError('cancelled', 'cancelled');
    const ff = await this.o.ffmpeg();
    if (!ff || !ff.encoders.has('libx264')) {
      for (const src of needs.keys()) warnings.push({ src, message: `video ${src} is not normalised: ${ff ? 'libx264 is missing' : 'ffmpeg is missing'}` });
      return result;
    }
    await mkdir(cacheDir, { recursive: true });
    // The folders mkdir may have created (`.studio/cache/media`): the core's own change, never a move (run-tripwire.ts).
    for (const d of [cacheDir, dirname(cacheDir), dirname(dirname(cacheDir))]) await noteCoreChange(d);
    await Promise.all([...needs].map(([src, need]) => this.slot(async () => {
      if (signal.aborted) throw new RenderError('cancelled', 'cancelled');
      const r = await this.one(ff, p, cacheDir, src, need, signal);
      if ('warning' in r) warnings.push({ src, message: r.warning });
      else { clips.set(src, r.file); if (r.cached) result.cached++; else result.made++; }
      p.onProgress?.({ done: ++done, total });
    })));
    return result;
  }

  /** One source: hash, probe, then the cached file or a new one, probed. */
  private async one(ff: FfmpegInfo, p: PrepareMediaOptions, cacheDir: string, src: string, need: { width: number; height: number }, signal: AbortSignal): Promise<{ file: SessionMediaFile; cached: boolean } | { warning: string }> {
    const fps = p.composition.fps;
    const useFd = ff.fdProtocol && process.platform !== 'win32';
    let copyDir: string | null = null;
    try {
      let hashed: { sha256: string; id: Identity };
      let input: <T>(use: (args: string[], fds: number[]) => Promise<T>) => Promise<T>;
      if (useFd) {
        hashed = await hashSource(p.compDir, src);
        input = (use) => withSource(p.compDir, src, hashed.id, (args, fds) => use(args, fds));
      } else {
        // No `fd` protocol (Windows): a confined copy in a private temp folder is what ffmpeg reads.
        copyDir = await mkdtemp(join(this.o.tempDir ?? tmpdir(), 'ms-render-media-'));
        const copy = join(copyDir, 'source');
        await copyConfinedFile(p.compDir, src, copy).catch((e: { code?: string }) => { throw unreadable(src, e.code ?? 'refused'); });
        const h = createHash('sha256');
        await pipeline(createReadStream(copy), h);
        hashed = { sha256: h.digest('hex'), id: { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 } };
        input = (use) => use(['-i', copy], []);
      }
      const info = sourceInfoOf(await input((args, fds) => probeJson(ff, [...SOURCE_PROBE, ...args], { fds, signal })));
      if (!info) throw unreadable(src, 'no video stream');
      const size = targetSize(info, need);
      const name = `${hashed.sha256}-${fps}-${Math.max(size.width, size.height)}.mp4`;
      if (!MEDIA_FILE_RE.test(name)) return { warning: `video ${src} is not normalised: unexpected cache name` };
      const final = join(cacheDir, name);
      const want = { fps, ...size };
      const existing = await this.probeCached(ff, final, want, signal);
      if (existing) return { file: { file: final, ...existing }, cached: true };
      let pending = this.inflight.get(final);
      if (!pending) {
        pending = this.make(ff, input, final, want, { allIntra: (info.durationSec ?? Infinity) < ALL_INTRA_UNDER_SEC, untagged: info.untagged }, signal);
        this.inflight.set(final, pending);
        void pending.catch(() => {}).finally(() => { if (this.inflight.get(final) === pending) this.inflight.delete(final); });
      }
      try { await pending; } catch (e) {
        if (e instanceof RenderError && (e.code === 'cancelled' || e.code === 'mediaUnreadable')) throw e;
        if (signal.aborted) throw new RenderError('cancelled', 'cancelled');
        return { warning: `video ${src} is not normalised: ${(e as Error).message.slice(0, 300)}` };
      }
      const made = await this.probeCached(ff, final, want, signal);
      if (!made) return { warning: `video ${src} is not normalised: the result could not be verified` };
      return { file: { file: final, ...made }, cached: false };
    } finally {
      if (copyDir) await rm(copyDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** The source fields of a cached file when it is a single-linked regular file that probes as wanted; a bad one is removed. */
  private async probeCached(ff: FfmpegInfo, file: string, want: { fps: number; width: number; height: number }, signal: AbortSignal): Promise<Omit<SessionMediaFile, 'file'> | null> {
    const st = await lstat(file).catch(() => null);
    if (!st) return null;
    if (!st.isFile() || st.nlink !== 1) return null;
    const fields = await withConfinedFile(dirname(file), file.slice(dirname(file).length + 1), true, async (fh) => {
      let dup: FileHandle;
      try { dup = await open(`/dev/fd/${fh.fd}`, 'r'); } catch { return { skipped: 'unreadable' as const }; }
      try {
        const args = ff.fdProtocol && process.platform !== 'win32' ? ['-fd', '3', 'fd:'] : [file];
        return { value: normalisedFieldsOf(await probeJson(ff, [...NORMALISED_PROBE, ...args], { fds: [dup.fd], signal }), want) };
      } finally { await dup.close().catch(() => {}); }
    });
    const value = fields && 'value' in fields ? fields.value as Omit<SessionMediaFile, 'file'> | { problem: string } : null;
    if (value && !('problem' in value)) return value;
    // Not what this name promises (an interrupted write never gets the name, so this is damage): made again.
    if (fields && 'value' in fields) await rm(file, { force: true }).catch(() => {});
    return null;
  }

  /** Encodes into a hidden temp file next to `final`, then renames it; the temp file is removed on any failure. */
  private async make(ff: FfmpegInfo, input: <T>(use: (args: string[], fds: number[]) => Promise<T>) => Promise<T>, final: string,
    want: { fps: number; width: number; height: number }, how: { allIntra: boolean; untagged: boolean }, signal: AbortSignal): Promise<void> {
    const name = final.slice(dirname(final).length + 1);
    const temp = join(dirname(final), `.${name.slice(0, -'.mp4'.length)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await input((args, fds) => spawnFfmpeg(ff, [...args, ...normalizeArgs({ ...want, ...how, ...(this.o.x264Preset ? { preset: this.o.x264Preset } : {}) }), temp], { signal, fds }).done);
      if (signal.aborted) throw new RenderError('cancelled', 'cancelled');
      await rename(temp, final);
      await noteCoreChange(dirname(final));
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }
}

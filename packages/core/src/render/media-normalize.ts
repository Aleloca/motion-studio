import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, utimes } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { Composition } from '@motion-studio/shared';
import { copyConfinedFile, withConfinedFile } from '../brand/agent-guard.ts';
import { MEDIA_FILE_RE, type SessionMedia, type SessionMediaFile } from '../compositions/composition-server.ts';
import { noteCoreChange } from '../core-changes.ts';
import { readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { RenderError } from './errors.ts';
import { spawnFfmpeg, type FfmpegInfo } from './encode.ts';
import { killGroup, trackGroup } from './watchdog.ts';
import { makeOwnedTempDir } from './owner.ts';
import { ffprobeOf, mediaInput, MP4_DEMUXERS, spawnFf, type FfArg } from '../media/ffmpeg-exec.ts';
import { gamutStage, hdrStage, normalizeVideoFilter, type ColourStage, type HdrInfo } from '../media/ffmpeg-filters.ts';

/**
 * Video media normalisation (Task 5, orchestrator decision): before a composition is rendered or previewed, the core makes
 * a render version of every video clip source, so the runtime can apply its strict frame rule to it.
 *
 * - **What:** H.264 `yuv420p`, constant frame rate equal to the composition's (`fps` filter rounding up, first frame at 0),
 *   no B-frames, a key frame every half second (all-intra when the source is under 10 s), no audio (the render's mix and
 *   the preview's `<audio>` read the ORIGINAL source). Its size is what the clip's box needs at composition size, the clip's
 *   `scale` and scale animations included (`clipScaleBound`), never more than the source (no upscaling) nor `MAX_MEDIA_DIM`.
 * - **Colour** (measured in Chrome 154, runtime README "colour"): an untagged source is read as BT.709 (Chrome's own
 *   assumption), a tagged one as tagged; the output is tagged BT.709 matrix and primaries, limited range, and **sRGB
 *   transfer** (IEC 61966-2-1), so the preview `<video>` and the render canvas show the same values. **HDR** sources (PQ or
 *   HLG transfer, or BT.2020 primaries) are tone-mapped when this ffmpeg has `zscale` and `tonemap`; otherwise they are
 *   converted with the `colorspace` filter (primaries and matrix exact, the HDR transfer read as BT.2020 SDR) and get a
 *   warning (`hdrApproximate`): the colours are approximate, the timing is still trusted.
 * - **Where:** `<project>/.studio/cache/media/<sha256 of the source>-<fps>-<w>x<h>-n<RECIPE_VERSION>.mp4`, out of the agent's
 *   reach, outside the versions, regenerable. The name identifies the output: a new source, size or recipe is a new name.
 *   Written to a hidden temp file, then renamed. A file is touched (mtime) on every use; `pruneMediaCache` removes files of
 *   an older recipe, files unused for 30 days, and the least recently used ones above the project's cap, never one in use.
 * - **Trust:** the normalised file is probed with ffprobe and its `sourceFps`, `sourceStart`, `sourceVideoEnd` are given to the
 *   composition server (`SessionMedia`), which injects them with `sourceTrusted: true` into the inlined copy only: the
 *   agent's `composition.json` (versioned, hashed) is never written.
 * - **Failure:** a source that cannot be read (refused by the confined-read checks, or with no video stream) is a hard
 *   error (`mediaUnreadable`), which cancels the composition's other encodes; a normalisation that fails otherwise leaves the
 *   clip on its original file, untrusted (the runtime's lenient rule), with a warning.
 * - **Inputs** pass the confined-read checks (regular file, `nlink === 1`, real path exactly inside the composition folder);
 *   ffmpeg and ffprobe get the verified open file (`-fd N -i fd:`), or a confined copy when ffmpeg has no `fd` protocol.
 *   Source hashes are remembered in `.studio/cache/source-hashes.json` by path, size, mtime, ctime and inode.
 * - **Processes:** at most `parallel` encodes at once in the whole normaliser (a cache hit never waits for one). Two
 *   preparations that need the same file share one encode, which runs under its own controller and is cancelled only when
 *   every waiter has gone (or on `close()`). Every ffmpeg/ffprobe leads its own process group, killed as a group; temp
 *   files are removed.
 */

export const MEDIA_CACHE = ['.studio', 'cache', 'media'] as const;
export const mediaCacheDir = (projectDir: string): string => join(projectDir, ...MEDIA_CACHE);
/** Bumped whenever the encode changes in a way the probe cannot see (arguments, filters, colour handling). */
export const MEDIA_RECIPE_VERSION = 1;
/** Longest side of a normalised file. */
export const MAX_MEDIA_DIM = 4096;
/** Highest clip scale the size accounts for (a larger zoom is shown softer rather than decoding a huge file). */
export const MAX_CLIP_SCALE = 8;
/** Sources shorter than this are encoded all-intra (every frame a key frame): seeking is then always one decode. */
export const ALL_INTRA_UNDER_SEC = 10;
export const DEFAULT_MEDIA_PARALLEL = 2;
/** Default cap of a project's media cache. */
export const DEFAULT_MEDIA_CACHE_MAX_BYTES = 5 * 1024 ** 3;
/** A cached file not used for this long is removed by the startup sweep. */
export const MEDIA_UNUSED_MS = 30 * 24 * 3600 * 1000;
/** A file used this recently is never evicted for the size cap (a session of another process may be playing it). */
export const MEDIA_EVICT_GRACE_MS = 10 * 60 * 1000;
/** A hidden temp file of the media cache (`.<name without .mp4>.<hex>.tmp`): removed by the startup sweep when old. */
export const MEDIA_TEMP_RE = /^\.[0-9a-f]{64}-\d{1,3}-\d{1,5}x\d{1,5}-n\d{1,4}\.[0-9a-f]{12}\.tmp$/;
export const mediaFileName = (sha: string, fps: number, size: { width: number; height: number }, recipe = MEDIA_RECIPE_VERSION) =>
  `${sha}-${fps}-${size.width}x${size.height}-n${recipe}.mp4`;
/** The recipe version of a cache file name, or null when it is not one. */
export const mediaRecipeOf = (name: string): number | null => (MEDIA_FILE_RE.test(name) ? Number(/-n(\d+)\.mp4$/.exec(name)![1]) : null);
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
export function normalizeArgs(o: { fps: number; width: number; height: number; allIntra: boolean; untagged?: boolean; colour?: ColourStage; preset?: string }): FfArg[] {
  const gop = o.allIntra ? 1 : Math.max(1, Math.round(o.fps / 2));
  return [
    '-map', '0:v:0', '-an', '-sn', '-dn',
    // round=up: output frame j (at j/fps) shows the source frame on screen at that time (the last one starting at or before
    // it), the frame the runtime would pick from the source itself; the default (near) can show the next one early.
    // After a colour stage the frames are BT.709 already; an untagged source is read as BT.709 (Chrome's assumption).
    normalizeVideoFilter({ fps: o.fps, width: o.width, height: o.height, ...(o.colour ? { colour: o.colour } : {}), ...(o.untagged ? { untagged: true } : {}) }),
    '-c:v', 'libx264', '-preset', o.preset ?? 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-bf', '0',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-color_range', 'tv',
    '-video_track_timescale', '90000', '-movflags', '+faststart', '-f', 'mp4',
  ];
}

// ---------- ffprobe ----------

/**
 * Runs ffprobe (own process group, killed on abort) and parses its JSON; null when it fails or prints no JSON. Its input
 * must come from `mediaInput`/`ownInput` (`media/ffmpeg-exec.ts`), or it throws.
 */
export function probeJson(ff: FfmpegInfo, args: string[], o: { fds?: number[]; signal: AbortSignal }): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) return reject(new RenderError('cancelled', 'cancelled'));
    const proc = spawnFf(ffprobeOf(ff.path), ['-v', 'error', ...args, '-of', 'json'], { stdio: ['ignore', 'pipe', 'ignore', ...(o.fds ?? [])], detached: true });
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
  /** A PQ or HLG transfer (HDR); null for SDR. */
  hdr: HdrInfo | null;
  /** BT.2020 primaries with an SDR transfer: converted to BT.709 without tone mapping. */
  wideGamut: HdrInfo | null;
  /** The source has an audio stream (the preview then plays it from the original). */
  audio: boolean;
  /** Where the first video frame sits on the media timeline (the preview's `<audio>` of the original starts there). */
  videoStart: number;
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
  const transfer = v.color_transfer ?? '', primaries = v.color_primaries ?? '';
  const colour = { primaries, transfer, space: v.color_space ?? '' };
  const hdr = transfer === 'smpte2084' || transfer === 'arib-std-b67' ? colour : null;
  const wideGamut = !hdr && primaries === 'bt2020' ? colour : null;
  const start = Number(v.start_time);
  const audio = streamsOf(j).some((x) => x.codec_type === 'audio');
  return { width: Math.round(w), height: Math.round(h), durationSec: Number.isFinite(d) && d > 0 ? d : null, untagged, hdr, wideGamut, audio, videoStart: Number.isFinite(start) && start > 0 ? start : 0 };
}

/**
 * The trusted source fields of a normalised file, or the reason it is not what was asked: one H.264 `yuv420p` video
 * stream at `fps` and the expected size, tagged BT.709, no audio, at least one frame. `sourceVideoEnd` is the first
 * frame's time plus the frame count over the (constant) rate.
 */
export function normalisedFieldsOf(j: Record<string, unknown> | null, want: { fps: number; width: number; height: number }): Pick<SessionMediaFile, 'sourceFps' | 'sourceStart' | 'sourceVideoEnd'> | { problem: string } {
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
const SOURCE_PROBE = ['-show_entries', 'stream=codec_type,width,height,sample_aspect_ratio,duration,start_time,color_space,color_transfer,color_primaries:stream_side_data=rotation:stream_tags=rotate:format=duration'];

// ---------- inputs ----------

interface Identity { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
const sameFile = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const unreadable = (src: string, why: string) => new RenderError('mediaUnreadable', `video source ${src} cannot be read (${why})`);
const cancelled = () => new RenderError('cancelled', 'cancelled');
const isCancel = (e: unknown) => e instanceof RenderError && e.code === 'cancelled';

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
    try { return { value: await use(mediaInput({ fd: 3 }), [dup.fd], id) }; } finally { await dup.close().catch(() => {}); }
  });
  if (failure) throw failure;
  if (r === null) throw unreadable(src, 'missing');
  if ('skipped' in r) throw unreadable(src, String(r.skipped));
  return (r as { value: T }).value;
}

/**
 * Source hashes, remembered per project in `.studio/cache/source-hashes.json` (and in memory) by the file's path, size,
 * mtime, ctime and inode (device too): a multi-GB source is hashed once, not at every app start. `.studio` is out of the agent's
 * reach; a stale or corrupt memo only costs a new hash.
 */
const HASH_MEMO_MAX = 2000;
const hashMemoSchema = z.object({ schemaVersion: z.literal(1), entries: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)) });
export const sourceHashMemoPath = (projectDir: string) => join(projectDir, '.studio', 'cache', 'source-hashes.json');
const memoKey = (path: string, id: Identity) => `${id.dev}:${id.ino}:${id.size}:${id.mtimeMs}:${id.ctimeMs}:${path}`;

class HashMemo {
  private loaded = new Map<string, Promise<Map<string, string>>>();
  private dirty = new Set<string>();
  private writes = new Map<string, Promise<void>>();
  private load(projectDir: string): Promise<Map<string, string>> {
    let m = this.loaded.get(projectDir);
    if (!m) {
      m = readJsonFile(sourceHashMemoPath(projectDir), hashMemoSchema).then((f) => new Map(Object.entries(f.entries)), () => new Map<string, string>());
      this.loaded.set(projectDir, m);
    }
    return m;
  }
  async get(projectDir: string, key: string): Promise<string | undefined> { return (await this.load(projectDir)).get(key); }
  async set(projectDir: string, key: string, sha: string): Promise<void> {
    const m = await this.load(projectDir);
    m.delete(key);
    m.set(key, sha);
    while (m.size > HASH_MEMO_MAX) m.delete(m.keys().next().value!);
    this.dirty.add(projectDir);
  }
  /** Writes a changed memo (atomic; serialised per project). */
  async flush(projectDir: string): Promise<void> {
    if (!this.dirty.delete(projectDir)) return;
    const m = await this.load(projectDir);
    const prev = this.writes.get(projectDir) ?? Promise.resolve();
    const next = prev.then(() => writeJsonFileAtomic(sourceHashMemoPath(projectDir), { schemaVersion: 1, entries: Object.fromEntries(m) })).catch(() => {});
    this.writes.set(projectDir, next);
    await next;
  }
}

async function hashSource(memo: HashMemo, projectDir: string, compDir: string, src: string): Promise<{ sha256: string; id: Identity }> {
  const path = join(compDir, ...src.split('/'));
  const r = await withConfinedFile(compDir, src, true, async (fh, info) => {
    const id: Identity = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
    const known = await memo.get(projectDir, memoKey(path, id));
    if (known) return { sha256: known, id };
    const h = createHash('sha256');
    // Positional reads: the descriptor's offset is never moved.
    await pipeline(fh.createReadStream({ start: 0, autoClose: false }), h);
    const sha256 = h.digest('hex');
    await memo.set(projectDir, memoKey(path, id), sha256);
    return { sha256, id };
  });
  if (r === null) throw unreadable(src, 'missing');
  if ('skipped' in r) throw unreadable(src, r.skipped);
  return r;
}

// ---------- the cache ----------

export interface PruneOptions {
  /** Cap of the folder; the least recently used files above it are removed. Default `DEFAULT_MEDIA_CACHE_MAX_BYTES`. */
  maxBytes?: number;
  /** Remove files unused (mtime) for longer than this; `null`: keep them. Default `MEDIA_UNUSED_MS`. */
  maxUnusedMs?: number | null;
  /** Remove files of another recipe version. Default true. */
  oldRecipes?: boolean;
  /** Files a live session may be serving: never removed. */
  inUse?: (file: string) => boolean;
  now?: number;
}

/**
 * Garbage collection of a project's media cache (see the module comment): only regular, single-linked files named like a
 * cache file, directly in the folder; never one in use, and never one used in the last `MEDIA_EVICT_GRACE_MS` for the cap.
 * Returns the paths removed.
 */
export async function pruneMediaCache(dir: string, o: PruneOptions = {}): Promise<string[]> {
  const now = o.now ?? Date.now();
  const maxBytes = o.maxBytes ?? DEFAULT_MEDIA_CACHE_MAX_BYTES;
  const maxUnused = o.maxUnusedMs === undefined ? MEDIA_UNUSED_MS : o.maxUnusedMs;
  const inUse = o.inUse ?? (() => false);
  const files: Array<{ path: string; size: number; mtimeMs: number; used: boolean }> = [];
  const removed: string[] = [];
  const remove = async (path: string) => { await rm(path, { force: true }).then(() => removed.push(path), () => {}); };
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const recipe = mediaRecipeOf(name);
    if (recipe === null) continue;
    const path = join(dir, name);
    const st = await lstat(path).catch(() => null);
    if (!st || !st.isFile() || st.nlink !== 1) continue;
    // A file in use is never removed, but it counts toward the cap.
    const used = inUse(path);
    if (!used && (o.oldRecipes ?? true) && recipe !== MEDIA_RECIPE_VERSION) { await remove(path); continue; }
    if (!used && maxUnused !== null && now - st.mtimeMs > maxUnused) { await remove(path); continue; }
    files.push({ path, size: st.size, mtimeMs: st.mtimeMs, used });
  }
  let total = files.reduce((a, f) => a + f.size, 0);
  for (const f of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maxBytes) break;
    if (f.used || now - f.mtimeMs < MEDIA_EVICT_GRACE_MS) continue;
    await remove(f.path);
    if (removed.at(-1) === f.path) total -= f.size;
  }
  if (removed.length > 0) await noteCoreChange(dir);
  return removed;
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

/**
 * `notNormalised`: the clip stays on its original file, untrusted. `hdrApproximate`: an HDR source converted without a
 * tone-mapping filter; the clip is normalised and trusted (timing), its colours approximate.
 */
export interface MediaWarning { src: string; kind: 'notNormalised' | 'hdrApproximate'; message: string }

export interface PreparedMedia {
  /** For `mintSession({ media })` (and `renderComposition({ media })`). */
  media: SessionMedia;
  warnings: MediaWarning[];
  /** Sources made now, and found in the cache. */
  made: number;
  cached: number;
  /** The session using these files ended: they may be evicted again. Idempotent. Call it when the session ends. */
  release(): void;
}

/**
 * The media to give a session: none when no clip was normalised (a composition without video, or every source left as it
 * is), so the session never needs the cache folder, which then may not even exist.
 */
export const sessionMediaOf = (p: PreparedMedia): SessionMedia | undefined => (p.media.clips.size > 0 ? p.media : undefined);

/** At most `max` tasks at once; a waiter whose signal aborts leaves the queue. */
function limiter(max: number) {
  let active = 0;
  const queue: Array<{ go: () => void }> = [];
  return async <T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) throw cancelled();
    if (active < max) active++;
    else {
      await new Promise<void>((resolve, reject) => {
        const entry = { go: () => { signal.removeEventListener('abort', onAbort); resolve(); } };
        const onAbort = () => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); reject(cancelled()); };
        signal.addEventListener('abort', onAbort, { once: true });
        queue.push(entry);
      });
    }
    try { return await fn(); } finally {
      const next = queue.shift();
      if (next) next.go(); else active--;
    }
  };
}

/** An encode shared by every preparation that needs its file: cancelled only when all of them have gone. */
interface SharedEncode { promise: Promise<{ approximate: boolean }>; ctl: AbortController; waiters: number }

export interface MediaNormalizerOptions {
  ffmpeg: () => Promise<FfmpegInfo | null>;
  parallel?: number;
  x264Preset?: string;
  tempDir?: string;
  /** Per-project cap of the media cache (default 5 GB), enforced after each new file. */
  maxCacheBytes?: number;
}

export class MediaNormalizer {
  private readonly closing = new AbortController();
  private readonly running = new Set<Promise<unknown>>();
  private readonly slot: ReturnType<typeof limiter>;
  private readonly shared = new Map<string, SharedEncode>();
  /** Files of live sessions, with a count: never evicted, never removed as damaged. */
  private readonly leases = new Map<string, number>();
  private readonly memo = new HashMemo();
  private closed = false;
  /** Encodes started by this normaliser (tests: a shared encode runs once). */
  readonly stats = { encodes: 0 };
  /** Preparations waiting on shared encodes right now (tests). */
  sharedWaiters(): number { let n = 0; for (const e of this.shared.values()) n += e.waiters; return n; }

  constructor(private readonly o: MediaNormalizerOptions) {
    this.slot = limiter(Math.max(1, Math.min(8, Math.floor(o.parallel ?? DEFAULT_MEDIA_PARALLEL))));
  }

  /** Whether a live session (a prepared, unreleased composition) uses `file`. */
  inUse = (file: string): boolean => (this.leases.get(file) ?? 0) > 0;

  /** Prepares every video source of a composition (see the module comment). Throws `mediaUnreadable` or `cancelled`. */
  prepare(p: PrepareMediaOptions): Promise<PreparedMedia> {
    if (this.closed) return Promise.reject(cancelled());
    return this.track(this.run(p));
  }

  /** Cancels every running preparation and encode (their ffmpeg/ffprobe groups are killed, temp files removed) and waits. */
  async close(): Promise<void> {
    this.closed = true;
    this.closing.abort(cancelled());
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  private track<T>(job: Promise<T>): Promise<T> {
    this.running.add(job);
    void job.catch(() => {}).finally(() => this.running.delete(job));
    return job;
  }

  /** Takes one lease on `file`; the returned function gives it back (idempotent). */
  private hold(file: string): () => void {
    this.leases.set(file, (this.leases.get(file) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.leases.get(file) ?? 1) - 1;
      if (n > 0) this.leases.set(file, n); else this.leases.delete(file);
    };
  }

  private async run(p: PrepareMediaOptions): Promise<PreparedMedia> {
    // One unreadable source stops the composition's other sources too (their encodes leave, see SharedEncode).
    const local = new AbortController();
    const signal = AbortSignal.any([p.signal, this.closing.signal, local.signal]);
    const cacheDir = mediaCacheDir(p.projectDir);
    const needs = videoNeeds(p.composition);
    const clips = new Map<string, SessionMediaFile>();
    const warnings: MediaWarning[] = [];
    const total = needs.size;
    let done = 0;
    p.onProgress?.({ done, total });
    // Each file is leased the moment it is picked (a hit) or about to be made, so no prune or damage check elsewhere can
    // remove it while the composition's other sources are still being prepared; all leases go back if this throws.
    const held: Array<() => void> = [];
    const releaseAll = () => { for (const r of held.splice(0)) r(); };
    const result = (made: number, cached: number): PreparedMedia => ({ media: { dir: cacheDir, clips }, warnings, made, cached, release: releaseAll });
    if (total === 0) return result(0, 0);
    if (signal.aborted) throw cancelled();
    const ff = await this.o.ffmpeg();
    if (!ff || !ff.encoders.has('libx264')) {
      for (const src of needs.keys()) warnings.push({ src, kind: 'notNormalised', message: `video ${src} is not normalised: ${ff ? 'libx264 is missing' : 'ffmpeg is missing'}` });
      return result(0, 0);
    }
    await mkdir(cacheDir, { recursive: true });
    // The folders mkdir may have created (`.studio/cache/media`): the core's own change, never a move (run-tripwire.ts).
    for (const d of [cacheDir, dirname(cacheDir), dirname(dirname(cacheDir))]) await noteCoreChange(d);
    let made = 0, cached = 0;
    let hard: unknown = null;
    const settled = await Promise.allSettled([...needs].map(async ([src, need]) => {
      try {
        const r = await this.one(ff, p, cacheDir, src, need, signal, (file) => { const r2 = this.hold(file); held.push(r2); return r2; });
        if ('file' in r) { clips.set(src, r.file); if (r.cached) cached++; else made++; }
        warnings.push(...r.warnings.map((w) => ({ src, ...w })));
        p.onProgress?.({ done: ++done, total });
      } catch (e) {
        if (!isCancel(e) && hard === null) { hard = e; local.abort(); }
        throw e;
      }
    }));
    await this.memo.flush(p.projectDir);
    if (hard !== null) { releaseAll(); throw hard; }
    if (settled.some((r) => r.status === 'rejected')) { releaseAll(); throw cancelled(); }
    return result(made, cached);
  }

  /** One source: hash, probe, then the cached file (no slot needed) or a shared encode, probed. */
  private async one(ff: FfmpegInfo, p: PrepareMediaOptions, cacheDir: string, src: string, need: { width: number; height: number }, signal: AbortSignal, hold: (file: string) => () => void):
    Promise<{ file: SessionMediaFile; cached: boolean; warnings: Array<Omit<MediaWarning, 'src'>> } | { warnings: Array<Omit<MediaWarning, 'src'>> }> {
    const fps = p.composition.fps;
    const useFd = ff.fdProtocol && process.platform !== 'win32';
    let copyDir: string | null = null;
    try {
      let hashed: { sha256: string; id: Identity };
      let input: <T>(use: (args: string[], fds: number[]) => Promise<T>) => Promise<T>;
      if (useFd) {
        hashed = await hashSource(this.memo, p.projectDir, p.compDir, src);
        input = (use) => withSource(p.compDir, src, hashed.id, (args, fds) => use(args, fds));
      } else {
        // No `fd` protocol (Windows): a confined copy in a private temp folder is what ffmpeg reads.
        copyDir = await makeOwnedTempDir(join(this.o.tempDir ?? tmpdir(), 'ms-render-media-'));
        const copy = join(copyDir, 'source');
        await copyConfinedFile(p.compDir, src, copy).catch((e: { code?: string }) => { throw unreadable(src, e.code ?? 'refused'); });
        const h = createHash('sha256');
        await pipeline(createReadStream(copy), h);
        hashed = { sha256: h.digest('hex'), id: { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 } };
        input = (use) => use(mediaInput({ file: copy }), []);
      }
      if (signal.aborted) throw cancelled();
      const info = sourceInfoOf(await input((args, fds) => probeJson(ff, [...SOURCE_PROBE, ...args], { fds, signal })));
      if (!info) throw unreadable(src, 'no video stream');
      const size = targetSize(info, need);
      const name = mediaFileName(hashed.sha256, fps, size);
      if (!MEDIA_FILE_RE.test(name)) return { warnings: [{ kind: 'notNormalised', message: `video ${src} is not normalised: unexpected cache name` }] };
      const final = join(cacheDir, name);
      const want = { fps, ...size };
      const hdr = info.hdr ? hdrStage(info.hdr, ff.filters) : info.wideGamut ? { stage: gamutStage(info.wideGamut), approximate: false } : null;
      const notes: Array<Omit<MediaWarning, 'src'>> = hdr?.approximate ? [{ kind: 'hdrApproximate', message: `video ${src} is an HDR source: its colours are approximate` }] : [];
      const fields = (f: Pick<SessionMediaFile, 'sourceFps' | 'sourceStart' | 'sourceVideoEnd'>): SessionMediaFile => ({ file: final, ...f, originalVideoStart: info.videoStart, originalAudio: info.audio });
      // Leased from here: a hit, or the file about to be made, cannot be pruned or removed by anyone else meanwhile.
      const unhold = hold(final);
      const existing = await this.probeCached(ff, final, want, signal, 1);
      if (existing === 'damaged') { unhold(); return { warnings: [{ kind: 'notNormalised', message: `video ${src} is not normalised: its cached file is damaged and in use` }] }; }
      if (existing) { await this.touch(final); return { file: fields(existing), cached: true, warnings: notes }; }
      try {
        await this.encode(name, (sig) => this.make(ff, input, final, want, { allIntra: (info.durationSec ?? Infinity) < ALL_INTRA_UNDER_SEC, untagged: info.untagged, ...(hdr ? { colour: hdr.stage } : {}) }, sig), signal);
      } catch (e) {
        if (isCancel(e) || (e instanceof RenderError && e.code === 'mediaUnreadable')) throw e;
        if (signal.aborted) throw cancelled();
        unhold();
        return { warnings: [{ kind: 'notNormalised', message: `video ${src} is not normalised: ${(e as Error).message.slice(0, 300)}` }] };
      }
      const made = await this.probeCached(ff, final, want, signal, 1);
      if (!made || made === 'damaged') { unhold(); return { warnings: [{ kind: 'notNormalised', message: `video ${src} is not normalised: the result could not be verified` }] }; }
      await this.touch(final);
      void this.prune(cacheDir);
      return { file: fields(made), cached: false, warnings: notes };
    } finally {
      if (copyDir) await rm(copyDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async touch(file: string): Promise<void> {
    const now = new Date();
    await utimes(file, now, now).catch(() => {});
  }

  /** Enforces the size cap after a new file (never a file in use, never one used in the grace period). */
  private prune(cacheDir: string): Promise<string[]> {
    return pruneMediaCache(cacheDir, { maxBytes: this.o.maxCacheBytes ?? DEFAULT_MEDIA_CACHE_MAX_BYTES, maxUnusedMs: null, oldRecipes: false, inUse: this.inUse }).catch(() => []);
  }

  /**
   * Waits for the shared encode of `name`, starting it when none runs. The encode runs under its own controller (plus
   * `close()`), in a slot; it is cancelled only when every waiter's signal has aborted. A waiter that is still live when a
   * shared encode was cancelled under it (all others left meanwhile) starts a new one once.
   */
  private async encode(name: string, start: (signal: AbortSignal) => Promise<{ approximate: boolean }>, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let sh = this.shared.get(name);
      if (!sh || sh.ctl.signal.aborted) {
        const ctl = new AbortController();
        const sig = AbortSignal.any([ctl.signal, this.closing.signal]);
        const entry: SharedEncode = { ctl, waiters: 0, promise: null as unknown as Promise<{ approximate: boolean }> };
        entry.promise = this.track(this.slot(() => start(sig), sig));
        this.shared.set(name, entry);
        void entry.promise.catch(() => {}).finally(() => { if (this.shared.get(name) === entry) this.shared.delete(name); });
        sh = entry;
      }
      const cur = sh;
      cur.waiters++;
      let left = false;
      const leave = () => { if (left) return; left = true; if (--cur.waiters <= 0) cur.ctl.abort(cancelled()); };
      try {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(cancelled());
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
          cur.promise.then(() => { signal.removeEventListener('abort', onAbort); resolve(); },
            (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); });
        });
        left = true; // done: leaving must not cancel a finished encode's controller for nothing
        cur.waiters--;
        return;
      } catch (e) {
        leave();
        if (signal.aborted || this.closing.signal.aborted) {
          // This waiter's abort rejects at once, before the encode has reacted to it. When it was the last waiter (the encode
          // is cancelled), wait for that encode to settle: its ffmpeg group has exited and its temp file is removed (`make`).
          // A cancelled preparation then never settles while its encoder still runs or its temp file is still there.
          if (cur.waiters <= 0) await cur.promise.catch(() => {});
          throw cancelled();
        }
        if (isCancel(e) && attempt === 0) continue;
        throw e;
      }
    }
  }

  /**
   * The source fields of a cached file that is a single-linked regular file and probes as wanted; null when it is missing or
   * was damaged and is removed (to be made again); `damaged` when it is damaged but a live session uses it (left alone).
   */
  private async probeCached(ff: FfmpegInfo, file: string, want: { fps: number; width: number; height: number }, signal: AbortSignal, own = 0): Promise<Pick<SessionMediaFile, 'sourceFps' | 'sourceStart' | 'sourceVideoEnd'> | null | 'damaged'> {
    const st = await lstat(file).catch(() => null);
    if (!st) return null;
    const fields = st.isFile() && st.nlink === 1 ? await withConfinedFile(dirname(file), file.slice(dirname(file).length + 1), true, async (fh) => {
      let dup: FileHandle;
      try { dup = await open(`/dev/fd/${fh.fd}`, 'r'); } catch { return { skipped: 'unreadable' as const }; }
      try {
        const args = ff.fdProtocol && process.platform !== 'win32' ? mediaInput({ fd: 3 }, MP4_DEMUXERS) : mediaInput({ file }, MP4_DEMUXERS);
        return { value: normalisedFieldsOf(await probeJson(ff, [...NORMALISED_PROBE, ...args], { fds: [dup.fd], signal }), want) };
      } finally { await dup.close().catch(() => {}); }
    }) : null;
    const value = fields && 'value' in fields ? fields.value as Pick<SessionMediaFile, 'sourceFps' | 'sourceStart' | 'sourceVideoEnd'> | { problem: string } : null;
    if (value && !('problem' in value)) return value;
    // The name says exactly what the file must be, so a mismatch is damage: made again, unless a session is serving it.
    if ((this.leases.get(file) ?? 0) > own) return 'damaged';
    await rm(file, { force: true }).catch(() => {});
    return null;
  }

  /** Encodes into a hidden temp file next to `final`, then renames it; the temp file is removed on any failure. */
  private async make(ff: FfmpegInfo, input: <T>(use: (args: string[], fds: number[]) => Promise<T>) => Promise<T>, final: string,
    want: { fps: number; width: number; height: number }, how: { allIntra: boolean; untagged: boolean; colour?: ColourStage }, signal: AbortSignal): Promise<{ approximate: boolean }> {
    const name = final.slice(dirname(final).length + 1);
    const temp = join(dirname(final), `.${name.slice(0, -'.mp4'.length)}.${randomBytes(6).toString('hex')}.tmp`);
    this.stats.encodes++;
    let renamed = false;
    try {
      // `done` settles on the leader's exit (reaped): ffmpeg starts no children, so nothing writes `temp` after it.
      await input((args, fds) => spawnFfmpeg(ff, [...args, ...normalizeArgs({ ...want, ...how, ...(this.o.x264Preset ? { preset: this.o.x264Preset } : {}) }), temp], { signal, fds }).done);
      if (signal.aborted) throw cancelled();
      await rename(temp, final);
      renamed = true;
      await noteCoreChange(dirname(final));
      return { approximate: false };
    } finally {
      if (!renamed) await removeTempSettled(temp);
    }
  }
}

/** Re-checks of a removed temp file, and the pause before each (a bounded window: about 100 ms in all). */
const TEMP_RECHECKS = 4;
const TEMP_RECHECK_MS = 25;

/**
 * Removes an encode's temp file once its ffmpeg has exited, then re-checks it a few times within a short bounded window and
 * removes it again if it is back (belt and braces: a writer still flushing when the exit was reported). Never throws.
 */
export async function removeTempSettled(temp: string, o: { rechecks?: number; pauseMs?: number } = {}): Promise<void> {
  await rm(temp, { force: true }).catch(() => {});
  for (let i = 0; i < (o.rechecks ?? TEMP_RECHECKS); i++) {
    await new Promise((r) => setTimeout(r, o.pauseMs ?? TEMP_RECHECK_MS));
    if (await lstat(temp).then(() => true, () => false)) await rm(temp, { force: true }).catch(() => {});
  }
}

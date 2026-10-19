import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Writable } from 'node:stream';
import { QUALITY_BITRATE_FACTOR, videoTargetBitrateKbps, type ExportQuality, type FormatPreset } from '@motion-studio/shared';
import { RenderError } from './errors.ts';
import { binaryArch, hostArch, type BinaryArch } from './arch.ts';
import { killGroup, trackGroup } from './watchdog.ts';
import { makeOwnedTempDir } from './owner.ts';
import { execFf, ffprobeOf, MP4_DEMUXERS, ownInput, spawnFf, type CheckedFfArgs, type ChildProcess, type FfArg, type StdioOptions } from '../media/ffmpeg-exec.ts';
import { h264ColourFilter, ssimCompareFilter, testPatternInput } from '../media/ffmpeg-filters.ts';

export { binaryArch, hostArch, type BinaryArch } from './arch.ts';

/**
 * ffmpeg for the renderer (spec §5.3): discovery with the binary's CPU architecture (an x86_64 ffmpeg under Rosetta on
 * Apple Silicon is reported, never silently accepted as native), process control (own process group, killed as a group on
 * cancel and failure), the H.264 settings of phase 8, the optional VideoToolbox encoder behind a quality check, and the
 * final concat + mux.
 */

export interface FfmpegInfo {
  path: string;
  version: string;
  /** The ffmpeg binary's architecture (Mach-O / ELF header). */
  arch: BinaryArch;
  /** The machine's: `arm64` on Apple Silicon even when Node itself runs under Rosetta. */
  hostArch: string;
  /** An x86_64-only ffmpeg on an arm64 machine (Rosetta 2, which may be absent: then it is not found at all): it works, slower. The doctor reports it (Task 8). */
  translated: boolean;
  encoders: ReadonlySet<string>;
  /** Supports `-fd N -i fd:` (seekable input from an open file descriptor). */
  fdProtocol: boolean;
  /** The filters of this build (e.g. `zscale`, `tonemap`, `colorspace`); absent: unknown. */
  filters?: ReadonlySet<string>;
}


/** Every `name` on PATH (or the usual install places), in order: a build that cannot run here is skipped for the next. */
function which(name: string, env: NodeJS.ProcessEnv): string[] {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  const found: string[] = [];
  for (const d of dirs) { const p = join(d, exe); if (existsSync(p) && !found.includes(p)) found.push(p); }
  return found;
}

const infoCache = new Map<string, Promise<FfmpegInfo | null>>();

/** One candidate: null when it does not run (missing, wrong CPU architecture with no Rosetta, broken, spawn error). Cached per path. */
function probeFfmpeg(path: string): Promise<FfmpegInfo | null> {
  let p = infoCache.get(path);
  if (!p) {
    p = (async () => {
      const v = await execFf(path, ['-hide_banner', '-version'], 60_000);
      if (v.code !== 0) return null;
      const [enc, prot, arch, host, flt] = await Promise.all([
        execFf(path, ['-hide_banner', '-encoders'], 60_000), execFf(path, ['-hide_banner', '-protocols'], 60_000), binaryArch(path), hostArch(),
        execFf(path, ['-hide_banner', '-filters'], 60_000),
      ]);
      const filters = new Set<string>();
      for (const line of flt.stdout.split('\n')) { const m = /^\s*[TSC.]{2,3}\s+(\S+)\s+\S+->\S+/.exec(line); if (m) filters.add(m[1]!); }
      const encoders = new Set<string>();
      for (const line of enc.stdout.split('\n')) { const m = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line); if (m) encoders.add(m[1]!); }
      const input = prot.stdout.split(/Output:/)[0] ?? '';
      return {
        path, version: /ffmpeg version (\S+)/.exec(v.stdout)?.[1] ?? 'unknown', arch, hostArch: host,
        translated: host === 'arm64' && arch === 'x86_64', encoders, filters, fdProtocol: /^\s*fd\s*$/m.test(input),
      };
    })().catch(() => null);
    infoCache.set(path, p);
  }
  return p;
}

/**
 * ffmpeg: `FFMPEG_PATH`, else PATH and the usual places. Null when missing or none answering (an Intel-only build on a Mac
 * without Rosetta cannot be started: it is skipped and the next one is tried, e.g. /opt/homebrew/bin after /usr/local/bin).
 */
export async function findFfmpeg(env: NodeJS.ProcessEnv = process.env): Promise<FfmpegInfo | null> {
  const paths = env.FFMPEG_PATH ? (existsSync(env.FFMPEG_PATH) ? [env.FFMPEG_PATH] : []) : which('ffmpeg', env);
  for (const path of paths) {
    const info = await probeFfmpeg(path);
    if (info) return info;
  }
  return null;
}

export interface FfmpegProcess {
  proc: ChildProcess;
  /** stdin, when requested. */
  stdin: Writable | null;
  /** Resolves on exit 0; rejects with `ffmpegFailed` (and the stderr tail) or `cancelled`. */
  done: Promise<void>;
  kill(): void;
}

/**
 * Starts ffmpeg in its own process group (killed as a whole on `kill()` or abort), `-loglevel error`, never prompting.
 * `fds` are open file descriptors handed to the child as fd 3, 4, … (`-fd N -i fd:`). Every input of `args` must come from
 * `mediaInput`/`ownInput` (`media/ffmpeg-exec.ts`): an input without the whitelists is refused (throws). Filtergraphs and lavfi
 * inputs only from `media/ffmpeg-filters.ts` (a raw string for them does not compile and throws).
 */
export function spawnFfmpeg<const A extends readonly FfArg[]>(ff: FfmpegInfo, args: A & CheckedFfArgs<A>, o: { signal?: AbortSignal; stdin?: boolean; fds?: number[] } = {}): FfmpegProcess {
  const stdio: StdioOptions = [o.stdin ? 'pipe' : 'ignore', 'ignore', 'pipe', ...(o.fds ?? [])];
  const all: readonly FfArg[] = ['-hide_banner', '-loglevel', 'error', ...(o.stdin ? [] : ['-nostdin']), '-y', ...args];
  let proc: ChildProcess;
  try { proc = spawnFf(ff.path, all, { stdio, detached: true }); } catch (e) {
    // A synchronous spawn error (e.g. EBADARCH, errno -86, an Intel binary without Rosetta) is a failed render (a RenderError), not a crash.
    throw new RenderError('ffmpegFailed', `ffmpeg could not start: ${(e as Error).message}`);
  }
  const untrack = proc.pid ? trackGroup(proc.pid) : () => {};
  let tail = '';
  proc.stderr!.on('data', (d: Buffer) => { tail = (tail + d.toString('utf8')).slice(-4000); });
  proc.stdin?.on('error', () => { /* ffmpeg exited early: reported by `done` */ });
  let cancelled = false;
  // Only while the leader runs: ffmpeg starts no children, and once it is reaped its pid may be reused.
  const kill = () => { if (proc.exitCode === null && proc.signalCode === null) { if (proc.pid) killGroup(proc.pid); else proc.kill('SIGKILL'); } };
  const onAbort = () => { cancelled = true; kill(); };
  if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener('abort', onAbort, { once: true });
  const done = new Promise<void>((resolve, reject) => {
    const finish = (code: number | null, sig: NodeJS.Signals | null, err?: Error) => {
      o.signal?.removeEventListener('abort', onAbort);
      untrack();
      if (cancelled) reject(new RenderError('cancelled', 'cancelled'));
      else if (err) reject(new RenderError('ffmpegFailed', `ffmpeg could not start: ${err.message}`));
      else if (code !== 0) reject(new RenderError('ffmpegFailed', `ffmpeg exited with ${code ?? sig}: ${tail.trim().slice(-1500)}`));
      else resolve();
    };
    proc.once('error', (e) => finish(null, null, e));
    proc.once('exit', (code, sig) => finish(code, sig));
  });
  done.catch(() => {});
  return { proc, stdin: proc.stdin, done, kill };
}

/** Runs ffmpeg to completion. */
export function runFfmpeg<const A extends readonly FfArg[]>(ff: FfmpegInfo, args: A & CheckedFfArgs<A>, o: { signal?: AbortSignal; fds?: number[] } = {}): Promise<void> {
  const all: readonly FfArg[] = args;
  return spawnFfmpeg(ff, all, o).done;
}

/**
 * The encoder's input: the captured frames on stdin, PNG or JPEG images (`image2pipe`), or raw BGRA frames of one size
 * (report 53: the desktop reads them without encoding).
 */
export function frameInput(frames: 'png' | 'jpeg' | { raw: { width: number; height: number } }, fps: number): string[] {
  if (typeof frames === 'object') {
    return ownInput('-', { formats: ['rawvideo'], force: true, options: ['-pixel_format', 'bgra', '-video_size', `${frames.raw.width}x${frames.raw.height}`, '-framerate', String(fps)] });
  }
  return ownInput('-', { formats: ['image2pipe'], force: true, options: ['-c:v', frames === 'png' ? 'png' : 'mjpeg', '-framerate', String(fps)] });
}

/** The target bitrate of phase 8 (kbps) for a preset at `fps`. */
export function targetKbps(format: Pick<FormatPreset, 'width' | 'height' | 'targetBitrateKbps'>, fps: number): number {
  const base = format.targetBitrateKbps ?? videoTargetBitrateKbps(format.width, format.height);
  return fps > 45 ? Math.round(base * 1.5) : base;
}

export type VideoEncoder = 'libx264' | 'h264_videotoolbox';

/**
 * H.264 output settings (phase 8, `prompt.ts` `encodeFlags`): `yuv420p`, CRF 20 capped at 1.5× the target bitrate with a
 * 2× buffer (VideoToolbox has no CRF: the target bitrate with the same cap). BT.709, limited range, converted explicitly
 * from the full-range BT.601 JPEG frames (or RGB PNG frames) Chromium captures. A key frame every 2 s.
 *
 * Tags (orchestrator ruling, Task 5): full BT.709 (primaries, transfer and matrix), limited range, pixel values unchanged.
 * ffmpeg 8 takes the stream's colour properties from the frames, so `setparams` sets them in the chain (the `-color_*`
 * options alone left primaries and transfer `unknown`). Known effect: Chrome's `<video>` converts the BT.709 transfer, so a
 * final file played in Chrome shows mid-tones about 8 levels lighter than the preview canvas (measured; platforms and
 * phone players show BT.709 SDR as display-referred, i.e. as designed).
 */
export function h264Args(encoder: VideoEncoder, kbps: number, fps: number, preset = 'fast',
  o: { crf?: number; cap?: boolean; size?: { width: number; height: number } } = {}): FfArg[] {
  const color: FfArg[] = [h264ColourFilter(o.size), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
  // `cap: false` (quality `max`): libx264 at its CRF alone. VideoToolbox has no CRF: it always keeps its bitrate and cap.
  const cap = o.cap !== false || encoder === 'h264_videotoolbox' ? ['-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${Math.round(kbps * 2)}k`] : [];
  const common = ['-r', String(fps), '-g', String(fps * 2), ...cap, '-profile:v', 'high'];
  if (encoder === 'h264_videotoolbox') return [...color, '-c:v', 'h264_videotoolbox', '-b:v', `${kbps}k`, '-allow_sw', '0', '-realtime', '0', ...common];
  return [...color, '-c:v', 'libx264', '-preset', preset, '-crf', String(o.crf ?? 20), '-pix_fmt', 'yuv420p', ...common];
}

/** How a quality is encoded (decision 974): the encoder choice, the bitrate (target and cap reference), CRF, and the frames. */
export interface QualitySettings {
  encoder: 'auto' | VideoEncoder;
  kbps: number;
  crf: number;
  /** Whether the bitrate caps the encode (`-maxrate` 1.5x `kbps`). */
  cap: boolean;
  /** The libx264 preset, when not the default `fast`. */
  preset?: string;
  /** The intermediate frames: JPEG at `jpegQuality`, or lossless PNG. */
  capture: 'jpeg' | 'png';
  jpegQuality?: number;
}

/**
 * The encode of a quality from the phase 8 target `kbps` of the output (`targetKbps`, scaled by its pixels):
 * - `standard`: as every render before decision 974: VideoToolbox when its check passes, the target bitrate, CRF 20, JPEG q90;
 * - `high` (default): libx264 CRF 18 capped at 1.6x the target (8 Mbps at 1080p30 landscape), JPEG q95;
 * - `max`: libx264 CRF 16 with no cap, preset `medium`, PNG frames (no JPEG loss before the encode).
 */
export function qualitySettings(quality: ExportQuality, kbps: number): QualitySettings {
  const at = (k: number) => Math.max(100, Math.round((kbps * k) / 100) * 100);
  if (quality === 'standard') return { encoder: 'auto', kbps, crf: 20, cap: true, capture: 'jpeg', jpegQuality: 90 };
  if (quality === 'max') return { encoder: 'libx264', kbps: at(QUALITY_BITRATE_FACTOR.max), crf: 16, cap: false, preset: 'medium', capture: 'png' };
  return { encoder: 'libx264', kbps: at(QUALITY_BITRATE_FACTOR.high), crf: 18, cap: true, capture: 'jpeg', jpegQuality: 95 };
}

/** The minimum SSIM a VideoToolbox test encode must reach against its source (libx264 at the same cap scores ≈0.98+). */
export const VIDEOTOOLBOX_MIN_SSIM = 0.97;
export interface VideotoolboxCheck { ok: boolean; ssim: number | null; reason?: string; transient?: boolean }
const vtCache = new Map<string, Promise<VideotoolboxCheck>>();

/**
 * Whether `h264_videotoolbox` is usable for this size: macOS only, the encoder present, and a 2 s test pattern encoded at
 * the format's target bitrate reaches `VIDEOTOOLBOX_MIN_SSIM` against the source. A real quality result is cached per
 * ffmpeg, size, fps and bitrate; a transient failure (the encoder or the comparison did not run, e.g. under load or with
 * the hardware busy) is not, so the next render checks again.
 */
export function checkVideotoolbox(ff: FfmpegInfo, width: number, height: number, fps: number, kbps: number): Promise<VideotoolboxCheck> {
  if (process.platform !== 'darwin' || !ff.encoders.has('h264_videotoolbox')) return Promise.resolve({ ok: false, ssim: null, reason: 'unavailable' });
  const key = `${ff.path}|${width}x${height}@${fps}|${kbps}`;
  let p = vtCache.get(key);
  if (!p) {
    p = (async (): Promise<VideotoolboxCheck> => {
      const dir = await makeOwnedTempDir(join(tmpdir(), 'ms-render-vtcheck-'));
      try {
        // The test pattern (`media/ffmpeg-filters.ts` `testPatternInput`): counters at two sizes over colour bars.
        const src = testPatternInput(width, height, fps);
        const out = join(dir, 'vt.mp4');
        const enc = await execFf(ff.path, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', src, ...h264Args('h264_videotoolbox', kbps, fps), '-f', 'mp4', out], 300_000);
        if (enc.code !== 0) return { ok: false, ssim: null, reason: enc.stderr.trim().slice(-300) || 'encode failed', transient: true };
        const cmp = await execFf(ff.path, ['-hide_banner', '-nostdin', '-loglevel', 'info', ...ownInput(out, { formats: MP4_DEMUXERS }), src,
          ssimCompareFilter(), '-f', 'null', '-'], 300_000);
        const ssim = Number(/All:([\d.]+)/.exec(cmp.stderr)?.[1]);
        if (!Number.isFinite(ssim)) return { ok: false, ssim: null, reason: 'no SSIM', transient: true };
        return { ok: ssim >= VIDEOTOOLBOX_MIN_SSIM, ssim, ...(ssim < VIDEOTOOLBOX_MIN_SSIM ? { reason: 'quality' } : {}) };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    })();
    vtCache.set(key, p);
    void p.then((r) => { if (r.transient) vtCache.delete(key); }, () => vtCache.delete(key));
  }
  return p;
}

/** Picks the encoder: `auto` takes VideoToolbox on macOS when its quality check passes, else libx264. */
export async function chooseEncoder(ff: FfmpegInfo, choice: 'auto' | VideoEncoder, width: number, height: number, fps: number, kbps: number): Promise<VideoEncoder> {
  if (choice === 'libx264') return 'libx264';
  if (choice === 'h264_videotoolbox') {
    if (!ff.encoders.has('h264_videotoolbox')) throw new RenderError('ffmpegFailed', 'h264_videotoolbox is not available');
    return 'h264_videotoolbox';
  }
  return (await checkVideotoolbox(ff, width, height, fps, kbps)).ok ? 'h264_videotoolbox' : 'libx264';
}

/** One line of a concat demuxer list (`file '<path>'`, quotes escaped). */
export const concatLine = (p: string) => `file '${p.replace(/'/g, "'\\''")}'`;

export interface StreamCount { frames: number; width: number; height: number; audio: boolean }

/** Counts the video packets (one per frame for our H.264) of `file` and reads its size; null when unreadable. */
export async function countVideoFrames(ff: FfmpegInfo, file: string): Promise<StreamCount | null> {
  const r = await execFf(ffprobeOf(ff.path), ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_type,nb_read_packets,width,height', '-of', 'json', ...ownInput(file, { formats: MP4_DEMUXERS })], 300_000);
  if (r.code !== 0) return null;
  try {
    const data = JSON.parse(r.stdout) as { streams?: Array<{ codec_type?: string; nb_read_packets?: string; width?: number; height?: number }> };
    const v = data.streams?.find((s) => s.codec_type === 'video');
    if (!v) return null;
    return { frames: Number(v.nb_read_packets), width: v.width ?? 0, height: v.height ?? 0, audio: !!data.streams?.some((s) => s.codec_type === 'audio') };
  } catch { return null; }
}

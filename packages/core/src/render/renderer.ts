import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Composition, FormatPreset } from '@motion-studio/shared';
import { RUNTIME_DIST_DIR } from '@motion-studio/composition-runtime/dist';
import { startCompositionServer, type CompositionServer, type CompositionSession, type SessionMedia } from '../compositions/composition-server.ts';
import { readRegularFile } from '../safe-read.ts';
import { mixAudio, mixClips } from './audio-mix.ts';
import { CdpError } from './cdp-pipe.ts';
import { captureFrame, captureSegment, splitSegments, writeWithBackpressure } from './capture.ts';
import {
  ChromeProvider, RenderError, type CaptureFormat, type ChromiumProvider, type ChromiumProviderFactory, type PageTimeouts,
  type RenderPage, type RuntimeErrorInfo,
} from './chromium-provider.ts';
import { cftPlatform, findInstalledCft } from './cft-download.ts';
import { chooseEncoder, concatLine, countVideoFrames, findFfmpeg, h264Args, hostArch, spawnFfmpeg, targetKbps, type FfmpegInfo, type VideoEncoder } from './encode.ts';
import { findSystemChrome } from './system-chrome.ts';
import type { WatchdogLimits } from './watchdog.ts';

/**
 * The core renderer (spec §5.3): composition → final media, outside the agent sandbox, through the isolated composition
 * server and an isolated Chromium (isolation.ts), with the phase 8 encoding targets.
 *
 * - **Video:** `round(duration × fps)` frames at `t = i / fps`, split into `parallel` contiguous segments (default 4), one
 *   page each, every page streaming JPEG q90 into its own ffmpeg (image2pipe → H.264 segment); then the concat demuxer
 *   with the audio mix muxed as AAC 128k, `+faststart`. The frame count of the result is checked exactly.
 * - **Still** (`duration` 0): one capture at t = 0, PNG (or JPEG/WebP when `out` asks for it).
 * - Everything is written to temp files; the output is renamed to `out` only on success. On cancel, a time limit, a crash,
 *   a watchdog trip or an ffmpeg failure, the browser group and every ffmpeg are killed and the temp files removed.
 * - Any runtime error (missing asset, font, layer timeout…) fails the render, except `audioBlocked` (preview only) and
 *   `videoFrameMismatch` (a warning: an untrusted source showed a frame its metadata does not place at the target),
 *   returned in `warnings`. A video frame that cannot be drawn (`videoSeekTimeout`) rejects the seek at once, so the
 *   render stops on it instead of waiting out every later seek.
 */

export interface RenderResult {
  file: string; sha256: string; width: number; height: number; durationSec: number | null; frames: number; encoder: VideoEncoder | null; audio: boolean;
  /** Non-fatal runtime reports (`videoFrameMismatch`: an untrusted source's frame drawn on stability), at most 50. */
  warnings: RuntimeErrorInfo[];
}

export interface RenderProgress { frames: number; total: number }

export interface RenderCompositionOptions {
  /** The creative folder. */
  dir: string;
  /** The version folder under it (`outputs/v3`); the composition folder is `<dir>/<versionDir>/compositions/<format.id>`. */
  versionDir: string;
  /** The normalised, validated composition. */
  composition: Composition;
  format: FormatPreset;
  /** The final file (`…/outputs/vN/<format>.<ext>`): `.mp4`/`.mov`/`.m4v` for a video, `.png`/`.jpg`/`.jpeg`/`.webp` for a still. */
  out: string;
  /** The browser for this render; always closed at the end. */
  provider: ChromiumProvider;
  /** Pages in parallel (video); default 4, clamped to 1–16 and to the frame count. */
  parallel?: number;
  signal: AbortSignal;
  onProgress?(p: RenderProgress): void;
  /** A running composition server; by default the render starts its own and closes it. */
  server?: CompositionServer;
  /** The built runtime (default `RUNTIME_DIST_DIR`), for a server the render starts and for `clock.js`. */
  distDir?: string;
  ffmpeg?: FfmpegInfo;
  /** `auto` (default): VideoToolbox on macOS when its quality check passes, else libx264. */
  encoder?: 'auto' | VideoEncoder;
  /** libx264 preset; default `fast`. */
  x264Preset?: string;
  /** JPEG quality of the intermediate frames; default 90. */
  jpegQuality?: number;
  /** Wall-clock limit of the whole render, ms; default 5 min + 5 s per frame. */
  timeLimitMs?: number;
  /** Where the work folder goes; default the OS temp folder. */
  tempDir?: string;
  /**
   * The normalised video media (`MediaNormalizer.prepare`), given to the composition server session: the page plays those
   * files, with the trusted source fields. The audio mix still reads the composition's own sources.
   */
  media?: SessionMedia;
}

/** The hidden temp file a render writes next to its output (`.<name>.render-<hex>.tmp`): the startup sweep removes old ones. */
export const RENDER_TEMP_RE = /^\..+\.render-[0-9a-f]{12}\.tmp$/;
/** The work folder of a render in the temp folder holds this file with the core's pid (the startup sweep skips live ones). */
export const RENDER_OWNER_FILE = 'owner.pid';

export const DEFAULT_PARALLEL = 4;
/** Runtime reports that never fail a render: `audioBlocked` (preview only) and `videoFrameMismatch` (a warning). */
const IGNORED_RUNTIME_ERRORS = new Set(['audioBlocked', 'videoFrameMismatch']);
const VIDEO_EXT: Record<string, string> = { '.mp4': 'mp4', '.m4v': 'mp4', '.mov': 'mov' };
const STILL_EXT: Record<string, CaptureFormat> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' };

/** A RenderError for anything thrown during a render (a CDP timeout during a frame is a `frameTimeout`). */
export function toRenderError(e: unknown): RenderError {
  if (e instanceof RenderError) return e;
  if (e instanceof CdpError) return new RenderError(e.code === 'timeout' ? 'frameTimeout' : e.code === 'closed' ? 'crashed' : 'loadFailed', e.message);
  return new RenderError('loadFailed', e instanceof Error ? e.message : String(e));
}

const failing = (errors: RuntimeErrorInfo[]) => errors.filter((e) => !IGNORED_RUNTIME_ERRORS.has(e.code));
const warningsOf = (lists: RuntimeErrorInfo[][]) => {
  const seen = new Set<string>();
  return lists.flat().filter((e) => e.code === 'videoFrameMismatch' && !seen.has(e.message) && (seen.add(e.message), true)).slice(0, 50);
};

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

async function clockSource(distDir: string): Promise<string | undefined> {
  const r = await readRegularFile(join(distDir, 'clock.js'), 1024 * 1024).catch(() => null);
  return r && r.kind === 'file' ? r.data.toString('utf8') : undefined;
}

/** Renders one format of a composition version (see the module comment). */
export async function renderComposition(o: RenderCompositionOptions): Promise<RenderResult> {
  const c = o.composition;
  const still = !(c.duration > 0);
  const ext = extname(o.out).toLowerCase();
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort(new RenderError('cancelled', 'cancelled'));
  // Cancel, the time limit or a failing segment: the browser goes at once, as a whole group. A call in flight on a page
  // (a seek stuck in a layer) would otherwise wait for its own timeout.
  ctl.signal.addEventListener('abort', () => {
    const r: unknown = ctl.signal.reason;
    if (!(r instanceof RenderError && r.message === 'render finished')) void o.provider.close().catch(() => {});
  }, { once: true });
  if (o.signal.aborted) onOuterAbort(); else o.signal.addEventListener('abort', onOuterAbort, { once: true });
  const frames = still ? 1 : Math.max(1, Math.round(c.duration * c.fps));
  const deadline = setTimeout(() => ctl.abort(new RenderError('timeLimit', 'the render took too long')), o.timeLimitMs ?? 300_000 + frames * 5_000);
  const tempOut = join(dirname(o.out), `.${basename(o.out)}.render-${randomBytes(6).toString('hex')}.tmp`);
  let work: string | null = null;
  let server: CompositionServer | null = null;
  let session: CompositionSession | null = null;
  const pages: RenderPage[] = [];
  let warnings: RuntimeErrorInfo[] = [];
  /** The error the render reports: the browser's own failure, a user cancel, the time limit, else the first error. */
  const reason = (e: unknown): RenderError => {
    const f = o.provider.failure;
    if (f) return new RenderError(f.code, f.message);
    if (o.signal.aborted) return new RenderError('cancelled', 'cancelled');
    const r: unknown = ctl.signal.aborted ? ctl.signal.reason : null;
    if (r instanceof RenderError && r.code === 'timeLimit') return r;
    if (e instanceof RenderError && e.code !== 'cancelled') return e;
    if (r instanceof Error && !(r instanceof RenderError && r.code === 'cancelled')) return toRenderError(r);
    return toRenderError(e);
  };
  try {
    if (c.width !== o.format.width || c.height !== o.format.height) {
      throw new RenderError('compositionMismatch', `the composition is ${c.width}×${c.height}, the format ${o.format.width}×${o.format.height}`);
    }
    if (still ? !(ext in STILL_EXT) : !(ext in VIDEO_EXT)) throw new RenderError('unsupportedOutput', `cannot render ${still ? 'a still' : 'a video'} to ${ext || 'a file without extension'}`);
    const ff = still ? null : (o.ffmpeg ?? await findFfmpeg());
    if (!still && !ff) throw new RenderError('noFfmpeg', 'ffmpeg is needed to render a video');
    const distDir = o.distDir ?? RUNTIME_DIST_DIR;
    server = o.server ?? await startCompositionServer({ uiOrigins: [], distDir });
    session = await server.mintSession({ creativeDir: o.dir, versionDir: o.versionDir, format: o.format.id, composition: c, mode: 'render', ttlMs: (o.timeLimitMs ?? 300_000 + frames * 5_000) + 60_000, ...(o.media ? { media: o.media } : {}) });
    const clock = await clockSource(distDir);
    const openPage = async () => {
      const p = await o.provider.open({ width: c.width, height: c.height, url: session!.url, signal: ctl.signal, ...(clock ? { clockSource: clock } : {}) });
      pages.push(p);
      const bad = failing(p.info.errors);
      if (bad.length) throw new RenderError('runtimeErrors', `the composition has errors: ${bad.map((e) => e.code).join(', ')}`, bad);
      if (p.info.frames !== frames || p.info.fps !== c.fps) throw new RenderError('compositionMismatch', 'the page and the composition disagree on frames');
      return p;
    };
    const progress = { frames: 0, total: frames };
    const tick = () => { progress.frames++; o.onProgress?.({ ...progress }); };
    o.onProgress?.({ ...progress });

    if (still) {
      const page = await openPage();
      const buf = await captureFrame(page, 0, { format: STILL_EXT[ext]!, ...(ext === '.png' ? {} : { quality: 95 }), width: c.width, height: c.height });
      const all = await page.errors();
      const bad = failing(all);
      if (bad.length) throw new RenderError('runtimeErrors', `the composition has errors: ${bad.map((e) => e.code).join(', ')}`, bad);
      warnings = warningsOf([all]);
      tick();
      await writeFile(tempOut, buf, { flag: 'wx', mode: 0o644 });
    } else {
      work = await mkdtemp(join(o.tempDir ?? tmpdir(), 'ms-render-'));
      await writeFile(join(work, RENDER_OWNER_FILE), String(process.pid));
      const kbps = targetKbps(o.format, c.fps);
      const encoder = await chooseEncoder(ff!, o.encoder ?? 'auto', c.width, c.height, c.fps, kbps);
      const segments = splitSegments(frames, Math.min(16, Math.max(1, Math.floor(o.parallel ?? DEFAULT_PARALLEL))));
      const wav = join(work, 'mix.wav');
      const audio = mixAudio({ ff: ff!, compDir: join(o.dir, ...o.versionDir.split('/'), 'compositions', o.format.id), clips: mixClips(c), durationSec: c.duration, outWav: wav, workDir: work, signal: ctl.signal });
      audio.catch((e: unknown) => { if (!ctl.signal.aborted) ctl.abort(toRenderError(e)); });
      const opened = await Promise.allSettled(segments.map(() => openPage()));
      const failed = opened.find((r) => r.status === 'rejected');
      if (failed) throw (failed as PromiseRejectedResult).reason;
      const segFiles = await Promise.all(segments.map(async (seg, j) => {
        const page = (opened[j] as PromiseFulfilledResult<RenderPage>).value;
        const file = join(work!, `seg-${String(seg.index).padStart(2, '0')}.mp4`);
        const enc = spawnFfmpeg(ff!, ['-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(c.fps), '-i', '-',
          ...h264Args(encoder, kbps, c.fps, o.x264Preset), '-an', '-f', 'mp4', file], { signal: ctl.signal, stdin: true });
        try {
          await captureSegment(page, seg, {
            fps: c.fps, format: 'jpeg', quality: o.jpegQuality ?? 90, width: c.width, height: c.height, signal: ctl.signal,
            sink: (buf) => writeWithBackpressure(enc.stdin!, buf, enc.done), onFrame: tick,
          });
          enc.stdin!.end();
          await enc.done;
        } catch (e) {
          enc.kill();
          ctl.abort(reason(e)); // stop the other segments at once
          throw e;
        }
        return file;
      }));
      const reports: RuntimeErrorInfo[][] = [];
      for (const p of pages) {
        const all = await p.errors();
        reports.push(all);
        const bad = failing(all);
        if (bad.length) throw new RenderError('runtimeErrors', `the composition has errors: ${bad.map((e) => e.code).join(', ')}`, bad);
      }
      warnings = warningsOf(reports);
      await Promise.all(pages.splice(0).map((p) => p.close().catch(() => {})));
      const hasAudio = await audio;
      const list = join(work, 'segments.txt');
      await writeFile(list, segFiles.map(concatLine).join('\n') + '\n');
      await spawnFfmpeg(ff!, ['-f', 'concat', '-safe', '0', '-i', list, ...(hasAudio ? ['-i', wav] : []),
        '-map', '0:v:0', ...(hasAudio ? ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000'] : []),
        '-c:v', 'copy', '-movflags', '+faststart', '-f', VIDEO_EXT[ext]!, tempOut], { signal: ctl.signal }).done;
      const check = await countVideoFrames(ff!, tempOut);
      if (!check || check.frames !== frames || check.width !== c.width || check.height !== c.height) {
        throw new RenderError('ffmpegFailed', `the output has ${check ? `${check.frames} frames at ${check.width}×${check.height}` : 'no readable video'}, expected ${frames} at ${c.width}×${c.height}`);
      }
      const sha256 = await sha256File(tempOut);
      await rename(tempOut, o.out);
      return { file: o.out, sha256, width: c.width, height: c.height, durationSec: c.duration, frames, encoder, audio: hasAudio, warnings };
    }
    const sha256 = await sha256File(tempOut);
    await rename(tempOut, o.out);
    return { file: o.out, sha256, width: c.width, height: c.height, durationSec: null, frames: 1, encoder: null, audio: false, warnings };
  } catch (e) {
    const err = reason(e);
    // Failed: the browser goes first, as a whole group (a page may be stuck in a loop; closing it politely would wait).
    await o.provider.close().catch(() => {});
    throw err;
  } finally {
    clearTimeout(deadline);
    o.signal.removeEventListener('abort', onOuterAbort);
    if (!ctl.signal.aborted) ctl.abort(new RenderError('cancelled', 'render finished'));
    await Promise.all(pages.map((p) => p.close().catch(() => {})));
    await o.provider.close().catch(() => {});
    session?.revoke();
    if (server && !o.server) await server.close().catch(() => {});
    await rm(tempOut, { force: true }).catch(() => {});
    if (work) await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

export interface RenderEngineOptions {
  /** An injected provider factory (the desktop app's Electron provider, Task 7). Wins over everything else. */
  provider?: ChromiumProviderFactory;
  /** The app data folder: an installed Chrome for Testing is looked for in `<appDataDir>/chromium/`. */
  appDataDir?: string;
  limits?: Partial<WatchdogLimits>;
  timeouts?: PageTimeouts;
  env?: NodeJS.ProcessEnv;
}

export interface RenderEngineInfo {
  kind: 'electron' | 'system' | 'cft' | 'injected' | null;
  exe?: string;
  version?: string;
}

/**
 * Which Chromium renders, resolved at each use (Chrome may be installed or Chrome for Testing downloaded meanwhile):
 * the injected factory, else system Chrome, else an installed Chrome for Testing, else none (the UI offers the download).
 */
export function createRenderEngine(o: RenderEngineOptions = {}) {
  const limits = (): WatchdogLimits => ({ timeLimitMs: 4 * 60 * 60 * 1000, ...o.limits });
  async function resolve(): Promise<{ info: RenderEngineInfo; factory: ChromiumProviderFactory | null }> {
    if (o.provider) return { info: { kind: 'injected' }, factory: o.provider };
    const sys = await findSystemChrome({ env: o.env });
    if (sys) return { info: { kind: 'system', exe: sys.exe, version: sys.version }, factory: async () => new ChromeProvider({ exe: sys.exe, kind: 'system', limits: limits(), timeouts: o.timeouts }) };
    if (o.appDataDir) {
      let platform;
      try { platform = cftPlatform(process.platform, await hostArch()); } catch { platform = null; }
      const cft = platform ? await findInstalledCft(o.appDataDir, platform) : null;
      if (cft) return { info: { kind: 'cft', exe: cft.exe, version: cft.version }, factory: async () => new ChromeProvider({ exe: cft.exe, kind: 'cft', limits: limits(), timeouts: o.timeouts }) };
    }
    return { info: { kind: null }, factory: null };
  }
  return {
    /** The render engine that would be used now (System check, Task 8). */
    info: async () => (await resolve()).info,
    /** A provider for one render; throws `noBrowser` when there is none. */
    async provider(): Promise<ChromiumProvider> {
      const { factory } = await resolve();
      if (!factory) throw new RenderError('noBrowser', 'no Chromium available: install Chrome, or download Chrome for Testing');
      return factory();
    },
    /** Renders with a fresh provider from this engine. */
    async render(opts: Omit<RenderCompositionOptions, 'provider'>): Promise<RenderResult> {
      return renderComposition({ ...opts, provider: await this.provider() });
    },
  };
}
export type RenderEngine = ReturnType<typeof createRenderEngine>;


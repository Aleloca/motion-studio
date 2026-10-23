import type { Composition, FormatPreset } from '@motion-studio/shared';
import type { RuntimeSubtitles } from '@motion-studio/composition-runtime/page';
import { RUNTIME_DIST_DIR } from '@motion-studio/composition-runtime/dist';
import { startCompositionServer, type CompositionServer, type CompositionSession, type SessionMedia } from '../compositions/composition-server.ts';
import { readRegularFile } from '../safe-read.ts';
import { join } from 'node:path';
import { imageSize, seekAndGrab } from './capture.ts';
import { RenderError, type CaptureFormat, type ChromiumProvider, type RenderPage, type RuntimeErrorInfo } from './chromium-provider.ts';

/**
 * A few frames of a composition, small, without encoding anything (Task 5b): the storyboard thumbnails (scene starts and
 * the poster, 270 px wide) and the agent's `preview_frames` (up to 6 PNGs, at most 540 px wide). Same path as a render:
 * the isolated composition server, a render-mode session and an isolated Chromium page driven over CDP; the frame is shrunk
 * in the browser (`Page.captureScreenshot` `clip.scale`), so no full-size image is ever encoded.
 *
 * Runtime errors do not throw: they are returned (`errors`, without `audioBlocked` and `videoFrameMismatch`), so the agent
 * sees what is wrong next to the frames it asked for. A seek or capture that fails throws, as in a render.
 */

export interface RenderFramesOptions {
  /** The creative folder, and the version folder under it (`outputs/v3`), as for a render. */
  dir: string;
  versionDir: string;
  /** The normalised composition (validated: a frame of an invalid one is never asked for). */
  composition: Composition;
  /** The format whose composition folder this is (`compositions/<format.id>`). */
  format: FormatPreset;
  /** Times in seconds; each is clamped to the composition (a still shows t = 0). */
  times: number[];
  /** Width of each image in pixels (at most the composition's); the height follows the aspect ratio. */
  width: number;
  imageFormat: CaptureFormat;
  /** JPEG/WebP quality (default 80). */
  quality?: number;
  provider: ChromiumProvider;
  signal: AbortSignal;
  /** The normalised video media (`MediaNormalizer.prepare`). */
  media?: SessionMedia;
  server?: CompositionServer;
  distDir?: string;
  /** Wall-clock limit, ms (default 120 s + 10 s per frame). */
  timeLimitMs?: number;
  /**
   * The subtitle set the composition's `subtitles` clip draws (subtitles Task 19: the agent sees its style), as for a render
   * (`RenderOptions.subtitles`). Absent: the session is minted as before.
   */
  subtitles?: RuntimeSubtitles;
}

export interface RenderedFrame { t: number; data: Buffer; width: number; height: number }
export interface RenderFramesResult { frames: RenderedFrame[]; errors: RuntimeErrorInfo[] }

const IGNORED = new Set(['audioBlocked', 'videoFrameMismatch']);

/** The time actually shown for `t`: inside `[0, last frame]`, on the frame grid (a still: 0). */
export function frameTime(c: Pick<Composition, 'duration' | 'fps'>, t: number): number {
  if (!(c.duration > 0)) return 0;
  const frames = Math.max(1, Math.round(c.duration * c.fps));
  const i = Math.min(frames - 1, Math.max(0, Math.floor((Number.isFinite(t) ? t : 0) * c.fps + 1e-6)));
  return i / c.fps;
}

export async function renderFrames(o: RenderFramesOptions): Promise<RenderFramesResult> {
  const c = o.composition;
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort(new RenderError('cancelled', 'cancelled'));
  ctl.signal.addEventListener('abort', () => { void o.provider.close().catch(() => {}); }, { once: true });
  if (o.signal.aborted) onOuterAbort(); else o.signal.addEventListener('abort', onOuterAbort, { once: true });
  const deadline = setTimeout(() => ctl.abort(new RenderError('timeLimit', 'the preview took too long')), o.timeLimitMs ?? 120_000 + o.times.length * 10_000);
  let server: CompositionServer | null = null;
  let session: CompositionSession | null = null;
  let page: RenderPage | null = null;
  try {
    if (c.width !== o.format.width || c.height !== o.format.height) {
      throw new RenderError('compositionMismatch', `the composition is ${c.width}×${c.height}, the format ${o.format.width}×${o.format.height}`);
    }
    const width = Math.max(1, Math.min(c.width, Math.round(o.width)));
    const scale = width / c.width;
    const distDir = o.distDir ?? RUNTIME_DIST_DIR;
    server = o.server ?? await startCompositionServer({ uiOrigins: [], distDir });
    session = await server.mintSession({
      creativeDir: o.dir, versionDir: o.versionDir, format: o.format.id, composition: c, mode: 'render', ttlMs: (o.timeLimitMs ?? 300_000) + 60_000,
      ...(o.media ? { media: o.media } : {}), ...(o.format.safeZone ? { safeZone: o.format.safeZone } : {}), ...(o.subtitles ? { subtitles: o.subtitles } : {}),
    });
    const clock = await readRegularFile(join(distDir, 'clock.js'), 1024 * 1024).catch(() => null);
    page = await o.provider.open({
      width: c.width, height: c.height, url: session.url, signal: ctl.signal, purpose: 'frames',
      ...(clock && clock.kind === 'file' ? { clockSource: clock.data.toString('utf8') } : {}),
    });
    const frames: RenderedFrame[] = [];
    for (const t of o.times) {
      if (ctl.signal.aborted) throw ctl.signal.reason instanceof Error ? ctl.signal.reason : new RenderError('cancelled', 'cancelled');
      const at = frameTime(c, t);
      const p = page;
      // Decision 1755: captured again when a canvas lost its GPU context meanwhile, as a render's frames are.
      const data = await seekAndGrab(p, at, () => p.capture(o.imageFormat, o.imageFormat === 'png' ? undefined : o.quality ?? 80, scale < 1 ? scale : undefined));
      const size = imageSize(data);
      if (!size) throw new RenderError('badFrame', 'captured frame is unreadable');
      frames.push({ t: at, data, width: size.width, height: size.height });
    }
    const seen = new Set<string>();
    const errors = [...page.info.errors, ...(await page.errors())]
      // Keyed by clip too: two clips with the same message (equal boxes that both overflow) are two reports (fix I3).
      .filter((e) => !IGNORED.has(e.code) && !seen.has(`${e.code}:${e.clipId ?? ""}:${e.message}`) && (seen.add(`${e.code}:${e.clipId ?? ""}:${e.message}`), true))
      .slice(0, 20);
    return { frames, errors };
  } catch (e) {
    const f = o.provider.failure;
    if (f) throw new RenderError(f.code, f.message);
    if (o.signal.aborted) throw new RenderError('cancelled', 'cancelled');
    const r: unknown = ctl.signal.aborted ? ctl.signal.reason : null;
    if (r instanceof RenderError && r.code === 'timeLimit') throw r;
    throw e instanceof RenderError ? e : new RenderError('loadFailed', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(deadline);
    o.signal.removeEventListener('abort', onOuterAbort);
    await page?.close().catch(() => {});
    await o.provider.close().catch(() => {});
    session?.revoke();
    if (server && !o.server) await server.close().catch(() => {});
  }
}

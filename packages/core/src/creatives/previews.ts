import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { compositionProblemText, messages, type Composition, type FormatPreset, type Locale, type PreviewSessionInfo, type VersionEntry } from '@motion-studio/shared';
import { loadComposition } from '../compositions/composition-files.ts';
import { startCompositionServer, type CompositionServer } from '../compositions/composition-server.ts';
import { noteCoreChange } from '../core-changes.ts';
import { noteCoreTemp } from '../core-temps.ts';
import { findPreset } from '../formats/format-catalog.ts';
import { currentLocale } from '../i18n.ts';
import { readJsonFile } from '../json-file.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { sessionMediaOf, type MediaNormalizer, type PreparedMedia } from '../render/media-normalize.ts';
import { PreviewLane, PreviewLaneBusyError } from '../render/preview-lane.ts';
import type { RenderEngine } from '../render/renderer.ts';
import { CodedError } from '../workspace-store.ts';
import { isRealDirChain, realDirChain } from './core-files.ts';

/**
 * Everything the core shows of a composition without a final render (Task 5b):
 *
 * - **Storyboards** (spec §2.2): one small frame at each scene start plus the poster at 1 s (a still: one frame), 270 px
 *   wide, JPEG, in `.studio/cache/storyboards/<creative>/v<N>/<format>/` with a `storyboard.json` index. Protected (the
 *   agent cannot write `.studio`), not in the version and not in git, regenerable: the index carries the composition hash
 *   and a missing or stale one is made again on request. A follower uses its primary's (same composition folder).
 * - **The agent's `preview_frames`**: up to 6 PNG frames of a composition, at most 540 px wide, returned to the agent.
 * - **Live preview sessions** for the web (canvas, format view, Compare): a preview-mode session of the composition server
 *   for one (version, format), with the normalised media; the iframe's parent origin must be one of the UI origins.
 *
 * Frames run in the **preview lane** (`PreviewLane`, 2 slots, bounded queue, a time limit each), never in the render
 * lane of the job queue: a preview is seconds, and must not wait behind a render of minutes. All of them use the
 * normalised media (`MediaNormalizer.prepare`), released when done (a preview session: when its token expires).
 */

const withMedia = (p: PreparedMedia) => { const media = sessionMediaOf(p); return media ? { media } : {}; };

export const STORYBOARD_WIDTH = 270;
export const AGENT_FRAME_MAX_WIDTH = 540;
export const AGENT_FRAME_MAX_TIMES = 6;
/** Live preview sessions at once (a canvas with a few boards, Compare's two players); a new one ends the oldest. */
export const MAX_PREVIEW_SESSIONS = 8;
/** The poster frame's time (spec: "the poster at 1 s"), clamped to the composition. */
export const POSTER_TIME_SEC = 1;
/** At most this many scene frames in a storyboard (a composition may have up to 200 scenes). */
const MAX_STORYBOARD_SCENES = 40;

const HEX64 = /^[0-9a-f]{64}$/;
const FRAME_FILE = /^f-\d{1,3}\.jpg$/;
export const storyboardSchema = z.object({
  schemaVersion: z.literal(1),
  hash: z.string().regex(HEX64),
  width: z.number().int().positive(),
  frames: z.array(z.object({
    t: z.number().min(0),
    kind: z.enum(['scene', 'poster']),
    scene: z.string().max(64).optional(),
    file: z.string().regex(FRAME_FILE),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })).max(MAX_STORYBOARD_SCENES + 1),
});
export type Storyboard = z.infer<typeof storyboardSchema>;

/** `<project>/.studio/cache/storyboards/<creative>/v<N>/<format>`; `format` is the composition folder's name. */
export const storyboardDir = (projectDir: string, creativeSlug: string, n: number, format: string) =>
  join(projectDir, '.studio', 'cache', 'storyboards', creativeSlug, `v${n}`, format);

/** The frames of a storyboard: each scene start (in time order, at most 40) and the poster; a still has one frame. */
export function storyboardPlan(c: Pick<Composition, 'duration' | 'fps' | 'scenes'>): Array<{ t: number; kind: 'scene' | 'poster'; scene?: string }> {
  if (!(c.duration > 0)) return [{ t: 0, kind: 'poster' }];
  const scenes = [...c.scenes].sort((a, b) => a.start - b.start).slice(0, MAX_STORYBOARD_SCENES);
  return [
    ...scenes.map((s) => ({ t: s.start, kind: 'scene' as const, scene: s.id })),
    { t: Math.min(POSTER_TIME_SEC, c.duration), kind: 'poster' as const },
  ];
}

/** The `times` of a `preview_frames` call: 1 to 6 finite times in seconds (400 `preview-times` otherwise). */
export function checkedPreviewTimes(times: unknown, locale: Locale): number[] {
  if (!Array.isArray(times) || times.length < 1 || times.length > AGENT_FRAME_MAX_TIMES || !times.every((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= 3600)) {
    throw new CodedError(400, messages(locale).errors.previewFramesTimes({ max: AGENT_FRAME_MAX_TIMES }), 'preview-times');
  }
  return times as number[];
}

export interface PreviewServiceDeps {
  engine: RenderEngine | undefined;
  normalizer: MediaNormalizer;
  presets: () => Promise<FormatPreset[]>;
  /** The UI origins a live preview may be embedded in (read at every mint). */
  uiOrigins: () => readonly string[];
  lane?: PreviewLane;
  /** The built runtime (tests). */
  distDir?: string;
  /**
   * Told the live composition server's origin when it starts, and null when it stops (the desktop pins its UI window's
   * frames to that exact origin, Task 7).
   */
  onServerOrigin?: (origin: string | null) => void;
}

export interface VersionFormatRef { projectDir: string; creativeDir: string; creativeSlug: string; n: number }

/** The answer of the preview-session route (shared with the web's player). */
export type { PreviewSessionInfo } from '@motion-studio/shared';

/** A format's composition entry in a version, resolved to its folder (`compositions/<folder>`). */
function entryOf(version: VersionEntry | undefined, format: string): { folder: string; hash: string } | null {
  const e = version?.compositions?.find((c) => c.format === format);
  if (!e) return null;
  const folder = e.dir.slice('compositions/'.length);
  return { folder, hash: e.hash };
}

export class PreviewService {
  readonly lane: PreviewLane;
  private server: Promise<CompositionServer> | null = null;
  private readonly sessions = new Map<string, { release: () => void; revoke: () => void; timer: NodeJS.Timeout; creativeDir: string; n: number }>();
  private readonly storyboardLocks = new KeyedMutex();
  private readonly closing = new AbortController();
  /** Storyboard runs in flight: `close()` waits for them, so nothing is written after the app closed. */
  private readonly tasks = new Set<Promise<unknown>>();

  constructor(private readonly deps: PreviewServiceDeps) {
    this.lane = deps.lane ?? new PreviewLane();
  }

  /** Whether frames can be made (a renderer with a browser). */
  async available(): Promise<boolean> {
    if (!this.deps.engine) return false;
    return (await this.deps.engine.info().catch(() => ({ kind: null }))).kind !== null;
  }

  /** The long-lived composition server of the live previews (started on first use). */
  compositionServer(): Promise<CompositionServer> {
    this.server ??= startCompositionServer({ uiOrigins: this.deps.uiOrigins, ...(this.deps.distDir ? { distDir: this.deps.distDir } : {}) })
      .then((s) => { this.deps.onServerOrigin?.(s.origin); return s; })
      .catch((e: unknown) => { this.server = null; throw e; });
    return this.server;
  }

  /** Frames through the lane, with the normalised media (released after). */
  private async frames(o: { ref: VersionFormatRef; folder: string; preset: FormatPreset; composition: Composition; times: number[]; width: number; imageFormat: 'png' | 'jpeg'; signal?: AbortSignal }) {
    const engine = this.deps.engine;
    if (!engine || !(await this.available())) throw new CodedError(503, messages(currentLocale()).errors.previewUnavailable, 'no-renderer');
    const signal = AbortSignal.any([this.closing.signal, ...(o.signal ? [o.signal] : [])]);
    const compDir = join(o.ref.creativeDir, 'outputs', `v${o.ref.n}`, 'compositions', o.folder);
    try {
      return await this.lane.run(async (laneSignal) => {
        const prepared = await this.deps.normalizer.prepare({ projectDir: o.ref.projectDir, compDir, composition: o.composition, signal: laneSignal });
        try {
          return await engine.frames({
            server: await this.compositionServer(), // one long-lived server for every preview (fix minor 5)
            dir: o.ref.creativeDir, versionDir: `outputs/v${o.ref.n}`, composition: o.composition, format: { ...o.preset, id: o.folder },
            times: o.times, width: o.width, imageFormat: o.imageFormat, quality: 80, signal: laneSignal, ...withMedia(prepared),
            ...(this.deps.distDir ? { distDir: this.deps.distDir } : {}),
          });
        } finally {
          prepared.release();
        }
      }, signal);
    } catch (e) {
      if (e instanceof PreviewLaneBusyError) throw new CodedError(429, messages(currentLocale()).errors.previewBusy, 'preview-busy');
      throw e;
    }
  }

  /**
   * The agent's `preview_frames` on the composition it is writing (version `n`, not saved yet): up to 6 PNGs, at most
   * 540 px wide. An invalid composition returns its problems instead of frames.
   */
  async agentFrames(o: { ref: VersionFormatRef; format: string; times: unknown; locale: Locale; signal: AbortSignal }): Promise<Record<string, unknown>> {
    const times = checkedPreviewTimes(o.times, o.locale);
    const preset = findPreset(await this.deps.presets(), o.format);
    if (!preset) throw new CodedError(400, messages(o.locale).validation.unknownPreset({ id: o.format }), 'unknown-format');
    const compDir = join(o.ref.creativeDir, 'outputs', `v${o.ref.n}`, 'compositions', o.format);
    // A linked folder (planted by the agent) is never followed (fix minor 1).
    if ((await isRealDirChain(o.ref.creativeDir, ['outputs', `v${o.ref.n}`, 'compositions', o.format])) !== 'ok') {
      return { format: o.format, ok: false, problems: [messages(o.locale).validation.compositionMissing({ label: preset.name, id: o.format, dir: `compositions/${o.format}` })] };
    }
    const loaded = await loadComposition(compDir, preset);
    if (!loaded.ok) return { format: o.format, ok: false, problems: loaded.problems.map((p) => compositionProblemText(p, o.locale)) };
    const c = loaded.composition;
    const r = await this.frames({ ref: o.ref, folder: o.format, preset, composition: c, times, width: Math.min(AGENT_FRAME_MAX_WIDTH, c.width), imageFormat: 'png', signal: o.signal });
    return {
      format: o.format, ok: true,
      frames: r.frames.map((f) => ({ t: f.t, width: f.width, height: f.height })),
      ...(r.errors.length ? { runtimeErrors: r.errors.map((x) => ({ code: x.code, message: x.message, ...(x.clipId ? { clipId: x.clipId } : {}) })) } : {}),
      images: r.frames.map((f) => ({ mimeType: 'image/png', data: f.data.toString('base64') })),
    };
  }

  /** The storyboard index of (version, format) when it exists and matches `hash`; null otherwise. */
  async readStoryboard(ref: VersionFormatRef, folder: string, hash: string): Promise<Storyboard | null> {
    const sb = await readJsonFile(join(storyboardDir(ref.projectDir, ref.creativeSlug, ref.n, folder), 'storyboard.json'), storyboardSchema).catch(() => null);
    return sb && sb.hash === hash ? sb : null;
  }

  /**
   * Makes the storyboard of one composition folder of a saved version (`hash` is its recorded hash): replaced as a whole
   * (a temp folder renamed into place). Returns null when the composition is not valid or not the recorded one. Concurrent
   * calls for the same folder share the work.
   */
  async makeStoryboard(ref: VersionFormatRef, folder: string, hash: string, signal?: AbortSignal): Promise<Storyboard | null> {
    const dir = storyboardDir(ref.projectDir, ref.creativeSlug, ref.n, folder);
    return this.storyboardLocks.run(dir, async () => {
      const existing = await this.readStoryboard(ref, folder, hash);
      if (existing) return existing;
      const preset = findPreset(await this.deps.presets(), folder);
      if (!preset) return null;
      const loaded = await loadComposition(join(ref.creativeDir, 'outputs', `v${ref.n}`, 'compositions', folder), preset);
      if (!loaded.ok || loaded.hash !== hash) return null;
      const plan = storyboardPlan(loaded.composition);
      const unique = [...new Set(plan.map((p) => p.t))];
      const r = await this.frames({ ref, folder, preset, composition: loaded.composition, times: unique, width: Math.min(STORYBOARD_WIDTH, loaded.composition.width), imageFormat: 'jpeg', ...(signal ? { signal } : {}) });
      if (this.closing.signal.aborted) throw new Error('closed');
      // Every folder of the path is a real directory (a link planted under the cache steers neither the rm nor the rename).
      const parent = await realDirChain(ref.projectDir, ['.studio', 'cache', 'storyboards', ref.creativeSlug, `v${ref.n}`]);
      if (parent === null || join(parent, folder) !== dir) return null;
      const temp = `${dir}.${randomBytes(6).toString('hex')}.tmp`;
      noteCoreTemp(temp);
      try {
        await mkdir(temp);
        const files = new Map<number, { file: string; width: number; height: number }>();
        for (const [i, f] of r.frames.entries()) {
          const file = `f-${i}.jpg`;
          await writeFile(join(temp, file), f.data, { flag: 'wx' });
          files.set(unique[i]!, { file, width: f.width, height: f.height });
        }
        const sb: Storyboard = {
          schemaVersion: 1, hash, width: Math.min(STORYBOARD_WIDTH, loaded.composition.width),
          frames: plan.map((p) => ({ ...p, ...files.get(p.t)! })),
        };
        await writeFile(join(temp, 'storyboard.json'), `${JSON.stringify(sb, null, 2)}\n`, { flag: 'wx' });
        await rm(dir, { recursive: true, force: true });
        await rename(temp, dir);
        // The core's own folders (the tripwire must never read them as a move).
        for (let d = dirname(dir), i = 0; i < 4; i++, d = dirname(d)) await noteCoreChange(d);
        return sb;
      } finally {
        await rm(temp, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  /** Storyboards of every primary composition of a saved version; followers share their primary's. Never throws. */
  storyboardsFor(ref: VersionFormatRef, version: VersionEntry, signal?: AbortSignal): Promise<void> {
    const task = this.storyboardsRun(ref, version, signal);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
    return task;
  }

  private async storyboardsRun(ref: VersionFormatRef, version: VersionEntry, signal?: AbortSignal): Promise<void> {
    const done = new Set<string>();
    for (const c of version.compositions ?? []) {
      const folder = c.dir.slice('compositions/'.length);
      if (done.has(folder) || signal?.aborted || this.closing.signal.aborted) continue;
      done.add(folder);
      await this.makeStoryboard(ref, folder, c.hash, signal).catch((e: unknown) => {
        if (this.closing.signal.aborted) return;
        console.warn(`Motion Studio: storyboard of ${folder} v${ref.n} failed: ${(e as Error).message}`);
      });
    }
  }

  /** The storyboard of `format` in `version` (made when missing or stale and possible), with its folder; null when there is none. */
  async storyboardOf(ref: VersionFormatRef, version: VersionEntry, format: string): Promise<{ folder: string; storyboard: Storyboard } | null> {
    const e = entryOf(version, format);
    if (!e) throw new CodedError(404, messages(currentLocale()).errors.compositionNotFound({ format, n: version.n }), 'composition-not-found');
    const have = await this.readStoryboard(ref, e.folder, e.hash);
    if (have) return { folder: e.folder, storyboard: have };
    if (!(await this.available())) return null;
    const made = await this.makeStoryboard(ref, e.folder, e.hash);
    return made ? { folder: e.folder, storyboard: made } : null;
  }

  /**
   * One frame of `format` in a saved v2 version at `t`, as a JPEG at most 540 px wide: the feedback frame of a pinned
   * comment on a version that has no render (Task 5b). Null when it cannot be made. The caller writes it (safely).
   */
  async frameJpeg(ref: VersionFormatRef, version: VersionEntry, format: string, t: number): Promise<Buffer | null> {
    const e = entryOf(version, format);
    if (!e || !(await this.available())) return null;
    const preset = findPreset(await this.deps.presets(), e.folder);
    if (!preset) return null;
    const loaded = await loadComposition(join(ref.creativeDir, 'outputs', `v${ref.n}`, 'compositions', e.folder), preset);
    if (!loaded.ok || loaded.hash !== e.hash) return null;
    const r = await this.frames({ ref, folder: e.folder, preset, composition: loaded.composition, times: [t], width: Math.min(AGENT_FRAME_MAX_WIDTH, loaded.composition.width), imageFormat: 'jpeg' });
    return r.frames[0]?.data ?? null;
  }

  /**
   * A live preview session of `format` in a saved version (spec §2.3, Task 8's player and Compare): the composition is
   * re-hashed and validated (it must still be the recorded one), its media normalised, and a preview-mode session minted
   * for `parentOrigin` (one of the UI origins, else 403). The media lease ends when the session expires.
   */
  async mintPreview(ref: VersionFormatRef, version: VersionEntry, format: string, parentOrigin: string, locale: Locale): Promise<PreviewSessionInfo> {
    const e = messages(locale).errors;
    const entry = entryOf(version, format);
    if (!entry) throw new CodedError(404, e.compositionNotFound({ format, n: version.n }), 'composition-not-found');
    if (!this.deps.uiOrigins().includes(parentOrigin)) throw new CodedError(403, e.previewOrigin, 'preview-origin');
    const preset = findPreset(await this.deps.presets(), entry.folder);
    if (!preset) throw new CodedError(409, e.compositionUnusable({ format, n: version.n }), 'composition-unusable');
    const compDir = join(ref.creativeDir, 'outputs', `v${ref.n}`, 'compositions', entry.folder);
    const loaded = await loadComposition(compDir, preset);
    if (!loaded.ok || loaded.hash !== entry.hash) throw new CodedError(409, e.compositionUnusable({ format, n: version.n }), 'composition-unusable');
    const prepared = await this.deps.normalizer.prepare({ projectDir: ref.projectDir, compDir, composition: loaded.composition, signal: this.closing.signal });
    try {
      const server = await this.compositionServer();
      const session = await server.mintSession({
        creativeDir: ref.creativeDir, versionDir: `outputs/v${ref.n}`, format: entry.folder, composition: loaded.composition,
        mode: 'preview', parentOrigin, ...withMedia(prepared),
      });
      const ttl = Math.max(0, session.expiresAt - Date.now());
      const timer = setTimeout(() => { prepared.release(); this.sessions.delete(session.token); }, ttl + 1000);
      timer.unref();
      this.sessions.set(session.token, { release: prepared.release, revoke: session.revoke, timer, creativeDir: ref.creativeDir, n: ref.n });
      // At most MAX_PREVIEW_SESSIONS live at once (each holds media leases): the oldest ends first (fix minor 5).
      while (this.sessions.size > MAX_PREVIEW_SESSIONS) {
        const [token, old] = this.sessions.entries().next().value!;
        clearTimeout(old.timer); old.revoke(); old.release(); this.sessions.delete(token);
      }
      const c = loaded.composition;
      return {
        url: session.url, token: session.token, origin: session.origin, expiresAt: new Date(Date.now() + ttl).toISOString(),
        format: entry.folder, hash: entry.hash, width: c.width, height: c.height, duration: c.duration, fps: c.fps,
      };
    } catch (err) {
      prepared.release();
      throw err;
    }
  }

  /**
   * Ends a live preview session early (Task 8 fix I2: a hover preview the UI no longer shows): its token stops working and
   * its media lease is returned. Only a session of this creative's version `ref.n`; false when there is no such live session.
   */
  revokePreview(ref: Pick<VersionFormatRef, 'creativeDir' | 'n'>, token: string): boolean {
    const s = this.sessions.get(token);
    if (!s || s.creativeDir !== ref.creativeDir || s.n !== ref.n) return false;
    clearTimeout(s.timer); s.revoke(); s.release(); this.sessions.delete(token);
    return true;
  }

  /** App quit: running frames aborted, sessions ended, media leases returned, the server closed. */
  async close(): Promise<void> {
    this.closing.abort(new Error('closed'));
    this.lane.close();
    await Promise.allSettled([...this.tasks]);
    for (const s of this.sessions.values()) { clearTimeout(s.timer); s.release(); }
    this.sessions.clear();
    const server = this.server;
    this.server = null;
    this.deps.onServerOrigin?.(null);
    if (server) await (await server.catch(() => null))?.close().catch(() => {});
  }
}

/**
 * Leftover storyboard temp folders (`<format>.<hex>.tmp`, a crash while one was written) of a project, older than
 * `olderThanMs` (default 10 min, so a storyboard being written now is never touched). Startup and workspace switch.
 */
export async function sweepStoryboardTemps(projectDir: string, o: { now?: number; olderThanMs?: number } = {}): Promise<string[]> {
  const root = join(projectDir, '.studio', 'cache', 'storyboards');
  const limit = (o.now ?? Date.now()) - (o.olderThanMs ?? 10 * 60_000);
  const removed: string[] = [];
  for (const creative of await readdir(root).catch(() => [] as string[])) {
    const cdir = join(root, creative);
    if (!(await lstat(cdir).catch(() => null))?.isDirectory()) continue;
    for (const v of await readdir(cdir).catch(() => [] as string[])) {
      const vdir = join(cdir, v);
      if (!/^v\d+$/.test(v) || !(await lstat(vdir).catch(() => null))?.isDirectory()) continue;
      for (const name of await readdir(vdir).catch(() => [] as string[])) {
        if (!/^[a-z0-9][a-z0-9-]{0,62}\.[0-9a-f]{12}\.tmp$/.test(name)) continue;
        const st = await lstat(join(vdir, name)).catch(() => null);
        if (!st || st.mtimeMs > limit) continue;
        await rm(join(vdir, name), { recursive: true, force: true }).catch(() => {});
        removed.push(`${creative}/${v}/${name}`);
      }
      if (removed.length > 0) await noteCoreChange(vdir);
    }
  }
  return removed;
}

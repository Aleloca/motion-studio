import { exportRenderJobKey, renderJobKey } from '@motion-studio/shared';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  compositionProblemText, outputWarningText, scaledSize, stripSubtitles, toSrt, DEFAULT_EXPORT_QUALITY, profileApplies, recordedQuality, effectiveLinks, formatDisplayName, messages, renderProblems, renderState, type RenderInfo, type RenderProfile,
  type Brief, type Composition, type FormatPreset, type JobProgress, type JobSummary, type Locale, type LocaleTag, type Localization, type LocalizationIssue, type LocalizationRow, type ManifestV2, type OutputFileInfo,
  type IdentitySetInfo, type RenderedSubtitles, type SubtitleSet, type OutputIssue, type ServerMessage, type VersionComposition, type VersionEntry,
} from '@motion-studio/shared';
import { copyConfinedFile, hashConfinedFile, readConfinedFile } from '../brand/agent-guard.ts';
import { BrandStore } from '../brand/brand-store.ts';
import { buildIdentitySet } from '../identity/identity-set.ts';
import { checkVectorComposition, MAX_VECTOR_SVG_BYTES } from '../identity/svg-check.ts';
import { makeOwnedTempDir } from '../render/owner.ts';
import { identityProblems } from './composition-contract.ts';
import { loadComposition, readCompositionFolder } from '../compositions/composition-files.ts';
import { withIssues, withoutIssues } from '../localization/issues.ts';
import { sourceOverflowOf } from '../localization/store.ts';
import { changedAssets, instanceComposition, isAssetChangedProblem, localizedComposition, overlayAssetPaths, readOverlay } from '../localization/store.ts';
import { assertLocalesInBrief, checkedLocale, clipLabel, voiceFileOk } from '../localization/validate.ts';
import { realDirChain } from './core-files.ts';
import { noteCoreChange } from '../core-changes.ts';
import { noteCoreTemp } from '../core-temps.ts';
import { findPreset } from '../formats/format-catalog.ts';
import { currentLocale } from '../i18n.ts';
import { JobFailedError, type JobQueue } from '../jobs/job-queue.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { RenderError } from '../render/errors.ts';
import { sessionMediaOf, type MediaNormalizer } from '../render/media-normalize.ts';
import { activeLocaleRenders } from '../render/render-sweep.ts';
import { storeComposition, storeRenderOptions } from '../store-pack/flatten.ts';
import type { RenderCompositionOptions, RenderEngine, RenderResult } from '../render/renderer.ts';
import { defaultSubtitleLang, drawsSubtitles, readSubtitleSet, stageSubtitles, subtitleHashes, writeSubtitleSnapshot, type SubtitleCommits } from '../subtitles/store.ts';
import { CodedError } from '../workspace-store.ts';
import { noteCoreOutputWrite } from './carry-over.ts';
import { CreativeStore } from './creative-store.ts';
import { noteRenderStamps, updateVersionManifest } from './render-stamps.ts';
import type { CreativeRef } from './creative-turns.ts';
import { largeFileWarning } from './output-contract.ts';

/**
 * Render jobs (spec §5.3, Task 5): `POST …/versions/:n/render` renders a v2 version's compositions into its folder.
 *
 * - **One job per request**, key `render:<root>:<project>:<creative>:v<n>`. A request while jobs of that version are queued
 *   or running reuses them for the formats they cover and queues a follow-up job (`…:v<n>:<k>`) for the rest (I3). Formats are rendered one after the other (each render runs its own parallel pages).
 *   Progress per format (`JobSummary.progress`): `media` ("Preparing media…", the video sources normalised), `frames`,
 *   `finishing`. Cancel: the queue's cancel aborts the normalisation and the render (process groups killed, temp removed).
 * - **Formats:** by default every primary of the version; a follower named in the request stands for its primary. Every
 *   follower of a rendered primary gets a copy of the primary's render (`COPYFILE_EXCL` into a temp file, then a rename:
 *   never a hard link) with the primary's `problems` and the follower's own composition hash as `fromComposition`.
 * - **Per format:** the composition folder is hashed and validated again (`loadComposition`); a hash that is no longer the
 *   version's recorded one is refused (`compositionChanged`). Then the media is normalised, the renderer writes
 *   `outputs/vN/<format>.<ext>` (temp file + rename, only on success; an earlier render of the same file is replaced, a
 *   render of any other version is never touched), and the file is checked like an agent's output was (ffprobe size and
 *   duration, the channel's size limit, the phase 8 bitrate warning) and gets its poster.
 * - **Recorded** in `versions.json` (`VersionEntry.outputs`, with `sha256` and `fromComposition`, so `renderState` is
 *   `rendered`) and in the manifest v2 `renders[]`, as each format finishes (a later failure keeps the earlier ones). A
 *   follower's composition entry gets `followsFormat` when it lacked it.
 * - **No tokens, no usage ledger row** (decision): a render spends no model tokens; its time shows in the job list.
 * - **Concurrency with turns** (decision): allowed. A render reads a recorded version `vN` and writes only into its folder;
 *   a turn writes `v(N+1)`. versions.json is written under one process-wide lock (`CreativeStore.updateVersion`), and the
 *   turn's check of earlier versions leaves out the core's own writes (`noteCoreOutputWrite`). `outputs/` is not in git.
 */

/** Shared with the web, which derives it from the creative's key (`renderJobKeyOf`). */
export { renderJobKey };

export interface RenderJobDeps {
  queue: JobQueue;
  /** The renderer; absent: renders are refused (503 `no-renderer`). */
  engine: RenderEngine | undefined;
  media: MediaTools;
  normalizer: MediaNormalizer;
  presets: () => Promise<FormatPreset[]>;
  broadcast: (msg: ServerMessage) => void;
  /** Passed to every render (tests: the built runtime, a temp folder, fewer pages, the encoder). */
  renderOptions?: Partial<Pick<RenderCompositionOptions, 'distDir' | 'tempDir' | 'parallel' | 'encoder' | 'x264Preset' | 'timeLimitMs' | 'jpegQuality'>>;
  /** Least time between two progress updates of a job, ms (default 250); phase changes always go out. */
  progressIntervalMs?: number;
  /**
   * The browser's text measure (the preview service's `measureTextOverflow`): a localized render takes the SOURCE verdict from
   * it (`sourceOverflowOf`, cached), so a translation is judged against its source (fix round 2, N1). Absent: the row's notes.
   */
  measureText?: (o: { ref: { projectDir: string; creativeDir: string; creativeSlug: string; n: number }; folder: string; preset: FormatPreset; composition: Composition; signal?: AbortSignal }) => Promise<string[] | null>;
  /** The batched commits of the user's subtitle edits (decision 1646): flushed when a render job starts, before it reads the sets. */
  subtitleCommits?: Pick<SubtitleCommits, 'flush'>;
}

/** How a caller waits for render jobs (decision 974): its cancel, and the jobs it waits for (an export job's progress). */
export interface RenderWait { signal?: AbortSignal; onJobs?(ids: string[]): void }
/**
 * How a render made for an export is made (decision 974; subtitles Task 21): at `profile`, and, when `subtitles` is given, with
 * explicit subtitles instead of the version render's default pairing: `drawn` the language drawn into the picture (null: none),
 * `strip` the subtitles track taken out (the clean video of anti-goal 2), `soft` the languages muxed as `mov_text` tracks.
 * `video` (Task 27): the localized video of that language (`localizedComposition`, each instance with its own overlay, at the
 * default profile); absent: the original. `force`: a translation with open problems or outdated entries is rendered anyway.
 */
export interface ExportRenderOptions { profile: RenderProfile; force?: boolean; subtitles?: { video?: LocaleTag; drawn: LocaleTag | null; strip: boolean; soft: LocaleTag[];
  /** The sets the export read with its request: the soft tracks use them, so they match the `.srt`/`.vtt` beside the video. */
  sets?: Partial<Record<LocaleTag, SubtitleSet>> } }
/** A render made for one export (decision 974): the file (in the export's own temp folder) and its record. */
export interface ExportRendered {
  path: string; render: RenderInfo;
  /** The output checks of that format (review #4: as a version render's, against the format's own preset; never the size). */
  problems: string[]; issues: OutputIssue[];
  /** The video's duration in seconds (its composition's), null for a still: what its subtitle files are cut to. */
  durationSec?: number | null;
  /** Soft subtitle tracks were asked and left out (an App Store preview, final review M4): the export says so. */
  softIgnored?: boolean;
}

export interface RenderPlan {
  /** Primary formats to render, in the version's order. */
  primaries: string[];
  /** Followers to copy, follower → primary (only of primaries being rendered). */
  followers: Record<string, string>;
  /** Followers whose composition entry lacks `followsFormat` (recognised from the brief's links): written when recorded. */
  fixFollows: Record<string, string>;
  /** Requested formats this version has no composition for. */
  unknown: string[];
  /** Primaries whose CURRENT, clean render is kept: only their followers' copies are made (final wave C6). */
  reuse?: string[];
}

/**
 * What a render request covers. A follower is a composition entry with `followsFormat`, or (an entry written without it)
 * a brief link follower → primary whose entry has the primary's very composition (same `dir` and `hash`).
 */
export function renderPlan(comps: VersionComposition[], brief: Pick<Brief, 'links' | 'formats'>, requested?: readonly string[]): RenderPlan {
  const byFormat = new Map(comps.map((c) => [c.format, c]));
  const links = effectiveLinks(brief.links, brief.formats);
  const follows = new Map<string, string>();
  const fixFollows: Record<string, string> = {};
  for (const c of comps) {
    if (c.followsFormat && byFormat.has(c.followsFormat) && !byFormat.get(c.followsFormat)!.followsFormat) { follows.set(c.format, c.followsFormat); continue; }
    const p = links[c.format];
    const pc = p ? byFormat.get(p) : undefined;
    if (p && pc && !pc.followsFormat && pc.dir === c.dir && pc.hash === c.hash) { follows.set(c.format, p); fixFollows[c.format] = p; }
  }
  const allPrimaries = comps.map((c) => c.format).filter((f) => !follows.has(f));
  const unknown: string[] = [];
  let primaries = allPrimaries;
  if (requested && requested.length > 0) {
    const wanted = new Set<string>();
    for (const f of requested) {
      if (!byFormat.has(f)) { if (!unknown.includes(f)) unknown.push(f); continue; }
      wanted.add(follows.get(f) ?? f);
    }
    primaries = allPrimaries.filter((f) => wanted.has(f));
  }
  const followers: Record<string, string> = {};
  for (const [f, p] of follows) if (primaries.includes(p)) followers[f] = p;
  return { primaries, followers, fixFollows, unknown };
}

/**
 * Of a version's active render jobs (`base` key and follow-ups `<base>:<k>`), the one that ends last in the render lane:
 * the latest created, and on a tie (the same millisecond, M2) the higher follow-up number. Deterministic.
 */
export function lastRenderJob(jobs: readonly JobSummary[], base: string): JobSummary {
  const seq = (j: JobSummary) => (j.key === base ? 1 : Number(j.key.slice(base.length + 1)) || 0);
  return jobs.reduce((a, b) => (b.createdAt > a.createdAt || (b.createdAt === a.createdAt && seq(b) > seq(a)) ? b : a));
}

/** The file extension of a render: the preset's first H.264 container (video) or image type (still), else mp4 / png. */
export function renderExtension(preset: FormatPreset, still: boolean): string {
  const prefer = still ? ['png', 'jpg', 'jpeg', 'webp'] : ['mp4', 'mov', 'm4v'];
  return prefer.find((e) => preset.extensions.includes(e)) ?? prefer[0]!;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
/**
 * The record of a video render (decision 974): the quality asked for (the renderer's own when it says), its size and encoder,
 * and its frame rate (report 39, decision 1234; the renderer's own when it says, else the one asked for).
 */
const renderInfoOf = (r: RenderResult, quality: RenderInfo['quality'], fps: Composition['fps']): RenderInfo =>
  ({ quality: r.quality ?? quality, width: r.width, height: r.height, encoder: r.encoder, fps: r.fps ?? fps });
const tempName = (name: string) => `.${name}.render-${randomBytes(6).toString('hex')}.tmp`;

/**
 * Copies `from` to `dir/name` through a fresh temp file (`COPYFILE_EXCL`, never a link), then renames it into place;
 * `beforeRename(temp)` runs just before the rename (to note the stamp first).
 */
async function copyInto(from: string, dir: string, name: string, beforeRename?: (temp: string) => Promise<void>): Promise<void> {
  const temp = join(dir, tempName(name));
  noteCoreTemp(temp);
  try {
    await copyFile(from, temp, constants.COPYFILE_EXCL);
    await beforeRename?.(temp);
    await rename(temp, join(dir, name));
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export class RenderJobService {
  constructor(private readonly deps: RenderJobDeps) {}

  /**
   * Validates the request and enqueues the job (see the module comment). Never a conflict (final review I3): when render
   * jobs of this version are already queued or running, the formats they cover are not asked again. If they cover every
   * requested format, the latest of them is returned; otherwise a follow-up job renders the rest, in the same lane (it runs
   * after them), keyed `render:…:v<n>:<k>` (`renderJobKeyOf` matches it too).
   */
  async start(ref: CreativeRef, n: number, requested?: string[], opts: { locales?: readonly string[]; force?: boolean; byWait?: boolean } = {}): Promise<JobSummary> {
    const job = await this.startJob(ref, n, requested, opts);
    // Review #7: a job asked for by anyone but a cancellable wait (the render route, the agent, prepare) is never cancelled
    // by an export that shares it.
    if (!opts.byWait) this.pin(job.id);
    return job;
  }

  private async startJob(ref: CreativeRef, n: number, requested: string[] | undefined, opts: { locales?: readonly string[]; force?: boolean; byWait?: boolean }): Promise<JobSummary> {
    const locale = currentLocale();
    const m = messages(locale);
    const store = new CreativeStore(ref.projectDir);
    const creative = await store.get(ref.creativeSlug);
    const version = (await store.readVersions(ref.creativeSlug)).find((v) => v.n === n);
    if (!version) throw new CodedError(404, m.errors.versionNNotFound({ n }), 'version-not-found');
    const comps = version.compositions ?? [];
    if (comps.length === 0) throw new CodedError(400, m.render.notV2({ n }), 'version-not-v2');
    const full = renderPlan(comps, creative.brief, requested);
    if (full.unknown.length > 0) throw new CodedError(400, m.render.formatsNotInVersion({ list: full.unknown.join(', ') }), 'formats-not-in-version');
    if (opts.locales && opts.locales.length > 0) assertLocalesInBrief(creative.brief, opts.locales.map((x) => checkedLocale(x, locale)), locale);
    if (opts.locales && opts.locales.length > 0) return this.startLocalized(ref, version, creative.title, requested, opts.locales, opts.force === true, locale);
    if (!this.deps.engine) throw new CodedError(503, m.render.noRenderer, 'no-renderer');
    if ((await this.deps.engine.info()).kind === null) throw new CodedError(409, m.render.noBrowser, 'no-browser');
    const presets = await this.deps.presets();
    // Subtitles Task 18: a render that drew a set changed since is not current (`renderState`), so it is never kept.
    const subtitles = await subtitleHashes(new CreativeStore(ref.projectDir).dir(ref.creativeSlug));
    // From here to the enqueue nothing awaits: the active jobs seen are the ones the new job queues behind.
    const base = renderJobKey(ref.root, ref.projectSlug, ref.creativeSlug, n);
    const active = this.activeJobs(base);
    const covered = new Set(active.flatMap((j) => j.formats ?? []));
    const wanted = [...full.primaries, ...Object.keys(full.followers)];
    const missing = wanted.filter((f) => !covered.has(f));
    if (!opts.byWait) for (const j of active) if (wanted.some((f) => j.formats?.includes(f))) this.pin(j.id);
    if (active.length > 0 && missing.length === 0) {
      // One job covering them all, else the one that ends last: the latest of those covering any (one lane, in order),
      // whose progress a caller (the export dialog) then follows to the end.
      const all = active.find((j) => wanted.every((f) => j.formats?.includes(f)));
      if (all) return all;
      return lastRenderJob(active.filter((j) => wanted.some((f) => j.formats?.includes(f))), base);
    }
    const basePlan = active.length > 0 ? renderPlan(comps, creative.brief, missing) : full;
    // A follower asked for alone (its primary not asked for) does not render a current, clean primary again: it is copied.
    const asked = new Set(active.length > 0 ? missing : requested ?? []);
    const reuse: string[] = [];
    if (asked.size > 0) {
      for (const p of basePlan.primaries) {
        if (asked.has(p) || renderState(version, p, subtitles) !== 'rendered' || renderProblems(version, p).length > 0) continue;
        // A video render made before the quality choice (review #1): rendered again, so its followers get the default quality too.
        if (profileApplies(findPreset(presets, p), p) && recordedQuality(version.outputs.find((o) => o.format === p)) !== DEFAULT_EXPORT_QUALITY) continue;
        const file = version.outputs.find((o) => o.format === p)?.file;
        const st = file ? await lstat(join(new CreativeStore(ref.projectDir).outputsDir(ref.creativeSlug, n), file)).catch(() => null) : null;
        if (st?.isFile() && st.nlink === 1) reuse.push(p);
      }
    }
    const plan: RenderPlan = reuse.length > 0 ? { ...basePlan, reuse } : basePlan;
    const keys = new Set(active.map((j) => j.key));
    let key = base;
    for (let k = 2; keys.has(key); k++) key = `${base}:${k}`;
    return this.deps.queue.enqueue({
      key,
      kind: 'render',
      // Its own lane (one render at a time): renders never take the slots of agent turns (M3).
      lane: 'render',
      label: m.render.jobLabel({ title: creative.title, n }),
      formats: [...plan.primaries, ...Object.keys(plan.followers)],
      run: (signal, jobId) => this.run(ref, n, plan, comps, locale, signal, jobId),
    });
  }

  /** The queued or running render jobs of a version (its key, and its follow-ups' `<key>:<k>`), latest first. */
  private activeJobs(base: string): JobSummary[] {
    return this.deps.queue.list().filter((j) => (j.key === base || j.key.startsWith(`${base}:`)) && (j.state === 'queued' || j.state === 'running'));
  }

  /**
   * The render job that will produce `formats` of version `n` (export/prepare). `start` reuses the active jobs that cover
   * them and queues a follow-up for the rest (I3), so the job returned always covers every format: it is the last of the
   * version's jobs in the render lane, and when it ends the others have too. `wait` is kept for callers; it changes nothing.
   */
  async ensureJob(ref: CreativeRef, n: number, formats: string[], o: { wait?: boolean; byWait?: boolean } = {}): Promise<{ job: JobSummary; covers: boolean }> {
    const job = await this.start(ref, n, formats, o.byWait ? { byWait: true } : {});
    return { job, covers: true };
  }

  /** Renders `formats` of each version (`ensureJob`, waiting for a job that covers other formats) and waits; the summaries as they ended. */
  async renderAndWait(ref: CreativeRef, pending: ReadonlyMap<number, string[]>, w: RenderWait = {}): Promise<JobSummary[]> {
    if (w.signal?.aborted) throw new RenderError('cancelled', 'cancelled');
    const jobs = await Promise.all([...pending].map(async ([n, formats]) => (await this.ensureJob(ref, n, formats, { byWait: true })).job));
    // Every active job of those versions (a follow-up runs after the jobs it queued behind; wait for them all).
    const all = new Map(jobs.map((j) => [j.id, j]));
    for (const [n] of pending) for (const j of this.activeJobs(renderJobKey(ref.root, ref.projectSlug, ref.creativeSlug, n))) all.set(j.id, j);
    return this.waitAll([...all.keys()], w);
  }

  /** Renders `formats` of version `n` in `locales` (`start` with locales) and waits for the job; its summary as it ended. */
  async renderLocalesAndWait(ref: CreativeRef, n: number, formats: string[], locales: readonly string[], force: boolean, w: RenderWait = {}): Promise<JobSummary | null> {
    if (w.signal?.aborted) throw new RenderError('cancelled', 'cancelled');
    const job = await this.start(ref, n, formats, { locales, force, byWait: true });
    return (await this.waitAll([job.id], w))[0] ?? null;
  }

  /** Review #7: render jobs someone asked for outside a cancellable wait (never cancelled by an export), and the waits on each. */
  private readonly pinned = new Set<string>();
  private readonly waiters = new Map<string, number>();
  private pin(id: string): void {
    if (this.pinned.has(id)) return;
    this.pinned.add(id);
    void this.deps.queue.whenSettled(id).then(() => this.pinned.delete(id));
  }

  /**
   * Waits for jobs `ids` (reported to `w.onJobs` first). Every wait counts on each job (review #7). An abort of `w.signal`
   * (an export cancelled, decision 974) drops this wait and cancels a job only when no other wait is left on it and nobody
   * asked for it outside a wait (`pinned`: the render route, the agent, prepare); then it rejects as cancelled.
   */
  private waitAll(ids: string[], w: RenderWait): Promise<JobSummary[]> {
    w.onJobs?.(ids);
    for (const id of ids) this.waiters.set(id, (this.waiters.get(id) ?? 0) + 1);
    let held = true;
    const release = (cancel: boolean) => {
      if (!held) return;
      held = false;
      for (const id of ids) {
        const left = (this.waiters.get(id) ?? 1) - 1;
        if (left > 0) { this.waiters.set(id, left); continue; }
        this.waiters.delete(id);
        if (cancel && !this.pinned.has(id)) this.deps.queue.cancel(id);
      }
    };
    const settled = Promise.all(ids.map((id) => this.deps.queue.whenSettled(id))).then((list) => list.filter((j): j is JobSummary => j !== null));
    settled.then(() => release(false), () => release(false));
    const signal = w.signal;
    if (!signal) return settled;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        release(true);
        reject(new RenderError('cancelled', 'cancelled'));
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      settled.then((r) => { signal.removeEventListener('abort', onAbort); resolve(r); }, (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); });
    });
  }

  /**
   * Decision 974: renders `pending` (version → formats) at `profile` (another quality or size than the version's own render)
   * into `outDir`, for one export, and waits. One render job per version, in the render lane (one render at a time), keyed
   * `render-export:…` (`exportRenderJobKey`): it records nothing in the version, and no other request reuses it. A follower is
   * the file of its primary's render. Returns the files made (key `<n>\0<format>`) and the failed jobs' errors.
   */
  async exportRenderAndWait(ref: CreativeRef, pending: ReadonlyMap<number, string[]>, o: ExportRenderOptions, outDir: string, w: RenderWait = {}):
    Promise<{ files: Map<string, ExportRendered>; failed: Map<string, string>; errors: string[] }> {
    if (w.signal?.aborted) throw new RenderError('cancelled', 'cancelled');
    const files = new Map<string, ExportRendered>();
    const failed = new Map<string, string>();
    const ids: string[] = [];
    try {
      for (const [n, formats] of pending) {
        ids.push((await this.startExportRender(ref, n, formats, o, join(outDir, `v${n}`),
          (format, r) => files.set(`${n}\0${format}`, r), (format, reason) => failed.set(`${n}\0${format}`, reason))).id);
      }
    } catch (e) {
      // A version that cannot start (review #3): the jobs already queued for this export go too.
      for (const id of ids) this.deps.queue.cancel(id);
      await this.settled(ids);
      throw e;
    }
    try {
      const ended = await this.waitAll(ids, w);
      return { files, failed, errors: ended.filter((j) => j.state !== 'succeeded').map((j) => j.error ?? j.state) };
    } catch (e) {
      // Cancelled: the caller removes `outDir` next, so wait (bounded) for the renders to stop writing into it first.
      await this.settled(ids);
      throw e;
    }
  }

  /** Waits for jobs `ids` to end, at most `ms` (a render stuck in its cancel never holds the caller forever). */
  private async settled(ids: string[], ms = 30_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((r) => { timer = setTimeout(r, ms); timer.unref?.(); });
    await Promise.race([Promise.all(ids.map((id) => this.deps.queue.whenSettled(id))), limit]);
    clearTimeout(timer);
  }

  private async startExportRender(ref: CreativeRef, n: number, requested: string[], o: ExportRenderOptions, outDir: string,
    collect: (format: string, r: ExportRendered) => void, fail: (format: string, reason: string) => void): Promise<JobSummary> {
    const { profile, subtitles } = o;
    const locale = currentLocale();
    const m = messages(locale);
    const store = new CreativeStore(ref.projectDir);
    const creative = await store.get(ref.creativeSlug);
    const version = (await store.readVersions(ref.creativeSlug)).find((v) => v.n === n);
    if (!version) throw new CodedError(404, m.errors.versionNNotFound({ n }), 'version-not-found');
    const comps = version.compositions ?? [];
    if (comps.length === 0) throw new CodedError(400, m.render.notV2({ n }), 'version-not-v2');
    const full = renderPlan(comps, creative.brief, requested);
    if (full.unknown.length > 0) throw new CodedError(400, m.render.formatsNotInVersion({ list: full.unknown.join(', ') }), 'formats-not-in-version');
    // Task 27: a localized video renders every instance with its own overlay (a follower too), as a render per language does.
    const video = subtitles?.video;
    const plan = video === undefined ? full : { ...full, primaries: [...full.primaries, ...Object.keys(full.followers)], followers: {} };
    if (video !== undefined) await this.checkLocalized(ref, version, plan.primaries, video, o.force === true, locale);
    if (!this.deps.engine) throw new CodedError(503, m.render.noRenderer, 'no-renderer');
    if ((await this.deps.engine.info()).kind === null) throw new CodedError(409, m.render.noBrowser, 'no-browser');
    const detail = [video ?? null, profile.short !== undefined ? `${profile.short}p` : null, profile.fps !== undefined ? m.render.fpsName({ fps: profile.fps }) : null, m.render.qualityNames[profile.quality],
      subtitles?.drawn ? m.render.exportSubtitlesDrawn({ lang: subtitles.drawn }) : subtitles?.strip ? m.render.exportNoSubtitles : null].filter(Boolean).join(' · ');
    return this.deps.queue.enqueue({
      key: exportRenderJobKey(ref.root, ref.projectSlug, ref.creativeSlug, n, randomBytes(4).toString('hex')),
      kind: 'render', lane: 'render',
      label: m.render.exportJobLabel({ title: creative.title, n, detail }),
      formats: [...plan.primaries, ...Object.keys(plan.followers)],
      run: async (signal, jobId) => {
        const presets = await this.deps.presets();
        const label = (id: string) => formatDisplayName(presets, id, locale);
        const progress = this.throttled(jobId);
        const failures: string[] = [];
        const notes: string[] = [];
        const detail = (text: string) => { notes.push(text); this.deps.queue.patch(jobId, { notes: [...notes] }); };
        await mkdir(outDir, { recursive: true });
        try {
          for (const format of plan.primaries) {
            if (signal.aborted) throw new RenderError('cancelled', 'cancelled');
            const followers = Object.keys(plan.followers).filter((f) => plan.followers[f] === format);
            try {
              const r = await this.renderForExport({ ref, n, format, comps, presets, profile, ...(subtitles ? { subtitles } : {}), force: o.force === true, outDir, signal, progress, label, locale });
              // Each file checked against its own format (a follower's limits are its own, M4), as a version render's.
              for (const f of [format, ...followers]) {
                const checked = await this.exportChecks(r.path, findPreset(presets, f) ?? { ...findPreset(presets, format)!, id: f }, r.composition, r.render, locale);
                if (checked.warning) detail(`${label(f)}: ${outputWarningText(checked.warning, locale)}`);
                collect(f, { path: r.path, render: r.render, problems: checked.problems, issues: checked.issues, durationSec: r.composition.duration > 0 ? r.composition.duration : null,
                  ...(r.softIgnored ? { softIgnored: true } : {}) });
              }
            } catch (e) {
              if (signal.aborted || (e instanceof RenderError && e.code === 'cancelled')) throw e;
              const reason = errorText(e);
              for (const f of [format, ...followers]) fail(f, reason);
              failures.push(m.render.formatFailed({ format: label(format), reason }));
            }
          }
        } finally {
          this.deps.queue.patch(jobId, { progress: undefined });
        }
        if (failures.length > 0) throw new JobFailedError(m.render.someFailed({ list: failures.join('; ') }));
      },
    });
  }

  /** A job's progress, throttled like the version renders' (phase changes always go out). */
  private throttled(jobId: string): (p: JobProgress) => void {
    let last = 0;
    let lastKey = '';
    return (p) => {
      const now = Date.now();
      const key = `${p.format}:${p.phase}`;
      if (key === lastKey && p.done < p.total && now - last < (this.deps.progressIntervalMs ?? 250)) return;
      last = now;
      lastKey = key;
      this.deps.queue.patch(jobId, { progress: p });
    };
  }

  /**
   * One format rendered for an export at `profile` (decision 974): the composition checked as for the version's render (its
   * hash still the recorded one), its media normalised, rendered into `outDir`. Nothing is recorded in the version.
   */
  private async renderForExport(o: { ref: CreativeRef; n: number; format: string; comps: VersionComposition[]; presets: FormatPreset[]; profile: RenderProfile;
    subtitles?: ExportRenderOptions['subtitles']; force?: boolean; outDir: string; signal: AbortSignal; progress: (p: JobProgress) => void; label: (id: string) => string; locale: Locale }): Promise<{ path: string; render: RenderInfo; composition: Composition; softIgnored: boolean }> {
    const { ref, n, format, signal } = o;
    const m = messages(o.locale);
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(ref.creativeSlug);
    o.progress({ format, phase: 'media', done: 0, total: 0 });
    // Task 27: a localized video from its private copy (`localizedFolder`), else the version's composition as it is.
    const video = o.subtitles?.video;
    const loc = video !== undefined ? await this.localizedFolder(ref, n, format, video, o.force === true, o.presets, o.locale) : null;
    try {
      let base: Composition, compDir: string, preset: FormatPreset;
      if (loc) ({ composition: base, compDir, preset } = loc);
      else {
        const entry = o.comps.find((c) => c.format === format)!;
        const found = findPreset(o.presets, format);
        if (!found) throw new Error(m.validation.unknownPreset({ id: format }));
        preset = found;
        compDir = join(store.outputsDir(ref.creativeSlug, n), ...entry.dir.split('/'));
        const loaded = await loadComposition(compDir, preset);
        if (!loaded.ok) {
          const list = loaded.problems.slice(0, 5).map((p) => compositionProblemText(p, o.locale)).join('; ');
          throw new Error(m.render.compositionProblems({ format: o.label(format), list }));
        }
        if (loaded.hash !== entry.hash) throw new Error(m.render.compositionChanged({ format: o.label(format) }));
        base = loaded.composition;
      }
      return await this.renderExportComposition({ ...o, creativeDir, compDir, preset, base, dir: loc ? loc.root : creativeDir });
    } finally {
      await loc?.release();
    }
  }

  /** The render of `renderForExport`, once its composition (`base`), folder and preset are known. */
  private async renderExportComposition(o: { ref: CreativeRef; n: number; format: string; profile: RenderProfile; subtitles?: ExportRenderOptions['subtitles']; outDir: string; signal: AbortSignal;
    progress: (p: JobProgress) => void; locale: Locale; creativeDir: string; compDir: string; preset: FormatPreset; base: Composition; dir: string }): Promise<{ path: string; render: RenderInfo; composition: Composition; softIgnored: boolean }> {
    const { ref, n, format, signal, creativeDir, compDir, preset } = o;
    // Report 39 (decision 1234): at the export's frame rate for the media too, so an embedded video is normalised at that
    // rate (its own cache file) and never shows each frame twice at 60 fps.
    // Subtitles Task 21: the clean video never has the subtitles track (anti-goal 2).
    const own = storeComposition(format, o.subtitles?.strip ? stripSubtitles(o.base) : o.base);
    const composition = o.profile.fps !== undefined && o.profile.fps !== own.fps ? { ...own, fps: o.profile.fps } : own;
    // The video sources at the render's scale (review #8): never upscaled soft at 1440p or 2160p.
    const scale = scaledSize(composition, o.profile.short).width / composition.width;
    const prepared = await this.deps.normalizer.prepare({ projectDir: ref.projectDir, compDir, composition, signal, ...(scale !== 1 ? { scale } : {}),
      onProgress: (p) => o.progress({ format, phase: 'media', done: p.done, total: p.total }) });
    const file = `${format}.${renderExtension(preset, !(composition.duration > 0))}`;
    let softDir: string | null = null;
    try {
      // Soft tracks (Task 21): SRT files of the core's own, in the export's work folder, cut at the composition's end.
      if (o.subtitles?.soft.length) softDir = await mkdtemp(join(o.outDir, `.soft-${format}-`));
      // Without explicit subtitles: the version render's (default pairing), not recorded: an export renders the version as it
      // would be. With them (Task 21): only the language asked for, never recorded either.
      if (o.subtitles && (o.subtitles.drawn !== null || softDir)) await this.deps.subtitleCommits?.flush(ref);
      const subtitles = o.subtitles ? await this.exportSubtitles(ref, composition, o.subtitles.drawn) : (await this.subtitlesFor(ref, n, composition, { snapshot: false }))?.data;
      const media = sessionMediaOf(prepared);
      const soft: Array<{ lang: LocaleTag; srt: string }> = [];
      for (const lang of softDir ? o.subtitles!.soft : []) {
        // The set the export read with its request (the side files' content), else the one on disk now.
        const set = o.subtitles!.sets?.[lang] ?? (await readSubtitleSet(creativeDir, lang))?.set;
        if (!set) throw new Error(messages(o.locale).export.subtitlesMissing({ lang }));
        const srt = join(softDir!, `${lang}.srt`);
        await writeFile(srt, toSrt(set.cues, { durationMs: Math.round(composition.duration * 1000) }));
        soft.push({ lang, srt });
      }
      const result = await this.deps.engine!.render({
        ...this.deps.renderOptions,
        dir: o.dir, versionDir: `outputs/v${n}`, composition, format: { ...preset, id: format }, out: join(o.outDir, file), signal, ...(media ? { media } : {}),
        // The App Store preview keeps its store audio, as its version render (final review M4): it then takes no soft tracks.
        ...storeRenderOptions(format, composition),
        ...(subtitles ? { subtitles } : {}), ...(soft.length ? { softSubtitles: soft } : {}),
        quality: o.profile.quality, ...(o.profile.short !== undefined ? { short: o.profile.short } : {}),
        onProgress: (p) => o.progress({ format, phase: 'frames', done: p.frames, total: p.total }),
      });
      return { path: result.file, render: renderInfoOf(result, o.profile.quality, composition.fps), composition,
        softIgnored: soft.length > 0 && result.warnings.some((w) => w.code === 'softSubtitlesIgnored') };
    } finally {
      prepared.release();
      if (softDir) await rm(softDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * The set drawn into a render made for an export with explicit subtitles (Task 21): `lang`'s, cut at the composition's end;
   * none for `null` (the clean video). A language asked for that cannot be drawn now (its set gone, or no subtitles track) fails
   * the render rather than giving a video named for subtitles it does not have.
   */
  private async exportSubtitles(ref: CreativeRef, composition: Composition, lang: LocaleTag | null): Promise<NonNullable<RenderCompositionOptions['subtitles']> | undefined> {
    if (lang === null) return undefined;
    const staged = await stageSubtitles({ creativeDir: new CreativeStore(ref.projectDir).dir(ref.creativeSlug), composition, lang, durationMs: Math.round(composition.duration * 1000) });
    if (!staged) throw new Error(messages(currentLocale()).export.subtitlesMissing({ lang }));
    return staged.data;
  }

  /**
   * The output checks of a render made for an export (review #4), as `describe` does for a version render: readable, the
   * duration (and the channel's maximum), the channel's size limit, and the bitrate warning of its quality. The size is the
   * one the export asked for, so it is never a problem here.
   */
  private async exportChecks(path: string, preset: FormatPreset, composition: Composition, render: RenderInfo, locale: Locale):
    Promise<{ problems: string[]; issues: OutputIssue[]; warning: ReturnType<typeof largeFileWarning> }> {
    const v = messages(locale).validation;
    const file = basename(path);
    const st = await lstat(path);
    const media = this.deps.media;
    const probed = media.available ? await media.probe(path).catch(() => null) : null;
    const problems: string[] = [];
    const issues: OutputIssue[] = [];
    const round1 = (x: number) => Math.round(x * 10) / 10;
    if (media.available && !probed) { problems.push(v.notReadable({ file })); issues.push({ code: 'notReadable', params: {} }); }
    const video = composition.duration > 0;
    const durationSec = video ? (probed?.durationSec ?? composition.duration) : null;
    if (video && durationSec !== null) {
      if (Math.abs(durationSec - composition.duration) > Math.max(0.1, 2 / composition.fps)) {
        problems.push(v.durationOffTarget({ file, duration: durationSec.toFixed(1), target: composition.duration }));
        issues.push({ code: 'durationOffTarget', params: { duration: round1(durationSec), target: composition.duration } });
      }
      if (preset.maxDurationSec !== undefined && durationSec > preset.maxDurationSec + 1e-3) {
        problems.push(v.durationOverMax({ file, duration: durationSec.toFixed(1), max: preset.maxDurationSec }));
        issues.push({ code: 'durationOverMax', params: { duration: round1(durationSec), max: preset.maxDurationSec } });
      }
    }
    if (preset.maxFileMB !== undefined && st.size / 1e6 > preset.maxFileMB) {
      problems.push(v.tooLarge({ file, size: (st.size / 1e6).toFixed(1), max: preset.maxFileMB }));
      issues.push({ code: 'tooLarge', params: { size: round1(st.size / 1e6), max: preset.maxFileMB } });
    }
    // The bitrate target scales with the pixels of the output, as the renderer's does.
    const k = (render.width * render.height) / (preset.width * preset.height);
    const scaled: FormatPreset = { ...preset, width: render.width, height: render.height,
      ...(preset.targetBitrateKbps !== undefined ? { targetBitrateKbps: Math.round(preset.targetBitrateKbps * k) } : {}) };
    const warning = largeFileWarning(scaled, file.slice(file.lastIndexOf('.') + 1), st.size, durationSec, render.fps ?? composition.fps, render.quality);
    return { problems, issues, warning };
  }

  private async run(ref: CreativeRef, n: number, plan: RenderPlan, comps: VersionComposition[], locale: Locale, signal: AbortSignal, jobId: string): Promise<void> {
    const m = messages(locale);
    const presets = await this.deps.presets();
    const label = (id: string) => formatDisplayName(presets, id, locale);
    const store = new CreativeStore(ref.projectDir);
    const notes: string[] = [];
    // Details for the UI behind "Details" (the English reasons of an SVG refusal): job notes only, not the chat.
    const detail = (text: string) => { notes.push(text); this.deps.queue.patch(jobId, { notes: [...notes] }); };
    const note = async (text: string) => {
      notes.push(text);
      this.deps.queue.patch(jobId, { notes: [...notes] });
      await store.appendConversation(ref.creativeSlug, { type: 'system', at: new Date().toISOString(), level: 'warning', text }).catch(() => {});
    };
    let last = 0;
    let lastPhase = '';
    const progress = (p: JobProgress) => {
      const now = Date.now();
      const key = `${p.format}:${p.phase}`;
      if (key === lastPhase && p.done < p.total && now - last < (this.deps.progressIntervalMs ?? 250)) return;
      last = now;
      lastPhase = key;
      this.deps.queue.patch(jobId, { progress: p });
    };
    const failures: string[] = [];
    try {
      for (const format of plan.primaries) {
        if (signal.aborted) throw new RenderError('cancelled', 'cancelled');
        const followers = Object.keys(plan.followers).filter((f) => plan.followers[f] === format);
        try {
          await this.renderFormat({ ref, n, format, followers, plan, comps, presets, locale, signal, progress, note, detail, label });
        } catch (e) {
          if (signal.aborted || (e instanceof RenderError && e.code === 'cancelled')) throw e;
          failures.push(m.render.formatFailed({ format: label(format), reason: errorText(e) }));
        }
      }
    } finally {
      this.deps.queue.patch(jobId, { progress: undefined });
    }
    if (failures.length > 0) throw new JobFailedError(m.render.someFailed({ list: failures.join('; ') }));
  }

  private async renderFormat(o: {
    ref: CreativeRef; n: number; format: string; followers: string[]; plan: RenderPlan; comps: VersionComposition[]; presets: FormatPreset[]; locale: Locale;
    signal: AbortSignal; progress: (p: JobProgress) => void; note: (text: string) => Promise<void>; detail?: (text: string) => void; label: (id: string) => string;
  }): Promise<void> {
    const { ref, n, format, signal } = o;
    const m = messages(o.locale);
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(ref.creativeSlug);
    const versionDir = store.outputsDir(ref.creativeSlug, n);
    const entry = o.comps.find((c) => c.format === format)!;
    const preset = findPreset(o.presets, format);
    if (!preset) throw new Error(m.validation.unknownPreset({ id: format }));
    if (o.plan.reuse?.includes(format)) return this.copyFollowers(o, preset, entry);
    o.progress({ format, phase: 'media', done: 0, total: 0 });
    const compDir = join(versionDir, ...entry.dir.split('/'));
    const loaded = await loadComposition(compDir, preset);
    if (!loaded.ok) {
      const list = loaded.problems.slice(0, 5).map((p) => compositionProblemText(p, o.locale)).join('; ');
      throw new Error(m.render.compositionProblems({ format: o.label(format), list }));
    }
    if (loaded.hash !== entry.hash) throw new Error(m.render.compositionChanged({ format: o.label(format) }));
    // An identity format (Phase 14): vector mode and the strict SVG check again, before anything is rendered or rasterised.
    if (preset.identity) {
      const v = await identityProblems(compDir, loaded.composition);
      if (v.problems.length > 0) {
        // The user reads one translated summary per file (decision 767); the English reasons go to the job's notes ("Details").
        const refused = v.problems.filter((p) => p.key === 'composition.svgRefused');
        const perFile = new Map<string, number>();
        for (const p of refused) perFile.set(String(p.params.file), (perFile.get(String(p.params.file)) ?? 0) + 1);
        for (const p of refused) o.detail?.(compositionProblemText(p, o.locale));
        const list = [
          ...[...perFile].map(([file, count]) => m.composition.svgRefusedSummary({ file, count })),
          ...v.problems.filter((p) => p.key !== 'composition.svgRefused').slice(0, 5).map((p) => compositionProblemText(p, o.locale)),
        ].join('; ');
        throw new Error(m.render.identitySvgRefused({ format: o.label(format), list }));
      }
    }
    // At the output's frame rate for the media too (the App Store preview: 30 fps, M4).
    const composition = storeComposition(format, loaded.composition);
    // The subtitles it draws (spec §6.1, U8), staged and kept next to the output before anything is rendered.
    const subtitles = await this.subtitlesFor(ref, n, composition, { snapshot: true });
    const sub: Pick<OutputFileInfo, 'subtitles'> = subtitles ? { subtitles: subtitles.record } : {};
    const prepared = await this.deps.normalizer.prepare({
      projectDir: ref.projectDir, compDir, composition, signal,
      onProgress: (p) => o.progress({ format, phase: 'media', done: p.done, total: p.total }),
    });
    let result: RenderResult;
    const still = !(composition.duration > 0);
    const ext = renderExtension(preset, still);
    const file = `${format}.${ext}`;
    try {
      for (const w of prepared.warnings) {
        await o.note(w.kind === 'hdrApproximate' ? m.render.hdrApproximate({ format: o.label(format), src: w.src }) : m.render.mediaNotNormalised({ format: o.label(format), src: w.src }));
      }
      result = await this.deps.engine!.render({
        ...this.deps.renderOptions,
        dir: creativeDir, versionDir: `outputs/v${n}`, composition, format: preset, out: join(versionDir, file), signal, ...(sessionMediaOf(prepared) ? { media: sessionMediaOf(prepared)! } : {}),
        // Store screenshots are flattened, the App Store preview gets its audio track (Phase 12, spec §4.2).
        ...storeRenderOptions(format, composition),
        ...(subtitles?.data ? { subtitles: subtitles.data } : {}),
        // The version's own render is always at the default quality and the format's size (decision 974).
        quality: DEFAULT_EXPORT_QUALITY,
        onProgress: (p) => o.progress({ format, phase: 'frames', done: p.frames, total: p.total }),
        // The stamp is noted before the rename (M1): a turn's check in between sees the core's own write.
        beforeRename: (temp) => noteCoreOutputWrite(creativeDir, `outputs/v${n}/${file}`, temp),
      });
    } finally {
      prepared.release();
    }
    // What the render was made with (decision 974): its quality, size and the encoder that ran; a still has no quality.
    const render: Pick<OutputFileInfo, 'render'> = still ? {} : { render: renderInfoOf(result, DEFAULT_EXPORT_QUALITY, composition.fps) };
    // From here the new file is in place: the record is always written, with what is on disk (I3), whatever happens next
    // (a cancel waits for these few steps; a failing follower is left out and reported). First the primary alone, at once,
    // with the renderer's own hash (a crash during the steps below then leaves a true record), then everything.
    const bare: OutputFileInfo = { format, file, width: result.width, height: result.height, durationSec: result.durationSec, verified: false, preview: null, sha256: result.sha256, problems: [], fromComposition: loaded.hash, ...render, ...sub };
    const infos: OutputFileInfo[] = [];
    let failure: unknown = null;
    // A failing first record must not skip the checks, the follower copies and the final record below (C10).
    await this.record(store, ref, n, [bare], o.plan.fixFollows, o.comps).catch((e: unknown) => { failure = e; });
    try {
      o.progress({ format, phase: 'finishing', done: 0, total: 1 + o.followers.length });
      await noteCoreChange(versionDir);
      if (result.warnings.length > 0) await o.note(m.render.frameWarnings({ format: o.label(format), count: result.warnings.length })).catch(() => {});
      let info = await this.describe({ creativeDir, versionDir, n, preset, file, composition, sha256: result.sha256, hash: loaded.hash, locale: o.locale, poster: true })
        .then((x) => ({ ...x, ...render, ...sub }), (e: unknown) => {
          failure = e;
          return bare;
        });
      if (preset.identity) {
        try {
          const set = await this.identitySet({ ref, n, format, kind: preset.identity, compDir, composition, signal, locale: o.locale });
          info = { ...info, identitySet: set };
          for (const w of set.warnings) await o.note(w).catch(() => {});
        } catch (e) {
          if (signal.aborted) throw e;
          failure ??= new Error(m.render.identitySetFailed({ format: o.label(format), reason: errorText(e) }));
        }
      }
      infos.push(info);
      for (const [i, f] of o.followers.entries()) {
        try {
          infos.push(await this.follower({ creativeDir, versionDir, n, f, ext, primary: info, composition, presets: o.presets, comps: o.comps, locale: o.locale, fallback: preset }));
        } catch (e) {
          failure ??= e;
        }
        o.progress({ format, phase: 'finishing', done: i + 1, total: 1 + o.followers.length });
      }
    } finally {
      await this.record(store, ref, n, infos, o.plan.fixFollows, o.comps);
      await noteCoreChange(versionDir);
      this.deps.broadcast({ type: 'creative', project: ref.projectSlug, creative: ref.creativeSlug });
    }
    // The output checks' problems (size, duration, resolution, unreadable; final review I2) as job notes and chat warnings,
    // like the frame warnings; a follower's copy only for the problems its own preset adds.
    const primaryProblems = infos[0]?.problems ?? [];
    for (const [i, info] of infos.entries()) {
      const own = i === 0 ? primaryProblems : (info.problems ?? []).filter((p) => !primaryProblems.includes(p));
      if (own.length) await o.note(m.render.outputProblems({ format: o.label(info.format), list: own.join('; ') })).catch(() => {});
    }
    if (failure) throw failure;
  }

  /**
   * The primary's current render is kept (C6): the followers' copies are made from it and recorded, nothing is rendered.
   * The primary's file is checked against its record first; if it no longer matches, it is rendered as usual.
   */
  private async copyFollowers(o: Parameters<RenderJobService['renderFormat']>[0], preset: FormatPreset, entry: VersionComposition): Promise<void> {
    const { ref, n, format } = o;
    const m = messages(o.locale);
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(ref.creativeSlug);
    const versionDir = store.outputsDir(ref.creativeSlug, n);
    const version = (await store.readVersions(ref.creativeSlug)).find((v) => v.n === n);
    const primary = version?.outputs.find((x) => x.format === format);
    const h = primary ? await hashConfinedFile(creativeDir, `outputs/v${n}/${primary.file}`) : null;
    if (!primary || !h || !('sha256' in h) || h.sha256 !== primary.sha256) return this.renderFormat({ ...o, plan: { ...o.plan, reuse: o.plan.reuse!.filter((f) => f !== format) } });
    const compDir = join(versionDir, ...entry.dir.split('/'));
    const loaded = await loadComposition(compDir, preset);
    if (!loaded.ok || loaded.hash !== entry.hash) return this.renderFormat({ ...o, plan: { ...o.plan, reuse: o.plan.reuse!.filter((f) => f !== format) } });
    const ext = primary.file.slice(primary.file.lastIndexOf('.') + 1);
    const infos: OutputFileInfo[] = [];
    let failure: unknown = null;
    try {
      o.progress({ format, phase: 'finishing', done: 0, total: o.followers.length });
      for (const [i, f] of o.followers.entries()) {
        try {
          infos.push(await this.follower({ creativeDir, versionDir, n, f, ext, primary, composition: loaded.composition, presets: o.presets, comps: o.comps, locale: o.locale, fallback: preset }));
        } catch (e) { failure ??= e; }
        o.progress({ format, phase: 'finishing', done: i + 1, total: o.followers.length });
      }
    } finally {
      if (infos.length > 0) await this.record(store, ref, n, infos, o.plan.fixFollows, o.comps);
      await noteCoreChange(versionDir);
      this.deps.broadcast({ type: 'creative', project: ref.projectSlug, creative: ref.creativeSlug });
    }
    const own0 = primary.problems ?? [];
    for (const info of infos) {
      const own = (info.problems ?? []).filter((p) => !own0.includes(p));
      if (own.length) await o.note(m.render.outputProblems({ format: o.label(info.format), list: own.join('; ') })).catch(() => {});
    }
    if (failure) throw failure;
  }

  /**
   * A follower's copy of its primary's render (`COPYFILE_EXCL` into a temp file, then a rename), checked against the
   * follower's OWN preset (extension, size and duration limits, bitrate warning; M4) and carrying the primary's problems.
   */
  private async follower(o: { creativeDir: string; versionDir: string; n: number; f: string; ext: string; primary: OutputFileInfo; composition: Composition;
    presets: FormatPreset[]; comps: VersionComposition[]; locale: Locale; fallback: FormatPreset }): Promise<OutputFileInfo> {
    const v = messages(o.locale).validation;
    const fPreset = findPreset(o.presets, o.f) ?? { ...o.fallback, id: o.f };
    const fFile = `${o.f}.${o.ext}`;
    await copyInto(join(o.versionDir, o.primary.file), o.versionDir, fFile, (temp) => noteCoreOutputWrite(o.creativeDir, `outputs/v${o.n}/${fFile}`, temp));
    // The copy is in place: from here it is always recorded (never a stale entry). It is a byte copy of the primary, so
    // the primary's hash; it is checked, and an entry that could not be checked is marked unverified.
    const fEntry = o.comps.find((c) => c.format === o.f);
    const fromComposition = fEntry?.hash ?? o.primary.fromComposition;
    const base: OutputFileInfo = {
      ...o.primary, format: o.f, file: fFile, preview: null, verified: false, problems: [...(o.primary.problems ?? [])],
      ...(o.primary.sha256 ? { sha256: o.primary.sha256 } : {}), ...(fromComposition ? { fromComposition } : {}),
    };
    try {
      const h = await hashConfinedFile(o.creativeDir, `outputs/v${o.n}/${fFile}`);
      const sha256 = h && 'sha256' in h ? h.sha256 : undefined;
      if (sha256 !== undefined && o.primary.sha256 !== undefined && sha256 !== o.primary.sha256) return { ...base, sha256 };
      const own = await this.describe({ creativeDir: o.creativeDir, versionDir: o.versionDir, n: o.n, preset: fPreset, file: fFile, composition: o.composition, sha256, hash: '', locale: o.locale, poster: false });
      const problems = [...(o.primary.problems ?? [])];
      for (const p of own.problems ?? []) if (!problems.includes(p)) problems.push(p);
      const issues: OutputIssue[] = [...(o.primary.issues ?? [])];
      for (const i of own.issues ?? []) if (!issues.some((x) => JSON.stringify(x) === JSON.stringify(i))) issues.push(i);
      if (!fPreset.extensions.includes(o.ext)) {
        problems.push(v.badExtension({ file: fFile, ext: o.ext, id: o.f, allowed: fPreset.extensions.join(', ') }));
        issues.push({ code: 'badExtension', params: { ext: o.ext } });
      }
      let preview: string | null = null;
      if (o.primary.preview) {
        const pv = `.previews/${fFile}.jpg`;
        const ok = await copyInto(join(o.versionDir, o.primary.preview), join(o.versionDir, '.previews'), `${fFile}.jpg`,
          (temp) => noteCoreOutputWrite(o.creativeDir, `outputs/v${o.n}/${pv}`, temp)).then(() => true, () => false);
        if (ok) { preview = pv; await noteCoreOutputWrite(o.creativeDir, `outputs/v${o.n}/.previews`); }
      }
      const { sha256: _drop, fromComposition: _fc, issues: _own, ...rest } = own;
      return { ...rest, verified: own.verified && sha256 !== undefined, preview, problems, ...(issues.length ? { issues } : {}), ...(base.sha256 ? { sha256: base.sha256 } : {}), ...(fromComposition ? { fromComposition } : {}),
        ...(o.primary.render ? { render: o.primary.render } : {}), ...(o.primary.subtitles ? { subtitles: o.primary.subtitles } : {}) };
    } catch {
      return base;
    }
  }

  /**
   * The file set of an identity format (Phase 14, spec §4.1–4.2) into `outputs/vN/<format>/`: the SVGs are read confined
   * from the composition folder (already checked, the composition's hash is the version's) and copied to a temp folder of the
   * core's own, the set is built there (`buildIdentitySet`, with the render engine's browser), then every file is copied
   * into the version through a temp name, noted as the core's write, and renamed. Every folder of the way must be a real
   * folder of the creative (never through a link the agent left).
   */
  private async identitySet(o: { ref: CreativeRef; n: number; format: string; kind: 'logo' | 'favicon' | 'app-icon'; compDir: string; composition: Composition; signal: AbortSignal; locale: Locale }): Promise<IdentitySetInfo> {
    const store = new CreativeStore(o.ref.projectDir);
    const creativeDir = store.dir(o.ref.creativeSlug);
    const v = checkVectorComposition(o.composition);
    if (!v.ok) throw new Error(v.reason);
    const work = await makeOwnedTempDir(join(this.deps.renderOptions?.tempDir ?? tmpdir(), 'ms-identity-set-'));
    try {
      const copy = async (rel: string, name: string) => {
        const r = await readConfinedFile(o.compDir, rel, MAX_VECTOR_SVG_BYTES);
        if (!r || !('text' in r)) throw new Error(`${rel} cannot be read safely`);
        const path = join(work, name);
        await writeFile(path, r.text, { flag: 'wx', mode: 0o644 });
        return path;
      };
      const master = await copy(v.svgFile, 'master.svg');
      const small = v.small !== undefined ? await copy(v.small, 'small.svg') : undefined;
      // The logo's negative (decision 876); an older logo has none, and its set simply has no logo-dark files.
      const dark = o.kind === 'logo' && v.dark !== undefined ? await copy(v.dark, 'dark.svg') : undefined;
      const creative = await store.get(o.ref.creativeSlug);
      const brand = await new BrandStore(o.ref.projectDir).readKit().catch(() => undefined);
      const engine = this.deps.engine!;
      const outDir = join(work, 'set');
      const built = await buildIdentitySet(o.kind, {
        master, ...(small ? { small } : {}), ...(dark ? { dark } : {}), outDir, ...(brand ? { brand } : {}),
        name: creative.brief.identity?.name ?? creative.title, background: o.composition.background, label: o.format, signal: o.signal, locale: o.locale,
        raster: { provider: () => engine.provider(), ...(this.deps.renderOptions?.distDir ? { distDir: this.deps.renderOptions.distDir } : {}), ...(this.deps.renderOptions?.tempDir ? { tempDir: this.deps.renderOptions.tempDir } : {}) },
      });
      const vRel = `outputs/v${o.n}`;
      const madeDirs = new Set<string>();
      for (const f of built.files) {
        const parts = f.path.split('/');
        const name = parts.pop()!;
        const dir = await realDirChain(creativeDir, ['outputs', `v${o.n}`, o.format, ...parts]);
        if (!dir) throw new Error(`${vRel}/${o.format}/${parts.join('/')} is not a folder of the creative`);
        madeDirs.add([o.format, ...parts].join('/'));
        const rel = `${vRel}/${o.format}/${f.path}`;
        await copyInto(join(outDir, ...f.path.split('/')), dir, name, (temp) => noteCoreOutputWrite(creativeDir, rel, temp));
      }
      for (const d of madeDirs) await noteCoreOutputWrite(creativeDir, `${vRel}/${d}`);
      await noteCoreChange(join(creativeDir, 'outputs', `v${o.n}`));
      return { dir: o.format, files: built.files, warnings: built.warnings };
    } finally {
      await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }

  /** The output entry of a render: checked like an agent's file (ffprobe size and duration, limits, bitrate), with its poster. */
  private async describe(o: { creativeDir: string; versionDir: string; n: number; preset: FormatPreset; file: string; composition: Composition; sha256: string | undefined; hash: string; locale: Locale; poster: boolean }): Promise<OutputFileInfo> {
    const v = messages(o.locale).validation;
    const { preset, file } = o;
    const path = join(o.versionDir, file);
    const st = await lstat(path);
    const media = this.deps.media;
    const probed = media.available ? await media.probe(path).catch(() => null) : null;
    const problems: string[] = [];
    // Each problem also as a code with its figures (P2): the UI says it briefly in its own language.
    const issues: OutputIssue[] = [];
    const width = probed?.width ?? o.composition.width;
    const height = probed?.height ?? o.composition.height;
    const video = o.composition.duration > 0;
    const durationSec = video ? (probed?.durationSec ?? o.composition.duration) : null;
    const round1 = (x: number) => Math.round(x * 10) / 10;
    if (media.available && !probed) { problems.push(v.notReadable({ file })); issues.push({ code: 'notReadable', params: {} }); }
    if (width !== preset.width || height !== preset.height) {
      problems.push(v.badResolution({ file, width, height, expectedWidth: preset.width, expectedHeight: preset.height }));
      issues.push({ code: 'badResolution', params: { width, height, expectedWidth: preset.width, expectedHeight: preset.height } });
    }
    if (video && durationSec !== null) {
      // The renderer counted the frames exactly; the container may add up to an AAC frame of padding.
      if (Math.abs(durationSec - o.composition.duration) > Math.max(0.1, 2 / o.composition.fps)) {
        problems.push(v.durationOffTarget({ file, duration: durationSec.toFixed(1), target: o.composition.duration }));
        issues.push({ code: 'durationOffTarget', params: { duration: round1(durationSec), target: o.composition.duration } });
      }
      if (preset.maxDurationSec !== undefined && durationSec > preset.maxDurationSec + 1e-3) {
        problems.push(v.durationOverMax({ file, duration: durationSec.toFixed(1), max: preset.maxDurationSec }));
        issues.push({ code: 'durationOverMax', params: { duration: round1(durationSec), max: preset.maxDurationSec } });
      }
    }
    if (preset.maxFileMB !== undefined && st.size / 1e6 > preset.maxFileMB) {
      problems.push(v.tooLarge({ file, size: (st.size / 1e6).toFixed(1), max: preset.maxFileMB }));
      issues.push({ code: 'tooLarge', params: { size: round1(st.size / 1e6), max: preset.maxFileMB } });
    }
    // The version's render is at the default quality (decision 974): its bitrate is measured against that quality's target.
    const large = largeFileWarning(preset, file.slice(file.lastIndexOf('.') + 1), st.size, durationSec, o.composition.fps, DEFAULT_EXPORT_QUALITY);
    let preview: string | null = null;
    if (o.poster && video && media.available && probed) {
      const dir = join(o.versionDir, '.previews');
      const target = join(dir, `${file}.jpg`);
      const d = await lstat(dir).catch(() => null);
      const t = await lstat(target).catch(() => null);
      if ((d === null || d.isDirectory()) && (t === null || t.isFile())) {
        // Into a temp file, noted, then renamed (M1): a turn's check never sees a half-written poster or an unnoted one.
        const temp = join(dir, tempName(`${file}.jpg`));
        noteCoreTemp(temp);
        try {
          await mkdir(dir, { recursive: true });
          const made = await media.poster(path, temp).catch(() => false);
          if (made) {
            preview = `.previews/${file}.jpg`;
            await noteCoreOutputWrite(o.creativeDir, `outputs/v${o.n}/${preview}`, temp);
            await rename(temp, target);
            await noteCoreOutputWrite(o.creativeDir, `outputs/v${o.n}/.previews`);
          }
        } catch { preview = null; } finally {
          await rm(temp, { force: true }).catch(() => {});
          // The folder's mtime moved (made, or a failed poster): the core's own change, noted whatever happened (C10).
          if ((await lstat(dir).catch(() => null))?.isDirectory()) await noteCoreOutputWrite(o.creativeDir, `outputs/v${o.n}/.previews`).catch(() => {});
        }
      }
    }
    return {
      format: preset.id, file, width, height, durationSec, verified: probed !== null, preview,
      ...(large ? { warnings: [large] } : {}), ...(o.sha256 ? { sha256: o.sha256 } : {}), problems, ...(issues.length ? { issues } : {}), ...(o.hash ? { fromComposition: o.hash } : {}),
    };
  }

  /**
   * Ruling L, checked again before every localized render: an "asset changed" problem of the row whose file is the recorded one
   * again is cleared (files looked up as the render takes them: the composition folder first, then the project). Returns the
   * row as it is now.
   */
  private async reverifyAssets(ref: CreativeRef, n: number, row: LocalizationRow, overlay: Localization, compDir: string): Promise<LocalizationRow> {
    const recorded = Object.keys(row.assetHashes ?? {});
    if (recorded.length === 0 || !(row.problems ?? []).some((p) => isAssetChangedProblem(p, recorded))) return row;
    const still = new Set(await changedAssets([compDir, ref.projectDir], row, overlayAssetPaths(overlay, row)));
    const cleared = recorded.filter((p) => !still.has(p));
    if (!(row.problems ?? []).some((p) => isAssetChangedProblem(p, cleared))) return row;
    const strip = (r: LocalizationRow): LocalizationRow =>
      withoutIssues(r, (i) => i.code === 'assetChanged' && isAssetChangedProblem(i.message, cleared), (p) => isAssetChangedProblem(p, cleared));
    await new CreativeStore(ref.projectDir).updateVersion(ref.creativeSlug, n, (x) => ({
      ...x, localizations: (x.localizations ?? []).map((r) => (r.locale === row.locale && r.instanceId === row.instanceId ? strip(r) : r)),
    }));
    this.deps.broadcast({ type: 'creative', project: ref.projectSlug, creative: ref.creativeSlug });
    return strip(row);
  }

  /**
   * A render in other languages (Phase 12, spec §3.5): every requested instance (all of the version's when none; a follower
   * is rendered with its OWN overlay on the composition it shows) in every requested language, into
   * `outputs/vN/<instanceId>.<locale>.<ext>`. Refused before anything is queued: a language not in the curated list (400),
   * an instance with no translation (409 `localization-missing`), and, without `force` ("render anyway"), a translation with
   * open problems or outdated entries (409 `localization-needs-force`, `problems` listing them). Always a new job in the
   * render lane; the primary-language files and records are never touched.
   */
  private async startLocalized(ref: CreativeRef, version: VersionEntry, title: string, requested: readonly string[] | undefined, rawLocales: readonly string[], force: boolean, locale: Locale): Promise<JobSummary> {
    const m = messages(locale);
    const v = m.variants;
    const tags = [...new Set(rawLocales.map((x) => checkedLocale(x, locale)))];
    const comps = version.compositions ?? [];
    const instances = requested && requested.length > 0 ? comps.map((c) => c.format).filter((f) => requested.includes(f)) : comps.map((c) => c.format);
    const presets = await this.deps.presets();
    const label = (id: string, tag: string) => `${formatDisplayName(presets, id, locale)} (${tag})`;
    const missing: string[] = [];
    const needsForce: string[] = [];
    const creativeDir = new CreativeStore(ref.projectDir).dir(ref.creativeSlug);
    for (const tag of tags) {
      for (const id of instances) {
        const found = version.localizations?.find((r) => r.locale === tag && r.instanceId === id);
        const read = found ? await readOverlay(creativeDir, version.n, tag, id) : null;
        if (!found || !read || read.hash !== found.hash) { missing.push(label(id, tag)); continue; }
        const dir = comps.find((c) => c.format === id)?.dir;
        const row = dir ? await this.reverifyAssets(ref, version.n, found, read.overlay, join(creativeDir, 'outputs', `v${version.n}`, ...dir.split('/'))) : found;
        if ((row.problems?.length ?? 0) > 0 || row.stale.length > 0) needsForce.push(label(id, tag));
      }
    }
    if (missing.length > 0) {
      const err = new CodedError(409, v.localizationMissing({ list: missing.slice(0, 10).join(', ') }), 'localization-missing');
      err.problems = missing.slice(0, 50);
      throw err;
    }
    if (needsForce.length > 0 && !force) {
      const err = new CodedError(409, v.renderNeedsForce({ list: needsForce.slice(0, 10).join(', ') }), 'localization-needs-force');
      err.problems = needsForce.slice(0, 50);
      throw err;
    }
    if (!this.deps.engine) throw new CodedError(503, m.render.noRenderer, 'no-renderer');
    if ((await this.deps.engine.info()).kind === null) throw new CodedError(409, m.render.noBrowser, 'no-browser');
    const base = renderJobKey(ref.root, ref.projectSlug, ref.creativeSlug, version.n);
    const keys = new Set(this.activeJobs(base).map((j) => j.key));
    let key = `${base}:2`;
    for (let k = 3; keys.has(key); k++) key = `${base}:${k}`;
    const items = tags.flatMap((tag) => instances.map((id) => ({ id, tag })));
    return this.deps.queue.enqueue({
      key, kind: 'render', lane: 'render',
      label: m.render.jobLabel({ title, n: version.n }),
      // `<instance>.<locale>`: never taken for a primary-language format by a later request's coverage check.
      formats: items.map((x) => `${x.id}.${x.tag}`),
      run: async (signal, jobId) => {
        const failures: string[] = [];
        // The same throttle as the primary renders; the format is the job's own `<instance>.<locale>`.
        let last = 0;
        let lastKey = '';
        const progress = (p: JobProgress) => {
          const now = Date.now();
          const key = `${p.format}:${p.phase}`;
          if (key === lastKey && p.done < p.total && now - last < (this.deps.progressIntervalMs ?? 250)) return;
          last = now;
          lastKey = key;
          this.deps.queue.patch(jobId, { progress: p });
        };
        try {
          for (const it of items) {
            if (signal.aborted) throw new RenderError('cancelled', 'cancelled');
            try {
              await this.renderLocalized(ref, version.n, it.id, it.tag, force, presets, locale, signal, progress);
            } catch (e) {
              if (signal.aborted || (e instanceof RenderError && e.code === 'cancelled')) throw e;
              failures.push(m.render.formatFailed({ format: label(it.id, it.tag), reason: errorText(e) }));
            }
          }
        } finally {
          this.deps.queue.patch(jobId, { progress: undefined });
        }
        if (failures.length > 0) throw new JobFailedError(m.render.someFailed({ list: failures.join('; ') }));
      },
    });
  }

  /**
   * One localized render: the instance's composition (re-hashed, still the recorded one) with its overlay applied
   * (`localizedComposition`, stale ids keep the source), rendered by the usual pipeline from a private copy of the folder in
   * `<project>/.studio/cache/locale-render/` (the folder's files, verified against the recorded hash, plus the overlay's
   * fallback font files from the project), removed afterwards. Recorded in the row (`render`) and in the manifest's
   * `renders[]` with `locale`, `forced` and `stale`.
   */
  private async renderLocalized(ref: CreativeRef, n: number, instanceId: string, tag: LocaleTag, force: boolean, presets: FormatPreset[], locale: Locale, signal: AbortSignal, progress?: (p: JobProgress) => void): Promise<void> {
    const m = messages(locale);
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(ref.creativeSlug);
    const versionDir = store.outputsDir(ref.creativeSlug, n);
    const loc = await this.localizedFolder(ref, n, instanceId, tag, force, presets, locale);
    const { root, composition, preset, ic, row, read, forced, version, compDir } = loc;
    try {
      const atFps = storeComposition(instanceId, composition);
      // Its own language's subtitles when there is a set in it, else none (U8).
      const subtitles = await this.subtitlesFor(ref, n, atFps, { snapshot: true, localized: tag });
      const prepared = await this.deps.normalizer.prepare({ projectDir: ref.projectDir, compDir, composition: atFps, signal });
      const still = !(composition.duration > 0);
      const file = `${instanceId}.${tag}.${renderExtension(preset, still)}`;
      let result: RenderResult;
      try {
        result = await this.deps.engine!.render({
          ...this.deps.renderOptions,
          dir: root, versionDir: `outputs/v${n}`, composition: atFps, format: { ...preset, id: instanceId }, out: join(versionDir, file), signal,
          ...storeRenderOptions(instanceId, composition),
          ...(sessionMediaOf(prepared) ? { media: sessionMediaOf(prepared)! } : {}),
          ...(subtitles?.data ? { subtitles: subtitles.data } : {}),
          ...(progress ? { onProgress: (p: { frames: number; total: number }) => progress({ format: `${instanceId}.${tag}`, phase: 'frames', done: p.frames, total: p.total }) } : {}),
          beforeRename: (temp) => noteCoreOutputWrite(creativeDir, `outputs/v${n}/${file}`, temp),
        });
      } finally {
        prepared.release();
      }
      await noteCoreChange(versionDir);
      const info = await this.describe({ creativeDir, versionDir, n, preset, file, composition, sha256: result.sha256, hash: ic.entry.hash, locale, poster: false })
        // A check that could not run is a problem of the render, never a clean record (Ruling J).
        .catch(() => ({ width: result.width, height: result.height, durationSec: result.durationSec, problems: [m.variants.renderCheckFailed({ file })] }));
      // The browser's own measure (Ruling I): a translated text that overflows its box at the applied fit is a problem of this
      // language. A clip that shows the source text (not translated, or outdated: the stale rule) overflows with the original's
      // words: a note on the row (`sourceTextOverflow`, live F4), never a problem of the translation nor a reason to force.
      const translated = (id: string) => Object.hasOwn(read.overlay.texts, id) && !row.stale.includes(id);
      // A translated clip whose SOURCE already overflows keeps a note: the source-relative estimate judged the translation itself.
      // The source verdict comes from the browser (cached per composition and preset, fix round 2 N1); the row's notes (written
      // when the translation was judged, or carried) only when the browser cannot measure now. Any other translated clip that
      // overflows is a problem: nothing is exported silently.
      const measureText = this.deps.measureText;
      const sourceOver = measureText ? await sourceOverflowOf({ ...ic, preset }, (c, s) => measureText({ ref: { projectDir: ref.projectDir, creativeDir, creativeSlug: ref.creativeSlug, n },
        folder: basename(ic.compDir), preset, composition: c, signal: s }), signal).catch(() => null) : null;
      const sourceNoted = new Set((sourceOver ?? (row.issues ?? []).filter((i) => i.code === 'sourceTextOverflow' && i.clipId !== undefined).map((i) => i.clipId!)).filter((id) => translated(id)));
      const measured = (result.textOverflows ?? []).filter((e) => e.clipId !== undefined).map((e) => e.clipId!);
      const overflowIssues: LocalizationIssue[] = [...new Set([...measured, ...sourceNoted])].map((id): LocalizationIssue => (translated(id) && !sourceNoted.has(id)
        ? { code: 'textOverflowMeasured', clipId: id, message: m.variants.textOverflowMeasured({ clip: clipLabel(ic.composition, id), fit: Math.round((read.overlay.fit[id] ?? 1) * 100) }) }
        : { code: 'sourceTextOverflow', clipId: id, message: (translated(id) ? m.variants.sourceLayoutOverflow : m.variants.sourceTextOverflow)({ clip: clipLabel(ic.composition, id) }) }));
      const overflows = overflowIssues.filter((i) => i.code === 'textOverflowMeasured').map((i) => i.message);
      const problems = [...new Set([...(info.problems ?? []), ...overflows])];
      const at = new Date().toISOString();
      const render: NonNullable<LocalizationRow['render']> = {
        file, width: info.width, height: info.height, durationSec: info.durationSec !== null && info.durationSec > 0 ? info.durationSec : null,
        sha256: result.sha256, fromComposition: ic.entry.hash, overlayHash: row.hash, forced, stale: [...row.stale],
        ...(problems.length ? { problems } : {}), renderedAt: at, ...(subtitles ? { subtitles: subtitles.record } : {}),
      };
      await store.updateVersion(ref.creativeSlug, n, (x) => ({
        ...x, localizations: (x.localizations ?? []).map((r) => {
          if (r.locale !== tag || r.instanceId !== instanceId) return r;
          // A measured overflow is also an open problem of the translation (while it is the overlay rendered). The source-text
          // notes are this render's measure: the previous render's are replaced.
          return { ...(r.hash === row.hash ? withIssues(withoutIssues(r, (i) => i.code === 'sourceTextOverflow'), overflowIssues) : r), render };
        }),
      }));
      await updateVersionManifest(creativeDir, n, (found) => {
        // No v2 manifest yet: one is started from the version's compositions, as the primary record does.
        const current: ManifestV2 = found?.schemaVersion === 2 ? found : { schemaVersion: 2, compositions: version.compositions ?? [], renders: [] };
        return {
          ...current,
          renders: [
            ...current.renders.filter((r) => !(r.format === instanceId && r.locale === tag)),
            { format: instanceId, file, width: render.width, height: render.height, durationSec: render.durationSec, sha256: render.sha256, renderedAt: at,
              fromComposition: render.fromComposition, locale: tag, forced, stale: render.stale, ...(render.subtitles ? { subtitles: render.subtitles } : {}) },
          ],
        };
      });
      await noteRenderStamps(ref.projectDir, creativeDir, ref.creativeSlug, n, [{ file, sha256: result.sha256 }]).catch(() => {});
      this.deps.broadcast({ type: 'creative', project: ref.projectSlug, creative: ref.creativeSlug });
    } finally {
      await loc.release();
    }
  }

  /**
   * The refusals of a render of `instances` in `tag` before anything is queued (as `startLocalized`): an instance with no
   * translation (409 `localization-missing`) and, without `force`, a translation with open problems or outdated entries
   * (409 `localization-needs-force`, `problems` listing them).
   */
  private async checkLocalized(ref: CreativeRef, version: VersionEntry, instances: readonly string[], tag: LocaleTag, force: boolean, locale: Locale): Promise<void> {
    const v = messages(locale).variants;
    const presets = await this.deps.presets();
    const label = (id: string) => `${formatDisplayName(presets, id, locale)} (${tag})`;
    const creativeDir = new CreativeStore(ref.projectDir).dir(ref.creativeSlug);
    const comps = version.compositions ?? [];
    const missing: string[] = [];
    const needsForce: string[] = [];
    for (const id of instances) {
      const found = version.localizations?.find((r) => r.locale === tag && r.instanceId === id);
      const read = found ? await readOverlay(creativeDir, version.n, tag, id) : null;
      if (!found || !read || read.hash !== found.hash) { missing.push(label(id)); continue; }
      const dir = comps.find((c) => c.format === id)?.dir;
      const row = dir ? await this.reverifyAssets(ref, version.n, found, read.overlay, join(creativeDir, 'outputs', `v${version.n}`, ...dir.split('/'))) : found;
      if ((row.problems?.length ?? 0) > 0 || row.stale.length > 0) needsForce.push(label(id));
    }
    const refuse = (list: string[], text: (p: { list: string }) => string, code: string) => {
      const err = new CodedError(409, text({ list: list.slice(0, 10).join(', ') }), code);
      err.problems = list.slice(0, 50);
      throw err;
    };
    if (missing.length > 0) refuse(missing, v.localizationMissing, 'localization-missing');
    if (needsForce.length > 0 && !force) refuse(needsForce, v.renderNeedsForce, 'localization-needs-force');
  }

  /**
   * The private copy a localized render is made from (Phase 12; shared by the export renders of a localized video, subtitles
   * Task 27): the instance's composition (re-hashed, still the recorded one) with its overlay applied (`localizedComposition`,
   * stale ids keep the source), its folder's files (verified against the recorded hash), the overlay's fallback font files and
   * its translated voices, in `<project>/.studio/cache/locale-render/`. A voice or font file changed since the core recorded it
   * is a problem of the language (recorded on the row) and refuses the render. `release` removes the copy.
   */
  private async localizedFolder(ref: CreativeRef, n: number, instanceId: string, tag: LocaleTag, force: boolean, presets: FormatPreset[], locale: Locale) {
    const m = messages(locale);
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(ref.creativeSlug);
    const version = (await store.readVersions(ref.creativeSlug)).find((x) => x.n === n);
    const row = version?.localizations?.find((r) => r.locale === tag && r.instanceId === instanceId);
    const read = row ? await readOverlay(creativeDir, n, tag, instanceId) : null;
    if (!version || !row || !read || read.hash !== row.hash) throw new Error(m.variants.localizationNotFound({ locale: tag, format: instanceId, n }));
    const ic = await instanceComposition(creativeDir, version, instanceId, presets);
    if (!ic) throw new Error(m.render.compositionChanged({ format: instanceId }));
    const used = overlayAssetPaths(read.overlay, row);
    row.problems = (await this.reverifyAssets(ref, n, row, read.overlay, ic.compDir)).problems;
    const forced = (row.problems?.length ?? 0) > 0 || row.stale.length > 0;
    if (forced && !force) throw new Error(m.variants.renderNeedsForce({ list: `${instanceId} (${tag})` }));
    const composition = localizedComposition(ic.composition, read.overlay, row);
    if (!composition) throw new Error(m.variants.localizationUnusable({ locale: tag, format: instanceId }));
    const preset = findPreset(presets, instanceId) ?? { ...ic.preset, id: instanceId };
    const cache = await realDirChain(ref.projectDir, ['.studio', 'cache', 'locale-render']);
    if (!cache) throw new Error(m.render.compositionChanged({ format: instanceId }));
    const root = join(cache, `r-${randomBytes(8).toString('hex')}`);
    const compDir = join(root, 'outputs', `v${n}`, 'compositions', instanceId);
    activeLocaleRenders.add(root);
    const release = async () => {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      activeLocaleRenders.delete(root);
    };
    try {
      await mkdir(compDir, { recursive: true });
      for (const f of ic.folder.files) {
        await mkdir(dirname(join(compDir, ...f.path.split('/'))), { recursive: true });
        await copyConfinedFile(ic.compDir, f.path, join(compDir, ...f.path.split('/')));
      }
      if ((await readCompositionFolder(compDir)).hash !== ic.entry.hash) throw new Error(m.render.compositionChanged({ format: instanceId }));
      const have = new Set(ic.folder.files.map((f) => f.path));
      for (const font of read.overlay.fonts) {
        for (const p of font.files) {
          if (have.has(p)) continue;
          await mkdir(dirname(join(compDir, ...p.split('/'))), { recursive: true });
          await copyConfinedFile(ref.projectDir, p, join(compDir, ...p.split('/')));
          have.add(p);
        }
      }
      // The translated voices the core generated are project assets (Task 4, `voiceRootsOf`): copied in too, unless the
      // composition folder has that path (it wins, as in the checks). Stale or unused voices are not needed.
      if (row.voice === 'translated') {
        for (const [id, v] of Object.entries(read.overlay.voices)) {
          if (have.has(v.src) || row.stale.includes(id)) continue;
          if (!(await voiceFileOk([ref.projectDir], v.src))) throw new Error(m.variants.voiceFileInvalid({ clip: clipLabel(ic.composition, id) }));
          await mkdir(dirname(join(compDir, ...v.src.split('/'))), { recursive: true });
          await copyConfinedFile(ref.projectDir, v.src, join(compDir, ...v.src.split('/')));
          have.add(v.src);
        }
      }
      // Ruling L: every voice and font file the core wrote or attached must still be the one it recorded, checked on the very
      // file this render uses (the private copy). A changed file is a problem of the language, never rendered silently.
      const changed = await changedAssets([compDir], row, used);
      if (changed.length > 0) {
        const texts = changed.map((file) => m.variants.assetChanged({ file }));
        const found: LocalizationIssue[] = changed.map((file, i) => {
          const clipId = Object.entries(read.overlay.voices).find(([, v]) => v.src === file)?.[0];
          return { code: 'assetChanged', message: texts[i]!, ...(clipId !== undefined ? { clipId } : {}) };
        });
        await store.updateVersion(ref.creativeSlug, n, (x) => ({
          ...x, localizations: (x.localizations ?? []).map((r) => (r.locale !== tag || r.instanceId !== instanceId ? r : withIssues(r, found))),
        }));
        this.deps.broadcast({ type: 'creative', project: ref.projectSlug, creative: ref.creativeSlug });
        throw new Error(texts.join('; '));
      }
    } catch (e) {
      await release();
      throw e;
    }
    return { root, compDir, composition, preset, ic, row, read, forced, version, release };
  }

  /**
   * The subtitles a render of version `n` draws (subtitles Task 18, spec §6.1 "Versions", U8). For a composition without a
   * visible subtitles track nothing is read, committed or recorded (null: anti-goal 4). Otherwise the user's pending subtitle
   * commits are flushed first (review M4: only renders that draw subtitles wait for them), the language is the default pairing
   * (`defaultSubtitleLang`: a localized render's own, else the brief's primary or the speech's) and the set is staged clamped to
   * the composition and, with `snapshot`, kept next to the output first (`writeSubtitleSnapshot`). No set: `data` null and the
   * record a marker (`hash: null`, the language looked for), so the render turns stale once a set appears (review I1).
   */
  private async subtitlesFor(ref: CreativeRef, n: number, composition: Composition, o: { snapshot: boolean; localized?: LocaleTag }):
    Promise<{ data: NonNullable<RenderCompositionOptions['subtitles']> | null; record: RenderedSubtitles } | null> {
    if (!drawsSubtitles(composition)) return null;
    await this.deps.subtitleCommits?.flush(ref);
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(ref.creativeSlug);
    // A localized render looks for its own language only (the marker names it when there is no set yet).
    const lang = o.localized ?? await defaultSubtitleLang(creativeDir, (await store.get(ref.creativeSlug)).brief);
    const staged = await stageSubtitles({ creativeDir, composition, lang, durationMs: Math.round(composition.duration * 1000) });
    // No set: a marker. With no language at all, the languages present are kept, so a render made again with the same sets is
    // current and one that could now pair them is not (review round 2).
    if (!staged) return { data: null, record: lang !== null ? { lang, hash: null } : { lang, hash: null, seen: Object.keys(await subtitleHashes(creativeDir)).sort() as LocaleTag[] } };
    if (o.snapshot) await writeSubtitleSnapshot(creativeDir, n, staged.set, staged.hash);
    return { data: staged.data, record: { lang: staged.set.lang, hash: staged.hash } };
  }

  /** Records renders in versions.json (outputs) and the manifest v2 (`renders[]`), and the followers' `followsFormat`. */
  private async record(store: CreativeStore, ref: CreativeRef, n: number, infos: OutputFileInfo[], fixFollows: Record<string, string>, comps: VersionComposition[]): Promise<void> {
    const fixed = (list: VersionComposition[]) => list.map((c) => (fixFollows[c.format] && !c.followsFormat ? { ...c, followsFormat: fixFollows[c.format] } : c));
    const formats = new Set(infos.map((i) => i.format));
    const updated = await store.updateVersion(ref.creativeSlug, n, (v) => ({
      ...v,
      outputs: [...v.outputs.filter((o) => !formats.has(o.format)), ...infos],
      ...(v.compositions ? { compositions: fixed(v.compositions) } : {}),
    }));
    const at = new Date().toISOString();
    // Read, changed and written under the manifest's lock, shared with `reconcileRenders` (T5a(1)).
    await updateVersionManifest(store.dir(ref.creativeSlug), n, (current) => {
      const base: ManifestV2 = current?.schemaVersion === 2 ? current : { schemaVersion: 2, compositions: updated.compositions ?? comps, renders: [] };
      return {
        schemaVersion: 2,
        compositions: fixed(base.compositions),
        renders: [
          ...base.renders.filter((r) => !formats.has(r.format) || r.locale !== undefined),
          ...infos.filter((i) => i.sha256 !== undefined).map((i) => ({
            format: i.format, file: i.file, width: i.width, height: i.height,
            durationSec: i.durationSec !== null && i.durationSec > 0 ? i.durationSec : null,
            sha256: i.sha256!, renderedAt: at, ...(i.fromComposition ? { fromComposition: i.fromComposition } : {}), ...(i.render ? { render: i.render } : {}),
            ...(i.subtitles ? { subtitles: i.subtitles } : {}),
          })),
        ],
      };
    });
    await noteRenderStamps(ref.projectDir, store.dir(ref.creativeSlug), ref.creativeSlug, n, infos).catch(() => {});
  }
}

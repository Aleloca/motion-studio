import { renderJobKey } from '@motion-studio/shared';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  compositionProblemText, effectiveLinks, formatDisplayName, messages, renderProblems, renderState,
  type Brief, type Composition, type FormatPreset, type JobProgress, type JobSummary, type Locale, type LocaleTag, type Localization, type LocalizationIssue, type LocalizationRow, type ManifestV2, type OutputFileInfo,
  type OutputIssue, type ServerMessage, type VersionComposition, type VersionEntry,
} from '@motion-studio/shared';
import { copyConfinedFile, hashConfinedFile } from '../brand/agent-guard.ts';
import { loadComposition, readCompositionFolder } from '../compositions/composition-files.ts';
import { withIssues, withoutIssues } from '../localization/issues.ts';
import { changedAssets, instanceComposition, isAssetChangedProblem, localizedComposition, overlayAssetPaths, readOverlay } from '../localization/store.ts';
import { checkedLocale, clipLabel, voiceFileOk } from '../localization/validate.ts';
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
import { storeRenderOptions } from '../store-pack/flatten.ts';
import type { RenderCompositionOptions, RenderEngine, RenderResult } from '../render/renderer.ts';
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
  async start(ref: CreativeRef, n: number, requested?: string[], opts: { locales?: readonly string[]; force?: boolean } = {}): Promise<JobSummary> {
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
    if (opts.locales && opts.locales.length > 0) return this.startLocalized(ref, version, creative.title, requested, opts.locales, opts.force === true, locale);
    if (!this.deps.engine) throw new CodedError(503, m.render.noRenderer, 'no-renderer');
    if ((await this.deps.engine.info()).kind === null) throw new CodedError(409, m.render.noBrowser, 'no-browser');
    // From here to the enqueue nothing awaits: the active jobs seen are the ones the new job queues behind.
    const base = renderJobKey(ref.root, ref.projectSlug, ref.creativeSlug, n);
    const active = this.activeJobs(base);
    const covered = new Set(active.flatMap((j) => j.formats ?? []));
    const wanted = [...full.primaries, ...Object.keys(full.followers)];
    const missing = wanted.filter((f) => !covered.has(f));
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
        if (asked.has(p) || renderState(version, p) !== 'rendered' || renderProblems(version, p).length > 0) continue;
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
  async ensureJob(ref: CreativeRef, n: number, formats: string[], _o: { wait?: boolean } = {}): Promise<{ job: JobSummary; covers: boolean }> {
    const job = await this.start(ref, n, formats);
    return { job, covers: true };
  }

  /** Renders `formats` of each version (`ensureJob`, waiting for a job that covers other formats) and waits; the summaries as they ended. */
  async renderAndWait(ref: CreativeRef, pending: ReadonlyMap<number, string[]>): Promise<JobSummary[]> {
    const jobs = await Promise.all([...pending].map(async ([n, formats]) => (await this.ensureJob(ref, n, formats)).job));
    // Every active job of those versions (a follow-up runs after the jobs it queued behind; wait for them all).
    const all = new Map(jobs.map((j) => [j.id, j]));
    for (const [n] of pending) for (const j of this.activeJobs(renderJobKey(ref.root, ref.projectSlug, ref.creativeSlug, n))) all.set(j.id, j);
    const ended = await Promise.all([...all.values()].map((j) => this.deps.queue.whenSettled(j.id)));
    return ended.filter((j): j is JobSummary => j !== null);
  }

  /** Renders `formats` of version `n` in `locales` (`start` with locales) and waits for the job; its summary as it ended. */
  async renderLocalesAndWait(ref: CreativeRef, n: number, formats: string[], locales: readonly string[], force: boolean): Promise<JobSummary | null> {
    const job = await this.start(ref, n, formats, { locales, force });
    return this.deps.queue.whenSettled(job.id);
  }

  private async run(ref: CreativeRef, n: number, plan: RenderPlan, comps: VersionComposition[], locale: Locale, signal: AbortSignal, jobId: string): Promise<void> {
    const m = messages(locale);
    const presets = await this.deps.presets();
    const label = (id: string) => formatDisplayName(presets, id, locale);
    const store = new CreativeStore(ref.projectDir);
    const notes: string[] = [];
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
          await this.renderFormat({ ref, n, format, followers, plan, comps, presets, locale, signal, progress, note, label });
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
    signal: AbortSignal; progress: (p: JobProgress) => void; note: (text: string) => Promise<void>; label: (id: string) => string;
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
    const composition = loaded.composition;
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
        onProgress: (p) => o.progress({ format, phase: 'frames', done: p.frames, total: p.total }),
        // The stamp is noted before the rename (M1): a turn's check in between sees the core's own write.
        beforeRename: (temp) => noteCoreOutputWrite(creativeDir, `outputs/v${n}/${file}`, temp),
      });
    } finally {
      prepared.release();
    }
    // From here the new file is in place: the record is always written, with what is on disk (I3), whatever happens next
    // (a cancel waits for these few steps; a failing follower is left out and reported). First the primary alone, at once,
    // with the renderer's own hash (a crash during the steps below then leaves a true record), then everything.
    const bare: OutputFileInfo = { format, file, width: result.width, height: result.height, durationSec: result.durationSec, verified: false, preview: null, sha256: result.sha256, problems: [], fromComposition: loaded.hash };
    const infos: OutputFileInfo[] = [];
    let failure: unknown = null;
    // A failing first record must not skip the checks, the follower copies and the final record below (C10).
    await this.record(store, ref, n, [bare], o.plan.fixFollows, o.comps).catch((e: unknown) => { failure = e; });
    try {
      o.progress({ format, phase: 'finishing', done: 0, total: 1 + o.followers.length });
      await noteCoreChange(versionDir);
      if (result.warnings.length > 0) await o.note(m.render.frameWarnings({ format: o.label(format), count: result.warnings.length })).catch(() => {});
      const info = await this.describe({ creativeDir, versionDir, n, preset, file, composition, sha256: result.sha256, hash: loaded.hash, locale: o.locale, poster: true })
        .catch((e: unknown) => {
          failure = e;
          return bare;
        });
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
      return { ...rest, verified: own.verified && sha256 !== undefined, preview, problems, ...(issues.length ? { issues } : {}), ...(base.sha256 ? { sha256: base.sha256 } : {}), ...(fromComposition ? { fromComposition } : {}) };
    } catch {
      return base;
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
    const large = largeFileWarning(preset, file.slice(file.lastIndexOf('.') + 1), st.size, durationSec, o.composition.fps);
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
      run: async (signal) => {
        const failures: string[] = [];
        for (const it of items) {
          if (signal.aborted) throw new RenderError('cancelled', 'cancelled');
          try {
            await this.renderLocalized(ref, version.n, it.id, it.tag, force, presets, locale, signal);
          } catch (e) {
            if (signal.aborted || (e instanceof RenderError && e.code === 'cancelled')) throw e;
            failures.push(m.render.formatFailed({ format: label(it.id, it.tag), reason: errorText(e) }));
          }
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
  private async renderLocalized(ref: CreativeRef, n: number, instanceId: string, tag: LocaleTag, force: boolean, presets: FormatPreset[], locale: Locale, signal: AbortSignal): Promise<void> {
    const m = messages(locale);
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(ref.creativeSlug);
    const versionDir = store.outputsDir(ref.creativeSlug, n);
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
      const prepared = await this.deps.normalizer.prepare({ projectDir: ref.projectDir, compDir, composition, signal });
      const still = !(composition.duration > 0);
      const file = `${instanceId}.${tag}.${renderExtension(preset, still)}`;
      let result: RenderResult;
      try {
        result = await this.deps.engine!.render({
          ...this.deps.renderOptions,
          dir: root, versionDir: `outputs/v${n}`, composition, format: { ...preset, id: instanceId }, out: join(versionDir, file), signal,
          ...storeRenderOptions(instanceId, composition),
          ...(sessionMediaOf(prepared) ? { media: sessionMediaOf(prepared)! } : {}),
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
      // A translated clip whose SOURCE already overflows (noted when the translation was judged, fix round 1 N1) keeps its note:
      // the source-relative estimate judged the translation itself. Any other translated clip that overflows is a problem.
      const sourceNoted = new Set((row.issues ?? []).filter((i) => i.code === 'sourceTextOverflow' && i.clipId !== undefined && translated(i.clipId)).map((i) => i.clipId!));
      const measured = (result.textOverflows ?? []).filter((e) => e.clipId !== undefined).map((e) => e.clipId!);
      const overflowIssues: LocalizationIssue[] = [...new Set([...measured, ...sourceNoted])].map((id): LocalizationIssue => (translated(id) && !sourceNoted.has(id)
        ? { code: 'textOverflowMeasured', clipId: id, message: m.variants.textOverflowMeasured({ clip: clipLabel(ic.composition, id), fit: Math.round((read.overlay.fit[id] ?? 1) * 100) }) }
        : { code: 'sourceTextOverflow', clipId: id, message: m.variants.sourceTextOverflow({ clip: clipLabel(ic.composition, id) }) }));
      const overflows = overflowIssues.filter((i) => i.code === 'textOverflowMeasured').map((i) => i.message);
      const problems = [...new Set([...(info.problems ?? []), ...overflows])];
      const at = new Date().toISOString();
      const render: NonNullable<LocalizationRow['render']> = {
        file, width: info.width, height: info.height, durationSec: info.durationSec !== null && info.durationSec > 0 ? info.durationSec : null,
        sha256: result.sha256, fromComposition: ic.entry.hash, overlayHash: row.hash, forced, stale: [...row.stale],
        ...(problems.length ? { problems } : {}), renderedAt: at,
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
              fromComposition: render.fromComposition, locale: tag, forced, stale: render.stale },
          ],
        };
      });
      await noteRenderStamps(ref.projectDir, creativeDir, ref.creativeSlug, n, [{ file, sha256: result.sha256 }]).catch(() => {});
      this.deps.broadcast({ type: 'creative', project: ref.projectSlug, creative: ref.creativeSlug });
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      activeLocaleRenders.delete(root);
    }
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
            sha256: i.sha256!, renderedAt: at, ...(i.fromComposition ? { fromComposition: i.fromComposition } : {}),
          })),
        ],
      };
    });
    await noteRenderStamps(ref.projectDir, store.dir(ref.creativeSlug), ref.creativeSlug, n, infos).catch(() => {});
  }
}

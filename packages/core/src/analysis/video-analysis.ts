import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  assetKindOf, CHUNK_FRAMES, LONG_VIDEO_SEC, SILENCE_NO_SPEECH, TOKENS_PER_FRAME, videoAnalysisJobKey,
  type ServerMessage, type SidecarHeader, type TranscriptKind, type TranscriptSegment, type VideoAnalysisPending, type VideoAnalysisView, type VideoAnalysisWrite,
} from '@motion-studio/shared';
import type { AgentLauncher } from '../agent/launcher.ts';
import type { ProjectRef } from '../brand/brand-analysis.ts';
import { execCommand, type CommandExec } from '../exec.ts';
import type { Git } from '../git.ts';
import { currentLocale, t } from '../i18n.ts';
import { JobFailedError, type JobQueue } from '../jobs/job-queue.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { assertAgentFolders } from '../workspace-store.ts';
import { buildAnalysisPrompt } from './analysis-prompt.ts';
import { extractWav, silenceRatio } from './audio.ts';
import { detectScenes, extractFrames, planFrames } from './frames.ts';
import { frameName, framesDirOf, mergeTranscript, readSidecar, renderSidecar, sidecarPathOf, writeSidecar, type SidecarScene } from './sidecar.ts';
import { hashVideo } from './video-hash.ts';

export type { ProjectRef };

/** The queue lane of the analyses (spec §5): they never take an agent turn's slot, so a turn can wait for them. */
export const ANALYSIS_LANE = 'video-analysis';

/**
 * Phase 2's transcription, behind one call: given the extracted audio, what was said (or why nothing is). Absent (Phase 1):
 * every video with speech gets `none-skipped`.
 */
export interface Transcriber {
  transcribe(i: { ref: ProjectRef; file: string; jobId: string; wav: string; durationSec: number; signal: AbortSignal }): Promise<{ kind: TranscriptKind; segments: TranscriptSegment[]; language: string | null }>;
}

export interface VideoAnalysisDeps {
  queue: JobQueue;
  launcher: AgentLauncher;
  media: MediaTools;
  /** The ffmpeg runner (scene detection, frames, audio); default: the system's. Test seam. */
  ffExec?: CommandExec;
  git: Git;
  broadcast(m: ServerMessage): void;
  model(): Promise<string | null | undefined>;
  transcriber?: Transcriber;
}

/** An analysis queued or running: one per content (sha256) and project; every file with that content waits for it. */
interface Active {
  ref: ProjectRef; sha: string; jobId: string; files: string[];
  density: 'full' | 'reduced' | null;
  /** What the held job asks the user (a long video); null: not held. */
  pending: VideoAnalysisPending | null;
  overwrite: boolean;
  /** Already queued again once because the video changed during an analysis. */
  retried: boolean;
}

const fileKey = (ref: ProjectRef, file: string) => `${ref.root}\0${ref.projectSlug}\0${file}`;
const shaKey = (ref: ProjectRef, sha: string) => videoAnalysisJobKey(ref.root, ref.projectSlug, sha);
const isVideoAsset = (file: string) => file.startsWith('assets/') && !file.startsWith('assets/.') && assetKindOf(file) === 'video';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const abortedError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/**
 * Decision 1468 (spec §5): the analysis of the videos that enter a brief. One queue per project, one analysis at a time
 * (the `video-analysis` lane, a slot group per project: decision 1481), deduplicated by content. For each video, without the
 * agent: scene cuts, frames into `.studio/cache/analysis/<sha>/`, audio and its silence; then the `video-analysis` agent in
 * chunks of 40 frames and a final pass; then the core renders the sidecar, commits it and says so. A failure is recorded on
 * the video and never thrown into a creative.
 */
export class VideoAnalysisService {
  private readonly active = new Map<string, Active>();
  /** The last failure per video and the content it was about (cleared when it is analysed again). */
  private readonly failures = new Map<string, { message: string; sha: string }>();
  private readonly ff: CommandExec;
  /** Told of every change of an analysis (the first turns' waits check again). */
  private readonly listeners = new Set<() => void>();
  /** The first turns waiting now, by project and creative: their files and how to end the wait (Salta). */
  private readonly waits = new Map<string, { files: string[]; skip: () => void }>();

  constructor(private readonly deps: VideoAnalysisDeps) {
    this.ff = deps.ffExec ?? execCommand;
  }

  /** Whether an analysis can run at all: ffmpeg and the `studio` tools (the agent writes through them). */
  canAnalyse(): boolean { return this.deps.media.available && this.deps.launcher.mcpActive(); }

  private activeOf(ref: ProjectRef, file: string): Active | null {
    for (const a of this.active.values()) if (a.ref.root === ref.root && a.ref.projectSlug === ref.projectSlug && a.files.includes(file)) return a;
    return null;
  }

  private jobState(jobId: string): 'queued' | 'running' | null {
    const j = this.deps.queue.list().find((x) => x.id === jobId);
    return j?.state === 'queued' || j?.state === 'running' ? j.state : null;
  }

  /**
   * The videos among `files` (`assets/…`; anything else is ignored) are analysed unless a fresh sidecar exists (spec §5). A
   * stale sidecar the user edited is left for the user (decision 1494) unless `overwrite`. Returns their views.
   */
  async ensure(ref: ProjectRef, files: readonly string[], o: { from?: 'brief' | 'library'; overwrite?: boolean; retried?: boolean } = {}): Promise<VideoAnalysisView[]> {
    const out: VideoAnalysisView[] = [];
    for (const file of [...new Set(files)].filter(isVideoAsset)) {
      try { out.push(await this.ensureOne(ref, file, o)); }
      catch (err) { out.push(this.errorView(file, errText(err))); }
    }
    return out;
  }

  private async ensureOne(ref: ProjectRef, file: string, o: { from?: 'brief' | 'library'; overwrite?: boolean; retried?: boolean }): Promise<VideoAnalysisView> {
    const running = this.activeOf(ref, file);
    if (running && !o.overwrite) return this.view(ref, file);
    const abs = join(ref.projectDir, file);
    const hash = await hashVideo(abs).catch(() => null);
    if (!hash) return this.errorView(file, t().errors.analysisGone);
    const sidecar = await readSidecar(ref.projectDir, file);
    const fresh = sidecar?.header.sha256 === hash.sha256;
    if (sidecar && !o.overwrite && (fresh || sidecar.header.edited)) return this.view(ref, file);
    // A brief does not retry the content whose analysis just failed (the library's Analizza does): a failure never loops.
    if (o.from === 'brief' && this.failures.get(fileKey(ref, file))?.sha === hash.sha256) return this.view(ref, file);
    if (!this.canAnalyse()) return this.view(ref, file);
    const join_ = async (same: Active) => {
      if (!same.files.includes(file)) same.files.push(file);
      same.overwrite ||= o.overwrite === true;
      const v = await this.view(ref, file);
      this.say(ref, file, v);
      return v;
    };
    const same = this.active.get(shaKey(ref, hash.sha256));
    if (same) return join_(same);
    const info = await this.deps.media.probe(abs).catch(() => null);
    // Two triggers at once (a creative made and its first turn): the one that queued first is joined.
    const meanwhile = this.active.get(shaKey(ref, hash.sha256));
    if (meanwhile) return join_(meanwhile);
    const duration = info?.durationSec ?? 0;
    const long = duration > LONG_VIDEO_SEC;
    const pending: VideoAnalysisPending | null = long ? (() => {
      // Before the scene detection only the time-based frames are known: the estimate counts those (decision 1491).
      const frames = planFrames([], duration, 'full').length, reducedFrames = planFrames([], duration, 'reduced').length;
      return { kind: 'long', frames, reducedFrames, tokens: frames * TOKENS_PER_FRAME, reducedTokens: reducedFrames * TOKENS_PER_FRAME };
    })() : null;
    const entry: Active = { ref, sha: hash.sha256, jobId: '', files: [file], density: long ? null : 'full', pending, overwrite: o.overwrite === true, retried: o.retried === true };
    this.failures.delete(fileKey(ref, file));
    const job = this.deps.queue.enqueue({
      key: shaKey(ref, hash.sha256), kind: 'video-analysis', label: t().jobs.videoAnalysisLabel({ file: basename(file) }),
      lane: ANALYSIS_LANE, slot: { group: `video-analysis:${ref.root}:${ref.projectSlug}`, limit: 1, reason: 'video-queue' },
      ...(long ? { hold: 'video-long' as const } : {}),
      run: (signal, jobId) => this.run(entry, signal, jobId),
      onCancelledBeforeStart: () => { this.forget(entry); },
    });
    entry.jobId = job.id;
    this.active.set(shaKey(ref, hash.sha256), entry);
    void this.deps.queue.whenSettled(job.id).then(() => this.forget(entry));
    const v = await this.view(ref, file);
    this.say(ref, file, v);
    return v;
  }

  private forget(entry: Active): void {
    const k = shaKey(entry.ref, entry.sha);
    if (this.active.get(k) !== entry) return;
    this.active.delete(k);
    for (const f of entry.files) void this.view(entry.ref, f).then((v) => this.say(entry.ref, f, v), () => {});
  }

  /** A long video's analysis goes ahead with the density the user chose (decision 1487). */
  async confirmLong(ref: ProjectRef, file: string, density: 'full' | 'reduced'): Promise<VideoAnalysisView> {
    const a = this.activeOf(ref, file);
    if (a?.pending?.kind === 'long') {
      a.density = density;
      a.pending = null;
      this.deps.queue.setHold(a.jobId, null);
    }
    const v = await this.view(ref, file);
    this.say(ref, file, v);
    return v;
  }

  /**
   * Stops the analysis of `file` (decision 1495: a rename or a delete of the video). The job is cancelled when no other file
   * with the same content waits for it; otherwise only this file leaves it (no sidecar is written for it).
   */
  cancel(ref: ProjectRef, file: string): boolean {
    const a = this.activeOf(ref, file);
    if (!a) return false;
    a.files = a.files.filter((f) => f !== file);
    if (a.files.length === 0) this.deps.queue.cancel(a.jobId);
    return true;
  }

  /** Analyses queued or running for `files` and not held for the user: what a first turn waits for (decision 1478). */
  activeFor(ref: ProjectRef, files: readonly string[]): Array<{ file: string; jobId: string }> {
    const out: Array<{ file: string; jobId: string }> = [];
    for (const file of files) {
      const a = this.activeOf(ref, file);
      if (!a || a.pending || this.jobState(a.jobId) === null) continue;
      const j = this.deps.queue.list().find((x) => x.id === a.jobId);
      if (j?.waitReason === 'video-long') continue;
      out.push({ file, jobId: a.jobId });
    }
    return out;
  }

  async settled(jobId: string): Promise<void> { await this.deps.queue.whenSettled(jobId); }

  /** The project's videos with their analyses (the library's videos). */
  async list(ref: ProjectRef, files: readonly string[]): Promise<VideoAnalysisView[]> {
    return Promise.all(files.filter(isVideoAsset).map((f) => this.view(ref, f)));
  }

  /** Where `file`'s analysis is, as the library shows it. */
  async view(ref: ProjectRef, file: string): Promise<VideoAnalysisView> {
    const a = this.activeOf(ref, file);
    const sidecar = await readSidecar(ref.projectDir, file).catch(() => null);
    const base = { file, header: sidecar?.header ?? null, body: sidecar?.body ?? null, pending: null, error: null, jobId: null };
    if (a) {
      const state = this.jobState(a.jobId);
      if (state) return { ...base, jobId: a.jobId, pending: a.pending, state: a.pending ? 'waiting' : state };
    }
    const failure = this.failures.get(fileKey(ref, file))?.message ?? null;
    if (sidecar) {
      const hash = await hashVideo(join(ref.projectDir, file)).catch(() => null);
      if (hash && hash.sha256 === sidecar.header.sha256) return { ...base, state: 'ready' };
      return { ...base, state: failure ? 'error' : 'stale', error: failure };
    }
    return { ...base, state: failure ? 'error' : 'none', error: failure };
  }

  private errorView(file: string, error: string): VideoAnalysisView {
    return { file, state: 'error', jobId: null, error, pending: null, header: null, body: null };
  }

  private say(ref: ProjectRef, file: string, view: VideoAnalysisView): void {
    try { this.deps.broadcast({ type: 'video-analysis', project: ref.projectSlug, file, view }); } catch { /* a faulty listener must not stop an analysis */ }
    for (const l of [...this.listeners]) l();
  }

  /** Decision 1468: the videos among `files` with a fresh analysis file (asset → its analysis file), what the prompts annotate. */
  async analysisRefs(ref: ProjectRef, files: readonly string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const file of [...new Set(files)].filter(isVideoAsset)) {
      const sidecar = await readSidecar(ref.projectDir, file).catch(() => null);
      if (!sidecar) continue;
      const hash = await hashVideo(join(ref.projectDir, file)).catch(() => null);
      if (hash?.sha256 === sidecar.header.sha256) out[file] = sidecarPathOf(file);
    }
    return out;
  }

  private waitKey = (ref: ProjectRef, creativeSlug: string) => `${ref.root}\0${ref.projectSlug}\0${creativeSlug}`;

  /**
   * Decision 1478: a creative's first turn waits for the analyses of its brief's videos (queued or running, never a held one:
   * a long video waiting for the user's confirmation does not hold a turn). While it waits, `note` writes the chat line and
   * `analysis-wait` says which videos; `skip` (Salta) ends the wait at once. A failed analysis ends it too (the agent then
   * gets the plain path). `aborted`: the turn was cancelled meanwhile.
   */
  async waitForBrief(ref: ProjectRef, creativeSlug: string, files: readonly string[], signal: AbortSignal, o: { note(e: { text: string; analysisWait?: { files: string[] } }): Promise<void> }): Promise<'none' | 'done' | 'skipped' | 'aborted'> {
    // Queued here too when no trigger did (the brief of an older creative): a no-op for fresh, active or failed ones.
    await this.ensure(ref, files, { from: 'brief' }).catch(() => []);
    if (this.activeFor(ref, files).length === 0 || signal.aborted) return signal.aborted ? 'aborted' : 'none';
    const names = [...new Set(this.activeFor(ref, files).map((a) => basename(a.file)))];
    const key = this.waitKey(ref, creativeSlug);
    const tell = (list: string[]) => { try { this.deps.broadcast({ type: 'analysis-wait', project: ref.projectSlug, creative: creativeSlug, files: list }); } catch { /* listener */ } };
    await o.note({ text: t().videoAnalysis.waiting({ files: names.join(', ') }), analysisWait: { files: names } }).catch(() => {});
    tell(names);
    let end!: (r: 'done' | 'skipped' | 'aborted') => void;
    const outcome = new Promise<'done' | 'skipped' | 'aborted'>((r) => { end = r; });
    const check = () => { if (this.activeFor(ref, files).length === 0) end('done'); };
    const onAbort = () => end('aborted');
    this.listeners.add(check);
    this.waits.set(key, { files: names, skip: () => end('skipped') });
    signal.addEventListener('abort', onAbort, { once: true });
    for (const a of this.activeFor(ref, files)) void this.settled(a.jobId).then(check);
    check();
    const r = await outcome;
    this.listeners.delete(check);
    if (this.waits.get(key)?.files === names) this.waits.delete(key);
    signal.removeEventListener('abort', onAbort);
    tell([]);
    if (r === 'skipped') await o.note({ text: t().videoAnalysis.skipped({ files: names.join(', ') }) }).catch(() => {});
    return r;
  }

  /** Salta: the creative's first turn stops waiting; false when it waits for nothing. */
  skip(ref: ProjectRef, creativeSlug: string): boolean {
    const w = this.waits.get(this.waitKey(ref, creativeSlug));
    if (!w) return false;
    w.skip();
    return true;
  }

  /** The videos a creative's first turn waits for now (names; empty: none). */
  waitingFiles(ref: ProjectRef, creativeSlug: string): string[] {
    return [...(this.waits.get(this.waitKey(ref, creativeSlug))?.files ?? [])];
  }

  private async run(entry: Active, signal: AbortSignal, jobId: string): Promise<void | 'cancelled'> {
    const { ref } = entry;
    const primary = entry.files[0];
    if (!primary) return 'cancelled';
    for (const f of entry.files) this.say(ref, f, await this.view(ref, f));
    let tmp: string | null = null;
    try {
      await assertAgentFolders(ref.projectDir, ref.root);
      const abs = join(ref.projectDir, primary);
      const before = await hashVideo(abs).catch(() => null);
      if (!before) throw new Error(t().errors.analysisGone);
      if (before.sha256 !== entry.sha) { await this.again(entry, primary); throw new Error(t().errors.analysisChanged); }
      const info = await this.deps.media.probe(abs);
      if (!info || info.durationSec === null) throw new Error(t().errors.analysisNotVideo);
      const duration = info.durationSec;
      const framesRel = framesDirOf(entry.sha);
      const framesDir = join(ref.projectDir, framesRel);
      const cuts = await detectScenes(this.ff, abs, duration, signal);
      const times = planFrames(cuts, duration, entry.density ?? 'full');
      // Frames already in the cache (an earlier analysis of the same content) are not extracted again.
      const missing: number[] = [];
      for (const at of times) if (!((await lstat(join(framesDir, frameName(at))).catch(() => null))?.isFile())) missing.push(at);
      await extractFrames(this.ff, abs, missing, framesDir, signal);
      const frames: Array<{ name: string; at: number }> = [];
      for (const at of times) if ((await lstat(join(framesDir, frameName(at))).catch(() => null))?.isFile()) frames.push({ name: frameName(at), at });
      if (frames.length === 0) throw new Error('no frame could be extracted');
      if (signal.aborted) return 'cancelled';

      let transcript: TranscriptSegment[] = [];
      let kind: TranscriptKind = 'none-no-speech';
      let language: string | null = null;
      if (info.audio) {
        tmp = await mkdtemp(join(tmpdir(), 'ms-analysis-'));
        const wav = join(tmp, 'audio.wav');
        if (await extractWav(this.ff, abs, wav, signal, duration)) {
          if ((await silenceRatio(this.ff, wav, duration, signal)) >= SILENCE_NO_SPEECH) kind = 'none-no-speech';
          else if (this.deps.transcriber) {
            const tr = await this.deps.transcriber.transcribe({ ref, file: primary, jobId, wav, durationSec: duration, signal });
            ({ kind, language } = tr);
            transcript = tr.segments;
          } else kind = 'none-skipped';
        } else kind = 'none-skipped';
      }
      if (signal.aborted) return 'cancelled';

      const model = (await this.deps.model().catch(() => null)) ?? undefined;
      const meta = { durationSec: duration, width: info.width, height: info.height, fps: info.fps ?? null, hasAudio: info.audio === true };
      const note = transcript.length ? null : kind === 'none-skipped' ? 'none-skipped' as const : 'none-no-speech' as const;
      const common = { ref, entry, jobId, signal, framesDir, model, meta, transcript, note, file: primary };
      let content: { timeline: SidecarScene[]; final: VideoAnalysisWrite };
      if (frames.length <= CHUNK_FRAMES) {
        const w = await this.agentRun({ ...common, pass: 'whole', from: 0, to: duration, frames });
        content = { timeline: mergeTranscript((w.timeline ?? []).map((s) => ({ ...s, onScreenText: s.onScreenText ?? [] })), transcript), final: w };
      } else {
        const count = Math.ceil(frames.length / CHUNK_FRAMES);
        const scenes: SidecarScene[] = [];
        for (let k = 0; k < count; k++) {
          const part = frames.slice(k * CHUNK_FRAMES, (k + 1) * CHUNK_FRAMES);
          const from = part[0]!.at, to = frames[(k + 1) * CHUNK_FRAMES]?.at ?? duration;
          const w = await this.agentRun({ ...common, pass: 'chunk', from, to, frames: part, span: { from, to, index: k, count } });
          scenes.push(...(w.timeline ?? []).map((s) => ({ ...s, onScreenText: s.onScreenText ?? [], speech: [] })));
        }
        const timeline = mergeTranscript(scenes, transcript);
        const w = await this.agentRun({ ...common, pass: 'final', from: 0, to: duration, frames: [], timeline });
        content = { timeline, final: w };
      }
      if (signal.aborted) return 'cancelled';

      // The video may have changed (or gone) while the agent looked at it: no sidecar for content it did not see (review focus 1).
      const written: string[] = [];
      for (const file of [...entry.files]) {
        const now = await hashVideo(join(ref.projectDir, file)).catch(() => null);
        if (!now) continue;
        if (now.sha256 !== entry.sha) { await this.again(entry, file); this.failures.set(fileKey(ref, file), { message: t().errors.analysisChanged, sha: entry.sha }); continue; }
        const existing = await readSidecar(ref.projectDir, file);
        if (existing?.header.edited && !entry.overwrite && file !== primary) continue;
        const header: SidecarHeader = {
          format: 'motion-studio-video-analysis/1', asset: file, sha256: entry.sha, bytes: now.bytes, durationSec: Number(duration.toFixed(3)),
          width: info.width, height: info.height, fps: info.fps ? Number(info.fps.toFixed(3)) : null, hasAudio: info.audio === true,
          transcript: kind, language, generator: `Motion Studio · ${model ?? 'default model'}`, createdAt: new Date().toISOString(), edited: false,
        };
        await writeSidecar(ref.projectDir, file, renderSidecar(header, {
          summary: content.final.summary ?? '', timeline: content.timeline, usableMoments: content.final.usableMoments ?? [],
          look: content.final.look ?? null, transcript, tags: content.final.tags ?? [],
        }));
        this.failures.delete(fileKey(ref, file));
        written.push(file);
      }
      if (written.length === 0) throw new Error(t().errors.analysisChanged);
      await this.deps.git.commitAll(ref.projectDir, t().videoAnalysis.commit({ file: written.map((f) => basename(f)).join(', ') })).catch((err: Error) => {
        console.warn(`Motion Studio: the video analysis could not be committed in project ${ref.projectSlug}: ${err.message}`);
      });
      this.deps.broadcast({ type: 'library', project: ref.projectSlug });
    } catch (err) {
      if (signal.aborted || (err as Error).name === 'AbortError') return 'cancelled';
      const message = errText(err);
      for (const f of entry.files) if (!this.failures.has(fileKey(ref, f))) this.failures.set(fileKey(ref, f), { message, sha: entry.sha });
      throw new JobFailedError(t().videoAnalysis.failed({ file: basename(primary), reason: message }));
    } finally {
      if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** The video changed during its analysis: it is analysed again, once (review focus 1). */
  private async again(entry: Active, file: string): Promise<void> {
    if (entry.retried) return;
    entry.files = entry.files.filter((f) => f !== file);
    // After this job is forgotten (its key is free again), not now.
    void this.deps.queue.whenSettled(entry.jobId).then(() => this.ensure(entry.ref, [file], { retried: true })).catch(() => {});
  }

  /** One agent run of the analysis; its validated write, or an error (no write: `analysisNoWrite`). */
  private async agentRun(i: {
    ref: ProjectRef; entry: Active; jobId: string; signal: AbortSignal; framesDir: string; model: string | undefined; file: string;
    meta: { durationSec: number; width: number; height: number; fps: number | null; hasAudio: boolean };
    transcript: TranscriptSegment[]; note: 'none-skipped' | 'none-no-speech' | null;
    pass: 'whole' | 'chunk' | 'final'; from: number; to: number; frames: Array<{ name: string; at: number }>;
    span?: { from: number; to: number; index: number; count: number }; timeline?: SidecarScene[];
  }): Promise<VideoAnalysisWrite> {
    if (i.signal.aborted) throw abortedError();
    let written: VideoAnalysisWrite | null = null;
    const spanTranscript = i.pass === 'chunk' ? i.transcript.filter((s) => s.to > i.from && s.from < i.to) : i.transcript;
    const prompt = buildAnalysisPrompt({
      locale: currentLocale(), pass: i.pass, file: i.file, meta: i.meta, framesDir: i.framesDir, frames: i.frames, transcript: spanTranscript,
      transcriptNote: i.note, ...(i.timeline ? { timeline: i.timeline } : {}), ...(i.span ? { span: i.span } : {}),
    });
    const run = await this.deps.launcher.start({
      kind: 'video-analysis', jobId: i.jobId, projectSlug: i.ref.projectSlug, projectDir: i.ref.projectDir, creativeSlug: null,
      readDirs: [i.framesDir],
      videoAnalysisScope: {
        root: i.ref.root, projectSlug: i.ref.projectSlug, projectDir: i.ref.projectDir, file: i.file, sha256: i.entry.sha,
        pass: i.pass, from: i.from, to: i.to, frames: i.frames.map((f) => f.name), write: (w) => { written = w; },
      },
      request: { prompt, ...(i.model ? { model: i.model } : {}) },
      onEvent: (event) => { try { this.deps.broadcast({ type: 'agent', jobId: i.jobId, event }); } catch { /* listener */ } },
    });
    const onAbort = () => run.cancel();
    i.signal.addEventListener('abort', onAbort, { once: true });
    if (i.signal.aborted) run.cancel();
    const result = await run.done.finally(() => i.signal.removeEventListener('abort', onAbort));
    if (i.signal.aborted || result.status === 'cancelled') throw abortedError();
    if (result.status === 'failed' && !written) throw new Error(result.error ?? t().errors.analysisNoWrite);
    if (!written) throw new Error(t().errors.analysisNoWrite);
    return written;
  }
}

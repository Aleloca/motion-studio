import { randomUUID } from 'node:crypto';
import type { VideoAnalysisService } from '../analysis/video-analysis.ts';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  BRIEF_QUEUE_MAX, assetsFileSchema, briefJobKey, isCustomPreset, sameCustomName, type CustomFormatInput, isSessionId, type AgentEvent, type BriefContext, type BriefField, type BriefForm, type BriefMessageInput, type BriefQueued, type BriefSendResult,
  type BriefFormSaved, type BriefSessionView, type ConversationEntry, type FormatPreset, type JobSummary, type LinkedCodebase, type ServerMessage,
} from '@motion-studio/shared';
import type { AgentLauncher } from '../agent/launcher.ts';
import type { AgentRun } from '../agent/runner.ts';
import { probeConfinedFile } from '../brand/agent-guard.ts';
import type { BridgeHandler } from '../bridge/bridge-routes.ts';
import { agentCodebases, codebaseProblemText, codebaseSpellings, resolveBrandCodebase } from '../codebases.ts';
import type { CreativeSideStateStore } from '../creatives/creative-side-state.ts';
import { CreativeStore } from '../creatives/creative-store.ts';
import { resumeErrorOf } from '../creatives/creative-turns.ts';
import type { CreativeRef } from '../creatives/creative-turns.ts';
import { currentLocale, t } from '../i18n.ts';
import type { JobQueue } from '../jobs/job-queue.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { CodedError, WorkspaceError } from '../workspace-store.ts';
import { briefDigest, briefFollowUp, buildBriefPrompt, type AssetFacts } from './brief-prompt.ts';
import { readJsonFile } from '../json-file.ts';
import { isUnreadable, type BriefSessionFile, type BriefSessionStore } from './brief-session-store.ts';
import { applyFill, fillLine, listFormats, mergeClientForm, reclaimLine, sameSizeCustom, sourceFormatSize } from './brief-tools.ts';
import { assertFormatsOffered } from '../formats/format-catalog.ts';

/** The most `fill_brief` calls one brief job may make (the app actions' cap idea, decision 917). */
export const BRIEF_FILLS_PER_JOB = 30;

/** Where a brief session lives and what the agent may read (the route builds it from the workspace). */
export interface BriefProjectRef {
  root: string; projectSlug: string; projectDir: string; projectName: string;
  /** The project's own linked codebases: readable by the agent, named in the prompt as already linked. */
  projectCodebases: LinkedCodebase[];
  /** Motion Studio's config folder: never a codebase. */
  configDir: string;
}

export interface BriefSessionDeps {
  queue: JobQueue;
  launcher: AgentLauncher;
  store: BriefSessionStore;
  broadcast(m: ServerMessage): void;
  presets(): Promise<FormatPreset[]>;
  model(): Promise<string | null | undefined>;
  /** The creatives' side state (the handoff records the brief's session there, decision 1423). */
  side: CreativeSideStateStore;
  /** Report 70: adds a custom format to the catalog (`source_format`), under the catalog's lock; the preset added. */
  addFormat?(input: CustomFormatInput): Promise<FormatPreset>;
  /**
   * Round 1 (I1): the size a library file is shown at, read now (its rotation applied), for entries stored before the library
   * applied it; null when it cannot be read (the library's size is used).
   */
  probeSize?(projectDir: string, path: string, o?: { cachedOnly?: boolean }): Promise<{ width: number; height: number } | null>;
}

/** Report 70: `source_format`'s argument, an attached asset's library path. */
const sourceFormatArgs = z.object({ asset: z.string().min(1).max(1024) }).strict();

/**
 * Report 70: what the project library knows of `paths` (`assets/<file>`): kind, size, length; nothing when it cannot be read.
 * With `probeSize`, a video's or an image's size is the one read now (round 1, I1: an older entry may hold the coded size).
 */
async function libraryFacts(projectDir: string, paths: readonly string[], probeSize?: BriefSessionDeps['probeSize'], o: { cachedOnly?: boolean } = {}): Promise<Record<string, AssetFacts>> {
  if (paths.length === 0) return {};
  const assets = await readJsonFile(join(projectDir, 'assets', 'assets.json'), assetsFileSchema).then((f) => f.assets).catch(() => []);
  // Round 2 (N2): the files are read in parallel (each once per version, `shownSizeReader`).
  const facts = await Promise.all(paths.map(async (p): Promise<[string, AssetFacts] | null> => {
    const a = assets.find((x) => `assets/${x.file}` === p);
    if (!a) return null;
    const now = probeSize && (a.kind === 'video' || a.kind === 'image') ? await probeSize(projectDir, p, o).catch(() => null) : null;
    return [p, { kind: a.kind, width: now?.width ?? a.width, height: now?.height ?? a.height, durationSec: a.durationSec ?? null }];
  }));
  return Object.fromEntries(facts.filter((f): f is [string, AssetFacts] => f !== null));
}

/** A session held for Genera / Salva bozza (`claim`): no message, discard or other claim until `handOff` or `release`. */
export interface BriefClaim { ref: BriefProjectRef; sessionId: string; key: string }

/** A message the next turn carries (the one just sent, or those queued). */
interface TurnMessage { clientId: string; text: string; context: { codebases: string[]; assets: string[] }; mode?: 'queued' }
/** The run a brief job has now (null between runs): where a live message goes. */
interface Active { jobId: string; sessionId: string; run: AgentRun | null; liveInput: boolean }

const ACTIVE_STATES = new Set(['queued', 'running']);
const gone = () => new CodedError(409, t().errors.briefSessionGone, 'brief-session-gone');
const busy = () => new CodedError(409, t().errors.briefSessionBusy, 'brief-session-busy');
const isDir = async (p: string) => Boolean((await stat(p).catch(() => null))?.isDirectory());

/**
 * Decisions 1421–1422: the brief sessions. One open session per project; each user message runs (or joins) a `brief` job, a
 * read-only agent that fills the New creative form through `fill_brief`. Nothing is created here: Genera and Salva bozza
 * hand the session to the create route (Task 8: `claim` / `release` / `handOff`).
 */
export class BriefSessionService {
  /** The running brief job of each project (by job key). */
  private readonly active = new Map<string, Active>();
  /** `fill_brief` calls by job id. */
  private readonly fills = new Map<string, number>();
  /** Sessions being handed to a creative (by project job key): no message is taken meanwhile. In memory: a restart ends it. */
  readonly claims = new Set<string>();
  /**
   * Sessions half moved into a creative whose mark could not be written (session id by project job key): refused for messages and
   * moves, in memory, until a discard or a restart.
   */
  private readonly blocked = new Map<string, string>();
  /** Serialises the decisions of one project (send, drain, discard, claim). */
  readonly lock = new KeyedMutex();
  /** Decision 1469: the video analyses (set once they exist): a video added to the session is analysed. */
  videoAnalyses: VideoAnalysisService | null = null;

  constructor(readonly deps: BriefSessionDeps) {}

  key(ref: Pick<BriefProjectRef, 'root' | 'projectSlug'>): string { return briefJobKey(ref.root, ref.projectSlug); }

  /** The project's brief job while it is queued or running. */
  jobOf(ref: Pick<BriefProjectRef, 'root' | 'projectSlug'>): JobSummary | null {
    const key = this.key(ref);
    return this.deps.queue.list().find((j) => j.key === key && ACTIVE_STATES.has(j.state)) ?? null;
  }

  private toView(ref: BriefProjectRef, s: BriefSessionFile): BriefSessionView {
    return {
      id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, context: s.context, form: s.form,
      userEdited: s.userEdited, agentFields: s.agentFields, queued: s.queued, jobId: this.jobOf(ref)?.id ?? null, revision: s.revision,
      ...(s.handedOffTo ? { handedOffTo: s.handedOffTo } : {}),
    };
  }

  /** Tells the clients the session changed; `s`: the session after the change (its form revision goes with it). */
  /** Decision 1469: the session's videos (attached or in the form) are analysed, in the background. */
  private analyse(ref: Pick<BriefProjectRef, 'root' | 'projectSlug' | 'projectDir'>, s: Pick<BriefSessionFile, 'context' | 'form'>): void {
    const files = [...new Set([...s.context.assets, ...s.form.assets])];
    if (!this.videoAnalyses || files.length === 0) return;
    void this.videoAnalyses.ensure({ root: ref.root, projectSlug: ref.projectSlug, projectDir: ref.projectDir }, files, { from: 'brief' })
      .catch((err: Error) => console.warn(`Motion Studio: video analysis not queued: ${err.message}`));
  }

  private changed(ref: BriefProjectRef, s: Pick<BriefSessionFile, 'id' | 'revision'>, extra: Partial<Extract<ServerMessage, { type: 'brief-session' }>> = {}): void {
    this.deps.broadcast({ type: 'brief-session', project: ref.projectSlug, sessionId: s.id, ...(extra.ended ? {} : { revision: s.revision }), ...extra });
  }

  /**
   * The project's open session. One whose files cannot be a session is a 422 `brief-session-unreadable` from the store
   * (discard removes it); any other I/O error stays what it is.
   */
  private openSession(ref: BriefProjectRef): Promise<BriefSessionFile | null> {
    return this.deps.store.open(ref.projectDir);
  }

  private async session(ref: BriefProjectRef, id: string): Promise<BriefSessionFile> {
    const s = await this.openSession(ref);
    if (!s || s.id !== id) throw gone();
    return s;
  }

  /** The open session `id`, if it takes messages and moves (not half moved into a creative). */
  private async usable(ref: BriefProjectRef, id: string): Promise<BriefSessionFile> {
    const s = await this.session(ref, id);
    if (s.handedOffTo || this.blocked.get(this.key(ref)) === s.id) throw new CodedError(409, t().errors.briefHandedOff, 'brief-session-handed-off');
    return s;
  }

  async view(ref: BriefProjectRef): Promise<BriefSessionView | null> {
    const s = await this.openSession(ref);
    return s ? this.toView(ref, s) : null;
  }

  conversation(ref: BriefProjectRef, id: string): Promise<ConversationEntry[]> { return this.deps.store.conversation(ref.projectDir, id); }

  /** Opens the project's session with the form as the user has it (the open one when there is one). */
  async start(ref: BriefProjectRef, init: { form: BriefForm; userEdited: BriefField[] }): Promise<BriefSessionView> {
    const s = await this.deps.store.create(ref.projectDir, init);
    this.changed(ref, s);
    return this.toView(ref, s);
  }

  /**
   * The context as it will be kept: folders and assets already in the session pass as they are (a folder gone since is said
   * in the prompt, spec §8); new ones are checked (an existing folder outside the project, the workspace and the config
   * folder, without glob characters; a regular file of the project library).
   */
  private async checkContext(ref: BriefProjectRef, c: BriefContext, had: BriefContext): Promise<BriefContext> {
    const codebases: LinkedCodebase[] = [];
    for (const cb of c.codebases) {
      if (had.codebases.some((h) => h.path === cb.path)) { codebases.push(cb); continue; }
      const r = await resolveBrandCodebase(cb.path, [ref.projectDir, ref.root], { configDir: ref.configDir, others: codebases.map((x) => x.path) });
      if ('problem' in r) throw new CodedError(400, codebaseProblemText(r.problem, cb.path), 'brief-codebase-invalid');
      codebases.push({ path: r.path, ...(cb.note ? { note: cb.note } : {}) });
    }
    const unique = [...new Map(codebases.map((x) => [x.path, x])).values()];
    const assets = [...new Set(c.assets)];
    for (const a of assets) {
      if (had.assets.includes(a)) continue;
      if (a.split('/').some((p) => p === '..' || p === '.' || p === '') || (await probeConfinedFile(ref.projectDir, a).catch(() => null)) !== true) {
        throw new CodedError(400, t().errors.briefAssetNotFound({ path: a }), 'brief-asset-invalid');
      }
    }
    return { codebases: unique, assets };
  }

  async setContext(ref: BriefProjectRef, id: string, c: BriefContext): Promise<BriefSessionView> {
    const cur = await this.session(ref, id);
    const context = await this.checkContext(ref, c, cur.context);
    const s = await this.deps.store.update(ref.projectDir, id, () => ({ context }));
    this.changed(ref, s);
    this.analyse(ref, s);
    return this.toView(ref, s);
  }

  /**
   * The form as the user has it (saved, debounced, while they edit), merged by field (`mergeClientForm`, decision 1422): the
   * user's fields come from the client, the others keep the server's value. Returns the revision after the merge.
   */
  async saveForm(ref: BriefProjectRef, id: string, f: { form: BriefForm; userEdited: BriefField[]; baseRevision: number }): Promise<BriefFormSaved> {
    let changed = false;
    const presets = f.userEdited.includes('formats') ? await this.deps.presets() : null;
    const s = await this.deps.store.update(ref.projectDir, id, (cur) => {
      // Report 59: the user's formats may add only formats still offered (one deleted in another window: 400).
      if (presets) assertFormatsOffered(f.form.formats, presets, cur.form.formats);
      const m = mergeClientForm(cur, f);
      changed = m.revision !== cur.revision;
      return { form: m.form, userEdited: m.userEdited, agentFields: cur.agentFields.filter((x) => !m.userEdited.includes(x)), revision: m.revision };
    });
    if (changed) { this.changed(ref, s); this.analyse(ref, s); }
    return { ok: true, form: s.form, userEdited: s.userEdited, agentFields: s.agentFields, revision: s.revision };
  }

  async removeQueued(ref: BriefProjectRef, id: string, clientId: string): Promise<BriefSessionView> {
    const s = await this.lock.run(this.key(ref), () => this.deps.store.update(ref.projectDir, id, (cur) => ({ queued: cur.queued.filter((q) => q.clientId !== clientId) })));
    this.changed(ref, s);
    return this.toView(ref, s);
  }

  /**
   * A user message. Idle: it starts a turn (with any message a restart left queued, first). While the job works: given to
   * the running agent when the user sent it live, live input is on and it adds no folder or asset (the running process
   * cannot read what it was not started with); otherwise queued for the next turn, which starts by itself.
   */
  async send(ref: BriefProjectRef, id: string, m: BriefMessageInput): Promise<BriefSendResult> {
    const key = this.key(ref);
    const before = await this.usable(ref, id);
    const context = await this.checkContext(ref, m.context, before.context);
    return this.lock.run(key, async () => {
      if (this.claims.has(key)) throw busy();
      const cur = await this.usable(ref, id);
      const added = {
        codebases: context.codebases.map((c) => c.path).filter((p) => !cur.context.codebases.some((c) => c.path === p)),
        assets: context.assets.filter((a) => !cur.context.assets.includes(a)),
      };
      const presets = m.userEdited.includes('formats') ? await this.deps.presets() : null;
      const s = await this.deps.store.update(ref.projectDir, id, (x) => {
        if (presets) assertFormatsOffered(m.form.formats, presets, x.form.formats);
        const merged = mergeClientForm(x, m);
        return { form: merged.form, userEdited: merged.userEdited, agentFields: x.agentFields.filter((f) => !merged.userEdited.includes(f)), revision: merged.revision, context };
      });
      this.analyse(ref, s);
      const job = this.jobOf(ref);
      if (job) {
        const act = this.active.get(key);
        const adds = added.codebases.length + added.assets.length > 0;
        if (m.mode === 'live' && !adds && act?.run && act.liveInput && act.sessionId === id) {
          const analyses = await this.videoAnalyses?.analysisRefs(ref, s.context.assets).catch(() => ({})) ?? {};
          // Round 2 (N2): a live message is never held for ffprobe: only the sizes already read.
          const assetFacts = await libraryFacts(ref.projectDir, s.context.assets, this.deps.probeSize, { cachedOnly: true });
          const text = briefFollowUp({ locale: currentLocale(), form: s.form, userEdited: s.userEdited, ...(await this.readable(ref, s)), assets: s.context.assets, analyses, assetFacts, request: m.text });
          if (await act.run.send?.({ text, clientId: m.clientId }) === 'written') {
            await this.deps.store.append(ref.projectDir, id, { type: 'user', at: new Date().toISOString(), text: m.text, pins: [], attachments: [], jobId: act.jobId, mode: 'live', clientId: m.clientId, deliveredAt: new Date().toISOString() });
            this.changed(ref, s);
            return { outcome: 'delivered-pending' };
          }
        }
        const q: BriefQueued = { clientId: m.clientId, text: m.text, at: new Date().toISOString(), context: added };
        const others = s.queued.filter((y) => y.clientId !== m.clientId);
        if (others.length >= BRIEF_QUEUE_MAX) throw new CodedError(409, t().errors.briefQueueFull({ max: BRIEF_QUEUE_MAX }), 'brief-queue-full');
        const after = await this.deps.store.update(ref.projectDir, id, (x) => ({ queued: [...x.queued.filter((y) => y.clientId !== m.clientId), q] }));
        this.changed(ref, after);
        return { outcome: 'queued' };
      }
      // After a restart, messages queued for a turn that never came go first, in order.
      const messages: TurnMessage[] = [...s.queued.map((q) => ({ clientId: q.clientId, text: q.text, context: q.context, mode: 'queued' as const })), { clientId: m.clientId, text: m.text, context: added }];
      return { outcome: 'started', job: await this.startTurn(ref, id, messages) };
    });
  }

  /** The session's folders that exist now, and those gone since they were linked. */
  private async readable(ref: BriefProjectRef, s: BriefSessionFile): Promise<{ codebases: LinkedCodebase[]; missingCodebases: string[] }> {
    const codebases: LinkedCodebase[] = [];
    const missingCodebases: string[] = [];
    for (const c of s.context.codebases) {
      if (await isDir(c.path)) codebases.push(c);
      else missingCodebases.push(c.path);
    }
    return { codebases, missingCodebases };
  }

  /** Starts a turn with `messages` (their user entries are written now, with the job's id). Called under the project lock. */
  private async startTurn(ref: BriefProjectRef, sessionId: string, messages: TurnMessage[]): Promise<JobSummary> {
    const key = this.key(ref);
    const jobId = randomUUID();
    const at = new Date().toISOString();
    await this.deps.store.update(ref.projectDir, sessionId, (s) => ({ queued: s.queued.filter((q) => !messages.some((m) => m.clientId === q.clientId)) }));
    for (const m of messages) {
      await this.deps.store.append(ref.projectDir, sessionId, {
        type: 'user', at, text: m.text, pins: [], attachments: [], jobId, clientId: m.clientId, ...(m.mode ? { mode: m.mode } : {}),
        ...(m.context.codebases.length + m.context.assets.length > 0 ? { context: m.context } : {}),
      });
    }
    const request = messages.map((m) => m.text).join('\n\n');
    const job = this.deps.queue.enqueue({
      id: jobId, key, kind: 'brief', label: t().jobs.briefLabel({ name: ref.projectName }),
      run: (signal, id) => this.runTurn(ref, sessionId, id, request, signal),
    });
    void this.deps.queue.whenSettled(jobId).then(() => this.drain(ref)).catch(() => {});
    const s = await this.deps.store.open(ref.projectDir).catch(() => null);
    if (s) this.changed(ref, s);
    return job;
  }

  /**
   * After a turn: the messages queued meanwhile start the next one, all together, in order. The session open now (not the
   * turn's): a session started over while the old turn was still ending may already hold messages waiting for it.
   */
  private async drain(ref: BriefProjectRef): Promise<void> {
    await this.lock.run(this.key(ref), async () => {
      if (this.claims.has(this.key(ref)) || this.jobOf(ref)) return;
      const s = await this.deps.store.open(ref.projectDir).catch(() => null);
      if (!s || s.handedOffTo || s.queued.length === 0) return;
      await this.startTurn(ref, s.id, s.queued.map((q) => ({ clientId: q.clientId, text: q.text, context: q.context, mode: 'queued' as const })));
    });
  }

  /** One brief turn: a run of the read-only agent, resumed from the session's Claude session; one fresh retry if it is lost. */
  private async runTurn(ref: BriefProjectRef, sessionId: string, jobId: string, request: string, signal: AbortSignal): Promise<void | 'cancelled'> {
    const key = this.key(ref);
    const act: Active = { jobId, sessionId, run: null, liveInput: false };
    this.active.set(key, act);
    /** The chat's writes, in event order; a write to a discarded session is dropped. */
    let writes: Promise<unknown> = Promise.resolve();
    const append = (e: ConversationEntry) => { writes = writes.then(() => this.deps.store.append(ref.projectDir, sessionId, e)).catch(() => {}); };
    try {
      let fresh = false;
      for (;;) {
        const s = await this.deps.store.open(ref.projectDir);
        if (!s || s.id !== sessionId || signal.aborted) return 'cancelled';
        const { codebases, missingCodebases } = await this.readable(ref, s);
        // The project's own folders: never one around the config folder either (the agent's tokens live there).
        const project = await agentCodebases(ref.projectCodebases, [ref.projectDir, ref.root, ref.configDir]);
        for (const line of project.ignored) this.deps.broadcast({ type: 'agent', jobId, event: { kind: 'progress', text: line } });
        // Every spelling of each folder (the linked one and its real path): the read-only, secret and allow rules hold
        // whichever path the agent uses (as brand analysis does, `codebaseSpellings`).
        const paths = [...new Set(await Promise.all([...codebases.map((c) => c.path), ...project.paths].map(async (p) => codebaseSpellings({ path: p, real: await realpath(p).catch(() => p) }))).then((x) => x.flat()))];
        const resume = fresh ? undefined : s.claudeSessionId;
        const analyses = await this.videoAnalyses?.analysisRefs(ref, s.context.assets).catch(() => ({})) ?? {};
        const assetFacts = await libraryFacts(ref.projectDir, s.context.assets, this.deps.probeSize);
        const common = { locale: currentLocale(), form: s.form, userEdited: s.userEdited, codebases, missingCodebases, assets: s.context.assets, analyses, assetFacts, request };
        const prompt = resume ? briefFollowUp(common)
          : buildBriefPrompt({ ...common, projectName: ref.projectName, projectCodebases: project.paths.filter((p) => !codebases.some((c) => c.path === p)),
            ...(fresh ? { digest: briefDigest((await this.deps.store.conversation(ref.projectDir, sessionId)).filter((e) => !('jobId' in e && e.jobId === jobId && e.type === 'user'))) } : {}) });
        const seen = { session: false, output: false };
        const onEvent = (event: AgentEvent) => {
          this.deps.broadcast({ type: 'agent', jobId, event });
          if (!(event.kind === 'usage' && event.live)) append({ type: 'agent', at: new Date().toISOString(), jobId, event });
          if (event.kind === 'text') seen.output = true;
          const sid = event.kind === 'session' || event.kind === 'result' ? event.sessionId : undefined;
          if (sid) {
            seen.session = true;
            this.deps.queue.patch(jobId, { sessionId: sid });
            writes = writes.then(() => this.deps.store.update(ref.projectDir, sessionId, () => ({ claudeSessionId: sid }))).catch(() => {});
          }
        };
        const run = await this.deps.launcher.start({
          kind: 'brief', jobId, projectSlug: ref.projectSlug, projectDir: ref.projectDir, creativeSlug: null, codebases: paths,
          briefScope: { root: ref.root, projectSlug: ref.projectSlug, projectDir: ref.projectDir, sessionId },
          request: { prompt, ...(resume ? { resumeSessionId: resume, forkSession: false } : {}), model: (await this.deps.model()) ?? undefined },
          onEvent,
        });
        act.run = run;
        act.liveInput = run.capabilities?.liveInput === true;
        const onAbort = () => run.cancel();
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) run.cancel();
        const result = await run.done.finally(() => signal.removeEventListener('abort', onAbort));
        act.run = null;
        await writes;
        if (signal.aborted || result.status === 'cancelled') return 'cancelled';
        // The Claude session of the brief no longer exists (aged out, another machine): one fresh run from the chat's digest.
        if (result.status === 'failed' && resume && !fresh && resumeErrorOf(result, seen)) {
          fresh = true;
          await this.deps.store.update(ref.projectDir, sessionId, () => ({ claudeSessionId: undefined })).catch(() => {});
          continue;
        }
        if (result.status === 'failed') {
          const error = result.error ?? t().errors.turnFailed;
          append({ type: 'system', at: new Date().toISOString(), level: 'error', text: error });
          await writes;
          throw new Error(error);
        }
        return;
      }
    } finally {
      if (this.active.get(key) === act) this.active.delete(key);
      this.fills.delete(jobId);
      await writes;
    }
  }

  /** Ends the session: its job is cancelled, its files removed. A session that cannot be read is removed whatever `id`. */
  async discard(ref: BriefProjectRef, id: string): Promise<void> {
    const key = this.key(ref);
    await this.lock.run(key, async () => {
      if (this.claims.has(key)) throw busy();
      let unreadable = false;
      try { await this.session(ref, id); } catch (err) {
        if (!isUnreadable(err)) throw err;
        unreadable = true;
      }
      const job = this.jobOf(ref);
      if (job) this.deps.queue.cancel(job.id);
      if (unreadable) await this.deps.store.removeAny(ref.projectDir);
      else await this.deps.store.remove(ref.projectDir, id);
      this.blocked.delete(key);
    });
    this.deps.broadcast({ type: 'brief-session', project: ref.projectSlug, sessionId: id, ended: true });
  }

  /**
   * Genera / Salva bozza, before anything is created: the session must be the open one (409 `brief-session-gone`) and its
   * agent must not be working (409 `brief-session-busy`). From here no message is taken until `handOff` or `release`.
   */
  async claim(ref: BriefProjectRef, id: string): Promise<BriefClaim> {
    const key = this.key(ref);
    return this.lock.run(key, async () => {
      if (this.claims.has(key)) throw busy();
      const s = await this.usable(ref, id);
      if (this.jobOf(ref)) throw busy();
      // Messages still waiting for a turn (the turn that would take them has not started, or a restart came between) are
      // never lost in the move: they start their turn now, and the creation waits for it like for any running turn.
      if (s.queued.length > 0) {
        await this.startTurn(ref, id, s.queued.map((q) => ({ clientId: q.clientId, text: q.text, context: q.context, mode: 'queued' as const })));
        throw busy();
      }
      this.claims.add(key);
      return { ref, sessionId: id, key };
    });
  }

  /** The creation failed before the handoff: the session goes on as it was. */
  release(claim: BriefClaim): void { this.claims.delete(claim.key); }

  /**
   * Decision 1423: moves the session into `creative`: its chat is copied in order, each entry with its own time (`group`:
   * stamped as the group's, for the group's one chat), then a line marks where the creative starts; the brief agent's Claude
   * session is recorded for the first turn (or the coordinator) to fork, with the chat's digest as the fallback; the
   * session ends.
   */
  async handOff(claim: BriefClaim, creative: CreativeRef, o: { group: boolean; title: string; formats: string }): Promise<void> {
    // On a failure the claim stays held: the caller marks the session (`markHandedOff`), which releases it, so no second
    // Genera can claim the session in between.
    const { ref, sessionId } = claim;
    const s = await this.session(ref, sessionId);
    const entries = await this.deps.store.conversation(ref.projectDir, sessionId);
    const stamp = (e: ConversationEntry): ConversationEntry => (o.group ? { ...e, group: true } : e);
    await new CreativeStore(creative.projectDir).appendConversationEntries(creative.creativeSlug, [
      ...entries.map(stamp),
      stamp({ type: 'system', at: new Date().toISOString(), level: 'info', origin: 'brief', text: t().briefSession.creativeStarts({ title: o.title, formats: o.formats }) }),
    ]);
    if (s.claudeSessionId && isSessionId(s.claudeSessionId)) {
      await this.deps.side.setBriefSession(creative.projectDir, creative.creativeSlug, { sessionId: s.claudeSessionId, at: new Date().toISOString(), summary: briefDigest(entries) });
    }
    await this.deps.store.remove(ref.projectDir, sessionId);
    this.changed(ref, s, { ended: true });
    this.deps.broadcast({ type: 'creative', project: creative.projectSlug, creative: creative.creativeSlug });
    this.release(claim);
  }

  /**
   * The move into `creativeSlug` did not finish (the creative exists): the session is marked so no second Genera makes a
   * duplicate and no message goes to it; the user keeps its chat and can discard it. Best effort.
   */
  async markHandedOff(claim: BriefClaim, creativeSlug: string): Promise<void> {
    try {
      const s = await this.deps.store.update(claim.ref.projectDir, claim.sessionId, () => ({ handedOffTo: creativeSlug }));
      this.changed(claim.ref, s);
    } catch {
      // The mark could not be written (the session's files cannot be read or written): it stays refused in memory.
      this.blocked.set(claim.key, claim.sessionId);
    } finally {
      this.release(claim);
    }
  }

  /** The brief job's `studio` tools (`MCP_TOOLS.brief`): the bridge checks the job's kind, the handlers check it again. */
  tools(): Record<'list_formats' | 'fill_brief' | 'source_format', BridgeHandler> {
    return {
      list_formats: async (c) => {
        if (c.kind !== 'brief' || !c.briefScope) throw new WorkspaceError(403, t().errors.toolUnavailable);
        return listFormats(await this.deps.presets(), currentLocale());
      },
      fill_brief: async (c, a) => {
        const scope = c.briefScope;
        if (c.kind !== 'brief' || !scope) throw new WorkspaceError(403, t().errors.toolUnavailable);
        const calls = (this.fills.get(c.jobId) ?? 0) + 1;
        this.fills.set(c.jobId, calls);
        if (calls > BRIEF_FILLS_PER_JOB) throw new CodedError(429, t().errors.briefFillLimit({ max: BRIEF_FILLS_PER_JOB }), 'brief-fill-limit');
        const presets = await this.deps.presets();
        let out: ReturnType<typeof applyFill> | null = null;
        const after = await this.deps.store.update(scope.projectDir, scope.sessionId, (s) => {
          out = applyFill(s, a, presets);
          // Decision 1422: a write is a new revision; a field taken back is the agent's against any save based on an older one.
          const revision = out.written.length > 0 ? s.revision + 1 : s.revision;
          const reclaimedAt = { ...s.reclaimedAt, ...Object.fromEntries(out.reclaimed.map((f) => [f, revision])) };
          return { form: out.form, agentFields: out.agentFields, userEdited: out.userEdited, revision, reclaimedAt };
        });
        const o = out as unknown as ReturnType<typeof applyFill>;
        const at = new Date().toISOString();
        const kept = o.kept.map((k) => k.field);
        const plain = o.written.filter((f) => !o.reclaimed.includes(f));
        if (plain.length > 0 || kept.length > 0 || o.reclaimed.length === 0) {
          await this.deps.store.append(scope.projectDir, scope.sessionId, { type: 'system', at, level: 'info', origin: 'agent', text: fillLine(plain, kept, o.form) });
        }
        if (o.reclaimed.length > 0) await this.deps.store.append(scope.projectDir, scope.sessionId, { type: 'system', at, level: 'info', origin: 'agent', text: reclaimLine(o.reclaimed) });
        this.deps.broadcast({ type: 'brief-session', project: scope.projectSlug, sessionId: scope.sessionId, revision: after.revision, fill: { written: o.written, kept, reclaimed: o.reclaimed } });
        if (o.written.includes('assets')) this.analyse(scope, after);
        return { ok: true, written: o.written, kept: o.kept, reclaimed: o.reclaimed };
      },
      // Report 70: "the original format" is a custom format of the source's own size (even sides for a video), never the
      // nearest preset. One of that kind and size already among the custom formats is reused; else one is added.
      source_format: async (c, a) => {
        const scope = c.briefScope;
        if (c.kind !== 'brief' || !scope || !this.deps.addFormat) throw new WorkspaceError(403, t().errors.toolUnavailable);
        const args = sourceFormatArgs.safeParse(a);
        if (!args.success) throw new CodedError(400, t().errors.briefBadField({ field: 'asset', detail: args.error.issues[0]?.message ?? 'invalid' }), 'brief-fill-invalid');
        const path = args.data.asset;
        const s = await this.deps.store.open(scope.projectDir);
        if (!s || s.id !== scope.sessionId) throw gone();
        if (!s.context.assets.includes(path) && !s.form.assets.includes(path)) throw new CodedError(400, t().errors.briefAssetOutside({ path }), 'brief-fill-invalid');
        const facts = (await libraryFacts(scope.projectDir, [path], this.deps.probeSize))[path];
        // Round 1 (M1): each refusal says what is wrong, so the agent tells the user the truth.
        const kind = facts?.kind === 'video' || facts?.kind === 'image' ? facts.kind : null;
        if (facts && !kind) throw new CodedError(400, t().errors.briefSourceKind({ path }), 'brief-source-kind');
        if (!kind || !facts?.width || !facts.height) throw new CodedError(400, t().errors.briefSourceSize({ path }), 'brief-source-size');
        const size = sourceFormatSize({ kind, width: facts.width, height: facts.height });
        if (!size) throw new CodedError(400, t().errors.briefSourceSmall({ path }), 'brief-source-small');
        const source = { width: facts.width, height: facts.height };
        // Round 1 (M2): scaled down to fit (more than the odd pixel a video loses): the agent says so.
        const scaled = source.width - size.width > 1 || source.height - size.height > 1;
        const answer = (p: FormatPreset, added: boolean) => ({ format: p.id, name: p.name, kind, width: p.width, height: p.height, source, scaled, added });
        const base = t().briefSession.sourceFormatName(size);
        // A name another custom format holds (of another size, or with a limit: neither is reused) takes " (2)", " (3)"…; a
        // window adding the same name meanwhile is a 409, and the catalog is read again.
        for (let k = 1; k <= 20; k++) {
          const presets = await this.deps.presets();
          const same = sameSizeCustom(presets, kind, size.width, size.height, base);
          if (same) return answer(same, false);
          const name = k === 1 ? base : `${base} (${k})`;
          if (presets.some((p) => isCustomPreset(p) && !p.hidden && sameCustomName(p.name, name))) continue;
          try {
            const p = await this.deps.addFormat({ name, kind, width: size.width, height: size.height });
            const at = new Date().toISOString();
            await this.deps.store.append(scope.projectDir, scope.sessionId, { type: 'system', at, level: 'info', origin: 'agent', text: t().briefSession.sourceFormatAdded({ name: p.name }) });
            // Round 1 (M3): the line reaches the chat now (the clients refetch the session), not with the next fill.
            this.deps.broadcast({ type: 'brief-session', project: scope.projectSlug, sessionId: scope.sessionId, revision: s.revision });
            return answer(p, true);
          } catch (err) {
            if (!(err instanceof CodedError && err.apiCode === 'custom-format-name-taken')) throw err;
          }
        }
        throw new CodedError(409, t().errors.briefSourceNoName({ path }), 'brief-source-no-name');
      },
    };
  }
}

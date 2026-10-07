import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CreativeFile, CreativeStatus, FormatPreset, JobSummary, Pin, ServerMessage } from '@motion-studio/shared';
import { AGENT_ALLOWED_TOOLS, type AgentRunner } from '../agent/runner.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import type { Git } from '../git.ts';
import { JobConflictError, type JobQueue } from '../jobs/job-queue.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { CONTEXT_MD } from '../project-template.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { CreativeStore } from './creative-store.ts';
import { validateOutputs } from './output-contract.ts';
import { buildCreativePrompt, type PromptKind } from './prompt.ts';

export interface CreativeTurnDeps {
  queue: JobQueue; runner: AgentRunner; git: Git; media: MediaTools;
  presets: () => Promise<FormatPreset[]>;
  model: () => Promise<string | null>;
  broadcast: (msg: ServerMessage) => void;
  maxAttempts?: number;
}
export interface CreativeRef { root: string; projectSlug: string; projectDir: string; creativeSlug: string }

export const creativeJobKey = (root: string, projectSlug: string, creativeSlug: string) => `creative:${root}:${projectSlug}:${creativeSlug}`;
const REGENERATE = 'Rigenera tutti i formati partendo dal brief aggiornato.';
const UNKNOWN_PRESET = 'Preset sconosciuto:';
const now = () => new Date().toISOString();

class AgentFailure extends Error {}

export class CreativeTurnService {
  private readonly maxAttempts: number;
  private readonly locks = new KeyedMutex();
  constructor(private readonly deps: CreativeTurnDeps) { this.maxAttempts = deps.maxAttempts ?? 3; }

  async start(ref: CreativeRef, message?: { text: string; pins: Pin[] }): Promise<JobSummary> {
    return this.locks.run(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug), () => this.startLocked(ref, message));
  }

  private async startLocked(ref: CreativeRef, message?: { text: string; pins: Pin[] }): Promise<JobSummary> {
    const store = new CreativeStore(ref.projectDir);
    const before = await store.get(ref.creativeSlug);
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    // Same check the queue does, but before touching the creative's files.
    if (this.isActive(key)) throw new JobConflictError(key);
    if (message) await store.appendConversation(ref.creativeSlug, { type: 'user', at: now(), text: message.text, pins: message.pins, attachments: [] });
    await store.update(ref.creativeSlug, { status: 'working', error: null });
    this.changed(ref);
    return this.deps.queue.enqueue({
      key,
      label: `Creatività · ${before.title}`,
      run: (signal, jobId) => this.run(ref, store, before.status, message, signal, jobId),
      onCancelledBeforeStart: () => this.locks.run(key, async () => {
        // A new start() may have won the lock after the cancel: the creative belongs to that job now.
        if (this.isActive(key)) return;
        await this.cancelled(ref, store, before.status, (await store.readVersions(ref.creativeSlug)).length > 0);
      }),
    });
  }

  async restore(ref: CreativeRef, n: number): Promise<CreativeFile> {
    return this.locks.run(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug), () => this.restoreLocked(ref, n));
  }

  private isActive(key: string): boolean {
    return this.deps.queue.list().some((j) => j.key === key && (j.state === 'queued' || j.state === 'running'));
  }

  private async restoreLocked(ref: CreativeRef, n: number): Promise<CreativeFile> {
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    if (this.isActive(key)) {
      throw new WorkspaceError(409, 'Attendi la fine della generazione in corso prima di ripartire da una versione');
    }
    const store = new CreativeStore(ref.projectDir);
    const version = (await store.readVersions(ref.creativeSlug)).find((v) => v.n === n);
    if (!version) throw new WorkspaceError(404, `Versione ${n} non trovata`);
    if (!version.commit || !version.sessionId) throw new WorkspaceError(409, `La versione ${n} non può essere ripristinata (manca commit o sessione)`);
    await this.deps.git.restorePath(ref.projectDir, version.commit, relative(ref.projectDir, store.workDir(ref.creativeSlug)));
    const updated = await store.update(ref.creativeSlug, { resumeFrom: { version: n, sessionId: version.sessionId } });
    await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: `Ripartenza dalla versione ${n}: il prossimo messaggio lavora su quella base.` });
    this.changed(ref);
    return updated;
  }

  private async run(ref: CreativeRef, store: CreativeStore, previous: CreativeStatus, message: { text: string; pins: Pin[] } | undefined, signal: AbortSignal, jobId: string): Promise<void | 'cancelled'> {
    const slug = ref.creativeSlug;
    try {
      await writeFile(join(ref.projectDir, '.studio', 'context.md'), CONTEXT_MD);
      const creative = await store.get(slug);
      const versions = await store.readVersions(slug);
      const latest = versions.at(-1);
      const n = await store.nextVersionNumber(slug);
      const presets = await this.deps.presets();
      const model = (await this.deps.model()) ?? undefined;
      const attachments = await this.extractPinFrames(ref, store, message?.pins ?? [], latest, n);

      let resumeSessionId = creative.resumeFrom?.sessionId ?? latest?.sessionId ?? undefined;
      let forkSession = Boolean(creative.resumeFrom);
      let kind: PromptKind = versions.length === 0 ? 'first' : 'iteration';
      let problems: string[] = [];
      let result = null as Awaited<ReturnType<typeof validateOutputs>> | null;
      let lastWrite: Promise<void> = Promise.resolve();

      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        const prompt = buildCreativePrompt({
          slug, creative, presets, version: n, kind,
          userText: kind === 'fix' ? undefined : message?.text || (kind === 'iteration' ? REGENERATE : undefined),
          pins: kind === 'iteration' ? message?.pins : undefined,
          attachments: kind === 'iteration' ? attachments : undefined,
          problems,
        });
        const run = this.deps.runner.start({ cwd: ref.projectDir, prompt, resumeSessionId, forkSession, model, allowedTools: [...AGENT_ALLOWED_TOOLS] }, (event) => {
          this.deps.broadcast({ type: 'agent', jobId, event });
          // Chained so writes stay ordered and a failure surfaces when the chain is awaited after the turn.
          lastWrite = lastWrite.then(() => store.appendConversation(slug, { type: 'agent', at: now(), jobId, event }));
          lastWrite.catch(() => {}); // observed here; the same rejection is rethrown by the await below
          const sid = event.kind === 'session' || event.kind === 'result' ? event.sessionId : undefined;
          if (sid) this.deps.queue.patch(jobId, { sessionId: sid });
        });
        const onAbort = () => run.cancel();
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort(); // cancelled before the listener existed (e.g. while preparing the turn)
        const outcome = await run.done.finally(() => signal.removeEventListener('abort', onAbort));
        await lastWrite;
        if (outcome.status === 'cancelled') return await this.cancelled(ref, store, previous, versions.length > 0);
        if (outcome.status === 'failed') throw new AgentFailure(outcome.error ?? 'Turno non riuscito');
        resumeSessionId = outcome.sessionId ?? resumeSessionId;
        forkSession = false;

        result = await validateOutputs({ dir: store.outputsDir(slug, n), requested: creative.brief.formats, presets, durationSec: creative.brief.durationSec, media: this.deps.media });
        problems = result.problems;
        // A preset missing from the catalog cannot be fixed by the agent: retrying would only waste turns.
        if (problems.every((p) => p.startsWith(UNKNOWN_PRESET)) || attempt === this.maxAttempts) break;
        await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: `Controllo output: ${problems.length} problemi. Chiedo una correzione (tentativo ${attempt + 1} di ${this.maxAttempts}).` });
        this.changed(ref);
        kind = 'fix';
      }

      const status = problems.length === 0 ? 'complete' : 'incomplete';
      const commit = await this.deps.git.commitAll(ref.projectDir, `${creative.title}: v${n}`);
      await store.appendVersion(slug, {
        n, commit, sessionId: resumeSessionId ?? null, status, createdAt: now(),
        request: message?.text || (versions.length === 0 ? 'Generazione dal brief' : REGENERATE),
        outputs: result?.outputs ?? [], problems, tools: result?.tools ?? [], renderCommand: result?.renderCommand ?? null,
        basedOn: creative.resumeFrom?.version ?? latest?.n ?? null,
      });
      await store.appendConversation(slug, { type: 'version', at: now(), n, status });
      await store.update(slug, { status: status === 'complete' ? 'ready' : 'incomplete', error: null, resumeFrom: null });
      this.changed(ref);
    } catch (err) {
      if (signal.aborted) return await this.cancelled(ref, store, previous, (await store.readVersions(slug)).length > 0);
      const text = err instanceof Error ? err.message : String(err);
      await store.update(slug, { status: 'error', error: text }).catch(() => {});
      await store.appendConversation(slug, { type: 'system', at: now(), level: 'error', text: `Generazione non riuscita: ${text}` }).catch(() => {});
      this.changed(ref);
      throw err;
    }
  }

  private async cancelled(ref: CreativeRef, store: CreativeStore, previous: CreativeStatus, hasVersions: boolean): Promise<'cancelled'> {
    const restored: CreativeStatus = previous === 'ready' || previous === 'incomplete' || previous === 'draft'
      ? previous : hasVersions ? 'ready' : 'draft';
    await store.update(ref.creativeSlug, { status: restored, error: null });
    await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: 'Generazione annullata.' });
    this.changed(ref);
    return 'cancelled';
  }

  private async extractPinFrames(ref: CreativeRef, store: CreativeStore, pins: Pin[], latest: { n: number; outputs: Array<{ format: string; file: string }> } | undefined, n: number): Promise<string[]> {
    if (!this.deps.media.available || !latest) return [];
    const out: string[] = [];
    for (const [i, pin] of pins.entries()) {
      if (pin.timeSec === null) continue;
      const output = latest.outputs.find((o) => o.format === pin.format);
      if (!output) continue;
      const target = join(store.workDir(ref.creativeSlug), '.feedback', `${n}-${i + 1}.jpg`);
      try {
        if (await this.deps.media.frame(join(store.outputsDir(ref.creativeSlug, latest.n), output.file), target, pin.timeSec)) {
          out.push(relative(ref.projectDir, target));
        }
      } catch {
        // The feedback frame is optional: the pin still travels as text.
      }
    }
    return out;
  }

  private changed(ref: CreativeRef) {
    this.deps.broadcast({ type: 'creative', project: ref.projectSlug, creative: ref.creativeSlug });
  }
}

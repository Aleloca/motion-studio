import { lstat, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { checkLink, effectiveLinks, formatLabel, starOf, EMPTY_BRAND_KIT, projectFileSchema, type Brief, type LinkedCodebase, type CreativeFile, type CreativeStatus, type FormatPreset, type JobSummary, type Pin, type ServerMessage, type UsageRecord, type VersionEntry } from '@motion-studio/shared';
import type { AgentLauncher } from '../agent/launcher.ts';
import { BrandStore } from '../brand/brand-store.ts';
import { assertCodebasesOutside, checkCodebases, codebaseOverlaps, codebaseOverlapMessage, codebaseSnapshot, normalizeCodebaseList } from '../codebases.ts';
import { readJsonFile } from '../json-file.ts';
import { LibraryStore } from '../library/library-store.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import type { Git } from '../git.ts';
import { JobFailedError, type JobQueue } from '../jobs/job-queue.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { availableTools } from '../bridge/provider-tools.ts';
import type { SecretsVault } from '../secrets/vault.ts';
import { CONTEXT_MD } from '../project-template.ts';
import { CodedError, WorkspaceError } from '../workspace-store.ts';
import { CreativeStore } from './creative-store.ts';
import { validateOutputs } from './output-contract.ts';
import { outputFileExists } from './format-summary.ts';
import { hashVersionOutputs, withLazyHashes } from './output-hashes.ts';
import { buildCreativePrompt, type CreativeContext, type PromptKind } from './prompt.ts';
import { sumUsage } from '../usage/usage-tracker.ts';
import { currentLocale, t } from '../i18n.ts';

export interface CreativeTurnDeps {
  queue: JobQueue; launcher: AgentLauncher; git: Git; media: MediaTools; vault: SecretsVault;
  presets: () => Promise<FormatPreset[]>;
  model: () => Promise<string | null>;
  broadcast: (msg: ServerMessage) => void;
  maxAttempts?: number;
}
export interface CreativeRef { root: string; projectSlug: string; projectDir: string; creativeSlug: string }

export const creativeJobKey = (root: string, projectSlug: string, creativeSlug: string) => `creative:${root}:${projectSlug}:${creativeSlug}`;
/** The render command comes from an agent-written manifest: single line, bounded, no control chars. */
const sanitizeCommand = (cmd: string): string => cmd.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300);

function addFormatsRequest(formats: string[], base: VersionEntry | undefined): string | undefined {
  if (!base) return undefined;
  const present = new Set(base.outputs.map((o) => o.format));
  const added = formats.filter((f) => !present.has(f));
  if (added.length === 0) return undefined;
  const command = base.renderCommand ? sanitizeCommand(base.renderCommand) : '';
  const j = t().jobs;
  return j.addFormatsRequest({ formats: added.join(', '), n: base.n })
    + (command ? ` ${j.renderCommandWas({ n: base.n, command })}` : '')
    + ` ${j.redeliverAll}`;
}
const now = () => new Date().toISOString();

class AgentFailure extends Error {}

export class CreativeTurnService {
  private readonly maxAttempts: number;
  private readonly locks = new KeyedMutex();
  constructor(private readonly deps: CreativeTurnDeps) { this.maxAttempts = deps.maxAttempts ?? 3; }

  async start(ref: CreativeRef, message?: { text: string; pins: Pin[] }): Promise<JobSummary> {
    return this.locks.run(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug), () => this.startLocked(ref, message));
  }

  /** Edits title and/or brief; refused while a generation is queued or running for the creative. */
  async updateBrief(ref: CreativeRef, patch: { title?: string; brief?: Brief; linkedCodebases?: LinkedCodebase[] }): Promise<CreativeFile> {
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    return this.locks.run(key, async () => {
      if (this.isActive(key)) throw new WorkspaceError(409, t().errors.waitBeforeBrief);
      const store = new CreativeStore(ref.projectDir);
      const linkedCodebases = patch.linkedCodebases ? normalizeCodebaseList(patch.linkedCodebases) : null;
      if (linkedCodebases) await assertCodebasesOutside(linkedCodebases, [ref.projectDir, ref.root]);
      // Links change only through setLink (validated): a brief save keeps the stored ones, whatever it carries.
      let brief: Brief | undefined;
      if (patch.brief) {
        const { links: _ignored, ...rest } = patch.brief;
        const stored = (await store.get(ref.creativeSlug)).brief.links;
        brief = stored ? { ...rest, links: stored } : rest;
      }
      const updated = await store.update(ref.creativeSlug, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(brief ? { brief } : {}),
        ...(linkedCodebases ? { linkedCodebases } : {}),
      });
      await this.commitState(ref, t().jobs.briefUpdatedCommit({ title: updated.title }));
      return updated;
    });
  }

  /**
   * Sets (`version`) or clears (`null`) the manual ★ of `format` (spec §2.2). A pick equal to what the default rule gives
   * is not stored (it clears the format's entry), so the ★ keeps following new versions. Refused for a format not in the
   * brief, a follower (it uses its primary's ★), a version that does not exist (404) or has no file for the format, and a
   * file missing on disk (409).
   */
  async setExportPick(ref: CreativeRef, format: string, version: number | null): Promise<CreativeFile> {
    return this.locks.run(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug), async () => {
      const store = new CreativeStore(ref.projectDir);
      const creative = await store.get(ref.creativeSlug);
      const presets = await this.deps.presets();
      const label = (id: string) => { const p = presets.find((x) => x.id === id); return p ? formatLabel(p, currentLocale()) : id; };
      const e = t().errors;
      if (!creative.brief.formats.includes(format)) throw new CodedError(400, e.formatNotInBrief({ format: label(format) }), 'format-not-in-brief');
      const links = effectiveLinks(creative.brief.links, creative.brief.formats);
      if (Object.hasOwn(links, format)) throw new CodedError(400, e.pickFollower({ format: label(format), primary: label(links[format]!) }), 'pick-follower');
      // The default rule needs the full history: wait for every hash here.
      const versions = await withLazyHashes({
        projectDir: ref.projectDir, creativeSlug: ref.creativeSlug, creativeDir: store.dir(ref.creativeSlug),
        versions: await store.readVersions(ref.creativeSlug), budgetMs: Number.POSITIVE_INFINITY,
      });
      if (version !== null) {
        const entry = versions.find((v) => v.n === version);
        if (!entry) throw new CodedError(404, e.versionNNotFound({ n: version }), 'version-not-found');
        if (!entry.outputs.some((o) => o.format === format)) throw new CodedError(400, e.pickNoFile({ format: label(format), n: version }), 'pick-no-file');
        if (!(await outputFileExists(store.dir(ref.creativeSlug), versions, version, format))) {
          throw new CodedError(409, e.pickFileMissing({ format: label(format), n: version }), 'pick-file-missing');
        }
      }
      const picks = { ...creative.exportPicks };
      if (version === null || version === starOf(versions, format, undefined, links).version) delete picks[format];
      else picks[format] = version;
      const updated = await store.update(ref.creativeSlug, { exportPicks: Object.keys(picks).length > 0 ? picks : undefined });
      await this.commitState(ref, t().jobs.stateCommit({ title: updated.title }));
      this.changed(ref);
      return updated;
    });
  }

  /**
   * Links `follower` to `primary`, or unlinks it (`null`) (spec §2.3); refused while a generation is queued or running.
   * A link is checked with `checkLink` against the primary's latest known duration (unknown: re-checked at materialization).
   * The stored links are sanitized (`effectiveLinks`): dropped formats, self-links and chains never stay.
   */
  async setLink(ref: CreativeRef, follower: string, primary: string | null): Promise<CreativeFile> {
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    return this.locks.run(key, async () => {
      if (this.isActive(key)) throw new CodedError(409, t().errors.waitBeforeLinks, 'job-running');
      const store = new CreativeStore(ref.projectDir);
      const creative = await store.get(ref.creativeSlug);
      const { brief } = creative;
      const presets = await this.deps.presets();
      const label = (id: string) => { const p = presets.find((x) => x.id === id); return p ? formatLabel(p, currentLocale()) : id; };
      const e = t().errors;
      for (const f of primary === null ? [follower] : [follower, primary]) {
        if (!brief.formats.includes(f)) throw new CodedError(400, e.formatNotInBrief({ format: label(f) }), 'format-not-in-brief');
      }
      const links = effectiveLinks(brief.links, brief.formats);
      if (primary === null) delete links[follower];
      else {
        const check = checkLink(brief, await store.readVersions(ref.creativeSlug), presets, follower, primary);
        if (!check.ok) {
          if (check.reason === 'self') throw new CodedError(400, e.linkSelf, 'link-self');
          if (check.reason === 'chain') throw new CodedError(400, e.linkChain({ follower: label(follower), primary: label(primary) }), 'link-chain');
          throw new CodedError(400, e.linkIncompatible({ follower: label(follower), primary: label(primary), reason: e.followReason[check.reason] }), 'link-incompatible');
        }
        links[follower] = primary;
      }
      const updated = await store.update(ref.creativeSlug, { brief: { ...brief, links } });
      await this.commitState(ref, t().jobs.briefUpdatedCommit({ title: updated.title }));
      this.changed(ref);
      return updated;
    });
  }

  private async startLocked(ref: CreativeRef, message?: { text: string; pins: Pin[] }): Promise<JobSummary> {
    const store = new CreativeStore(ref.projectDir);
    const before = await store.get(ref.creativeSlug);
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    // Same check the queue does, but before touching the creative's files.
    if (this.isActive(key)) throw new WorkspaceError(409, t().errors.generationRunning);
    if (message) await store.appendConversation(ref.creativeSlug, { type: 'user', at: now(), text: message.text, pins: message.pins, attachments: [] });
    await store.update(ref.creativeSlug, { status: 'working', error: null });
    this.changed(ref);
    return this.deps.queue.enqueue({
      key,
      kind: 'creative',
      label: t().jobs.creativeLabel({ title: before.title }),
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
      throw new WorkspaceError(409, t().errors.waitBeforeRestart);
    }
    const store = new CreativeStore(ref.projectDir);
    const version = (await store.readVersions(ref.creativeSlug)).find((v) => v.n === n);
    if (!version) throw new WorkspaceError(404, t().errors.versionNNotFound({ n }));
    if (!version.commit || !version.sessionId) throw new WorkspaceError(409, t().errors.versionNotRestorable({ n }));
    const removed = await this.deps.git.restorePath(ref.projectDir, version.commit, relative(ref.projectDir, store.workDir(ref.creativeSlug)));
    const updated = await store.update(ref.creativeSlug, { resumeFrom: { version: n, sessionId: version.sessionId } });
    if (removed > 0) {
      await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: t().jobs.removedUnsaved({ count: removed }) });
    }
    await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: t().jobs.restartedFrom({ n }) });
    await this.commitState(ref, t().jobs.restartCommit({ title: updated.title, n }));
    this.changed(ref);
    return updated;
  }

  private async run(ref: CreativeRef, store: CreativeStore, previous: CreativeStatus, message: { text: string; pins: Pin[] } | undefined, signal: AbortSignal, jobId: string): Promise<void | 'cancelled'> {
    const slug = ref.creativeSlug;
    // The agent's language is fixed when the job starts: a setting change mid-turn does not affect it.
    const locale = currentLocale();
    // Set once the last agent turn is over: from then on an abort no longer cancels (the version gets saved).
    let finalizing = false;
    try {
      await writeFile(join(ref.projectDir, '.studio', 'context.md'), CONTEXT_MD);
      const creative = await store.get(slug);
      const versions = await store.readVersions(slug);
      const latest = versions.at(-1);
      const n = await store.nextVersionNumber(slug);
      await this.clearStaleOutputs(store, slug, n, versions);
      const presets = await this.deps.presets();
      const model = (await this.deps.model()) ?? undefined;
      // Pins and the add-formats base refer to the version on screen: the one being resumed from, else the latest.
      const pinSource = creative.resumeFrom ? versions.find((v) => v.n === creative.resumeFrom!.version) : latest;
      const attachments = await this.extractPinFrames(ref, store, message?.pins ?? [], pinSource, n);
      const request = message?.text || (message?.pins.length ? t().jobs.pinsOnlyRequest : versions.length === 0 ? undefined : (addFormatsRequest(creative.brief.formats, pinSource) ?? t().jobs.regenerateRequest));

      const { context, existing } = await this.buildContext(ref, store, creative.linkedCodebases);
      const uncheckable = new Set<string>();

      let resumeSessionId = creative.resumeFrom?.sessionId ?? latest?.sessionId ?? undefined;
      let forkSession = Boolean(creative.resumeFrom);
      let kind: PromptKind = versions.length === 0 ? 'first' : 'iteration';
      let problems: string[] = [];
      let result = null as Awaited<ReturnType<typeof validateOutputs>> | null;
      let lastWrite: Promise<void> = Promise.resolve();
      // One ledger record per attempt: the version's usage is their sum (fix loop included).
      const attemptUsage: Array<UsageRecord | null | undefined> = [];

      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        // One decision per attempt, shared by the prompt's claims and the launched policy.
        const sandboxed = await this.deps.launcher.sandboxed();
        const prompt = buildCreativePrompt({
          slug, creative, presets, version: n, kind,
          userText: kind === 'fix' ? undefined : request,
          pins: kind === 'iteration' ? message?.pins : undefined,
          attachments: kind === 'iteration' ? attachments : undefined,
          problems, context, locale, sandboxed,
        });
        const snapshotsBefore = await Promise.all(existing.map((p) => codebaseSnapshot(p)));
        for (const [k, p] of existing.entries()) {
          const snap = snapshotsBefore[k]!;
          if ('value' in snap || uncheckable.has(p)) continue;
          uncheckable.add(p);
          const text = snap.unavailable === 'not-git' ? t().jobs.codebaseNotRepo({ path: p }) : t().jobs.codebaseCheckFailed({ path: p });
          await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text });
        }
        const run = await this.deps.launcher.start({
          kind: 'creative', jobId, projectSlug: ref.projectSlug, projectDir: ref.projectDir, creativeSlug: slug, codebases: existing,
          request: { prompt, resumeSessionId, forkSession, model },
          usage: { version: n, attempt }, sandboxed,
          onEvent: (event) => {
            this.deps.broadcast({ type: 'agent', jobId, event });
            // Live usage estimates are only for the UI (up to one a second): the final usage event is the one kept.
            if (event.kind === 'usage' && event.live) return;
            // Chained so writes stay ordered and a failure surfaces when the chain is awaited after the turn.
            lastWrite = lastWrite.then(() => store.appendConversation(slug, { type: 'agent', at: now(), jobId, event }));
            lastWrite.catch(() => {}); // observed here; the same rejection is rethrown by the await below
            const sid = event.kind === 'session' || event.kind === 'result' ? event.sessionId : undefined;
            if (sid) this.deps.queue.patch(jobId, { sessionId: sid });
          },
          validate: () => validateOutputs({ dir: store.outputsDir(slug, n), requested: creative.brief.formats, presets, durationSec: creative.brief.durationSec, media: this.deps.media, locale }),
        });
        const onAbort = () => run.cancel();
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort(); // cancelled before the listener existed (e.g. while preparing the turn)
        const outcome = await run.done.finally(() => signal.removeEventListener('abort', onAbort));
        attemptUsage.push(outcome.usage);
        await lastWrite;
        const snapshotsAfter = await Promise.all(existing.map((p) => codebaseSnapshot(p)));
        for (const [k, p] of existing.entries()) {
          const b = snapshotsBefore[k]!;
          const a = snapshotsAfter[k]!;
          // A repo that appears during the turn (git init) counts as a change too.
          const changed = 'value' in b ? 'value' in a && a.value !== b.value : 'value' in a;
          if (changed) {
            await store.appendConversation(slug, { type: 'system', at: now(), level: 'error', text: t().jobs.codebaseChanged({ path: p }) });
          }
        }
        if (outcome.status === 'cancelled') return await this.cancelled(ref, store, previous, versions.length > 0);
        if (outcome.status === 'failed') throw new AgentFailure(outcome.error ?? t().errors.turnFailed);
        resumeSessionId = outcome.sessionId ?? resumeSessionId;
        forkSession = false;

        result = await validateOutputs({ dir: store.outputsDir(slug, n), requested: creative.brief.formats, presets, durationSec: creative.brief.durationSec, media: this.deps.media, locale });
        problems = result.problems;
        // A preset missing from the catalog cannot be fixed by the agent: retrying would only waste turns.
        if (problems.length === result.unknownPresets.length || attempt === this.maxAttempts) break;
        await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: t().jobs.checkingOutputs({ count: problems.length, attempt: attempt + 1, max: this.maxAttempts }) });
        this.changed(ref);
        kind = 'fix';
      }

      finalizing = true;
      const status = problems.length === 0 ? 'complete' : 'incomplete';
      // Hashed by the core from the files, after the agent is done: never taken from anything the agent wrote.
      const outputs = await hashVersionOutputs(store.dir(slug), n, result?.outputs ?? []);
      const commit = await this.deps.git.commitAll(ref.projectDir, `${creative.title}: v${n}`);
      const usage = sumUsage(attemptUsage);
      await store.appendVersion(slug, {
        n, commit, sessionId: resumeSessionId ?? null, status, createdAt: now(),
        request: request ?? t().jobs.requestFromBrief,
        outputs, problems, tools: result?.tools ?? [], renderCommand: result?.renderCommand ?? null,
        basedOn: creative.resumeFrom?.version ?? latest?.n ?? null,
        ...(usage ? { usage } : {}),
      });
      await store.appendConversation(slug, { type: 'version', at: now(), n, status });
      await store.update(slug, { status: status === 'complete' ? 'ready' : 'incomplete', error: null, resumeFrom: null });
      if (signal.aborted) {
        await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: t().jobs.lateCancel({ n }) });
      }
      await this.commitState(ref, t().jobs.versionStateCommit({ title: creative.title, n }));
      this.changed(ref);
    } catch (err) {
      if (signal.aborted && !finalizing) return await this.cancelled(ref, store, previous, (await store.readVersions(slug)).length > 0);
      const text = err instanceof Error ? err.message : String(err);
      await store.update(slug, { status: 'error', error: text }).catch(() => {});
      await store.appendConversation(slug, { type: 'system', at: now(), level: 'error', text: t().jobs.generationFailed({ text }) }).catch(() => {});
      await this.commitState(ref, t().jobs.stateCommit({ title: await this.titleOf(store, slug) }));
      this.changed(ref);
      // After a late abort the queue would read a plain rejection as a cancel: this failure is real.
      throw finalizing ? new JobFailedError(text) : err;
    }
  }

  private async buildContext(ref: CreativeRef, store: CreativeStore, creativeCodebases: LinkedCodebase[]): Promise<{ context: CreativeContext; existing: string[] }> {
    const note = (text: string) => store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text });
    const brand = new BrandStore(ref.projectDir);
    const library = new LibraryStore(ref.projectDir, this.deps.media);
    let kit = EMPTY_BRAND_KIT;
    try { kit = await brand.readKit(); } catch (e) { await note(t().jobs.brandKitUnreadable({ detail: (e as Error).message })); }
    let hasGuidelines = false;
    try { hasGuidelines = (await brand.readGuidelines()).trim() !== ''; } catch (e) { await note(t().jobs.guidelinesUnreadable({ detail: (e as Error).message })); }
    let assets = 0;
    try { assets = (await library.listAssets()).length; } catch (e) { await note(t().jobs.assetListUnreadable({ detail: (e as Error).message })); }
    let references = 0;
    try { references = (await library.listReferences()).length; } catch (e) { await note(t().jobs.referenceListUnreadable({ detail: (e as Error).message })); }
    const project = await readJsonFile(join(ref.projectDir, 'project.json'), projectFileSchema);
    const normalized: LinkedCodebase[] = [];
    for (const c of [...project.linkedCodebases, ...creativeCodebases]) {
      try {
        const [n] = normalizeCodebaseList([c]);
        if (n && await codebaseOverlaps(n.path, [ref.projectDir, ref.root])) await note(t().jobs.codebaseIgnored({ path: n.path, reason: codebaseOverlapMessage() }));
        else if (n) normalized.push(n);
      } catch (e) { await note(t().jobs.codebaseIgnored({ path: c.path, reason: (e as Error).message })); }
    }
    const checks = await checkCodebases(normalizeCodebaseList(normalized));
    for (const c of checks.filter((x) => !x.exists)) await note(t().jobs.codebaseMissing({ path: c.path }));
    const existing = checks.filter((c) => c.exists);
    return {
      context: { kit, hasGuidelines, assets, references, codebases: existing.map(({ path, note: n }) => ({ path, ...(n ? { note: n } : {}) })), missingCodebases: checks.filter((c) => !c.exists).map((c) => c.path), tools: this.deps.launcher.mcpActive() ? await availableTools(this.deps.vault) : [] },
      existing: existing.map((c) => c.path),
    };
  }

  private async cancelled(ref: CreativeRef, store: CreativeStore, previous: CreativeStatus, hasVersions: boolean): Promise<'cancelled'> {
    const restored: CreativeStatus = previous === 'ready' || previous === 'incomplete' || previous === 'draft'
      ? previous : hasVersions ? 'ready' : 'draft';
    await store.update(ref.creativeSlug, { status: restored, error: null });
    await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: t().jobs.cancelledNote });
    await this.commitState(ref, t().jobs.stateCommit({ title: await this.titleOf(store, ref.creativeSlug) }));
    this.changed(ref);
    return 'cancelled';
  }

  /** Best-effort commit of the creative's metadata: never throws, so it cannot change the outcome of a turn. */
  private async commitState(ref: CreativeRef, message: string): Promise<void> {
    try { await this.deps.git.commitAll(ref.projectDir, message); } catch { /* the tree stays dirty until the next commit */ }
  }

  private async titleOf(store: CreativeStore, slug: string): Promise<string> {
    try { return (await store.get(slug)).title; } catch { return slug; }
  }

  /**
   * outputs/v<n> of a version that was never saved (e.g. a failed earlier turn) must not leak into this one.
   * A saved version's folder is never touched, even if n were already taken.
   */
  private async clearStaleOutputs(store: CreativeStore, slug: string, n: number, versions: VersionEntry[]): Promise<void> {
    if (versions.some((v) => v.n === n)) return;
    const dir = store.outputsDir(slug, n);
    const info = await lstat(dir).catch(() => null);
    if (!info) return;
    // A symlink or file is removed as an entry, never followed.
    await rm(dir, info.isDirectory() ? { recursive: true, force: true } : { force: true });
  }

  private async extractPinFrames(ref: CreativeRef, store: CreativeStore, pins: Pin[], source: { n: number; outputs: Array<{ format: string; file: string }> } | undefined, n: number): Promise<string[]> {
    if (!this.deps.media.available || !source) return [];
    const out: string[] = [];
    for (const [i, pin] of pins.entries()) {
      if (pin.timeSec === null) continue;
      const output = source.outputs.find((o) => o.format === pin.format);
      if (!output) continue;
      const target = join(store.workDir(ref.creativeSlug), '.feedback', `${n}-${i + 1}.jpg`);
      try {
        if (await this.deps.media.frame(join(store.outputsDir(ref.creativeSlug, source.n), output.file), target, pin.timeSec)) {
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

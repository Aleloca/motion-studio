import { lstat, rm, writeFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { checkLink, defaultLinks, effectiveLinks, formatHistory, formatLabel, manifestSchema, starOf, EMPTY_BRAND_KIT, projectFileSchema, type Brief, type LinkedCodebase, type CreativeFile, type CreativeStatus, type FormatPreset, type JobSummary, type Locale, type ManifestFile, type OutputFileInfo, type Pin, type ServerMessage, type UsageRecord, type VersionEntry } from '@motion-studio/shared';
import type { AgentLauncher } from '../agent/launcher.ts';
import { BrandStore } from '../brand/brand-store.ts';
import { assertCodebasesOutside, checkCodebases, codebaseOverlaps, codebaseOverlapMessage, codebaseSnapshot, normalizeCodebaseList } from '../codebases.ts';
import { readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { findPreset } from '../formats/format-catalog.ts';
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
import { validateOutputs, type ValidationResult } from './output-contract.ts';
import { confinedSha, copyVerified, earlierOutputDirs, followCheck, isConfinedFile, normalizeTargets, snapshotChanges, snapshotOutputs, versionDirReady, type FollowFailure } from './carry-over.ts';
import { outputFileExists } from './format-summary.ts';
import { hashVersionOutputs, LAZY_HASH_BUDGET_MS, withLazyHashes } from './output-hashes.ts';
import { legacyProblemsOf } from './legacy-problems.ts';
import { buildCreativePrompt, type CreativeContext, type PromptKind } from './prompt.ts';
import { sumUsage } from '../usage/usage-tracker.ts';
import { currentLocale, t } from '../i18n.ts';

export interface CreativeTurnDeps {
  queue: JobQueue; launcher: AgentLauncher; git: Git; media: MediaTools; vault: SecretsVault;
  presets: () => Promise<FormatPreset[]>;
  model: () => Promise<string | null>;
  broadcast: (msg: ServerMessage) => void;
  maxAttempts?: number;
  /** How long an export pick waits for hashes before answering `hashes-pending` (default PICK_HASH_BUDGET_MS). */
  pickHashBudgetMs?: number;
}
export interface CreativeRef { root: string; projectSlug: string; projectDir: string; creativeSlug: string }

export const creativeJobKey = (root: string, projectSlug: string, creativeSlug: string) => `creative:${root}:${projectSlug}:${creativeSlug}`;
/** The render command comes from an agent-written manifest: single line, bounded, no control chars. */
const sanitizeCommand = (cmd: string): string => cmd.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300);

/**
 * The request of a turn that adds `added` (new formats the agent delivers) to `base`; the other formats are carried.
 * The base's render command is shown with its output folders pointing at this turn's `outputs/v<n>/`, so the agent is
 * never led to write into an earlier version.
 */
function addFormatsRequest(added: string[], base: VersionEntry | undefined, n: number): string | undefined {
  if (!base || added.length === 0) return undefined;
  const command = base.renderCommand ? sanitizeCommand(base.renderCommand).replace(/outputs\/v\d+(?!\w)/g, `outputs/v${n}`) : '';
  const j = t().jobs;
  return j.addFormatsRequest({ formats: added.join(', '), n: base.n })
    + (command ? ` ${j.renderCommandWas({ n: base.n, command })}` : '');
}

/** `TikTok and Shorts`, in the locale's own way. */
const listText = (items: string[], locale: Locale) => new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);

/** What a turn delivers (spec §2.3–2.5): the agent's targets, the primaries carried from the base, the links to materialize. */
interface TurnPlan {
  creative: CreativeFile;
  /** Primary formats the agent delivers, in the brief's order (empty: no agent at all, spec §2.4). */
  targets: string[];
  /** Primary formats copied unchanged from the base version. */
  carried: string[];
  /** Effective links, follower → primary: each follower is materialized from its primary's file. */
  links: Record<string, string>;
  /** Brief formats the base version has no file for. */
  added: string[];
  /**
   * The trusted sha256 of each carried file: the hash recorded for the base version, checked against the file before the
   * agent starts (or computed then for old versions without one). A copy must match it.
   */
  expected: Map<string, string>;
  /** Formats unlinked before the agent started (the follower could not follow its carried primary any more). */
  unlinked: string[];
  /** The format that owns `file` this turn when the core writes it (carried files, `<follower>.<ext>`). */
  reservedOwner: (file: string) => string | undefined;
}

/** One manifest entry; a duration the schema refuses (zero, negative) is left unknown. */
const manifestEntry = (format: string, o: Pick<OutputFileInfo, 'file' | 'width' | 'height' | 'durationSec'>, file = o.file): ManifestFile['files'][number] =>
  ({ format, file, width: o.width, height: o.height, durationSec: o.durationSec !== null && o.durationSec > 0 ? o.durationSec : null });
const now = () => new Date().toISOString();
/** How long an export pick waits for its format's hashes before taking the creative's lock (generous: it is not locked). */
export const PICK_HASH_BUDGET_MS = 60_000;
/** `Retry-After` of a pick refused because its hashes are still being computed. */
export const PICK_RETRY_AFTER_SEC = 5;

class AgentFailure extends Error {}

export class CreativeTurnService {
  private readonly maxAttempts: number;
  private readonly locks = new KeyedMutex();
  constructor(private readonly deps: CreativeTurnDeps) { this.maxAttempts = deps.maxAttempts ?? 3; }

  /**
   * Starts a turn. `opts.formats`: the formats the request applies to (spec §2.5); formats outside the brief are dropped, a
   * follower stands for its primary, and none (or absent) means every primary. The other formats are carried unchanged.
   */
  async start(ref: CreativeRef, message?: { text: string; pins: Pin[] }, opts: { formats?: string[] } = {}): Promise<JobSummary> {
    return this.locks.run(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug), () => this.startLocked(ref, message, opts.formats));
  }

  /** Edits title and/or brief; refused while a generation is queued or running for the creative. */
  async updateBrief(ref: CreativeRef, patch: { title?: string; brief?: Brief; linkedCodebases?: LinkedCodebase[] }): Promise<CreativeFile> {
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    return this.locks.run(key, async () => {
      if (this.isActive(key)) throw new WorkspaceError(409, t().errors.waitBeforeBrief);
      const store = new CreativeStore(ref.projectDir);
      const linkedCodebases = patch.linkedCodebases ? normalizeCodebaseList(patch.linkedCodebases) : null;
      if (linkedCodebases) await assertCodebasesOutside(linkedCodebases, [ref.projectDir, ref.root]);
      // Links change only through setLink (validated): a brief save keeps the stored ones, whatever it carries. Formats the
      // save adds get the default links against the primaries already there (and each other), with the duration unknown
      // (`undefined`): it is checked on the real file when the follower is materialized (spec §2.4).
      let brief: Brief | undefined;
      if (patch.brief) {
        const { links: _ignored, ...rest } = patch.brief;
        const current = (await store.get(ref.creativeSlug)).brief;
        const added = rest.formats.filter((f) => !current.formats.includes(f));
        let links = current.links;
        if (added.length > 0) {
          const presets = await this.deps.presets();
          const active = effectiveLinks(current.links, current.formats);
          const primaries = current.formats.filter((f) => rest.formats.includes(f) && !Object.hasOwn(active, f));
          const known = [...primaries, ...added].map((id) => findPreset(presets, id)).filter((p): p is FormatPreset => p !== undefined);
          const defaults = defaultLinks(known, undefined);
          const next = { ...current.links };
          for (const f of added) {
            delete next[f];
            if (Object.hasOwn(defaults, f)) next[f] = defaults[f]!;
          }
          links = next;
        }
        brief = links ? { ...rest, links } : rest;
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
    const store = new CreativeStore(ref.projectDir);
    const presets = await this.deps.presets();
    const label = (id: string) => { const p = presets.find((x) => x.id === id); return p ? formatLabel(p, currentLocale()) : id; };
    const e = t().errors;
    /** The checks that need no hashes; run on an unlocked read first (fail fast), then again under the lock. */
    const validate = (creative: CreativeFile, versions: VersionEntry[]) => {
      if (!creative.brief.formats.includes(format)) throw new CodedError(400, e.formatNotInBrief({ format: label(format) }), 'format-not-in-brief');
      const links = effectiveLinks(creative.brief.links, creative.brief.formats);
      if (Object.hasOwn(links, format)) throw new CodedError(400, e.pickFollower({ format: label(format), primary: label(links[format]!) }), 'pick-follower');
      if (version !== null) {
        const entry = versions.find((v) => v.n === version);
        if (!entry) throw new CodedError(404, e.versionNNotFound({ n: version }), 'version-not-found');
        if (!entry.outputs.some((o) => o.format === format)) throw new CodedError(400, e.pickNoFile({ format: label(format), n: version }), 'pick-no-file');
      }
      return links;
    };
    // The default rule needs this format's full history, so a pick is never decided on partial hashes: when they are not all
    // known in time, 503 `hashes-pending` (the hashing goes on; a retry finds them in the cache).
    const hashed = async (versions: VersionEntry[], budgetMs: number) => {
      const r = await withLazyHashes({
        projectDir: ref.projectDir, creativeSlug: ref.creativeSlug, creativeDir: store.dir(ref.creativeSlug), versions, formats: [format], budgetMs,
      });
      if (!r.complete) throw new CodedError(503, e.hashesPending, 'hashes-pending', PICK_RETRY_AFTER_SEC);
      return r.versions;
    };
    // Hashing can be slow: it happens before taking the creative's lock (which would block turns, restores and brief edits).
    const unlockedVersions = await store.readVersions(ref.creativeSlug);
    validate(await store.get(ref.creativeSlug), unlockedVersions);
    await hashed(unlockedVersions, this.deps.pickHashBudgetMs ?? PICK_HASH_BUDGET_MS);
    return this.locks.run(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug), async () => {
      // Re-read and re-check under the lock (the brief or the versions may have changed); the hashes come from the cache.
      const creative = await store.get(ref.creativeSlug);
      const raw = await store.readVersions(ref.creativeSlug);
      const links = validate(creative, raw);
      const versions = await hashed(raw, LAZY_HASH_BUDGET_MS);
      if (version !== null && !(await outputFileExists(store.dir(ref.creativeSlug), versions, version, format))) {
        throw new CodedError(409, e.pickFileMissing({ format: label(format), n: version }), 'pick-file-missing');
      }
      const picks = { ...creative.exportPicks };
      if (version === null || version === starOf(versions, format, undefined, links).version) delete picks[format];
      else picks[format] = version;
      const updated = await store.update(ref.creativeSlug, { exportPicks: Object.keys(picks).length > 0 ? picks : undefined });
      // A pick is allowed while a turn runs: only creative.json is committed, never what the agent is writing in work/.
      await this.commitCreativeFile(ref, store, t().jobs.stateCommit({ title: updated.title }));
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
      // Refused while a turn runs (above); still, only creative.json changes here, so only it is committed.
      await this.commitCreativeFile(ref, store, t().jobs.briefUpdatedCommit({ title: updated.title }));
      this.changed(ref);
      return updated;
    });
  }

  private async startLocked(ref: CreativeRef, message: { text: string; pins: Pin[] } | undefined, formats: string[] | undefined): Promise<JobSummary> {
    const store = new CreativeStore(ref.projectDir);
    const before = await store.get(ref.creativeSlug);
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    // Same check the queue does, but before touching the creative's files.
    if (this.isActive(key)) throw new WorkspaceError(409, t().errors.generationRunning);
    // A request for formats none of which is in the brief is a mistake, not "all formats".
    if (formats?.length && !formats.some((f) => before.brief.formats.includes(f))) throw new CodedError(400, t().errors.formatsNotInBrief, 'formats-not-in-brief');
    if (message) await store.appendConversation(ref.creativeSlug, { type: 'user', at: now(), text: message.text, pins: message.pins, attachments: [] });
    await store.update(ref.creativeSlug, { status: 'working', error: null });
    this.changed(ref);
    // What the turn targets, said up front (the web marks only those boards and their followers as rendering): the same
    // resolution `planTurn` makes (a first generation targets every primary). Untargeted: absent.
    const targets = formats?.length && (await store.readVersions(ref.creativeSlug)).length > 0 ? normalizeTargets(formats, before.brief.formats, effectiveLinks(before.brief.links, before.brief.formats)) : undefined;
    return this.deps.queue.enqueue({
      key,
      kind: 'creative',
      label: t().jobs.creativeLabel({ title: before.title }),
      ...(targets ? { formats: targets } : {}),
      run: (signal, jobId) => this.run(ref, store, before.status, message, signal, jobId, formats),
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

  private async run(ref: CreativeRef, store: CreativeStore, previous: CreativeStatus, message: { text: string; pins: Pin[] } | undefined, signal: AbortSignal, jobId: string, requestedFormats?: string[]): Promise<void | 'cancelled'> {
    const slug = ref.creativeSlug;
    // The agent's language is fixed when the job starts: a setting change mid-turn does not affect it.
    const locale = currentLocale();
    // Set once the last agent turn is over: from then on an abort no longer cancels (the version gets saved).
    let finalizing = false;
    try {
      await writeFile(join(ref.projectDir, '.studio', 'context.md'), CONTEXT_MD);
      const versions = await store.readVersions(slug);
      const latest = versions.at(-1);
      const n = await store.nextVersionNumber(slug);
      await this.clearStaleOutputs(store, slug, n, versions);
      const presets = await this.deps.presets();
      const model = (await this.deps.model()) ?? undefined;
      const initial = await store.get(slug);
      const creativeDir = store.dir(slug);
      // Pins, the carried files and the add-formats base refer to the version on screen: the one being resumed from, else the latest.
      const base = initial.resumeFrom ? versions.find((v) => v.n === initial.resumeFrom!.version) : latest;
      const attachments = await this.extractPinFrames(ref, store, message?.pins ?? [], base, n);
      const hasMessage = Boolean(message?.text || message?.pins.length);
      const plan = await this.planTurn(ref, store, initial, presets, base, hasMessage, requestedFormats, locale);
      const { creative, targets } = plan;
      const label = (id: string) => { const p = findPreset(presets, id); return p ? formatLabel(p, locale) : id; };
      const j = t().jobs;
      const noAgent = targets.length === 0;
      const primaries = creative.brief.formats.filter((f) => !Object.hasOwn(plan.links, f));
      // The plan may target more than the request (a primary that cannot be carried, a follower unlinked by its real
      // duration) or a part of the brief without one (added formats): the summary says what really renders.
      // No agent: only the added followers are made (copies), so only their boards render.
      this.deps.queue.patch(jobId, {
        formats: noAgent && plan.added.length > 0 ? [...plan.added]
          : targets.length > 0 && targets.length < primaries.length ? [...targets] : undefined,
      });
      const request = message?.text || (message?.pins.length ? j.pinsOnlyRequest : versions.length === 0 ? undefined
        : noAgent ? this.addedFollowersRequest(plan, base!, versions, label, locale)
          : (addFormatsRequest(targets.filter((f) => plan.added.includes(f)), base, n)
            ?? (targets.length < primaries.length ? j.regenerateFormatsRequest({ formats: listText(targets.map(label), locale) }) : j.regenerateRequest)));

      let resumeSessionId = creative.resumeFrom?.sessionId ?? latest?.sessionId ?? undefined;
      let result = null as ValidationResult | null;
      // One ledger record per attempt: the version's usage is their sum (fix loop included). No agent: no record, no usage.
      const attemptUsage: Array<UsageRecord | null | undefined> = [];

      if (!noAgent) {
        const { context, existing } = await this.buildContext(ref, store, creative.linkedCodebases);
        const uncheckable = new Set<string>();
        let forkSession = Boolean(creative.resumeFrom);
        let kind: PromptKind = versions.length === 0 ? 'first' : 'iteration';
        let problems: string[] = [];
        let lastWrite: Promise<void> = Promise.resolve();
        // The agent delivers and is checked on its target formats only: the carried and linked ones are the core's job.
        const validateTargets = () => validateOutputs({
          dir: store.outputsDir(slug, n), requested: targets, presets, durationSec: creative.brief.durationSec, media: this.deps.media, locale,
          reservedOwner: plan.reservedOwner,
        });
        // Earlier versions are read-only for the agent (sandbox and Edit/Write rules); any change is still detected after.
        const earlier = await earlierOutputDirs(creativeDir, n);
        const earlierBefore = await snapshotOutputs(creativeDir, earlier);

        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
          // One decision per attempt, shared by the prompt's claims and the launched policy.
          const sandboxed = await this.deps.launcher.sandboxed();
          const prompt = buildCreativePrompt({
            slug, creative, presets, version: n, kind, formats: targets,
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
            protectedDirs: earlier.map((d) => join(creativeDir, 'outputs', d)),
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
            validate: validateTargets,
          });
          const onAbort = () => run.cancel();
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort(); // cancelled before the listener existed (e.g. while preparing the turn)
          const outcome = await run.done.finally(() => signal.removeEventListener('abort', onAbort));
          // Whatever the agent left running (a background render, a watcher) stops here: nothing writes in the version
          // folder while it is checked, completed and hashed.
          run.killGroup?.();
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

          result = await validateTargets();
          problems = result.problems;
          // A preset missing from the catalog cannot be fixed by the agent: retrying would only waste turns.
          if (problems.length === result.unknownPresets.length || attempt === this.maxAttempts) break;
          await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: t().jobs.checkingOutputs({ count: problems.length, attempt: attempt + 1, max: this.maxAttempts }) });
          this.changed(ref);
          kind = 'fix';
        }
        const changedEarlier = snapshotChanges(earlierBefore, await snapshotOutputs(creativeDir, earlier));
        if (changedEarlier.length > 0) {
          const list = changedEarlier.slice(0, 5).join(', ') + (changedEarlier.length > 5 ? ', …' : '');
          await store.appendConversation(slug, { type: 'system', at: now(), level: 'warning', text: j.earlierOutputsChanged({ list }) });
        }
      } else if (signal.aborted) {
        return await this.cancelled(ref, store, previous, versions.length > 0);
      }

      finalizing = true;
      const assembled = await this.assemble(ref, store, plan, presets, base, n, result, label, locale);
      // Hashed by the core from the files, after the agent is done: never taken from anything the agent wrote.
      const outputs = await hashVersionOutputs(creativeDir, n, assembled.outputs);
      const problems = [...assembled.problems];
      // Each file the core copied must still be the copy it verified.
      for (const o of outputs) {
        const copied = assembled.copied.get(o.format);
        if (copied !== undefined && o.sha256 !== copied) {
          // No hash at all (the file could not be read as a confined file) is not proof of a change.
          const text = o.sha256 === undefined ? j.copyUnverified({ format: label(o.format) }) : j.copyChangedAfter({ format: label(o.format) });
          problems.push(text);
          o.problems = [...(o.problems ?? []), text];
        }
      }
      const status = problems.length === 0 ? 'complete' : 'incomplete';
      const commit = await this.deps.git.commitAll(ref.projectDir, `${creative.title}: v${n}`);
      const usage = sumUsage(attemptUsage);
      await store.appendVersion(slug, {
        n, commit, sessionId: resumeSessionId ?? null, status, createdAt: now(),
        request: request ?? t().jobs.requestFromBrief,
        outputs, problems, tools: assembled.tools, renderCommand: assembled.renderCommand,
        basedOn: creative.resumeFrom?.version ?? latest?.n ?? null,
        ...(usage ? { usage } : {}),
      });
      if (noAgent && request) await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: `${request} · ${j.noAgentNeeded}` });
      await store.appendConversation(slug, { type: 'version', at: now(), n, status });
      // A version made without the agent after a restart keeps the restart's intent: the next agent turn still forks the
      // restored session (from this new version, which it now builds on).
      const resumeFrom = noAgent && creative.resumeFrom ? { version: n, sessionId: creative.resumeFrom.sessionId } : null;
      await store.update(slug, { status: status === 'complete' ? 'ready' : 'incomplete', error: null, resumeFrom });
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

  /**
   * Decides what the turn delivers (spec §2.3–2.5):
   * - targets: the requested formats (`normalizeTargets`); with no request and no explicit formats, a brief that gained
   *   formats targets only the new primaries (spec §2.4), else every primary; no base version: every primary. A primary
   *   whose file in the base is missing, unusable (a link) or not the one recorded for that version is always a target:
   *   it cannot be carried;
   * - carried: the other primaries, copied from the base, each with the hash its copy must have;
   * - links: every effective link. A follower of a carried primary is checked now on the base file (its real duration and
   *   size); one that cannot follow any more is unlinked in the brief (even if the turn is then cancelled), told in the chat
   *   and delivered by the agent.
   */
  private async planTurn(ref: CreativeRef, store: CreativeStore, creative: CreativeFile, presets: FormatPreset[], base: VersionEntry | undefined,
    hasMessage: boolean, requested: string[] | undefined, locale: Locale): Promise<TurnPlan> {
    const slug = ref.creativeSlug;
    const creativeDir = store.dir(slug);
    const { formats } = creative.brief;
    const links = effectiveLinks(creative.brief.links, formats);
    const isPrimary = (f: string) => !Object.hasOwn(links, f);
    const baseOut = (f: string) => base?.outputs.find((o) => o.format === f);
    const added = base ? formats.filter((f) => !baseOut(f)) : [];
    let targets: string[];
    if (!base) targets = formats.filter(isPrimary);
    else if (requested?.length) targets = normalizeTargets(requested, formats, links);
    else if (!hasMessage && added.length > 0) targets = added.filter(isPrimary);
    else targets = formats.filter(isPrimary);
    const wanted = new Set(targets);
    const usable = new Map<string, number>(); // carried primary → size of its base file
    const expected = new Map<string, string>();
    if (base) {
      for (const p of formats.filter(isPrimary)) {
        if (wanted.has(p)) continue;
        const out = baseOut(p);
        const rel = out ? `outputs/v${base.n}/${out.file}` : null;
        const file = rel ? await isConfinedFile(creativeDir, rel) : null;
        // The file as it is now, before the agent runs; it must be the one recorded for the base version (when recorded).
        const sha = rel && file ? await confinedSha(creativeDir, rel) : null;
        if (file && sha !== null && (out!.sha256 === undefined || out!.sha256 === sha)) {
          usable.set(p, file.size);
          expected.set(p, sha);
        } else wanted.add(p);
      }
    }
    const label = (id: string) => { const p = findPreset(presets, id); return p ? formatLabel(p, locale) : id; };
    const e = t().errors;
    const unlinked: string[] = [];
    for (const [f, p] of Object.entries(links)) {
      if (wanted.has(p)) continue; // the primary is delivered now: checked on the new file, after the render
      const pp = findPreset(presets, p);
      const fp = findPreset(presets, f);
      const check: { ok: true } | { ok: false; reason: FollowFailure } = pp && fp ? followCheck(pp, fp, baseOut(p)!, usable.get(p)!) : { ok: false, reason: 'unknown' };
      if (check.ok) continue;
      unlinked.push(f);
      wanted.add(f);
      await store.appendConversation(slug, { type: 'system', at: now(), level: 'warning', text: t().jobs.followerUnlinked({ follower: label(f), primary: label(p), reason: e.followReason[check.reason] }) });
    }
    let current = creative;
    if (unlinked.length > 0) {
      current = await this.unlinkFollowers(store, slug, unlinked);
      for (const f of unlinked) delete links[f];
    }
    const primaries = formats.filter(isPrimary);
    const carried = base ? primaries.filter((f) => !wanted.has(f)) : [];
    // Core-owned names: each carried file, and `<follower>.<any extension>` (the extension is the primary's, known later).
    const carriedNames = new Map(carried.map((f) => [baseOut(f)!.file, f] as const));
    const followerIds = new Set(Object.keys(links));
    const reservedOwner = (file: string) => {
      const dot = file.lastIndexOf('.');
      const stem = dot > 0 ? file.slice(0, dot) : file;
      return carriedNames.get(file) ?? (followerIds.has(stem) ? stem : undefined);
    };
    return {
      creative: current, links, added, expected, unlinked, reservedOwner,
      targets: primaries.filter((f) => wanted.has(f)),
      carried,
    };
  }

  /** Removes the links of `followers` from the stored brief: from the next turn on each is its own primary. */
  private async unlinkFollowers(store: CreativeStore, slug: string, followers: string[]): Promise<CreativeFile> {
    const fresh = await store.get(slug);
    const links = effectiveLinks(fresh.brief.links, fresh.brief.formats);
    for (const f of followers) delete links[f];
    return store.update(slug, { brief: { ...fresh.brief, links } });
  }

  /**
   * "Added TikTok and Shorts using the Reel (v5)": the request of a version made without the agent (spec §2.4). The number
   * is the primary's own history entry for the file copied (the latest history version ≤ `base`, i.e. where those bytes
   * first appeared), the version the user knows the primary by, not the creative version the copy came from.
   */
  private addedFollowersRequest(plan: TurnPlan, base: VersionEntry, versions: VersionEntry[], label: (id: string) => string, locale: Locale): string {
    const byPrimary = new Map<string, string[]>();
    for (const f of plan.added) {
      const p = plan.links[f];
      if (p !== undefined) byPrimary.set(p, [...(byPrimary.get(p) ?? []), label(f)]);
    }
    const upToBase = versions.filter((v) => v.n <= base.n);
    const entryOf = (p: string) => formatHistory(upToBase, p).at(-1) ?? base.n;
    return [...byPrimary].map(([p, fs]) => t().jobs.addedFollowers({ formats: listText(fs, locale), primary: label(p), n: entryOf(p) })).join('; ');
  }

  /**
   * Completes `outputs/v<n>` after the agent (spec §2.3–2.5), before the version is hashed and committed:
   * 1. every non-target format the agent wrote anyway is discarded first, before any copy. "Wrote" means: after its last
   *    attempt the folder has an entry (file, link or folder) at the name the core writes for that format, or the agent's
   *    manifest lists the format. A format whose core copy then succeeds gets the note `outputs.keptUnchanged`;
   * 2. the carried primaries are copied from the base version; each copy must match the hash taken before the agent ran
   *    (`plan.expected`), never the source's current bytes. A failed copy is a version problem (`carriedChanged` when the
   *    base file is no longer the recorded one, else `copyFailed`) and the format is left out of the version;
   * 3. each follower is re-checked on its primary's actual file (`canFollow` with its real duration, `maxFileMB` with its
   *    size), then copied to `<follower>.<primary's extension>`. A failed link is not delivered: a problem, a chat message,
   *    and the link is removed so the next turn makes a dedicated version. A failed copy is a problem (`copyFailed`);
   * 4. manifest.json is rewritten by the core (`followsFormat` only on the followers it made; anything the agent wrote in
   *    that field is dropped), then the whole version is validated: targets fully, carried files on presence and dimensions
   *    plus the problems they had in the base, followers on presence and dimensions plus their primary's problems.
   * With nothing to carry or link, the agent's delivery is the version: only `followsFormat` is stripped from its manifest.
   * `copied`: the sha256 of every file the core copied, to be cross-checked with the version's hashes.
   */
  private async assemble(ref: CreativeRef, store: CreativeStore, plan: TurnPlan, presets: FormatPreset[], base: VersionEntry | undefined, n: number,
    result: ValidationResult | null, label: (id: string) => string, locale: Locale): Promise<{ outputs: OutputFileInfo[]; problems: string[]; tools: string[]; renderCommand: string | null; copied: Map<string, string> }> {
    const slug = ref.creativeSlug;
    const creativeDir = store.dir(slug);
    const dir = store.outputsDir(slug, n);
    const manifestPath = join(dir, 'manifest.json');
    const { creative, targets, carried, links } = plan;
    const j = t().jobs;
    const copied = new Map<string, string>();
    let replaced: boolean;
    try { replaced = await versionDirReady(creativeDir, n); } catch { throw new Error(j.versionFolderUnsafe({ n })); }
    // The agent's folder was a link (now replaced by a real, empty folder): its delivery is checked again, so nothing
    // outside the creative is ever listed.
    if (replaced && result) result = await validateOutputs({ dir, requested: targets, presets, durationSec: creative.brief.durationSec, media: this.deps.media, locale, reservedOwner: plan.reservedOwner });
    const agentManifest = targets.length > 0 ? await readJsonFile(manifestPath, manifestSchema).catch(() => null) : null;
    const strip = (files: ManifestFile['files']) => files.map(({ followsFormat: _ignored, ...entry }) => entry);
    if (carried.length === 0 && Object.keys(links).length === 0 && result) {
      if (agentManifest?.files.some((f) => f.followsFormat !== undefined)) await writeJsonFileAtomic(manifestPath, { ...agentManifest, files: strip(agentManifest.files) });
      return { outputs: result.outputs, problems: result.problems, tools: result.tools, renderCommand: result.renderCommand, copied };
    }
    const vRel = `outputs/v${n}`;
    const targetOuts = result?.outputs ?? [];
    const targetFiles = new Set(targetOuts.map((o) => o.file));
    const baseOut = (f: string) => base?.outputs.find((o) => o.format === f);
    const primaryOut = (p: string) => (targets.includes(p) ? targetOuts.find((o) => o.format === p) : carried.includes(p) ? baseOut(p) : undefined);
    const followerName = (f: string) => { const o = primaryOut(links[f]!); return o ? `${f}${extname(o.file).toLowerCase()}` : undefined; };
    const touched = new Set<string>();
    const discard = async (format: string, dest: string | undefined) => {
      const entry = agentManifest?.files.find((e) => e.format === format);
      const atDest = dest ? await lstat(join(dir, dest)).catch(() => null) : null;
      if (!entry && !atDest) return;
      touched.add(format);
      for (const name of new Set([dest, entry?.file])) {
        // Never a file a target delivered (that name clash is the target's problem), nor the manifest (rewritten below).
        if (name && !targetFiles.has(name) && name !== 'manifest.json') await rm(join(dir, name), { recursive: true, force: true });
      }
    };
    // 1. Discards, all before any copy.
    for (const p of carried) await discard(p, baseOut(p)!.file);
    for (const f of Object.keys(links)) await discard(f, followerName(f));

    const problems: string[] = [];
    // 2. Carried primaries.
    for (const p of carried) {
      const out = baseOut(p)!;
      const from = `outputs/v${base!.n}/${out.file}`;
      const sha = await copyVerified(creativeDir, from, `${vRel}/${out.file}`, plan.expected.get(p)!);
      if (sha !== null) { copied.set(p, sha); continue; }
      const current = await confinedSha(creativeDir, from);
      problems.push(current !== null && current !== plan.expected.get(p) ? j.carriedChanged({ format: label(p), n: base!.n }) : j.copyFailed({ format: label(p) }));
    }
    // 3. Followers.
    const materialized: Record<string, string> = {};
    const notDelivered: string[] = [];
    const e = t().errors;
    for (const [f, p] of Object.entries(links)) {
      const out = primaryOut(p);
      const dest = followerName(f);
      if (!out || !dest) continue; // the primary has no file: its own problem says so, and the link stays
      if (carried.includes(p) && !copied.has(p)) { problems.push(j.copyFailed({ format: label(f) })); continue; }
      const file = await isConfinedFile(creativeDir, `${vRel}/${out.file}`);
      if (!file) { problems.push(j.copyFailed({ format: label(f) })); continue; }
      const pp = findPreset(presets, p);
      const fp = findPreset(presets, f);
      const check: { ok: true } | { ok: false; reason: FollowFailure } = pp && fp ? followCheck(pp, fp, out, file.size) : { ok: false, reason: 'unknown' };
      if (!check.ok) {
        const text = j.followerNotDelivered({ follower: label(f), primary: label(p), reason: e.followReason[check.reason] });
        notDelivered.push(f);
        problems.push(text);
        await store.appendConversation(slug, { type: 'system', at: now(), level: 'warning', text });
        continue;
      }
      // The agent is gone (its process group was killed): the primary's bytes now are the ones to copy.
      const source = copied.get(p) ?? await confinedSha(creativeDir, `${vRel}/${out.file}`);
      const sha = source !== null ? await copyVerified(creativeDir, `${vRel}/${out.file}`, `${vRel}/${dest}`, source) : null;
      if (sha !== null) { materialized[f] = p; copied.set(f, sha); } else problems.push(j.copyFailed({ format: label(f) }));
    }
    if (notDelivered.length > 0) await this.unlinkFollowers(store, slug, notDelivered);

    const { formats } = creative.brief;
    const files = formats.flatMap((f): ManifestFile['files'] => {
      if (targets.includes(f)) return strip((agentManifest?.files ?? []).filter((x) => x.format === f).slice(0, 1));
      if (carried.includes(f)) return copied.has(f) ? [manifestEntry(f, baseOut(f)!)] : [];
      const p = materialized[f];
      return p !== undefined ? [{ ...manifestEntry(f, primaryOut(p)!, followerName(f)), followsFormat: p }] : [];
    });
    await rm(manifestPath, { recursive: true, force: true });
    await writeJsonFileAtomic(manifestPath, {
      schemaVersion: 1, files,
      tools: result?.tools ?? base?.tools ?? [], renderCommand: result ? result.renderCommand : base?.renderCommand ?? null,
    });
    const carriedOk = carried.filter((f) => copied.has(f));
    const requested = formats.filter((f) => targets.includes(f) || carriedOk.includes(f) || Object.hasOwn(materialized, f));
    // A carried file keeps the problems it had in the base. Old versions have no per-file problems: only the version's
    // problems that name this format's file, id or label are its own; the others belong to other formats.
    // Matched as whole tokens (`legacyProblemsOf`): an id that is a prefix of another never takes its problems.
    const legacyProblems = (f: string) => legacyProblemsOf(base!.problems, f, baseOut(f)!.file, label(f));
    const inherited = Object.fromEntries(carriedOk.map((f) => [f, baseOut(f)!.problems ?? legacyProblems(f)] as const));
    const final = await validateOutputs({
      dir, requested, presets, durationSec: creative.brief.durationSec, media: this.deps.media, locale,
      carried: carriedOk, followers: materialized, inherited, reservedOwner: plan.reservedOwner,
    });
    // An unreadable agent manifest: its own problem says more than "missing format" for each target.
    const manifestProblems = targets.length > 0 && !agentManifest ? (result?.outputs.length === 0 ? result.problems.filter((x) => !final.problems.includes(x)) : []) : [];
    // A note only where the core's copy is really there: a carried format kept its previous file; a follower got a fresh
    // copy of its primary (not "the previous one").
    const note = (f: string) => (Object.hasOwn(materialized, f)
      ? { key: 'outputs.followerReplaced', params: { format: f, primary: materialized[f]! } }
      : { key: 'outputs.keptUnchanged', params: { format: f } });
    const outputs = final.outputs.map((o) => (touched.has(o.format) && copied.has(o.format)
      ? { ...o, warnings: [...(o.warnings ?? []), note(o.format)] } : o));
    return {
      outputs, copied,
      // A format the core could not deliver is a problem of the version (a brief format is missing), not of any file.
      problems: [...manifestProblems, ...final.problems, ...problems.filter((x) => !final.problems.includes(x))],
      tools: result?.tools ?? base?.tools ?? [], renderCommand: result ? result.renderCommand : base?.renderCommand ?? null,
    };
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

  /** Commits the creative's creative.json alone (by path): safe while an agent writes elsewhere in the project. */
  private async commitCreativeFile(ref: CreativeRef, store: CreativeStore, message: string): Promise<void> {
    const rel = relative(ref.projectDir, join(store.dir(ref.creativeSlug), 'creative.json')).split(sep).join('/');
    try { await this.deps.git.commitPaths(ref.projectDir, [rel], message); } catch { /* picked up by the next commit */ }
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

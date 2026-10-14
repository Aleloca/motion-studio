import { creativeJobKey, LIVE_LIMITS, type ConversationEntry, type LiveMessageOutcome, type QueuedRequest, type RedirectOutcome } from '@motion-studio/shared';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { canFollow, effectiveServices, checkLink, effectiveLinks, legacyTurnKind, linksAfterBriefSave, formatHistory, formatDisplayName, hasFormat, manifestSchema, messages, renderState, starOf, EMPTY_BRAND_KIT, projectFileSchema, type Brief, type LinkedCodebase, type CreativeFile, type CreativeStatus, type FormatPreset, type JobSummary, type AgentEvent, type Locale, type ManifestFile, type OutputFileInfo, type Pin, type ServerMessage, type UsageRecord, type VersionComposition, type VersionEntry } from '@motion-studio/shared';
import type { AgentLauncher } from '../agent/launcher.ts';
import { detachLinksUnder } from '../agent/protected-links.ts';
import { noteCoreChange } from '../core-changes.ts';
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
import type { KeyCheckCache } from '../providers/key-check.ts';
import type { SecretsVault } from '../secrets/vault.ts';
import { compositionSchemaFile, CONTEXT_MD } from '../project-template.ts';
import { CodedError, WorkspaceError } from '../workspace-store.ts';
import { CreativeStore } from './creative-store.ts';
import { validateOutputs, type ValidationResult } from './output-contract.ts';
import { confinedSha, copyVerified, earlierOutputDirs, followCheck, isConfinedFile, normalizeTargets, snapshotChanges, snapshotOutputs, versionDirReady, withoutCoreWrites, type FollowFailure } from './carry-over.ts';
import { outputFileExists } from './format-summary.ts';
import { hashVersionOutputs, LAZY_HASH_BUDGET_MS, withLazyHashes } from './output-hashes.ts';
import { legacyProblemsOf } from './legacy-problems.ts';
import { clearReferenceFrames, conversionPlan, extractReferenceFrames } from './legacy-conversion.ts';
import { AnswerCache, checkLiveMessage, liveMessageText, LiveSession, newLiveMessage, NO_LIVE, redirectLive, type LiveMessage, type UserMessageInput } from '../agent/live-session.ts';
import { buildCreativePrompt, pinLine, type AgentContract, type CreativeContext, type PromptKind } from './prompt.ts';
import { checkTargets } from './composition-contract.ts';
import { realDirChain, writeThroughTemp } from './core-files.ts';
import { acceptedDurationsOf, alignEditorCopies, assembleCompositions, carriableComposition, type CarriedComposition } from './composition-turn.ts';
import { checkedPreviewTimes, type PreviewService } from './previews.ts';
import { sumUsage } from '../usage/usage-tracker.ts';
import { carryLocalizations } from '../localization/carry.ts';
import { instanceComposition, type InstanceComposition } from '../localization/store.ts';
import { currentLocale, t } from '../i18n.ts';

export interface CreativeTurnDeps {
  queue: JobQueue; launcher: AgentLauncher; git: Git; media: MediaTools; vault: SecretsVault;
  /** What is known about the keys (F5: a capability checked `missing` is listed as unavailable in the prompt). */
  keyChecks?: KeyCheckCache;
  presets: () => Promise<FormatPreset[]>;
  model: () => Promise<string | null>;
  broadcast: (msg: ServerMessage) => void;
  maxAttempts?: number;
  /** How long an export pick waits for hashes before answering `hashes-pending` (default PICK_HASH_BUDGET_MS). */
  pickHashBudgetMs?: number;
  /**
   * What the agent delivers: `compositions` (default, output contract v2, Task 5b) or `media`, the phase 9 contract of
   * rendered files and manifest v1. `media` is kept ONLY for the phase 9 test suites, whose histories are built from
   * rendered media; the app always uses compositions.
   */
  agentContract?: AgentContract;
  /** Storyboards, the agent's `preview_frames` and pin frames of unrendered versions; absent: none of them. */
  previews?: PreviewService;
  /** `preview_frames` calls allowed per turn (default 10). */
  previewFramesPerTurn?: number;
  /** Phase 13: cancels the open approvals of a job (`ApprovalBroker.cancelJob`); a redirect calls it before anything else. */
  cancelApprovals?: (jobId: string) => void;
  /** Phase 13, Ruling T: this core process's id (random per start); queued requests start by themselves only under it. */
  bootId?: string;
}

/** Phase 13: what POST …/messages answers (and answers again for the same `clientId`). */
export interface MessageAnswer { entry: ConversationEntry; outcome: LiveMessageOutcome }
/** Phase 13: a message sent while a turn runs (live or queued), or a redirect, as the routes pass it. */
export type { UserMessageInput };

/** Phase 13: the live side of a creative turn. */
class LiveTurn extends LiveSession {
  /** Set by the turn once its agent runs start: the core's own markers go the same way as the agent's events. */
  emit: ((e: AgentEvent) => void) | null = null;
  /** The job was stopped or cancelled (also late, while the version was being saved): its queue waits for "Run next". */
  stopped = false;
  /** The turn saved a version (Ruling U: only then the queue goes on by itself). */
  savedVersion = false;
  constructor(jobId: string, caps: LiveSession['caps'], readonly ref: CreativeRef) { super(jobId, caps); }
}
/** How many idempotency answers are kept (per process; older ones are found again in the conversation or the queue). */
const MAX_ANSWERS = 1000;
export interface CreativeRef { root: string; projectSlug: string; projectDir: string; creativeSlug: string }

/** Shared with the web (render keys are derived from it): @motion-studio/shared `creativeJobKey`. */
export { creativeJobKey };
/** The render command comes from an agent-written manifest: single line, bounded, no control chars. */
const sanitizeCommand = (cmd: string): string => cmd.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300);

/**
 * The request of a turn that adds `added` (new formats the agent delivers) to `base`; the other formats are carried.
 * The base's render command is shown with its output folders pointing at this turn's `outputs/v<n>/`, so the agent is
 * never led to write into an earlier version.
 */
function addFormatsRequest(added: string[], base: VersionEntry | undefined, n: number, contract: AgentContract): string | undefined {
  if (!base || added.length === 0) return undefined;
  // Composition turns never see a render command (the agent does not render; fix I3), even from a legacy base.
  const command = contract === 'media' && base.renderCommand ? sanitizeCommand(base.renderCommand).replace(/outputs\/v\d+(?!\w)/g, `outputs/v${n}`) : '';
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
  /** Composition turns: each carried primary's composition, hashed before the agent starts. */
  carriedComps: Map<string, CarriedComposition>;
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

/**
 * Claude Code's words for a `--resume` id it does not have (Ruling V). From the CLI's own message as reported publicly
 * ("No conversation found with session ID: <id>"); UNVERIFIED LIVE (the Phase 13 spike was suspended, decisions log 610):
 * Task 4 lists it.
 */
export const SESSION_NOT_FOUND = /no conversation found with session id/i;

/**
 * Ruling V: whether a failed run that resumed a remembered session failed because that session is gone. `not-found`: the
 * CLI said so (the remembered session is then forgotten). `guess`: the backup — the run failed before any session event
 * and any output of the agent, so it never really started on that session (the remembered session is kept). A run the CLI could not even start
 * (missing binary or folder) is an ordinary failure.
 */
export function resumeErrorOf(outcome: { status: string; error?: string; startFailed?: boolean }, seen: { session: boolean; output: boolean }): 'not-found' | 'guess' | null {
  if (outcome.status !== 'failed') return null;
  if (SESSION_NOT_FOUND.test(outcome.error ?? '')) return 'not-found';
  if (outcome.startFailed) return null;
  // Ruling V/X: the guess only when the run reported no session and the agent wrote nothing.
  return seen.session || seen.output ? null : 'guess';
}

/**
 * The edit summaries of `base` and of the editor versions right before it in its line (`basedOn`), oldest first: what the
 * user changed directly since the agent's last version (decisions log 263).
 */
export function editorLineSummary(versions: readonly VersionEntry[], base: VersionEntry): string {
  const out: string[] = [];
  let v: VersionEntry | undefined = base;
  for (let i = 0; v?.origin === 'editor' && i < versions.length; i++) {
    out.unshift(v.request);
    const from: number | null = v.basedOn;
    v = from === null ? undefined : versions.find((x) => x.n === from);
  }
  return out.join('; ');
}

/**
 * The stored links without those whose follower or primary is in `gone`, and the manual picks without `gone`'s (Phase 12): what
 * a removed format, or a freed instance id taken again, must not carry. Empty picks become absent; links keep their shape.
 */
export function withoutFormatState(links: Record<string, string> | undefined, picks: Record<string, number> | undefined, gone: ReadonlySet<string>):
  { links: Record<string, string> | undefined; exportPicks: Record<string, number> | undefined } {
  const l = links === undefined ? undefined : Object.fromEntries(Object.entries(links).filter(([f, p]) => !gone.has(f) && !gone.has(p)));
  const k = picks === undefined ? undefined : Object.fromEntries(Object.entries(picks).filter(([f]) => !gone.has(f)));
  return { links: l, exportPicks: k && Object.keys(k).length > 0 ? k : undefined };
}

/**
 * `freed` with `ids` marked as freed at version `at` (the latest version now; `withoutFormatState`'s twin for the localization
 * rows, final review I1): a row of one of them in a version up to `at` is never carried. A later freeing moves the mark up.
 */
export function withFreedInstances(freed: Record<string, number> | undefined, ids: Iterable<string>, at: number): { freedInstances: Record<string, number> | undefined } {
  const out = { ...(freed ?? {}) };
  for (const id of ids) out[id] = Math.max(out[id] ?? 0, at);
  return { freedInstances: Object.keys(out).length > 0 ? out : undefined };
}

/** The instance ids whose rows in version `base` belong to an instance freed since (`withFreedInstances`). */
export function freedSince(freed: Record<string, number> | undefined, base: number): Set<string> {
  return new Set(Object.entries(freed ?? {}).filter(([, at]) => at >= base).map(([id]) => id));
}

export class CreativeTurnService {
  private readonly maxAttempts: number;
  private readonly locks = new KeyedMutex();
  /** Phase 13, Ruling T: queued requests made under another id (an earlier start of the app) wait for "Run next". */
  readonly bootId: string;
  /** Phase 13: the live side of each creative turn, by job id, from its start until it settles. */
  private readonly live = new Map<string, LiveTurn>();
  /** Phase 13: creatives whose last turn was stopped or cancelled: their queue waits for "Run next" (decisions log). */
  private readonly paused = new Set<string>();
  /** Phase 13: answers by creative key + clientId (idempotency, Review Focus 3); a pending one is shared by a double click. */
  private readonly answers = new AnswerCache(MAX_ANSWERS);
  /** Phase 13: the creatives whose queue this process changed, by job key (for `otherJobEndedByKey`). */
  private readonly refs = new Map<string, CreativeRef>();
  constructor(private readonly deps: CreativeTurnDeps) {
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.bootId = deps.bootId ?? randomUUID();
  }

  /**
   * Starts a turn. `opts.formats`: the formats the request applies to (spec §2.5); formats outside the brief are dropped, a
   * follower stands for its primary, and none (or absent) means every primary. The other formats are carried unchanged.
   */
  async start(ref: CreativeRef, message?: { text: string; pins: Pin[] }, opts: { formats?: string[] } = {}): Promise<JobSummary> {
    return this.locks.run(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug), () => this.startLocked(ref, message, opts.formats));
  }

  /** Edits title and/or brief; refused while a generation is queued or running for the creative. */
  async updateBrief(ref: CreativeRef, patch: { title?: string; brief?: Brief; services?: Brief['services']; formatLabels?: Record<string, string | null>; formats?: string[]; linkedCodebases?: LinkedCodebase[] }): Promise<CreativeFile> {
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
      let exportPicks: { exportPicks: CreativeFile['exportPicks'] } | undefined;
      let freed: { freedInstances: CreativeFile['freedInstances'] } | undefined;
      // Ids removed or added by this save are freed (final review I1): the rows the latest version holds for them belong to
      // the old instance and are never carried. Saved versions are not touched.
      const markFreed = async (stored: CreativeFile, ids: string[]) => {
        if (ids.length === 0) return;
        const latest = (await store.readVersions(ref.creativeSlug)).at(-1)?.n ?? 0;
        freed = withFreedInstances(stored.freedInstances, ids, latest);
      };
      if (patch.brief) {
        const { links: _ignored, ...rest } = patch.brief;
        const stored = await store.get(ref.creativeSlug);
        const current = stored.brief;
        const added = rest.formats.filter((f) => !current.formats.includes(f));
        // Shared with the web, which tells before "Save and regenerate" whether a legacy creative converts (I4).
        let links = added.length > 0 ? linksAfterBriefSave(current, rest.formats, await this.deps.presets()) : current.links;
        // Formats the save removes leave no link (either end) and no manual pick behind (Phase 12): a freed instance id
        // reused later starts clean. Saved versions are not touched.
        const gone = new Set(current.formats.filter((f) => !rest.formats.includes(f)));
        if (gone.size > 0) {
          const pruned = withoutFormatState(links, stored.exportPicks, gone);
          links = pruned.links;
          exportPicks = { exportPicks: pruned.exportPicks };
        }
        await markFreed(stored, [...gone, ...added]);
        brief = links ? { ...rest, links } : rest;
      } else if (patch.services || patch.formatLabels || patch.formats) {
        // A partial save (services chip, inline labels, reorder, removal): everything else comes from the brief stored now,
        // never from the caller's copy.
        const stored = await store.get(ref.creativeSlug);
        const next: Brief = { ...stored.brief };
        if (patch.services) next.services = patch.services;
        if (patch.formats) {
          const f = patch.formats;
          if (new Set(f).size !== f.length || f.some((id) => !stored.brief.formats.includes(id))) {
            throw new CodedError(400, t().errors.formatsReorderRemoveOnly, 'formats-reorder-remove-only');
          }
          next.formats = f;
          const gone = new Set(stored.brief.formats.filter((id) => !f.includes(id)));
          if (gone.size > 0) {
            const pruned = withoutFormatState(next.links, stored.exportPicks, gone);
            if (pruned.links) next.links = pruned.links;
            exportPicks = { exportPicks: pruned.exportPicks };
            await markFreed(stored, [...gone]);
          }
        }
        if (patch.formatLabels) {
          // Per key: a key left out is kept (a newer label from another tab survives); '' or null clears the key.
          const merged: Record<string, string> = { ...(next.formatLabels ?? {}) };
          for (const [k, v] of Object.entries(patch.formatLabels)) { if (v === null || v === '') delete merged[k]; else merged[k] = v; }
          next.formatLabels = merged;
        }
        // Ruling H: a label of a format the brief no longer has goes with it.
        if (next.formatLabels) {
          const kept = Object.fromEntries(Object.entries(next.formatLabels).filter(([k]) => next.formats.includes(k)));
          if (Object.keys(kept).length > 0) next.formatLabels = kept; else delete next.formatLabels;
        }
        brief = next;
      }
      const updated = await store.update(ref.creativeSlug, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(brief ? { brief } : {}),
        ...(exportPicks ?? {}),
        ...(freed ?? {}),
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
    const label = (id: string) => formatDisplayName(presets, id, currentLocale());
    const e = t().errors;
    /** The checks that need no hashes; run on an unlocked read first (fail fast), then again under the lock. */
    const validate = (creative: CreativeFile, versions: VersionEntry[]) => {
      if (!creative.brief.formats.includes(format)) throw new CodedError(400, e.formatNotInBrief({ format: label(format) }), 'format-not-in-brief');
      const links = effectiveLinks(creative.brief.links, creative.brief.formats);
      if (Object.hasOwn(links, format)) throw new CodedError(400, e.pickFollower({ format: label(format), primary: label(links[format]!) }), 'pick-follower');
      if (version !== null) {
        const entry = versions.find((v) => v.n === version);
        if (!entry) throw new CodedError(404, e.versionNNotFound({ n: version }), 'version-not-found');
        // A v2 composition counts without a render (export renders it first, Task 5b).
        if (!hasFormat(entry, format)) throw new CodedError(400, e.pickNoFile({ format: label(format), n: version }), 'pick-no-file');
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
      const picked = version === null ? undefined : versions.find((v) => v.n === version);
      const v2 = Boolean(picked?.compositions?.some((c) => c.format === format));
      if (version !== null && !v2 && !(await outputFileExists(store.dir(ref.creativeSlug), versions, version, format))) {
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
      const label = (id: string) => formatDisplayName(presets, id, currentLocale(), brief.formatLabels);
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

  private async startLocked(ref: CreativeRef, message: { text: string; pins: Pin[] } | undefined, formats: string[] | undefined, queued?: { clientId: string }): Promise<JobSummary> {
    const store = new CreativeStore(ref.projectDir);
    const before = await store.get(ref.creativeSlug);
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    // Same check the queue does, but before touching the creative's files.
    if (this.isActive(key)) throw new WorkspaceError(409, t().errors.generationRunning);
    // A request for formats none of which is in the brief is a mistake, not "all formats".
    if (formats?.length && !formats.some((f) => before.brief.formats.includes(f))) throw new CodedError(400, t().errors.formatsNotInBrief, 'formats-not-in-brief');
    const jobId = randomUUID();
    if (message) {
      // A queued request starts as a user entry with `mode: 'queued'`. One that was first written as a live message (it
      // arrived when the agent had finished) is not written twice, unless it was edited in the queue meanwhile.
      const written = queued && (await store.readConversation(ref.creativeSlug)).some((e) => e.type === 'user' && e.clientId === queued.clientId
        && e.text === message.text && JSON.stringify(e.pins) === JSON.stringify(message.pins));
      if (!written) {
        await store.appendConversation(ref.creativeSlug, {
          type: 'user', at: now(), text: message.text, pins: message.pins, attachments: [],
          ...(queued ? { jobId, mode: 'queued' as const, clientId: queued.clientId, deliveredAt: now() } : {}),
        });
      } else {
        // Its entry was written earlier (a live message that became the next request): its final state is this marker,
        // under the job that now takes it (fix round 1, I2).
        const event: AgentEvent = { kind: 'user_message_delivered', clientId: queued!.clientId };
        await store.appendConversation(ref.creativeSlug, { type: 'agent', at: now(), jobId, event });
        this.deps.broadcast({ type: 'agent', jobId, event });
      }
    }
    await store.update(ref.creativeSlug, { status: 'working', error: null });
    this.changed(ref);
    // What the turn targets, said up front (the web marks only those boards and their followers as rendering): the same
    // resolution `planTurn` makes (a first generation targets every primary). Untargeted: absent.
    const targets = formats?.length && (await store.readVersions(ref.creativeSlug)).length > 0 ? normalizeTargets(formats, before.brief.formats, effectiveLinks(before.brief.links, before.brief.formats)) : undefined;
    // Phase 13: the turn's live side exists from now, so a message sent while it waits in the job queue is kept.
    const caps = await this.deps.launcher.liveCapabilities?.('creative').catch(() => NO_LIVE) ?? NO_LIVE;
    const live = new LiveTurn(jobId, caps, ref);
    this.live.set(jobId, live);
    this.paused.delete(key);
    let job: JobSummary;
    try {
      job = this.deps.queue.enqueue({
        id: jobId,
        key,
        kind: 'creative',
        label: t().jobs.creativeLabel({ title: before.title }),
        ...(targets ? { formats: targets } : {}),
        run: (signal, id) => this.run(ref, store, before.status, message, signal, id, formats),
        onCancelledBeforeStart: () => this.locks.run(key, async () => {
          // A new start() may have won the lock after the cancel: the creative belongs to that job now.
          if (this.isActive(key)) return;
          await live.serial(async () => { await this.drainLive(ref, store, live); live.phase = 'ended'; });
          for (const m of live.messages) m.settle('dropped');
          await this.cancelled(ref, store, before.status, (await store.readVersions(ref.creativeSlug)).length > 0);
        }),
      });
    } catch (err) {
      this.live.delete(jobId);
      throw err;
    }
    void this.deps.queue.whenSettled(job.id).then((settled) => this.turnSettled(ref, job.id, settled?.state));
    return job;
  }

  /**
   * Runs `fn` under the creative's lock, the one turns, restores, brief edits, links and picks take (shared with
   * `DirectEditService.save`, Phase 10b).
   */
  runLocked<T>(ref: CreativeRef, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug), fn);
  }

  /** Whether a turn of the creative is queued or running. */
  turnActive(ref: CreativeRef): boolean {
    return this.isActive(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug));
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
    // Restoring work/ may recreate the creative's work/ folder: note the creative folder so the tripwire does not read it as a move (FP4).
    await noteCoreChange(store.dir(ref.creativeSlug));
    // A restore is the user's choice of base: it replaces a stopped turn's memory (Phase 13).
    const updated = await store.update(ref.creativeSlug, { resumeFrom: { version: n, sessionId: version.sessionId }, stoppedSession: undefined });
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
    // Phase 13: the turn's live side (made at start; a stand-in when the job was enqueued some other way).
    const live = this.live.get(jobId) ?? new LiveTurn(jobId, NO_LIVE, ref);
    this.live.set(jobId, live);
    try {
      await writeFile(join(ref.projectDir, '.studio', 'context.md'), CONTEXT_MD);
      const contract = this.deps.agentContract ?? 'compositions';
      // The full JSON Schema of composition.json, which the prompt and context.md point to (too long to inline).
      if (contract === 'compositions') await writeFile(join(ref.projectDir, '.studio', 'composition.schema.json'), compositionSchemaFile());
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
      // Final review I4, ruling A: on a legacy base (phase 9 media, no compositions), a turn that only adds LINKED followers
      // (no message, no explicit formats) keeps the phase 9 no-agent path: the followers are copies of their primaries'
      // files, the version stays a v1-contract one. When a primary's file cannot be carried, the turn converts as usual
      // (never a media-contract agent run).
      let turnContract: AgentContract = contract;
      if (contract === 'compositions' && !hasMessage && !requestedFormats?.length && legacyTurnKind(base, initial.brief) === 'followers') turnContract = 'media';
      let plan = await this.planTurn(ref, store, initial, presets, base, hasMessage, requestedFormats, locale, turnContract);
      if (turnContract !== contract && plan.targets.length > 0) {
        turnContract = contract;
        plan = await this.planTurn(ref, store, plan.creative, presets, base, hasMessage, requestedFormats, locale, contract);
      }
      const { creative, targets } = plan;
      const label = (id: string) => formatDisplayName(presets, id, locale, creative.brief.formatLabels);
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
          : (addFormatsRequest(targets.filter((f) => plan.added.includes(f)), base, n, turnContract)
            ?? (targets.length < primaries.length ? j.regenerateFormatsRequest({ formats: listText(targets.map(label), locale) }) : j.regenerateRequest)));

      // Phase 13 (spec §3): a turn the user stopped is resumed as a fork, with a note; the session of the base version is the
      // fallback when it no longer exists in Claude Code (Review Focus 4).
      const stopped = creative.stoppedSession;
      const baseSessionId = creative.resumeFrom?.sessionId ?? latest?.sessionId ?? undefined;
      let resumeSessionId = stopped?.sessionId ?? baseSessionId;
      // Durations of the base the agent keeps without being told to bring them back to the brief (decisions log 262).
      let accepted: ReadonlyMap<string, number> = new Map();
      let result = null as ValidationResult | null;
      // One ledger record per attempt: the version's usage is their sum (fix loop included). No agent: no record, no usage.
      const attemptUsage: Array<UsageRecord | null | undefined> = [];

      if (!noAgent) {
        const { context, existing } = await this.buildContext(ref, store, creative.linkedCodebases, creative.brief.services);
        // Spec §7: a legacy base (rendered media, v1 manifest) makes this change a conversion to compositions. The core
        // extracts reference frames of the old media into its protected cache; the chat says it costs more tokens once.
        let conversion: { formats: Awaited<ReturnType<typeof extractReferenceFrames>>; created: string[] } | undefined;
        if (turnContract === 'compositions') {
          const cp = conversionPlan(versions, base, targets);
          if (cp.sources.length > 0) {
            // Once per conversion: a retry of a turn that saved no version does not repeat the entry.
            const entries = await store.readConversation(slug);
            const texts = new Set([messages('en').jobs.convertingLegacy, messages('it').jobs.convertingLegacy]);
            const since = latest ? Date.parse(latest.createdAt) : 0;
            const told = entries.some((e) => e.type === 'system' && texts.has(e.text) && Date.parse(e.at) > since);
            if (!told) await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: j.convertingLegacy });
            conversion = {
              formats: await extractReferenceFrames({ projectDir: ref.projectDir, creativeDir, creativeSlug: slug, n, sources: cp.sources, presets, media: this.deps.media }),
              created: cp.created,
            };
          } else {
            // Not a conversion (any more): frames left by an earlier try of this version are removed.
            await clearReferenceFrames(ref.projectDir, slug, n);
          }
        }
        accepted = turnContract === 'compositions' ? acceptedDurationsOf(base, targets, presets, creative.brief.durationSec) : new Map();
        const uncheckable = new Set<string>();
        let forkSession = Boolean(creative.resumeFrom || stopped);
        /** A remembered session is resumed (stopped turn, or a redirect's live session): a resume error falls back once. */
        let remembered: 'stopped' | 'redirect' | null = stopped ? 'stopped' : null;
        /** The resume fallback happens at most once per turn (fix round 1, C1): a second resume error is a failure. */
        let resumeFallbackUsed = false;
        let kind: PromptKind = versions.length === 0 ? 'first' : 'iteration';
        let problems: string[] = [];
        let lastWrite: Promise<void> = Promise.resolve();
        // The agent delivers and is checked on its target formats only: the carried and linked ones are the core's job.
        const validateTargets = () => validateOutputs({
          dir: store.outputsDir(slug, n), requested: targets, presets, durationSec: creative.brief.durationSec, media: this.deps.media, locale,
          reservedOwner: plan.reservedOwner,
        });
        const checkCompositions = (only?: string) => checkTargets({
          versionDir: store.outputsDir(slug, n), targets: only === undefined ? targets : targets.filter((f) => f === only), presets,
          briefDurationSec: creative.brief.durationSec, locale, acceptedDurations: accepted,
        });
        // The agent's MCP tools on its compositions (output contract v2): the same checks as after the turn, and a few frames.
        let previewCalls = 0;
        const previewLimit = this.deps.previewFramesPerTurn ?? 10;
        const compositionTools = turnContract === 'compositions' ? {
          validateComposition: async (format?: string) => {
            if (format !== undefined && !targets.includes(format)) throw new CodedError(400, t().errors.formatNotInTurn({ format: format.slice(0, 100), list: targets.join(', ') }), 'formats-not-in-turn');
            const r = await checkCompositions(format);
            return {
              // The hash after normalisation: the one the version will record.
              formats: r.checks.map((c) => ({ format: c.format, ok: (r.byFormat.get(c.format) ?? []).length === 0, hash: c.finalHash })),
              problems: r.problems, warnings: r.warnings,
            };
          },
          previewFrames: async (a: { format: unknown; times: unknown }) => {
            const previews = this.deps.previews;
            if (!previews) throw new CodedError(503, t().errors.previewUnavailable, 'no-renderer');
            if (typeof a.format !== 'string' || !targets.includes(a.format)) throw new CodedError(400, t().errors.formatNotInTurn({ format: String(a.format).slice(0, 100), list: targets.join(', ') }), 'formats-not-in-turn');
            checkedPreviewTimes(a.times, locale); // a malformed call is refused without counting
            if (previewCalls >= previewLimit) throw new CodedError(429, t().errors.previewFramesLimit({ max: previewLimit }), 'preview-limit');
            previewCalls++;
            try {
              // Phase 13: a redirect aborts it (the turn's tool signal), not only the job's end.
              return await previews.agentFrames({ ref: { projectDir: ref.projectDir, creativeDir, creativeSlug: slug, n }, format: a.format, times: a.times, locale, signal: AbortSignal.any([signal, live.toolSignal]) });
            } catch (e) {
              // A full lane is Motion Studio's limit, not the agent's: that call does not count (fix minor 6).
              if (e instanceof CodedError && e.apiCode === 'preview-busy') previewCalls--;
              throw e;
            }
          },
        } : {};
        // Earlier versions are read-only for the agent (sandbox and Edit/Write rules); any change is still detected after.
        // `work/` and `outputs/` exist before the agent runs: the agent making one (`mkdir -p work`) is then never a change
        // to the creative's folder that the after-run check (run-tripwire.ts) would have to tell from a move (FP4).
        let madeDirs = false;
        for (const d of ['work', 'outputs']) {
          if (!(await lstat(join(creativeDir, d)).catch(() => null))) { await mkdir(join(creativeDir, d), { recursive: true }); madeDirs = true; }
        }
        if (madeDirs) await noteCoreChange(creativeDir);
        // A base made in the editor (decisions log 263): `work/editor/` holds an exact copy of its compositions, and the prompt
        // says so; any other base leaves no stale copy there.
        let directEdit: { version: number; summary: string; copies: string[] } | undefined;
        if (turnContract === 'compositions') {
          const copies = await alignEditorCopies(creativeDir, base);
          if (base?.origin === 'editor') directEdit = { version: base.n, summary: editorLineSummary(versions, base), copies };
        }
        const keptDurations = [...accepted].map(([format, durationSec]) => ({ format, durationSec }));
        const earlier = await earlierOutputDirs(creativeDir, n);
        // A hard link made while a version folder was still writable (during its own turn) would stay a writable second
        // name for its files: the sandbox only refuses new links. Detached before the snapshot, so the check below sees
        // only this turn's changes (decisions log 141).
        const linked = (await Promise.all(earlier.map((d) => detachLinksUnder(join(creativeDir, 'outputs', d), creativeDir)))).flat();
        if (linked.length > 0) {
          const list = linked.slice(0, 5).join(', ') + (linked.length > 5 ? ', …' : '');
          await store.appendConversation(slug, { type: 'system', at: now(), level: 'warning', text: j.earlierLinksDetached({ list }) });
        }
        const earlierBefore = await snapshotOutputs(creativeDir, earlier);

        let attempt = 1;
        let sawSession = false;
        /** The run wrote something as the agent (text or a tool call): a failure after that is never a resume error (Ruling V). */
        let sawOutput = false;
        // The agent's events (and the core's own markers) go to the clients and, in order, to the conversation.
        const emit = (event: AgentEvent) => {
          this.deps.broadcast({ type: 'agent', jobId, event });
          // Live usage estimates are only for the UI (up to one a second): the final usage event is the one kept.
          if (event.kind === 'usage' && event.live) return;
          // Chained so writes stay ordered and a failure surfaces when the chain is awaited after the turn.
          lastWrite = lastWrite.then(() => store.appendConversation(slug, { type: 'agent', at: now(), jobId, event }));
          lastWrite.catch(() => {}); // observed here; the same rejection is rethrown by the await below
        };
        live.emit = emit;
        for (;;) {
          sawSession = false;
          sawOutput = false;
          // Phase 13: a redirect waiting for this attempt (the fallback: the last run was cancelled) is its prompt.
          const redirect = await live.serial(async () => { const r = live.redirect; live.redirect = null; return r; });
          if (signal.aborted) return await this.cancelled(ref, store, previous, versions.length > 0, this.stoppedOf(jobId));
          // One decision per attempt, shared by the prompt's claims and the launched policy.
          const sandboxed = await this.deps.launcher.sandboxed();
          // With no session to go on (the agent has not started yet), a redirect joins the request in the attempt's prompt.
          const fresh = Boolean(redirect) && !live.sessionId;
          // A repair turn carries every message the user sent while the agent worked, after their request (F4).
          const liveWords = (kind === 'fix' && !redirect) || fresh ? await live.serial(async () => {
            const words = live.words();
            for (const m of words) if (m.state === 'pending') live.given(m, 'prompt');
            return words.map((m) => ({ text: m.text, pins: m.pins }));
          }) : undefined;
          if (redirect && !fresh) {
            live.given(redirect, 'prompt');
            // The live session goes on (not a fork): the agent keeps what it did so far.
            resumeSessionId = live.sessionId; forkSession = false; remembered = 'redirect';
          }
          const resumed = redirect && !fresh ? redirect : null;
          if (fresh) live.given(redirect!, 'prompt');
          const prompt = buildCreativePrompt({
            slug, creative, presets, version: n, kind: resumed ? 'redirect' : kind, formats: targets,
            userText: kind === 'fix' || resumed ? undefined : request,
            // A repair turn carries the user's own words (F4): only what they wrote, never a request the core made up.
            userWords: resumed ? resumed.text : kind === 'fix' ? message?.text || undefined : undefined,
            liveMessages: liveWords,
            stoppedNote: Boolean(stopped) && !resumed && kind !== 'fix',
            pins: resumed ? resumed.pins : kind === 'iteration' ? message?.pins : undefined,
            attachments: kind === 'iteration' && !resumed ? attachments : undefined,
            problems, context, locale, sandboxed, contract: turnContract,
            conversion: kind === 'iteration' ? conversion : undefined,
            directEdit: kind === 'iteration' ? directEdit : undefined,
            keptDurations: kind === 'iteration' ? keptDurations : undefined,
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
            // The brief as read at this turn's start (Task 7): a change from the chat applies from the next turn.
            services: effectiveServices(creative.brief),
            // After the agent's events written so far, so the chat keeps its order.
            onWarning: (text) => {
              lastWrite = lastWrite.then(() => store.appendConversation(slug, { type: 'system', at: now(), level: 'warning', text }));
              return lastWrite;
            },
            onEvent: (event) => {
              if (event.kind === 'session') sawSession = true;
              if (event.kind === 'text' || event.kind === 'tool_use') sawOutput = true;
              if (event.kind === 'user_message_delivered') { const m = live.messages.find((x) => x.clientId === event.clientId); if (m) m.announced = true; }
              emit(event);
              const sid = event.kind === 'session' || event.kind === 'result' ? event.sessionId : undefined;
              if (sid) { this.deps.queue.patch(jobId, { sessionId: sid }); live.sessionId = sid; }
            },
            ...compositionTools,
          });
          const onAbort = () => run.cancel();
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort(); // cancelled before the listener existed (e.g. while preparing the turn)
          // Phase 13: messages given in this attempt's prompt are delivered now; those that waited for the run are sent.
          await live.serial(async () => {
            live.run = run;
            live.phase = 'agent';
            live.lastAttempt = attempt >= this.maxAttempts;
            if (run.capabilities) live.caps = run.capabilities;
            // A redirect that came while this run was being started: it stops now and the next attempt takes it.
            if (live.redirect) { run.cancel(); return; }
            for (const m of live.messages) {
              if (m.state === 'prompt' && !m.announced) { m.announced = true; emit({ kind: 'user_message_delivered', clientId: m.clientId }); }
            }
            for (const m of live.pending()) {
              if ((await run.send?.({ text: liveMessageText(m.text, m.pins, pinLine), clientId: m.clientId })) === 'written') live.given(m, 'sent');
            }
          });
          const outcome = await run.done.finally(() => signal.removeEventListener('abort', onAbort));
          await live.serial(async () => { live.run = null; live.phase = 'between'; });
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
          // Phase 13: the run was cancelled for a redirect (not the job): the next attempt of the same number resumes it.
          if (outcome.status !== 'succeeded' && live.redirect && !signal.aborted) continue;
          // Phase 13 (Review Focus 4, Ruling V): a remembered session Claude Code no longer has falls back to the base
          // version's session, with a note: never a failed turn. Once per turn, and the restart counts as an attempt (C1).
          const resumeError = outcome.status === 'failed' && remembered && !resumeFallbackUsed && !signal.aborted
            ? resumeErrorOf(outcome, { session: sawSession, output: sawOutput }) : null;
          if (resumeError && attempt < this.maxAttempts) {
            resumeFallbackUsed = true;
            // Only the CLI's own "session not found" clears the remembered session; the backup guess keeps it.
            if (remembered === 'stopped' && resumeError === 'not-found') await store.update(slug, { stoppedSession: undefined });
            if (remembered === 'redirect') {
              // The live session cannot be resumed: the redirect starts afresh from the base session, with the request
              // and every message of the turn in the prompt (C1: never the same resume again).
              await live.serial(async () => { live.sessionId = undefined; if (redirect) { redirect.state = 'pending'; live.redirect ??= redirect; } });
            }
            remembered = null;
            // The base session itself may be the one that is gone (a stopped turn resumed it without a fork): then a new session.
            const gone = resumeSessionId;
            resumeSessionId = baseSessionId === gone ? undefined : baseSessionId;
            forkSession = resumeSessionId !== undefined && Boolean(creative.resumeFrom);
            await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: t().live.stoppedSessionUnavailable });
            this.changed(ref);
            attempt++;
            await live.serial(async () => { live.lastAttempt = attempt >= this.maxAttempts; });
            continue;
          }
          if (outcome.status === 'cancelled') return await this.cancelled(ref, store, previous, versions.length > 0, this.stoppedOf(jobId));
          if (outcome.status === 'failed') throw new AgentFailure(outcome.error ?? t().errors.turnFailed);
          resumeSessionId = outcome.sessionId ?? resumeSessionId;
          forkSession = false;
          remembered = null;

          let unknown: number;
          if (turnContract === 'compositions') {
            const r = await checkCompositions();
            problems = r.problems;
            unknown = r.unknownPresets.length;
          } else {
            result = await validateTargets();
            problems = result.problems;
            unknown = result.unknownPresets.length;
          }
          // Phase 13: a redirect that arrived while the outputs were checked is the next attempt.
          if (live.redirect && !signal.aborted) continue;
          // A preset missing from the catalog cannot be fixed by the agent: retrying would only waste turns.
          if (problems.length === unknown || attempt >= this.maxAttempts) break;
          await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: t().jobs.checkingOutputs({ count: problems.length, attempt: attempt + 1, max: this.maxAttempts }) });
          this.changed(ref);
          kind = 'fix';
          attempt++;
          // From here a message the run refuses goes to the repair attempt's prompt (or, at the last one, to the queue).
          await live.serial(async () => { live.lastAttempt = attempt >= this.maxAttempts; });
        }
        // A render job may record a render in an earlier version meanwhile (Task 5): the core's own writes are left out.
        const earlierAfter = await snapshotOutputs(creativeDir, earlier);
        const changedEarlier = withoutCoreWrites(creativeDir, snapshotChanges(earlierBefore, earlierAfter), earlierAfter);
        if (changedEarlier.length > 0) {
          const list = changedEarlier.slice(0, 5).join(', ') + (changedEarlier.length > 5 ? ', …' : '');
          await store.appendConversation(slug, { type: 'system', at: now(), level: 'warning', text: j.earlierOutputsChanged({ list }) });
        }
      } else if (signal.aborted) {
        return await this.cancelled(ref, store, previous, versions.length > 0);
      }

      finalizing = true;
      // Phase 13: from now on a message is the next request; those no attempt took are queued now (Review Focus 1).
      await live.serial(async () => { live.phase = 'finalizing'; await this.drainLive(ref, store, live); });
      let saved: { outputs: OutputFileInfo[]; problems: string[]; tools: string[]; renderCommand: string | null; compositions?: VersionComposition[]; localizations?: VersionEntry['localizations'] };
      if (turnContract === 'compositions') saved = await this.finishCompositions(ref, store, plan, presets, base, n, label, locale, { accepted });
      else {
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
        saved = { outputs, problems, tools: assembled.tools, renderCommand: assembled.renderCommand };
      }
      const { problems } = saved;
      const status = problems.length === 0 ? 'complete' : 'incomplete';
      const commit = await this.deps.git.commitAll(ref.projectDir, `${creative.title}: v${n}`);
      const usage = sumUsage(attemptUsage);
      await store.appendVersion(slug, {
        n, commit, sessionId: resumeSessionId ?? null, status, createdAt: now(),
        request: request ?? t().jobs.requestFromBrief,
        outputs: saved.outputs, problems, tools: saved.tools, renderCommand: saved.renderCommand,
        basedOn: creative.resumeFrom?.version ?? latest?.n ?? null,
        ...(usage ? { usage } : {}),
        ...(saved.compositions ? { compositions: saved.compositions } : {}),
        ...(saved.localizations ? { localizations: saved.localizations } : {}),
      });
      live.savedVersion = true;
      if (noAgent && request) await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: `${request} · ${j.noAgentNeeded}` });
      await store.appendConversation(slug, { type: 'version', at: now(), n, status });
      // A version made without the agent after a restart keeps the restart's intent: the next agent turn still forks the
      // restored session (from this new version, which it now builds on).
      const resumeFrom = noAgent && creative.resumeFrom ? { version: n, sessionId: creative.resumeFrom.sessionId } : null;
      // A saved version ends the stopped turn's memory (Phase 13): the next turn builds on this version's session.
      await store.update(slug, { status: status === 'complete' ? 'ready' : 'incomplete', error: null, resumeFrom, stoppedSession: undefined });
      if (signal.aborted) {
        await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: t().jobs.lateCancel({ n }) });
      }
      await this.commitState(ref, t().jobs.versionStateCommit({ title: creative.title, n }));
      this.changed(ref);
      // Storyboards (spec §2.2) once the version is saved: a follow-up in the preview lane, after this job and outside the
      // creative's lock, best effort; nothing it does can mark the turn as failed (fix minor 3).
      if (saved.compositions && !signal.aborted) this.storyboardsLater(ref, store, n);
    } catch (err) {
      if (signal.aborted && !finalizing) return await this.cancelled(ref, store, previous, (await store.readVersions(slug)).length > 0, this.stoppedOf(jobId));
      const text = err instanceof Error ? err.message : String(err);
      await store.update(slug, { status: 'error', error: text }).catch(() => {});
      await store.appendConversation(slug, { type: 'system', at: now(), level: 'error', text: t().jobs.generationFailed({ text }) }).catch(() => {});
      await this.commitState(ref, t().jobs.stateCommit({ title: await this.titleOf(store, slug) }));
      this.changed(ref);
      // After a late abort the queue would read a plain rejection as a cancel: this failure is real.
      throw finalizing ? new JobFailedError(text) : err;
    } finally {
      // Phase 13: whatever no attempt took (a stop, a failure) becomes the next request: never lost.
      await live.serial(async () => {
        if (signal.aborted) live.stopped = true;
        if (live.phase !== 'finalizing' && live.phase !== 'ended') await this.drainLive(ref, store, live);
        live.phase = 'ended';
        live.run = null;
      }).catch(() => {});
      // Every message reaches a final state (I2): one that could not even be queued is answered as not delivered.
      for (const m of live.messages) m.settle('dropped');
      live.redirect?.settle('dropped');
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
    hasMessage: boolean, requested: string[] | undefined, locale: Locale, contract: AgentContract): Promise<TurnPlan> {
    const slug = ref.creativeSlug;
    const creativeDir = store.dir(slug);
    const { formats } = creative.brief;
    const links = effectiveLinks(creative.brief.links, formats);
    const isPrimary = (f: string) => !Object.hasOwn(links, f);
    const baseOut = (f: string) => base?.outputs.find((o) => o.format === f);
    // A format the base delivers: its file (legacy) or its composition (v2), a follower's entry included.
    const added = base ? formats.filter((f) => !hasFormat(base, f)) : [];
    let targets: string[];
    if (!base) targets = formats.filter(isPrimary);
    else if (requested?.length) targets = normalizeTargets(requested, formats, links);
    else if (!hasMessage && added.length > 0) targets = added.filter(isPrimary);
    else targets = formats.filter(isPrimary);
    const wanted = new Set(targets);
    const usable = new Map<string, number>(); // carried primary → size of its base file
    const expected = new Map<string, string>();
    const carriedComps = new Map<string, CarriedComposition>();
    if (base) {
      for (const p of formats.filter(isPrimary)) {
        if (wanted.has(p)) continue;
        if (contract === 'compositions') {
          // Its own composition in the base, hashed now (before the agent runs) and still the recorded one; a legacy base
          // has none, so every primary is a target.
          const cc = await carriableComposition(creativeDir, base, p);
          if (cc) carriedComps.set(p, cc); else wanted.add(p);
          continue;
        }
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
    const label = (id: string) => formatDisplayName(presets, id, locale, creative.brief.formatLabels);
    const e = t().errors;
    const unlinked: string[] = [];
    for (const [f, p] of Object.entries(links)) {
      if (wanted.has(p)) continue; // the primary is delivered now: checked on the new file, after the render
      const pp = findPreset(presets, p);
      const fp = findPreset(presets, f);
      const cd = carriedComps.get(p)?.duration;
      const check: { ok: true } | { ok: false; reason: FollowFailure } = !pp || !fp ? { ok: false, reason: 'unknown' }
        // A composition's duration (an unreadable one is checked again at render); a legacy file's real duration and size.
        : contract === 'compositions' ? canFollow(pp, fp, cd === null || cd === undefined ? undefined : cd > 0 ? cd : null)
          : followCheck(pp, fp, baseOut(p)!, usable.get(p)!);
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
    // (Composition turns write no files of their own under these names: the media contract only.)
    const carriedNames = new Map(contract === 'compositions' ? [] : carried.map((f) => [baseOut(f)!.file, f] as const));
    const followerIds = new Set(Object.keys(links));
    const reservedOwner = (file: string) => {
      const dot = file.lastIndexOf('.');
      const stem = dot > 0 ? file.slice(0, dot) : file;
      return carriedNames.get(file) ?? (followerIds.has(stem) ? stem : undefined);
    };
    return {
      creative: current, links, added, expected, unlinked, reservedOwner, carriedComps,
      targets: primaries.filter((f) => wanted.has(f)),
      carried,
    };
  }

  /** Removes the links of `followers` from the stored brief: from the next turn on each is its own primary. */
  async unlinkFollowers(store: CreativeStore, slug: string, followers: string[]): Promise<CreativeFile> {
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
    const note = (f: string): { key: string; params: Record<string, string> } => (Object.hasOwn(materialized, f)
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

  /**
   * Completes a composition turn's `outputs/v<n>` (output contract v2, composition-turn.ts) and tells the chat what the core
   * did: followers that cannot follow any more (unlinked), formats the agent wrote although they were not targets,
   * entries it left that Motion Studio removed, and the advisory layer checks. Shared with `DirectEditService.save`, whose
   * single target is the edited format (its folder written by the core).
   */
  async finishCompositions(ref: CreativeRef, store: CreativeStore, plan: Pick<TurnPlan, 'creative' | 'targets' | 'carried' | 'carriedComps' | 'links'>, presets: FormatPreset[], base: VersionEntry | undefined, n: number,
    label: (id: string) => string, locale: Locale,
    /** `direct`: a direct edit (decisions log 262): the brief's duration is not checked. `accepted`: see `acceptedDurationsOf`. */
    duration: { direct: true; base?: { durationSec: number | null; userDuration?: { durationSec: number } } } | { accepted: ReadonlyMap<string, number> } = { accepted: new Map() }): Promise<{ outputs: OutputFileInfo[]; problems: string[]; tools: string[]; renderCommand: null; compositions: VersionComposition[]; localizations?: VersionEntry['localizations'] }> {
    const slug = ref.creativeSlug;
    const j = t().jobs;
    const a = await assembleCompositions({
      projectDir: ref.projectDir, creativeSlug: slug, creativeDir: store.dir(slug), n, base, formats: plan.creative.brief.formats, targets: plan.targets, carried: plan.carried,
      carriedComps: plan.carriedComps, links: plan.links, presets, locale, label,
      briefDurationSec: 'direct' in duration ? null : plan.creative.brief.durationSec,
      acceptedDurations: 'accepted' in duration ? duration.accepted : undefined,
      ...('direct' in duration ? { direct: { briefDurationSec: plan.creative.brief.durationSec, ...(duration.base ? { base: duration.base } : {}) } } : {}),
    });
    const say = (level: 'info' | 'warning', text: string) => store.appendConversation(slug, { type: 'system', at: now(), level, text });
    for (const x of a.notDelivered) await say('warning', x.text);
    if (a.notDelivered.length > 0) await this.unlinkFollowers(store, slug, a.notDelivered.map((x) => x.follower));
    for (const f of a.touched) await say('info', t().outputs.keptUnchanged({ format: label(f) }));
    const list = (items: string[]) => items.slice(0, 5).join('; ') + (items.length > 5 ? '; …' : '');
    if (a.stray.length > 0) await say('warning', j.strayRemoved({ list: list(a.stray) }));
    if (a.check && a.check.warnings.length > 0) await say('info', j.layerWarnings({ list: list(a.check.warnings) }));
    const exclude = base ? freedSince(plan.creative.freedInstances, base.n) : new Set<string>();
    const localizations = await this.carryLocalizations(ref, store, base, n, a.compositions, presets, locale, exclude);
    return { outputs: a.outputs, problems: a.problems, tools: [], renderCommand: null, compositions: a.compositions, ...(localizations ? { localizations } : {}) };
  }

  /**
   * The base's localization overlays carried into the new version `n` (Phase 12, spec §3.3: kept, stale or dropped,
   * `carryLocalizations`), for every way a version is made (turns, direct edits, duplicates all finish here). Best effort: a
   * failure leaves the new version without overlays and says so in the chat, it never fails the version.
   */
  private async carryLocalizations(ref: CreativeRef, store: CreativeStore, base: VersionEntry | undefined, n: number, compositions: VersionComposition[],
    presets: FormatPreset[], locale: Locale, exclude: ReadonlySet<string>): Promise<VersionEntry['localizations']> {
    if (!base?.localizations?.length) return undefined;
    const creativeDir = store.dir(ref.creativeSlug);
    try {
      const next = { n, compositions } as VersionEntry;
      const comps = new Map<string, InstanceComposition>();
      for (const c of compositions) {
        if (!base.localizations.some((r) => r.instanceId === c.format)) continue;
        const ic = await instanceComposition(creativeDir, next, c.format, presets);
        if (ic) comps.set(c.format, ic);
      }
      return await carryLocalizations({ creativeDir, n: base.n, version: base }, { creativeDir, n }, comps, { projectDir: ref.projectDir, uiLocale: locale, exclude });
    } catch (e) {
      await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'warning', text: messages(locale).variants.localizationInvalid({ detail: (e as Error).message.slice(0, 200) }) }).catch(() => {});
      return undefined;
    }
  }

  private async buildContext(ref: CreativeRef, store: CreativeStore, creativeCodebases: LinkedCodebase[], services: Brief['services']): Promise<{ context: CreativeContext; existing: string[] }> {
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
      context: { kit, hasGuidelines, assets, references, codebases: existing.map(({ path, note: n }) => ({ path, ...(n ? { note: n } : {}) })), missingCodebases: checks.filter((c) => !c.exists).map((c) => c.path), tools: this.deps.launcher.mcpActive() ? await availableTools(this.deps.vault, services, this.deps.keyChecks) : [] },
      existing: existing.map((c) => c.path),
    };
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Phase 13: messages while the agent works, the request queue, redirect.

  /** The live side of the creative's running (or queued) turn, if any. */
  private liveOf(key: string): LiveTurn | undefined {
    const job = this.deps.queue.list().find((j) => j.key === key && j.kind === 'creative' && (j.state === 'queued' || j.state === 'running'));
    return job ? this.live.get(job.id) : undefined;
  }

  /** The answer already given for `clientId` (this process), or rebuilt from the queue or the conversation (an earlier one). */
  private async knownAnswer(ref: CreativeRef, clientId: string): Promise<MessageAnswer | null> {
    const store = new CreativeStore(ref.projectDir);
    const q = (await store.get(ref.creativeSlug)).queued?.find((x) => x.clientId === clientId);
    if (q) return { entry: this.queuedEntry(q), outcome: 'queued' };
    const e = (await store.readConversation(ref.creativeSlug)).find((x) => x.type === 'user' && x.clientId === clientId);
    if (e && e.type === 'user') return { entry: e, outcome: e.mode === 'queued' ? 'queued' : 'delivered-pending' };
    return null;
  }

  /** The user entry a queued request will be written as when it starts (the queue is not in the conversation). */
  private queuedEntry(q: Pick<QueuedRequest, 'clientId' | 'text' | 'pins' | 'at'>): ConversationEntry {
    return { type: 'user', at: q.at, text: q.text, pins: q.pins, attachments: [], mode: 'queued', clientId: q.clientId };
  }

  /**
   * POST …/messages (spec §2). `queued`: into the queue (at most `LIVE_LIMITS.queued`). `live`: into the running turn — written
   * to the agent's session when live input is on, queued when it is off (`queued-unsupported`) or when the agent has finished
   * (`queued-after-finish`, never refused). A message the run can no longer take (its result came) waits for the core's
   * decision, so the answer is what really happens (fix round 1, I2): `delivered-pending` when a repair attempt carries it,
   * `queued-after-finish` when no attempt follows. Idempotent on `clientId` (Review Focus 3).
   */
  async postMessage(ref: CreativeRef, input: UserMessageInput & { mode: 'live' | 'queued' }): Promise<MessageAnswer> {
    const m = checkLiveMessage(input);
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    const answer = await this.answers.once(`${key}\0${m.clientId}`, async (): Promise<MessageAnswer> => {
      const known = await this.knownAnswer(ref, m.clientId);
      if (known) return known;
      if (input.mode === 'queued') return this.queueRequest(ref, m, 'queued');
      const live = this.liveOf(key);
      // Another job of the creative (a translation) takes no messages; with no job at all, the turn is over.
      if (!live) return this.queueRequest(ref, m, this.isActive(key) ? 'queued-unsupported' : 'queued-after-finish');
      const step = await live.serial(() => this.liveMessage(ref, live, m));
      if (!('wait' in step)) return step;
      const f = await step.wait.final;
      if (f === 'dropped') throw new CodedError(409, t().live.notRunning, 'not-running');
      return { entry: step.entry, outcome: f === 'queued' ? 'queued-after-finish' : 'delivered-pending' };
    });
    if (answer.outcome !== 'delivered-pending') void this.maybeAutoRun(ref);
    return answer;
  }

  private async liveMessage(ref: CreativeRef, live: LiveTurn, m: UserMessageInput): Promise<MessageAnswer | { entry: ConversationEntry; wait: LiveMessage }> {
    if (live.messages.length >= LIVE_LIMITS.perTurn) throw new CodedError(409, t().live.tooManyLive({ max: LIVE_LIMITS.perTurn }), 'limit');
    if (!live.caps.liveInput) return this.queueRequest(ref, m, 'queued-unsupported');
    if (live.phase === 'finalizing' || live.phase === 'ended') return this.queueRequest(ref, m, 'queued-after-finish');
    const store = new CreativeStore(ref.projectDir);
    const entry: ConversationEntry = { type: 'user', at: now(), text: m.text, pins: m.pins, attachments: [], jobId: live.jobId, mode: 'live', clientId: m.clientId };
    await store.appendConversation(ref.creativeSlug, entry);
    const msg = newLiveMessage(m, 'live');
    live.messages.push(msg);
    this.deps.queue.patch(live.jobId, { liveMessages: live.messages.length });
    this.changed(ref);
    // Before the run starts it is sent as soon as the run is there (the job may wait for a slot: answered now).
    if (live.phase === 'preparing') return { entry, outcome: 'delivered-pending' };
    if (live.phase === 'agent' && live.run) {
      const sent = await live.run.send?.({ text: liveMessageText(m.text, m.pins, pinLine), clientId: m.clientId });
      if (sent === 'written') { live.given(msg, 'sent'); return { entry, outcome: 'delivered-pending' }; }
    }
    // The run's input is closed (its result came) or no run is attached: at the last attempt it is the next request now;
    // otherwise the core decides after the checks (a repair attempt carries it, or it is queued).
    if (live.lastAttempt) { await this.queueAfterFinish(ref, store, [msg]); return { entry, outcome: 'queued-after-finish' }; }
    return { entry, wait: msg };
  }

  /** Messages no attempt will take (the turn is saving, failed or stopped): queued as the next requests, with a note. */
  private async drainLive(ref: CreativeRef, store: CreativeStore, live: LiveTurn): Promise<void> {
    const left = live.messages.filter((m) => m.state === 'pending');
    if (live.redirect) { if (!left.includes(live.redirect)) left.push(live.redirect); live.redirect = null; }
    if (left.length > 0) await this.queueAfterFinish(ref, store, left);
  }

  private async queueAfterFinish(ref: CreativeRef, store: CreativeStore, msgs: LiveMessage[]): Promise<void> {
    for (const m of msgs) {
      m.state = 'queued';
      await this.queueRequest(ref, m, 'queued-after-finish', { limit: false, note: false });
      m.settle('queued');
    }
    await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: t().live.queuedAfterFinish });
    this.changed(ref);
  }

  /**
   * Appends a request to the creative's queue under its lock; the user limit applies unless `limit: false` (never lost). A
   * request that arrived after the agent finished gets the chat's notice (unless `note: false`: the caller writes one).
   */
  private async queueRequest(ref: CreativeRef, m: UserMessageInput, outcome: Exclude<LiveMessageOutcome, 'delivered-pending'>, o: { limit?: boolean; note?: boolean } = {}): Promise<MessageAnswer> {
    const store = new CreativeStore(ref.projectDir);
    const item: QueuedRequest = { clientId: m.clientId, text: m.text, pins: m.pins, at: now(), bootId: this.bootId };
    this.refs.set(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug), ref);
    await this.runLocked(ref, async () => {
      const c = await store.get(ref.creativeSlug);
      const queued = c.queued ?? [];
      if (queued.some((x) => x.clientId === m.clientId)) return;
      if (o.limit !== false && queued.length >= LIVE_LIMITS.queued) throw new CodedError(409, t().live.queueFull({ max: LIVE_LIMITS.queued }), 'limit');
      await store.update(ref.creativeSlug, { queued: [...queued, item] });
    });
    if (outcome === 'queued-after-finish' && o.note !== false) {
      await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: t().live.queuedAfterFinish });
    }
    this.changed(ref);
    return { entry: this.queuedEntry(item), outcome };
  }

  /** DELETE …/queue/:clientId: only while it waits. */
  async removeQueued(ref: CreativeRef, clientId: string): Promise<CreativeFile> {
    return this.editQueue(ref, (q) => {
      if (!q.some((x) => x.clientId === clientId)) throw new CodedError(404, t().live.notQueued, 'not-queued');
      return q.filter((x) => x.clientId !== clientId);
    });
  }

  /** PUT …/queue/:clientId: new text and pins, only while it waits. */
  async editQueued(ref: CreativeRef, clientId: string, patch: { text: string; pins: Pin[] }): Promise<CreativeFile> {
    const m = checkLiveMessage({ clientId, ...patch });
    return this.editQueue(ref, (q) => {
      if (!q.some((x) => x.clientId === clientId)) throw new CodedError(404, t().live.notQueued, 'not-queued');
      return q.map((x) => (x.clientId === clientId ? { ...x, text: m.text, pins: m.pins } : x));
    });
  }

  /** PUT …/queue { order } (Ruling S): a permutation of the queue as it is now; anything else is refused. */
  async reorderQueue(ref: CreativeRef, order: string[]): Promise<CreativeFile> {
    return this.editQueue(ref, (q) => {
      const same = order.length === q.length && new Set(order).size === order.length && order.every((id) => q.some((x) => x.clientId === id));
      if (!same) throw new CodedError(409, t().live.queueChanged, 'queue-changed');
      return order.map((id) => q.find((x) => x.clientId === id)!);
    });
  }

  private async editQueue(ref: CreativeRef, fn: (q: QueuedRequest[]) => QueuedRequest[]): Promise<CreativeFile> {
    const store = new CreativeStore(ref.projectDir);
    const updated = await this.runLocked(ref, async () => {
      const c = await store.get(ref.creativeSlug);
      const next = fn(c.queued ?? []);
      return store.update(ref.creativeSlug, { queued: next.length > 0 ? next : undefined });
    });
    this.changed(ref);
    return updated;
  }

  /** POST …/queue/run-next: starts the first queued request now (after a restart or a stop, the only way it starts). */
  async runNext(ref: CreativeRef): Promise<JobSummary> {
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    return this.locks.run(key, async () => {
      if (this.isActive(key)) throw new CodedError(409, t().errors.generationRunning, 'job-running');
      const job = await this.startQueuedLocked(ref);
      if (!job) throw new CodedError(409, t().live.queueEmpty, 'queue-empty');
      return job;
    });
  }

  /** Takes the queue's first request off and starts it as a normal turn; it goes back to the front if the start fails. */
  private async startQueuedLocked(ref: CreativeRef): Promise<JobSummary | null> {
    const store = new CreativeStore(ref.projectDir);
    const c = await store.get(ref.creativeSlug);
    const [head, ...rest] = c.queued ?? [];
    if (!head) return null;
    await store.update(ref.creativeSlug, { queued: rest.length > 0 ? rest : undefined });
    try {
      return await this.startLocked(ref, { text: head.text, pins: head.pins }, undefined, { clientId: head.clientId });
    } catch (err) {
      const now2 = await store.get(ref.creativeSlug);
      await store.update(ref.creativeSlug, { queued: [head, ...(now2.queued ?? []).filter((x) => x.clientId !== head.clientId)] });
      throw err;
    }
  }

  /**
   * Starts the queue's first request when nothing runs for the creative, its last turn was not stopped, and it was queued
   * by this core process (Ruling T: after a restart the queue waits for "Run next"). Never throws.
   */
  async maybeAutoRun(ref: CreativeRef): Promise<JobSummary | null> {
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    try {
      return await this.locks.run(key, async () => {
        if (this.isActive(key) || this.paused.has(key)) return null;
        const head = (await new CreativeStore(ref.projectDir).get(ref.creativeSlug)).queued?.[0];
        if (!head || head.bootId !== this.bootId) return null;
        return this.startQueuedLocked(ref);
      });
    } catch {
      return null;
    }
  }

  /**
   * A creative turn settled (Ruling U): the next queued request starts by itself only after a turn that saved a version and
   * was not stopped; after a failure, a Stop or a cancel the queue waits for "Run next" (no spending without the user).
   */
  private async turnSettled(ref: CreativeRef, jobId: string, state: string | undefined): Promise<void> {
    const live = this.live.get(jobId);
    if (live) live.phase = 'ended';
    this.live.delete(jobId);
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    if (state !== 'succeeded' || !live?.savedVersion || live.stopped) { this.paused.add(key); return; }
    await this.maybeAutoRun(ref);
  }

  /**
   * Another job of the creative (a translation) ended: its queue may start (Ruling T applies). Known creatives only: a
   * queue made in this process has been seen here (its ref is kept), and an older one waits for "Run next" anyway.
   */
  async otherJobEndedByKey(key: string, state: string): Promise<void> {
    const ref = this.refs.get(key);
    // Ruling U: a failed or cancelled translation pauses the queue like a turn would.
    if (!ref) return;
    if (state !== 'succeeded') { this.paused.add(key); return; }
    if (!this.paused.has(key)) await this.maybeAutoRun(ref);
  }

  /** Whether a job is a creative turn this service runs (its live side exists). */
  hasLiveTurn(jobId: string): boolean { return this.live.has(jobId); }

  /**
   * POST /api/jobs/:id/redirect for a creative turn (spec §3), through the sequence shared with the console
   * (`redirectLive`): approvals first, running core tools aborted (the job goes on), then interrupt and write, or the
   * fallback — the run is cancelled and the next attempt of the same job resumes the live session (not a fork) with the
   * message. The answer says what happened; a redirect that comes while the version is saved is queued as the next request.
   * Idempotent per job and `clientId`, also once the turn is over.
   */
  async redirect(jobId: string, input: UserMessageInput): Promise<{ outcome: RedirectOutcome }> {
    const m = checkLiveMessage(input);
    return this.answers.once(`redirect\0${jobId}\0${m.clientId}`, async () => {
      const live = this.live.get(jobId);
      if (!live) throw new CodedError(409, t().live.notRunning, 'not-running');
      const ref = live.ref;
      const store = new CreativeStore(ref.projectDir);
      const outcome = await redirectLive(live, m, {
        cancelApprovals: () => this.deps.cancelApprovals?.(jobId),
        late: async (x) => (await this.queueRequest(ref, x, 'queued-after-finish', { limit: false })).outcome as RedirectOutcome,
        record: async (msg, count) => {
          await store.appendConversation(ref.creativeSlug, { type: 'user', at: now(), text: msg.text, pins: msg.pins, attachments: [], jobId, mode: 'redirect', clientId: msg.clientId });
          this.deps.queue.patch(jobId, { liveMessages: count });
          this.changed(ref);
        },
        interrupted: async () => {
          const marker: AgentEvent = { kind: 'interrupted' };
          if (live.emit) live.emit(marker);
          else {
            this.deps.broadcast({ type: 'agent', jobId, event: marker });
            await store.appendConversation(ref.creativeSlug, { type: 'agent', at: now(), jobId, event: marker });
          }
        },
        text: (msg) => liveMessageText(msg.text, msg.pins, pinLine),
        answerBeforeStart: true,
      });
      return { outcome };
    });
  }

  /** Phase 13: the session a stopped turn leaves to the next one (the one its agent reported), with the job. */
  private stoppedOf(jobId: string): CreativeFile['stoppedSession'] {
    const sessionId = this.deps.queue.list().find((j) => j.id === jobId)?.sessionId;
    return sessionId ? { sessionId, at: now(), jobId } : undefined;
  }

  private async cancelled(ref: CreativeRef, store: CreativeStore, previous: CreativeStatus, hasVersions: boolean, stopped?: CreativeFile['stoppedSession']): Promise<'cancelled'> {
    const restored: CreativeStatus = previous === 'ready' || previous === 'incomplete' || previous === 'draft'
      ? previous : hasVersions ? 'ready' : 'draft';
    // Phase 13 (spec §3): the stopped turn's session is remembered for the next turn (only when its agent had started one).
    await store.update(ref.creativeSlug, { status: restored, error: null, ...(stopped ? { stoppedSession: stopped } : {}) });
    await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: t().jobs.cancelledNote });
    await this.commitState(ref, t().jobs.stateCommit({ title: await this.titleOf(store, ref.creativeSlug) }));
    this.changed(ref);
    return 'cancelled';
  }

  /** Best-effort commit of the creative's metadata: never throws, so it cannot change the outcome of a turn. */
  async commitState(ref: CreativeRef, message: string): Promise<void> {
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
  async clearStaleOutputs(store: CreativeStore, slug: string, n: number, versions: VersionEntry[]): Promise<void> {
    if (versions.some((v) => v.n === n)) return;
    const dir = store.outputsDir(slug, n);
    const info = await lstat(dir).catch(() => null);
    if (!info) return;
    // A symlink or file is removed as an entry, never followed.
    await rm(dir, info.isDirectory() ? { recursive: true, force: true } : { force: true });
  }

  /**
   * The feedback frames of the pinned comments (the agent reads them): one JPEG per pin with a time (two for a range pin: its start and its end), from the base's media
   * or, for a v2 version without a current render, from its composition. They go to the protected core cache
   * `.studio/cache/pin-frames/<creative>/v<n>/<n>-<i>.jpg` (the agent can read `.studio`, never write it), through real
   * directories and a fresh temp file renamed into place (fix I1): never through a link someone planted.
   */
  private async extractPinFrames(ref: CreativeRef, store: CreativeStore, pins: Pin[], source: VersionEntry | undefined, n: number): Promise<string[]> {
    if (!source || !pins.some((p) => p.timeSec !== null || p.range)) return [];
    const dir = await realDirChain(ref.projectDir, ['.studio', 'cache', 'pin-frames', ref.creativeSlug, `v${n}`]).catch(() => null);
    if (!dir) return [];
    const out: string[] = [];
    for (const [i, pin] of pins.entries()) {
      // A range pin (Phase 10b) gets its start frame `<n>-<i>.jpg` and its end frame `<n>-<i>e.jpg`; any other pin with a time one frame.
      const wanted: Array<{ name: string; at: number }> = pin.range
        ? [{ name: `${n}-${i + 1}.jpg`, at: pin.range.start }, { name: `${n}-${i + 1}e.jpg`, at: pin.range.end }]
        : pin.timeSec !== null ? [{ name: `${n}-${i + 1}.jpg`, at: pin.timeSec }] : [];
      for (const { name, at: asked } of wanted) {
        try {
          const output = source.outputs.find((o) => o.format === pin.format);
          // A range that ends at the duration still gets its end frame: the grab is clamped to the last frame (a seek at EOF finds none).
          const at = output?.durationSec ? Math.min(asked, Math.max(0, output.durationSec - 1 / 30)) : asked;
          // A v2 version without a current render: the frame comes from its composition (Task 5b).
          const fromComposition = source.compositions?.some((c) => c.format === pin.format) && renderState(source, pin.format) !== 'rendered';
          let made = false;
          if (fromComposition && this.deps.previews) {
            const jpeg = await this.deps.previews.frameJpeg({ projectDir: ref.projectDir, creativeDir: store.dir(ref.creativeSlug), creativeSlug: ref.creativeSlug, n: source.n }, source, pin.format, at);
            made = jpeg !== null && await writeThroughTemp(dir, name, async (temp) => { await writeFile(temp, jpeg, { flag: 'wx' }); return true; });
          } else if (output && this.deps.media.available) {
            // ffmpeg writes a fresh random temp name (its `-y` never meets an existing entry), then it is renamed into place.
            made = await writeThroughTemp(dir, name, (temp) => this.deps.media.frame(join(store.outputsDir(ref.creativeSlug, source.n), output.file), temp, at));
          }
          if (made) out.push(relative(ref.projectDir, join(dir, name)).split(sep).join('/'));
        } catch {
          // The feedback frame is optional: the pin still travels as text.
        }
      }
    }
    return out;
  }

  /** The storyboards of version `n`, detached (see the caller); the clients are told when they are there. Never throws. */
  storyboardsLater(ref: CreativeRef, store: CreativeStore, n: number): void {
    const previews = this.deps.previews;
    if (!previews) return;
    void (async () => {
      if (!(await previews.available())) return;
      const version = (await store.readVersions(ref.creativeSlug)).find((v) => v.n === n);
      if (!version) return;
      await previews.storyboardsFor({ projectDir: ref.projectDir, creativeDir: store.dir(ref.creativeSlug), creativeSlug: ref.creativeSlug, n }, version);
      this.changed(ref);
    })().catch(() => {});
  }

  /** Tells the clients the creative changed (one `creative` event). */
  changed(ref: CreativeRef) {
    this.deps.broadcast({ type: 'creative', project: ref.projectSlug, creative: ref.creativeSlug });
  }
}

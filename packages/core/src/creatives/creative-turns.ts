import { activeMembers, briefSchema, compositionProblemText, creativeJobKey, issuesText, isSessionId, letterOfSlug, LIVE_LIMITS, MAX_RUNNING_VARIANTS, type JobWaitReason, type ConversationEntry, type LiveMessageOutcome, type QueuedRequest, type RedirectOutcome, type VariantGroup, type VariantId, type VariantMember } from '@motion-studio/shared';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mergeStorePack, verifyScreens } from '../store-pack/brief.ts';
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { canFollow, effectiveServices, servicesForFormats, checkLink, effectiveLinks, legacyTurnKind, linksAfterBriefSave, formatHistory, sameDelivery, formatDisplayName, hasFormat, manifestSchema, messages, renderState, starOf, EMPTY_BRAND_KIT, projectFileSchema, type Brief, type LinkedCodebase, type CreativeFile, type CreativeStatus, type FormatPreset, type JobSummary, type AgentEvent, type Locale, type ManifestFile, type OutputFileInfo, type Pin, type ServerMessage, type StorePack, storePackSchema, type UsageRecord, type VersionComposition, type VersionEntry } from '@motion-studio/shared';
import type { AgentLauncher } from '../agent/launcher.ts';
import { detachLinksUnder } from '../agent/protected-links.ts';
import { noteCoreChange } from '../core-changes.ts';
import { BrandStore } from '../brand/brand-store.ts';
import { assertCodebasesOutside, checkCodebases, codebaseGlobCharsMessage, codebaseHasGlobChars, codebaseOverlaps, codebaseOverlapMessage, codebaseSnapshot, normalizeCodebaseList } from '../codebases.ts';
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
import { assertAgentFolders, CodedError, WorkspaceError } from '../workspace-store.ts';
import { CreativeStore } from './creative-store.ts';
import { CreativeSideStateStore } from './creative-side-state.ts';
import { VariantGroupService } from './variant-group.ts';
import { setHelperTag } from './group-conversation.ts';
import { validateOutputs, type ValidationResult } from './output-contract.ts';
import { confinedSha, copyVerified, earlierOutputDirs, followCheck, isConfinedFile, normalizeTargets, snapshotChanges, snapshotOutputs, versionDirReady, withoutCoreWrites, type FollowFailure } from './carry-over.ts';
import { outputFileExists } from './format-summary.ts';
import { hashVersionOutputs, LAZY_HASH_BUDGET_MS, withLazyHashes } from './output-hashes.ts';
import { legacyProblemsOf } from './legacy-problems.ts';
import { clearReferenceFrames, conversionPlan, extractReferenceFrames } from './legacy-conversion.ts';
import { AnswerCache, checkLiveMessage, liveMessageText, LiveSession, newLiveMessage, NO_LIVE, redirectLive, type LiveMessage, type UserMessageInput } from '../agent/live-session.ts';
import { buildCreativePrompt, interruptedRedirectText, pinLine, REDIRECT_PARTIAL_NOTE, type AgentContract, type CreativeContext, type PromptKind, type PromptVariant } from './prompt.ts';
import { checkComposition, checkTargets, type TargetsCheck } from './composition-contract.ts';
import { isRealDirChain, realDirChain, writeThroughTemp } from './core-files.ts';
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
  /** Decision 1126: the user declined the paid services of this turn's variant run (`ApprovalBroker.paidOff`): the turn is told they are off. */
  paidOff?: (jobId: string) => boolean;
  /**
   * Phase 13 (final review I1): where each creative's queue and remembered session live — the core's config folder, out
   * of the agent's reach and out of git. Absent: in memory only.
   */
  sideState?: CreativeSideStateStore;
}

/** What a brief edit sends (PUT …/creatives/:c). */
export interface BriefPatch {
  title?: string; brief?: Brief; services?: Brief['services']; formatLabels?: Record<string, string | null>; formats?: string[]; storePack?: StorePack | null; linkedCodebases?: LinkedCodebase[];
  /**
   * Decision 917 (the agent's `update_brief`, `add_language`): these fields of the brief stored now, merged like `services`
   * (a partial save); the result is checked against the brief schema. Never sent by the routes.
   */
  fields?: Partial<Pick<Brief, 'goal' | 'message' | 'notes' | 'durationSec' | 'locales'>>;
}
/** Decision 917: how a creative turn ended, for the hooks that run when it settles (`onTurnSettled`). */
export interface TurnSettled { state: string | undefined; savedVersion: number | null; stopped: boolean }
export type TurnSettledHook = (ref: CreativeRef, jobId: string, outcome: TurnSettled) => Promise<void>;
/** Phase 15: what a variant group shares and propagates (spec §2): the brief (minus each variant's links), title and codebases. */
export interface SharedBrief { brief: Brief; title?: string; linkedCodebases?: LinkedCodebase[] }

/** Phase 13: what POST …/messages answers (and answers again for the same `clientId`). */
export interface MessageAnswer { entry: ConversationEntry; outcome: LiveMessageOutcome }
/** Phase 13: a message sent while a turn runs (live or queued), or a redirect, as the routes pass it. */
export type { UserMessageInput };

/** Phase 13: the live side of a creative turn. */
class LiveTurn extends LiveSession {
  /** Set by the turn once its agent runs start: the core's own markers go the same way as the agent's events. */
  emit: ((e: AgentEvent) => void) | null = null;
  /**
   * Set with `emit`: appends a user entry after every agent event emitted so far (user note 7). A message written outside
   * this chain would pass agent events still waiting to be written, and land in the file above them.
   */
  write: ((entry: ConversationEntry) => Promise<void>) | null = null;
  /** The job was stopped or cancelled (also late, while the version was being saved): its queue waits for "Run next". */
  stopped = false;
  /** The turn saved a version (Ruling U: only then the queue goes on by itself). */
  savedVersion = false;
  /** Decision 917: the number of the version it saved (the app actions kept for after the turn act on it). */
  savedN: number | null = null;
  constructor(jobId: string, caps: LiveSession['caps'], readonly ref: CreativeRef) { super(jobId, caps); }
}
/** How many idempotency answers are kept (per process; older ones are found again in the conversation or the queue). */
const MAX_ANSWERS = 1000;
export interface CreativeRef { root: string; projectSlug: string; projectDir: string; creativeSlug: string }

/** Shared with the web (render keys are derived from it): @motion-studio/shared `creativeJobKey`. */
export { creativeJobKey };
/** Decision 1153: a request sent to several variants at once: its one id and the variant whose turn may add variants. */
export type FanoutTag = NonNullable<QueuedRequest['fanout']>;

/**
 * Phase 3 of the single agent: a variant's turn run as a helper of a group turn (spec §4.3). `request`: the user's message to
 * the group (quoted in the helper's prompt for context; its instruction is the turn's message); `variant`: its id.
 */
export interface HelperOf { jobId: string; variant: VariantId; request: { text: string; pins: Pin[] } | null }
/**
 * Phase 3: where a grouped member's requests go when its group has one agent (`GroupTurnService`): a helper's leftover
 * messages join the group's queue, and a member's own queue never starts by itself.
 */
export interface GroupRouter {
  /** Whether `ref`'s group has one agent now. */
  enabled(ref: CreativeRef): Promise<boolean>;
  /** Puts `m` (sent to helper `ref` while it worked) into its group's queue, for the variant `variant`. */
  queueForGroup(ref: CreativeRef, m: UserMessageInput, variant: VariantId): Promise<void>;
}

/** Phase 15: see `CreativeTurnService.setQueuedHook`. `hold`: the reason the request's turn waits with (null: none now). */
export interface QueuedHook {
  hold: JobWaitReason | null;
  /** Called with the turn's job id right before it is enqueued. */ started?: (jobId: string) => void;
  /** Called when the request is taken out of the queue by hand (`removeQueued`). */ removed?: () => void;
}

/** Phase 15: the job queue group of a variant group's turns (`JobSpec.slot`): one per host creative. */
export const variantSlotGroup = (ref: CreativeRef, host: string): string => `variants:${creativeJobKey(ref.root, ref.projectSlug, host)}`;

/** Phase 15: what a variant's prompt says about its group (`PromptInput.variant`); undefined outside a group. */
function promptVariant(m: { group: VariantGroup; self: VariantMember } | null): PromptVariant | undefined {
  if (!m) return undefined;
  const active = activeMembers(m.group);
  return {
    letter: m.self.letter, count: active.length, direction: m.self.direction,
    others: active.filter((x) => x.slug !== m.self.slug).map((x) => ({ letter: x.letter, direction: x.direction })),
  };
}

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
/** User note 6: the first video composition of a check that is far from the brief's duration (seconds, as the problem says). */
function durationOffOf(r: TargetsCheck): { duration: number; target: number } | undefined {
  for (const c of r.checks) {
    const p = c.problems.find((x) => x.key === 'composition.durationOffBrief');
    if (p && typeof p.params.duration === 'number' && typeof p.params.target === 'number') return { duration: p.params.duration, target: p.params.target };
  }
  return undefined;
}

/**
 * Report 33: whether the agent left the version folder `dir` as the turn found it: nothing in it but folders (it may have
 * made `compositions/`). Any file or link counts as written. A folder that cannot be read counts as written too.
 */
async function slotUntouched(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? [] : null));
  if (entries === null) return false;
  for (const e of entries) {
    if (!e.isDirectory() || !(await slotUntouched(join(dir, e.name)))) return false;
  }
  return true;
}

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
  /**
   * Phase 13, Ruling T (final review I1): the queued requests this process queued, by creative key + clientId. Only these
   * start by themselves: one queued before a restart, or written by anyone else, waits for "Run next". Never persisted,
   * so nothing on disk can make a request start by itself.
   */
  private readonly queuedHere = new Set<string>();
  /** Phase 13: each creative's queue and remembered session (creative-side-state.ts). */
  readonly side: CreativeSideStateStore;
  /** Phase 13: the live side of each creative turn, by job id, from its start until it settles. */
  private readonly live = new Map<string, LiveTurn>();
  /** Phase 13: creatives whose last turn was stopped or cancelled: their queue waits for "Run next" (decisions log). */
  private readonly paused = new Set<string>();
  /** Phase 13: answers by creative key + clientId (idempotency, Review Focus 3); a pending one is shared by a double click. */
  private readonly answers = new AnswerCache(MAX_ANSWERS);
  /** Phase 13: the creatives whose queue this process changed, by job key (for `otherJobEndedByKey`). */
  private readonly refs = new Map<string, CreativeRef>();
  /** Decision 1153: the turns that may not add variants, by job id (`addRefusal`). */
  private readonly noAdd = new Map<string, { lead: VariantId } | { firstGeneration: true }>();
  /** Phase 15: hooks of queued requests of a variant run, by creative key + clientId (`setQueuedHook`). */
  private readonly queuedHooks = new Map<string, QueuedHook>();
  /** Decision 917: the duration a running turn's output checks use, by job id, once its agent changed the brief's. */
  private readonly turnDurations = new Map<string, number | null>();
  /** Decision 917: called when a creative turn settles (`onTurnSettled`). */
  private readonly settleHooks: TurnSettledHook[] = [];
  /** Phase 3 of the single agent: the helpers of group turns, by job id, until they settle. */
  private readonly helpers = new Map<string, HelperOf>();
  /** Phase 3: see `GroupRouter` (set by the group turn service). */
  private router: GroupRouter | null = null;
  constructor(private readonly deps: CreativeTurnDeps) {
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.side = deps.sideState ?? new CreativeSideStateStore(null);
  }

  /**
   * Starts a turn. `opts.formats`: the formats the request applies to (spec §2.5); formats outside the brief are dropped, a
   * follower stands for its primary, and none (or absent) means every primary. The other formats are carried unchanged.
   */
  /**
   * `opts.fanout`: the request was sent to several variants at once (decision 1153; see `QueuedRequest.fanout`). Phase 3 of
   * the single agent: `opts.helper`, the turn is a helper of that group turn: `message` is the coordinator's instruction (no
   * user entry is written: the user's message is the group's), every entry it writes carries `groupJobId`, and its group-level
   * actions are refused.
   */
  async start(ref: CreativeRef, message?: { text: string; pins: Pin[] }, opts: { formats?: string[]; hold?: JobWaitReason; fanout?: FanoutTag; helper?: HelperOf } = {}): Promise<JobSummary> {
    return this.locks.run(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug), () => this.startLocked(ref, message, opts.formats, undefined, opts.hold, opts.fanout, opts.helper));
  }

  /** Phase 3 of the single agent: see `GroupRouter`. */
  setGroupRouter(router: GroupRouter | null): void { this.router = router; }

  /** Phase 3: the group turn job `jobId` is a helper of, or null. */
  helperOf(jobId: string): HelperOf | null { return this.helpers.get(jobId) ?? null; }

  /**
   * Decision 1153 (review minor 10: derived from the turn, not from the run that started it): why turn `jobId` may not add a
   * variant. `lead`: it is one share of a request sent to several variants, and variant `lead`'s turn adds them;
   * `firstGeneration`: a turn with no message of a creative already in a group (a group's first generation, or "Genera").
   * Known from the turn's own start (a fan-out's queued share keeps its `fanout` on disk), for as long as the turn lives.
   */
  addRefusal(jobId: string): { lead: VariantId } | { firstGeneration: true } | null {
    return this.noAdd.get(jobId) ?? null;
  }

  /**
   * Phase 15 (variant runs): what happens when the queued request `clientId` of this creative becomes a turn: it is enqueued
   * held with `hold.reason` while that is set (it waits for the run's directions or paid-services card, even when the turn
   * before it ends first), and `started` is told its job id. The hook is read when the request starts and then dropped;
   * `null` removes it. In memory only, like the queue's auto-start (Ruling T).
   */
  setQueuedHook(ref: CreativeRef, clientId: string, hook: QueuedHook | null): void {
    const k = `${creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug)}\0${clientId}`;
    if (hook) this.queuedHooks.set(k, hook);
    else this.queuedHooks.delete(k);
  }

  /**
   * Edits title and/or brief; refused while a generation is queued or running for the creative. Phase 15: on a creative of
   * a variant group (its host or a real sister) the edit is the GROUP's: it goes through `VariantGroupService` and reaches
   * every active variant, a working one at its next turn (spec §2, "Brief comune").
   */
  async updateBrief(ref: CreativeRef, patch: BriefPatch): Promise<CreativeFile> {
    // Phase 14: the pack's screens are checked before anything is locked or written (the same check as the pack create route).
    if (patch.storePack) await verifyScreens(ref.projectDir, this.deps.media, patch.storePack);
    const variants = new VariantGroupService({ store: new CreativeStore(ref.projectDir), turns: this });
    const resolved = await variants.resolve(ref);
    if (resolved.group) return variants.updateGroupBrief(resolved.host, patch, ref);
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    return this.locks.run(key, async () => {
      if (this.isActive(key)) throw new WorkspaceError(409, t().errors.waitBeforeBrief);
      const store = new CreativeStore(ref.projectDir);
      // Decision 917: a brief the agent changed during a turn that just ended (its pending brief) applies first, so this
      // edit builds on it and is never overwritten by it afterwards.
      await this.applyPendingBriefLocked(ref);
      const stored = await store.get(ref.creativeSlug);
      const linkedCodebases = patch.linkedCodebases ? normalizeCodebaseList(patch.linkedCodebases) : null;
      // Decision 788: only new or changed paths get the glob check; a legacy one already stored passes (skipped at run time).
      if (linkedCodebases) await assertCodebasesOutside(linkedCodebases, [ref.projectDir, ref.root], stored.linkedCodebases ?? []);
      const change = await this.briefChange(store, ref.creativeSlug, stored, patch);
      const updated = await store.update(ref.creativeSlug, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(change.brief ? { brief: change.brief } : {}),
        ...(change.exportPicks ?? {}),
        ...(change.freed ?? {}),
        ...(linkedCodebases ? { linkedCodebases } : {}),
      });
      await this.commitState(ref, t().jobs.briefUpdatedCommit({ title: updated.title }));
      // User note 6: a new duration is checked again on the latest version at once, with no new turn.
      if (change.brief && change.brief.durationSec !== stored.brief.durationSec) return (await this.recheckLatest(ref, store, change.brief.durationSec)) ?? updated;
      return updated;
    });
  }

  /**
   * Decision 917: a brief edit by the agent of the running turn of `ref` (its `update_brief`, `add_format`, `add_language`).
   * In a variant group it is the group's edit (`updateGroupBrief`: idle variants now, working ones, this one included, at
   * their next turn). Outside a group the brief never changes under a running turn (`updateBrief` refuses the UI with 409):
   * the change is computed by `briefChange` on the brief as it will be (the pending one, else the stored one) and kept as the
   * creative's pending brief, which `briefAfterJob` applies when the turn ends, whatever its outcome. `build` makes the
   * patch from that brief, under the lock the write takes. Answers the brief before and after (for the chat line).
   */
  async briefFromAgent(ref: CreativeRef, build: (current: Brief) => BriefPatch): Promise<{ before: Brief; after: Brief }> {
    const store = new CreativeStore(ref.projectDir);
    const variants = new VariantGroupService({ store, turns: this });
    const resolved = await variants.resolve(ref);
    if (resolved.group) {
      let before: Brief | null = null;
      await variants.updateGroupBrief(resolved.host, (current) => { before = current; return build(current); }, ref);
      const after = (await this.side.pendingBrief(ref.projectDir, ref.creativeSlug))?.brief ?? (await store.get(ref.creativeSlug)).brief;
      return { before: before!, after };
    }
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    return this.locks.run(key, async () => {
      // The bridge only answers while the turn runs: a call that comes after it is refused, nothing is written.
      if (!this.isActive(key)) throw new CodedError(409, t().errors.toolUnavailable, 'turn-over');
      const stored = await store.get(ref.creativeSlug);
      const pending = await this.side.pendingBrief(ref.projectDir, ref.creativeSlug);
      const before = pending?.brief ?? stored.brief;
      const change = await this.briefChange(store, ref.creativeSlug, { ...stored, brief: before }, build(before));
      const after = change.brief ?? before;
      await this.side.setPendingBrief(ref.projectDir, ref.creativeSlug, {
        brief: after, ...(pending?.title ? { title: pending.title } : {}), ...(pending?.linkedCodebases ? { linkedCodebases: pending.linkedCodebases } : {}), at: now(),
      });
      // Any job of this creative that ends applies it (`briefAfterJob`).
      this.rememberRef(ref);
      return { before, after };
    });
  }

  /**
   * User note 6: after the brief's duration changed (a brief save, a group's brief applied, a pending brief applied when a
   * turn ended), the LATEST version is checked again when it is `incomplete`, with no agent: each primary composition with
   * problems goes through `checkComposition` again against the new duration, on its folder as it is now (its hash must
   * still be the recorded one; otherwise it is left as it is). A format that passes now loses its problems, and so do its
   * followers; the version's problems that only those formats explained go. With none left the version is `complete` and
   * the creative `ready`. `versions.json` and `creative.json` are committed by path; the chat says what changed. The caller
   * holds the creative's lock and no turn of it runs. Never throws: the brief save stands whatever happens here.
   */
  async recheckLatest(ref: CreativeRef, store: CreativeStore, durationSec: number | null): Promise<CreativeFile | null> {
    try {
      const slug = ref.creativeSlug;
      const latest = (await store.readVersions(slug)).at(-1);
      if (!latest || latest.status !== 'incomplete' || !latest.compositions?.length) return null;
      const presets = await this.deps.presets();
      const versionDir = store.outputsDir(slug, latest.n);
      const passing = new Set<string>();
      const failing = new Set<string>();
      for (const c of latest.compositions) {
        if (c.followsFormat !== undefined || !(c.problems?.length)) continue;
        const preset = findPreset(presets, c.format);
        if (!preset) { failing.add(c.format); continue; }
        const accepted = c.userDuration && durationSec !== null && c.userDuration.briefDurationSec === durationSec ? c.userDuration.durationSec : undefined;
        // Every folder of the path must be a real folder of the creative (as `checkTargets`): a link is never followed.
        if ((await isRealDirChain(store.dir(slug), ['outputs', `v${latest.n}`, ...c.dir.split('/')])) !== 'ok') { failing.add(c.format); continue; }
        const check = await checkComposition(join(versionDir, ...c.dir.split('/')), c.format, preset, durationSec, accepted);
        if (check.hash === c.hash && check.problems.length === 0) passing.add(c.format); else failing.add(c.format);
      }
      if (passing.size === 0) return null;
      // A follower's problems are copies of its primary's (`assembleCompositions`): they go with them.
      const cleared = (c: VersionComposition) => passing.has(c.format) || (c.followsFormat !== undefined && passing.has(c.followsFormat));
      const gone = new Set(latest.compositions.filter(cleared).flatMap((c) => c.problems ?? []));
      const kept = new Set(latest.compositions.filter((c) => !cleared(c)).flatMap((c) => c.problems ?? []));
      const problems = latest.problems.filter((p) => !gone.has(p) || kept.has(p));
      const complete = problems.length === 0;
      await store.updateVersion(slug, latest.n, (v) => ({
        ...v, problems, status: complete ? 'complete' : 'incomplete',
        compositions: v.compositions?.map((c) => (cleared(c) ? { ...c, problems: [] } : c)),
      }));
      const current = await store.get(slug);
      const updated = complete && current.status === 'incomplete' ? await store.update(slug, { status: 'ready' }) : current;
      const a = t().agentActions;
      const target = durationSec === null ? a.durationNone : a.seconds({ n: durationSec });
      const label = (id: string) => formatDisplayName(presets, id, currentLocale(), current.brief.formatLabels);
      await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: complete
        ? a.recheckComplete({ n: latest.n, target })
        : a.recheckPartial({ n: latest.n, target, formats: listText([...passing].map(label), currentLocale()) }) });
      await this.commitCreativeFiles(ref, [slug], a.recheckCommit({ title: current.title, n: latest.n }), [join(store.dir(slug), 'versions.json')]);
      this.changed(ref);
      return updated;
    } catch (err) {
      console.warn(`Motion Studio: the latest version of ${ref.creativeSlug} could not be checked again: ${(err as Error).message}`);
      return null;
    }
  }

  /** Decision 917: the duration this turn's output checks use from now on (its agent's `update_brief`); its brief changes when it ends. */
  setTurnDuration(jobId: string, durationSec: number | null): void {
    if (this.live.has(jobId)) this.turnDurations.set(jobId, durationSec);
  }

  /**
   * Decision 917: a group brief reached a working member as its pending brief. When its running turn's agent had set the
   * check duration, the check follows the brief the turn will end with (never a duration the brief no longer has).
   */
  pendingBriefSet(ref: CreativeRef, durationSec: number | null): void {
    const live = this.liveOf(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug));
    if (live && this.turnDurations.has(live.jobId)) this.turnDurations.set(live.jobId, durationSec);
  }

  /** Decision 917: `fn` runs when each creative turn settles, after its pending brief is applied and before its queue may go on. */
  onTurnSettled(fn: TurnSettledHook): void { this.settleHooks.push(fn); }

  /**
   * Decision 917: a chat line about the creative, from the running turn `jobId` when there is one: written after the agent's
   * events written so far (the turn's ordered writer), so it keeps its place; else appended now. The clients are told.
   */
  async noteFromTurn(jobId: string, ref: CreativeRef, entry: ConversationEntry): Promise<void> {
    const live = this.live.get(jobId);
    const own = live && live.ref.creativeSlug === ref.creativeSlug && live.ref.projectDir === ref.projectDir ? live.write : null;
    if (own) await own(entry);
    else await new CreativeStore(ref.projectDir).appendConversation(ref.creativeSlug, entry);
    this.changed(ref);
  }

  /**
   * What a brief save makes of `stored` (one creative, or a variant group's current brief): the new brief, the export picks
   * and the freed instances it leaves. No write. `slug` names the creative whose versions date the freed instances.
   */
  async briefChange(store: CreativeStore, slug: string, stored: CreativeFile, patch: BriefPatch): Promise<{ brief?: Brief; exportPicks?: { exportPicks: CreativeFile['exportPicks'] }; freed?: { freedInstances: CreativeFile['freedInstances'] } }> {
    // Links change only through setLink (validated): a brief save keeps the stored ones, whatever it carries. Formats the
    // save adds get the default links against the primaries already there (and each other), with the duration unknown
    // (`undefined`): it is checked on the real file when the follower is materialized (spec §2.4).
    let brief: Brief | undefined;
    let exportPicks: { exportPicks: CreativeFile['exportPicks'] } | undefined;
    let freed: { freedInstances: CreativeFile['freedInstances'] } | undefined;
    // Ids removed or added by this save are freed (final review I1): the rows the latest version holds for them belong to
    // the old instance and are never carried. Saved versions are not touched.
    const markFreed = async (ids: string[]) => {
      if (ids.length === 0) return;
      const latest = (await store.readVersions(slug)).at(-1)?.n ?? 0;
      freed = withFreedInstances(stored.freedInstances, ids, latest);
    };
    if (patch.brief) {
      const { links: _ignored, storePack: sentPack, ...sent } = patch.brief;
      const current = stored.brief;
      // Phase 14: the store pack changes only through `storePack` (it recomputes the pack's instances); a full save keeps it.
      // A pack other than the stored one (a second pack, or a changed one) is refused: one pack per creative, edited on its own.
      // Both sides go through the schema first, so a missing optional or a different key order is not a difference.
      if (sentPack !== undefined) {
        const parsed = (p: unknown) => (p === undefined ? undefined : storePackSchema.safeParse(p).data);
        if (!isDeepStrictEqual(parsed(sentPack), parsed(current.storePack))) {
          throw new CodedError(409, current.storePack ? t().variants.storePack.second : t().variants.storePack.useEntry, 'store-pack-second');
        }
      }
      const rest = current.storePack ? { ...sent, storePack: current.storePack } : sent;
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
      await markFreed([...gone, ...added]);
      brief = links ? { ...rest, links } : rest;
    } else if (patch.services || patch.formatLabels || patch.formats || patch.storePack !== undefined || patch.fields) {
      // A partial save (services chip, inline labels, reorder, removal): everything else comes from the brief stored now,
      // never from the caller's copy.
      let next: Brief = { ...stored.brief };
      if (patch.storePack !== undefined) {
        // Phase 14: the pack's instances are recomputed from the new pack (set, changed, or `null` to take it out); the
        // rest of the brief is untouched. Instances that go leave no link and no manual pick; added ones start clean.
        const m = mergeStorePack(next, patch.storePack, await this.deps.presets());
        next = m.brief;
        const gone = new Set(m.removed);
        if (gone.size > 0) {
          const pruned = withoutFormatState(next.links, stored.exportPicks, gone);
          exportPicks = { exportPicks: pruned.exportPicks };
        }
        await markFreed([...m.removed, ...m.added]);
      }
      if (patch.services) next.services = patch.services;
      if (patch.fields) {
        // Decision 917: the agent's partial edit; the result must still be a valid brief (lengths, languages).
        next = { ...next, ...patch.fields };
        const checked = briefSchema.safeParse(next);
        if (!checked.success) throw new CodedError(400, t().errors.invalidRequestDetail({ detail: issuesText(checked.error, currentLocale()) }), 'invalid-request');
      }
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
          await markFreed([...gone]);
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
    return { ...(brief ? { brief } : {}), ...(exportPicks ? { exportPicks } : {}), ...(freed ? { freed } : {}) };
  }

  /**
   * Phase 15: writes the group's shared brief `target` into one variant, as a full brief save of that variant would: its own
   * links are kept (formats added get the default links, removed ones leave none), its export picks and freed instances
   * follow the formats it gains or loses. The CALLER holds this variant's lock and has checked that no turn of it is queued
   * or running. Clears a pending brief (this one is newer). Commits nothing (the caller commits the group's files at once).
   */
  async applySharedBrief(ref: CreativeRef, target: SharedBrief): Promise<CreativeFile> {
    const store = new CreativeStore(ref.projectDir);
    const stored = await store.get(ref.creativeSlug);
    const { links: _hostLinks, ...shared } = target.brief;
    const current = stored.brief;
    const added = shared.formats.filter((f) => !current.formats.includes(f));
    const gone = new Set(current.formats.filter((f) => !shared.formats.includes(f)));
    let links = added.length > 0 ? linksAfterBriefSave(current, shared.formats, await this.deps.presets()) : current.links;
    let exportPicks: { exportPicks: CreativeFile['exportPicks'] } | undefined;
    if (gone.size > 0) {
      const pruned = withoutFormatState(links, stored.exportPicks, gone);
      links = pruned.links;
      exportPicks = { exportPicks: pruned.exportPicks };
    }
    const ids = [...gone, ...added];
    const latest = ids.length > 0 ? (await store.readVersions(ref.creativeSlug)).at(-1)?.n ?? 0 : 0;
    const updated = await store.update(ref.creativeSlug, {
      brief: links ? { ...shared, links } : shared,
      ...(target.title !== undefined ? { title: target.title } : {}),
      ...(target.linkedCodebases !== undefined ? { linkedCodebases: target.linkedCodebases } : {}),
      ...(exportPicks ?? {}),
      ...(ids.length > 0 ? withFreedInstances(stored.freedInstances, ids, latest) : {}),
    });
    await this.side.setPendingBrief(ref.projectDir, ref.creativeSlug, null);
    this.changed(ref);
    // User note 6: a new duration is checked again on the latest version at once, with no new turn.
    if (shared.durationSec !== current.durationSec) return (await this.recheckLatest(ref, store, shared.durationSec)) ?? updated;
    return updated;
  }

  /**
   * Phase 15: a brief the group changed while this variant was working is applied now, at the start of its next turn
   * (never mid-turn). The caller holds the variant's lock. No-op without one.
   */
  private async applyPendingBriefLocked(ref: CreativeRef): Promise<void> {
    const pending = await this.side.pendingBrief(ref.projectDir, ref.creativeSlug);
    if (!pending) return;
    await this.applySharedBrief(ref, pending);
    await this.commitCreativeFile(ref, new CreativeStore(ref.projectDir), t().jobs.briefUpdatedCommit({ title: pending.title ?? (await this.titleOf(new CreativeStore(ref.projectDir), ref.creativeSlug)) }));
  }

  /**
   * Phase 15 (decisions log 832): a brief the group changed while this variant worked, applied now. For the other writers
   * of a creative under its lock (a translation's start, an editor save, a duplicate), which hold the lock already.
   */
  applyPendingBrief(ref: CreativeRef): Promise<void> { return this.applyPendingBriefLocked(ref); }

  /**
   * Phase 15: after ANY job of the creative's key ends (a turn, a translation), its pending brief is applied under its
   * lock, unless another job of it is still queued or running (still never mid-turn).
   */
  async briefAfterJob(ref: CreativeRef): Promise<void> {
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    await this.locks.run(key, async () => { if (!this.isActive(key)) await this.applyPendingBriefLocked(ref); }).catch((err: Error) => {
      console.warn(`Motion Studio: the group's brief could not be applied to ${ref.creativeSlug}: ${err.message}`);
    });
  }

  /** Phase 15: keeps `ref` for `otherJobEndedByKey` (a variant with a pending brief, whose translation may end). */
  rememberRef(ref: CreativeRef): void { this.refs.set(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug), ref); }

  /** The format presets now (the variant service seeds a new variant with them). */
  presetList(): Promise<FormatPreset[]> { return this.deps.presets(); }

  /** Commits `absPaths` (folders or files of the project) only; the commit's sha, or null when nothing changed. Throws on a git error. */
  commitFolder(ref: CreativeRef, absPaths: readonly string[], message: string, opts: { headWhenClean?: boolean } = {}): Promise<string | null> {
    return this.deps.git.commitPaths(ref.projectDir, absPaths.map((p) => relative(ref.projectDir, p).split(sep).join('/')), message, opts);
  }

  /**
   * Commits the given creatives' creative.json files only (by path): safe while an agent of another variant writes
   * elsewhere. Best effort, like `commitState`.
   */
  async commitCreativeFiles(ref: CreativeRef, slugs: readonly string[], message: string, extra: readonly string[] = []): Promise<void> {
    const store = new CreativeStore(ref.projectDir);
    const rel = (p: string) => relative(ref.projectDir, p).split(sep).join('/');
    const paths = [...slugs.map((s) => rel(join(store.dir(s), 'creative.json'))), ...extra.map((p) => rel(p))];
    try { await this.deps.git.commitPaths(ref.projectDir, paths, message); } catch { /* picked up by the next commit */ }
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
      await this.assertNotDiscarded(ref);
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

  private async startLocked(ref: CreativeRef, message: { text: string; pins: Pin[]; pinsVersion?: number } | undefined, formats: string[] | undefined, queued?: { clientId: string }, hold?: JobWaitReason, fanout?: FanoutTag, helper?: HelperOf): Promise<JobSummary> {
    const store = new CreativeStore(ref.projectDir);
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    // Same check the queue does, but before touching the creative's files.
    if (this.isActive(key)) throw new WorkspaceError(409, t().errors.generationRunning);
    // Phase 15: a discarded variant stays inert until it is restored; a grouped member's turn takes one of the group's slots.
    // Final wave M3: this read cannot go stale before the enqueue below: a discard writes the status holding this creative's
    // lock (held here until the job is enqueued), so a start and a discard of the same variant are serialized.
    const member = await this.memberOf(ref);
    if (member?.self.status === 'discarded') throw new CodedError(409, t().errors.variantDiscardedTurn, 'variant-discarded');
    // Phase 15: a variant that was working when the group's brief changed takes it now, before its next turn is planned.
    await this.applyPendingBriefLocked(ref);
    const before = await store.get(ref.creativeSlug);
    // A request for formats none of which is in the brief is a mistake, not "all formats".
    if (formats?.length && !formats.some((f) => before.brief.formats.includes(f))) throw new CodedError(400, t().errors.formatsNotInBrief, 'formats-not-in-brief');
    const jobId = randomUUID();
    const hookKey = queued ? `${key}\0${queued.clientId}` : null;
    // Decision 1153: what this turn may not do with `add_variant` (see `addRefusal`).
    const refusal = !message ? ((await this.memberOf(ref)) ? { firstGeneration: true as const } : null)
      : fanout && fanout.lead !== letterOfSlug(ref.creativeSlug) ? { lead: fanout.lead } : null;
    // Set before the job can run; forgotten when it settles (below, once it is enqueued) or when it is never enqueued.
    if (refusal) this.noAdd.set(jobId, refusal);
    // Phase 3: a helper's entries carry its group turn from the first one on (the store stamps them); its message is the
    // coordinator's instruction, never written as the user's.
    if (helper) { this.helpers.set(jobId, helper); setHelperTag(ref.projectDir, ref.creativeSlug, helper.jobId); }
    if (message && !helper) {
      // A queued request starts as a user entry with `mode: 'queued'`. One that was first written as a live message (it
      // arrived when the agent had finished) is not written twice, unless it was edited in the queue meanwhile.
      const written = queued && (await store.readConversation(ref.creativeSlug, { own: true })).some((e) => e.type === 'user' && e.clientId === queued.clientId
        && e.text === message.text && JSON.stringify(e.pins) === JSON.stringify(message.pins));
      if (!written) {
        await store.appendConversation(ref.creativeSlug, {
          type: 'user', at: now(), text: message.text, pins: message.pins, attachments: [],
          ...(queued ? { jobId, mode: 'queued' as const, clientId: queued.clientId, deliveredAt: now() } : {}),
          ...(fanout ? { fanout: fanout.id } : {}),
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
    // Phase 15: a variant run's hook is read HERE, with no await before the enqueue below (fix round 2): a decision that
    // lands while this start awaited is seen, and the hook learns the id before the turn can start (a cover must be in
    // place before its first paid call; a cancelled run records the id to stop it).
    const hook = hookKey ? this.queuedHooks.get(hookKey) : undefined;
    const holdReason = hold ?? hook?.hold ?? undefined;
    if (hookKey && hook) { this.queuedHooks.delete(hookKey); hook.started?.(jobId); }
    try {
      job = this.deps.queue.enqueue({
        id: jobId,
        key,
        kind: 'creative',
        label: t().jobs.creativeLabel({ title: before.title }),
        ...(targets ? { formats: targets } : {}),
        // Phase 15 (spec §3): at most MAX_RUNNING_VARIANTS turns of a variant group run at once; the others wait, with the reason.
        ...(member ? { slot: { group: variantSlotGroup(ref, member.host), limit: MAX_RUNNING_VARIANTS, reason: 'variant-slot' as const } } : {}),
        // Phase 15: a turn of a variant run waits for the run's directions and paid-services card (`VariantFanout`).
        ...(holdReason ? { hold: holdReason } : {}),
        ...(helper ? { parentJobId: helper.jobId, variant: helper.variant } : {}),
        // Final wave Q8 (Ruling U micro-race): a failed or cancelled turn pauses its queue HERE, before the job turns terminal,
        // not in `turnSettled` after it: a message arriving in between can no longer start the queue after a failure or Stop.
        run: async (signal, id) => {
          try {
            const outcome = await this.run(ref, store, before.status, message, signal, id, formats);
            if (outcome === 'cancelled' || signal.aborted) this.paused.add(key);
            return outcome;
          } catch (err) {
            this.paused.add(key);
            throw err;
          }
        },
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
      this.noAdd.delete(jobId);
      if (helper) { this.helpers.delete(jobId); setHelperTag(ref.projectDir, ref.creativeSlug, null); }
      throw err;
    }
    void this.deps.queue.whenSettled(job.id).then((settled) => { this.noAdd.delete(job.id); return this.turnSettled(ref, job.id, settled?.state); });
    return job;
  }

  /**
   * Runs `fn` under the creative's lock, the one turns, restores, brief edits, links and picks take (shared with
   * `DirectEditService.save`, Phase 10b).
   */
  runLocked<T>(ref: CreativeRef, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug), fn);
  }

  /**
   * Phase 15: the creative's place in a variant group (its host, the group and its own member), or null outside a group (an
   * old creative, an orphan sister). Read without any lock: the group is written under the host's lock, never torn.
   */
  async memberOf(ref: CreativeRef): Promise<{ host: string; group: VariantGroup; self: VariantMember } | null> {
    // Only "no such creative" means "no group" (the caller then fails on its own read); any other error is real.
    const r = await new VariantGroupService({ store: new CreativeStore(ref.projectDir), turns: this }).resolve(ref)
      .catch((err: unknown) => { if ((err as { status?: unknown }).status === 404) return null; throw err; });
    const self = r?.group?.members.find((m) => m.slug === ref.creativeSlug);
    return r?.group && self ? { host: r.host.creativeSlug, group: r.group, self } : null;
  }

  /**
   * Phase 15 (decisions log 837, extended by the final wave's I2): a discarded variant is inert until it is restored: every
   * write to it (an editor save, a duplicate, a translation, a link, "resume from") is refused with 409 `variant-discarded`.
   * Its brief is the group's and is checked under the host's lock by `VariantGroupService.updateGroupBrief`.
   */
  async assertNotDiscarded(ref: CreativeRef): Promise<void> {
    if ((await this.memberOf(ref))?.self.status === 'discarded') throw new CodedError(409, t().errors.variantDiscardedTurn, 'variant-discarded');
  }

  /** Whether a turn of the creative is queued or running. */
  turnActive(ref: CreativeRef): boolean {
    return this.isActive(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug));
  }

  async restore(ref: CreativeRef, n: number): Promise<CreativeFile> {
    return this.locks.run(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug), async () => {
      await this.assertNotDiscarded(ref);
      return this.restoreLocked(ref, n);
    });
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
    const updated = await store.update(ref.creativeSlug, { resumeFrom: { version: n, sessionId: version.sessionId } });
    await this.side.update(ref.projectDir, ref.creativeSlug, () => ({ stoppedSession: undefined }));
    if (removed > 0) {
      await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: t().jobs.removedUnsaved({ count: removed }) });
    }
    await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: t().jobs.restartedFrom({ n }) });
    await this.commitState(ref, t().jobs.restartCommit({ title: updated.title, n }));
    this.changed(ref);
    return this.side.merged(ref.projectDir, ref.creativeSlug, updated);
  }

  private async run(ref: CreativeRef, store: CreativeStore, previous: CreativeStatus, message: { text: string; pins: Pin[]; pinsVersion?: number } | undefined, signal: AbortSignal, jobId: string, requestedFormats?: string[]): Promise<void | 'cancelled'> {
    const slug = ref.creativeSlug;
    // The agent's language is fixed when the job starts: a setting change mid-turn does not affect it.
    const locale = currentLocale();
    // Set once the last agent turn is over: from then on an abort no longer cancels (the version gets saved).
    let finalizing = false;
    // Phase 13: the turn's live side (made at start; a stand-in when the job was enqueued some other way).
    const live = this.live.get(jobId) ?? new LiveTurn(jobId, NO_LIVE, ref);
    this.live.set(jobId, live);
    try {
      // Decision 790: a project or workspace folder with glob characters runs no agent; refused before anything is written
      // (the chat gets the error line).
      await assertAgentFolders(ref.projectDir, ref.root);
      // Phase 15: a brief the group changed while this turn waited in the queue applies now, before anything reads the brief
      // (a turn already planned never sees a new brief mid-turn: spec §2).
      await this.runLocked(ref, () => this.applyPendingBriefLocked(ref));
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
      // Minor (Task 2): the brief just applied above may have dropped every format the request asked for; none left would
      // widen the turn to every format, so it is refused like at the start.
      if (requestedFormats?.length && !requestedFormats.some((f) => initial.brief.formats.includes(f))) throw new CodedError(400, t().errors.formatsNotInBrief, 'formats-not-in-brief');
      const creativeDir = store.dir(slug);
      // Pins, the carried files and the add-formats base refer to the version on screen: the one being resumed from, else the latest.
      const base = initial.resumeFrom ? versions.find((v) => v.n === initial.resumeFrom!.version) : latest;
      // Final wave P3: a queued request's pins refer to the version they were placed on (not a newer base); if it is gone,
      // they travel as text only, and the chat says so.
      const pinsAt = message?.pins.length && message.pinsVersion !== undefined ? message.pinsVersion : undefined;
      const pinSource = pinsAt !== undefined ? versions.find((v) => v.n === pinsAt) : base;
      if (pinsAt !== undefined && !pinSource) await store.appendConversation(slug, { type: 'system', at: now(), level: 'warning', text: t().live.queuedPinsVersionGone({ n: pinsAt }) });
      const attachments = await this.extractPinFrames(ref, store, message?.pins ?? [], pinSource, n);
      const pinsVersionNote = pinsAt !== undefined && pinsAt !== base?.n ? { n: pinsAt, gone: !pinSource } : undefined;
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
      // Decision 917: once the agent changed the brief's duration (`update_brief`), this turn's checks use the new one.
      const checkDuration = () => (this.turnDurations.has(jobId) ? this.turnDurations.get(jobId)! : creative.brief.durationSec);
      /** User note 6: the last check's first video composition far from the brief, for the repair prompt and the chat. */
      let durationOff: { duration: number; target: number } | undefined;
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
      // Kept by the core out of the agent's reach (creative-side-state.ts); every id is checked again where argv is built.
      const stopped = (await this.side.read(ref.projectDir, slug)).stoppedSession;
      const baseCandidate = creative.resumeFrom?.sessionId ?? latest?.sessionId ?? undefined;
      const baseSessionId = isSessionId(baseCandidate) ? baseCandidate : undefined;
      let resumeSessionId = stopped?.sessionId ?? baseSessionId;
      // Durations of the base the agent keeps without being told to bring them back to the brief (decisions log 262).
      let accepted: ReadonlyMap<string, number> = new Map();
      let result = null as ValidationResult | null;
      /** Report 33: the agent's run left the version folder empty (see `keepable`): the latest version stands for the turn. */
      let untouched = false;
      // One ledger record per attempt: the version's usage is their sum (fix loop included). No agent: no record, no usage.
      const attemptUsage: Array<UsageRecord | null | undefined> = [];

      // Decision 1125: the services this turn may use are the brief's narrowed to what its formats can carry; decision 1126: a
      // declined paid-services card of the variant run turns every paid one off (stock stays: it is free).
      const paidOff = this.deps.paidOff?.(jobId) ?? false;
      const fitted = servicesForFormats(creative.brief.services, creative.brief.formats, presets);
      const turnServices = paidOff ? { ...fitted, images: fitted?.images === 'none' ? 'none' as const : 'stock' as const, voice: 'none' as const, music: 'none' as const, sfx: 'none' as const } : fitted;

      if (!noAgent) {
        const { context, existing } = await this.buildContext(ref, store, creative.linkedCodebases, turnServices, paidOff);
        // Phase 15 (spec §3): a variant's own direction and the other active variants', as they are when the turn starts.
        const variant = promptVariant(await this.memberOf(ref));
        // Spec §7: a legacy base (rendered media, v1 manifest) makes this change a conversion to compositions. The core
        // extracts reference frames of the old media into its protected cache; the chat says it costs more tokens once.
        let conversion: { formats: Awaited<ReturnType<typeof extractReferenceFrames>>; created: string[] } | undefined;
        if (turnContract === 'compositions') {
          const cp = conversionPlan(versions, base, targets);
          if (cp.sources.length > 0) {
            // Once per conversion: a retry of a turn that saved no version does not repeat the entry.
            const entries = await store.readConversation(slug, { own: true });
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
        // Decision 917: the user's kept durations hold only against the brief duration they were chosen for.
        const acceptedNow = () => (checkDuration() === creative.brief.durationSec || turnContract !== 'compositions' ? accepted : acceptedDurationsOf(base, targets, presets, checkDuration()));
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
          dir: store.outputsDir(slug, n), requested: targets, presets, durationSec: checkDuration(), media: this.deps.media, locale,
          reservedOwner: plan.reservedOwner,
        });
        const checkCompositions = (only?: string) => checkTargets({
          versionDir: store.outputsDir(slug, n), targets: only === undefined ? targets : targets.filter((f) => f === only), presets,
          briefDurationSec: checkDuration(), locale, acceptedDurations: acceptedNow(),
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
        // Report 33 (decision 1120): a turn whose agent writes nothing in the version folder changes no output when every
        // target is one the latest version delivers as it is now (its own composition, still the recorded one): no repair
        // attempt, no version. A format the base lacks (added to the brief), a follower that must now be delivered, a
        // primary that cannot be carried or a base that is not the latest version keep the check and its repairs.
        const keepable = Boolean(latest && base && base.n === latest.n) && plan.unlinked.length === 0
          && (await Promise.all(targets.map(async (f) => (base!.compositions?.length ? Boolean(await carriableComposition(creativeDir, base!, f)) : hasFormat(base!, f))))).every(Boolean);

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
        live.write = (entry) => {
          // After every earlier write, whether it failed or not (an earlier failure is the turn's, not this message's).
          const before = lastWrite;
          const mine = before.catch(() => {}).then(() => store.appendConversation(slug, entry));
          // The chain waits for it but keeps only its own earlier failure: this entry's failure is the POST's alone.
          lastWrite = before.then(() => mine.then(() => {}, () => {}), (err: unknown) => mine.then(() => { throw err; }, () => { throw err; }));
          lastWrite.catch(() => {});
          return mine;
        };
        /**
         * Final wave P3: messages given to a run that was cut (for a newer redirect) before it reported its session, so before
         * it read its prompt: the next prompt carries them again, so no redirect is lost or replaced unseen.
         */
        let carry: LiveMessage[] = [];
        for (;;) {
          sawSession = false;
          sawOutput = false;
          /** Messages put in this attempt's prompt (delivered once its run is attached). */
          const givenNow: LiveMessage[] = [];
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
            for (const m of words) if (m.state === 'pending') { live.given(m, 'prompt'); givenNow.push(m); }
            return words.map((m) => ({ text: m.text, pins: m.pins }));
          }) : undefined;
          // Earlier redirects no run has read (one replaced before its attempt began, or carried from a cut run): they go
          // before the newest one, which wins where they disagree (final wave P3, N4).
          const earlierWords = redirect && !fresh ? await live.serial(async () => {
            const ms = live.messages.filter((m) => m !== redirect && (carry.includes(m) || (m.mode === 'redirect' && m.state === 'pending')));
            for (const m of ms) { if (m.state === 'pending') live.given(m, 'prompt'); givenNow.push(m); }
            return ms.map((m) => ({ text: m.text, pins: m.pins }));
          }) : undefined;
          if (redirect && !fresh) {
            live.given(redirect, 'prompt');
            givenNow.push(redirect);
            // The live session goes on (not a fork): the agent keeps what it did so far.
            resumeSessionId = live.sessionId; forkSession = false; remembered = 'redirect';
          }
          const resumed = redirect && !fresh ? redirect : null;
          if (fresh && redirect!.state === 'pending') { live.given(redirect!, 'prompt'); givenNow.push(redirect!); }
          const prompt = buildCreativePrompt({
            slug, creative, presets, version: n, kind: resumed ? 'redirect' : kind, formats: targets,
            userText: kind === 'fix' || resumed ? undefined : request,
            // A repair turn carries the user's own words (F4): only what they wrote, never a request the core made up.
            userWords: resumed ? resumed.text : kind === 'fix' ? message?.text || undefined : undefined,
            liveMessages: resumed ? (earlierWords?.length ? earlierWords : undefined) : liveWords,
            stoppedNote: Boolean(stopped) && !resumed && kind !== 'fix',
            pins: resumed ? resumed.pins : kind === 'iteration' ? message?.pins : undefined,
            pinsVersion: !resumed && kind === 'iteration' ? pinsVersionNote : undefined,
            attachments: kind === 'iteration' && !resumed ? attachments : undefined,
            problems, context, locale, sandboxed, contract: turnContract,
            conversion: kind === 'iteration' ? conversion : undefined,
            directEdit: kind === 'iteration' ? directEdit : undefined,
            keptDurations: kind === 'iteration' ? keptDurations : undefined,
            ...(variant ? { variant } : {}),
            // Phase 3 of the single agent: a helper works on its variant for the coordinator, with the user's message quoted.
            ...(this.helpers.get(jobId) ? { helper: { request: this.helpers.get(jobId)!.request } } : {}),
            // Decision 917: the agent's app actions (the `studio` server's tools), and a duration problem's way out (user note 6).
            appActions: this.deps.launcher.mcpActive(),
            ...(kind === 'fix' && durationOff ? { durationOff } : {}),
          });
          const snapshotsBefore = await Promise.all(existing.map((p) => codebaseSnapshot(p)));
          for (const [k, p] of existing.entries()) {
            const snap = snapshotsBefore[k]!;
            if ('value' in snap || uncheckable.has(p)) continue;
            uncheckable.add(p);
            const text = snap.unavailable === 'not-git' ? t().jobs.codebaseNotRepo({ path: p }) : t().jobs.codebaseCheckFailed({ path: p });
            await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text });
          }
          const sessionBefore = live.sessionId;
          const run = await this.deps.launcher.start({
            kind: 'creative', jobId, projectSlug: ref.projectSlug, projectDir: ref.projectDir, creativeSlug: slug, codebases: existing,
            protectedDirs: earlier.map((d) => join(creativeDir, 'outputs', d)),
            request: { prompt, resumeSessionId, forkSession, model },
            usage: { version: n, attempt }, sandboxed,
            // The brief as read at this turn's start (Task 7): a change from the chat applies from the next turn.
            services: effectiveServices({ services: turnServices }),
            // Decision 917: what the agent's app actions act on: this creative and the version this turn makes.
            appScope: { root: ref.root, projectSlug: ref.projectSlug, projectDir: ref.projectDir, creativeSlug: slug, version: n, ...(this.helpers.has(jobId) ? { helper: true } : {}) },
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
            // A redirect that came while this run was being started: it stops now and the next attempt takes it, with this
            // prompt's messages (never read: nothing is delivered).
            if (live.redirect) { live.unconfirmPrompt(); run.cancel(); return; }
            for (const m of live.confirmPrompt()) emit({ kind: 'user_message_delivered', clientId: m.clientId });
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
          // Phase 13: the run was cancelled for a redirect (not the job): the next attempt of the same number resumes it. A run
          // cut before it reported its session never read its prompt (final wave P3): its session is not taken, and what the
          // prompt carried goes with the next one.
          if (outcome.status !== 'succeeded' && live.redirect && !signal.aborted) {
            if (!sawSession) { live.sessionId = sessionBefore; carry = [...carry, ...givenNow.filter((m) => !carry.includes(m))]; }
            else carry = [];
            continue;
          }
          if (sawSession) carry = [];
          // Phase 13 (Review Focus 4, Ruling V): a remembered session Claude Code no longer has falls back to the base
          // version's session, with a note: never a failed turn. Once per turn, and the restart counts as an attempt (C1).
          const resumeError = outcome.status === 'failed' && remembered && !resumeFallbackUsed && !signal.aborted
            ? resumeErrorOf(outcome, { session: sawSession, output: sawOutput }) : null;
          if (resumeError && attempt < this.maxAttempts) {
            resumeFallbackUsed = true;
            // Only the CLI's own "session not found" clears the remembered session; the backup guess keeps it.
            if (remembered === 'stopped' && resumeError === 'not-found') await this.side.update(ref.projectDir, slug, () => ({ stoppedSession: undefined }));
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
          // Final wave P3 (N5): a run that failed or was stopped before it reported its session (e.g. a resume that failed)
          // never read its prompt: the messages it carried wait again, and the turn's end queues them as the next request.
          if (outcome.status !== 'succeeded' && !sawSession) {
            await live.serial(async () => { for (const m of [...givenNow, ...carry]) if (m.state === 'prompt') m.state = 'pending'; });
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
            durationOff = durationOffOf(r);
          } else {
            result = await validateTargets();
            problems = result.problems;
            unknown = result.unknownPresets.length;
          }
          // Phase 13: a redirect that arrived while the outputs were checked is the next attempt.
          if (live.redirect && !signal.aborted) continue;
          // Report 33: nothing written is no change: asking for a fix would only make the agent say so again.
          if (keepable && await slotUntouched(store.outputsDir(slug, n))) { untouched = true; break; }
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
      // Report 33: nothing to assemble; `keepable` already required a latest version.
      if (untouched && latest) {
        await this.keptLatest(ref, store, { creative, latest, n, versions, live, sessionId: resumeSessionId, noAgent, request, aborted: signal.aborted });
        return;
      }
      let saved: { outputs: OutputFileInfo[]; problems: string[]; tools: string[]; renderCommand: string | null; compositions?: VersionComposition[]; localizations?: VersionEntry['localizations']; durationOff?: { duration: number; target: number }; durationProblems?: string[] };
      // Decision 917: the duration the agent set for this turn, if any, is the one the version is checked against.
      if (turnContract === 'compositions') saved = await this.finishCompositions(ref, store, { ...plan, creative: { ...plan.creative, brief: { ...plan.creative.brief, durationSec: checkDuration() } } }, presets, base, n, label, locale,
        { accepted: turnContract === 'compositions' && checkDuration() !== creative.brief.durationSec ? acceptedDurationsOf(base, targets, presets, checkDuration()) : accepted });
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
      // Decision 1060 (user call 972): a turn that changed no output makes no version; what it changed besides (the brief,
      // a pending brief) still applies when it settles, and the latest version is checked again then (decision 964).
      // Decision 1066: only when the turn delivered every format of its brief (a target with no composition, or a follower
      // that could not follow, has no entry, so it would not count as a difference) and found no problem that is new
      // besides a duration off the brief (which the re-check settles against the brief the turn ends with).
      if (latest && this.keepsLatest(latest, saved, plan.creative.brief.formats)) {
        await this.keptLatest(ref, store, { creative, latest, n, versions, live, sessionId: noAgent ? undefined : resumeSessionId, noAgent, request, aborted: signal.aborted });
        return;
      }
      const { problems } = saved;
      const status = problems.length === 0 ? 'complete' : 'incomplete';
      const commit = await this.deps.git.commitAll(ref.projectDir, `${creative.title}: v${n}`, { headWhenClean: true });
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
      live.savedN = n;
      if (noAgent && request) await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: `${request} · ${j.noAgentNeeded}` });
      await store.appendConversation(slug, { type: 'version', at: now(), n, status });
      // User note 6: an incomplete version says in plain words what is wrong and what to do.
      if (status === 'incomplete') {
        const off = saved.durationOff;
        const a = t().agentActions;
        await store.appendConversation(slug, { type: 'system', at: now(), level: 'warning', text: off
          ? a.incompleteDuration({ n, duration: String(off.duration), target: String(off.target) })
          : a.incompleteOther({ n, count: problems.length }) });
      }
      // A version made without the agent after a restart keeps the restart's intent: the next agent turn still forks the
      // restored session (from this new version, which it now builds on).
      const resumeFrom = noAgent && creative.resumeFrom ? { version: n, sessionId: creative.resumeFrom.sessionId } : null;
      // A saved version ends the stopped turn's memory (Phase 13): the next turn builds on this version's session.
      await store.update(slug, { status: status === 'complete' ? 'ready' : 'incomplete', error: null, resumeFrom });
      await this.side.update(ref.projectDir, slug, () => ({ stoppedSession: undefined }));
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
        // Fix round 1 (M3): words in the prompt of a run that never started (launcher.start threw) were not delivered:
        // they wait again, so the drain queues them instead of dropping them.
        if (live.phase !== 'finalizing' && live.phase !== 'ended') { live.unconfirmPrompt(); await this.drainLive(ref, store, live); }
        live.phase = 'ended';
        live.run = null;
      }).catch(() => {});
      // Every message reaches a final state (I2): one that could not even be queued is answered as not delivered.
      for (const m of live.messages) m.settle('dropped');
      live.redirect?.settle('dropped');
      this.turnDurations.delete(jobId);
    }
  }

  /**
   * Decision 1060: the end of a turn whose outputs are all the latest version's (`sameDelivery`). No version is saved: the
   * unsaved folder `outputs/v<n>` goes (the next turn takes the number again) and the rest of the turn's files are committed.
   * The latest version stands for the turn: it takes the turn's session (the next turn goes on from that conversation; its
   * content is the same), and what the agent left for after the turn acts on it (`savedN`). The chat says it, with whether
   * the brief changes when the turn settles (its pending brief, applied by `briefAfterJob`, which checks the latest version
   * again on a new duration). The creative's status follows the latest version.
   */
  private keepsLatest(latest: VersionEntry, saved: Pick<VersionEntry, 'outputs' | 'compositions' | 'localizations' | 'problems'> & { durationProblems?: string[] }, formats: readonly string[]): boolean {
    const delivered = new Set([...(saved.compositions ?? []).map((c) => c.format), ...saved.outputs.map((o) => o.format)]);
    if (!formats.every((f) => delivered.has(f))) return false;
    const known = new Set([...latest.problems, ...(saved.durationProblems ?? [])]);
    return saved.problems.every((p) => known.has(p)) && sameDelivery(latest, saved);
  }

  private async keptLatest(ref: CreativeRef, store: CreativeStore, o: { creative: CreativeFile; latest: VersionEntry; n: number; versions: VersionEntry[]; live: LiveTurn; sessionId: string | undefined; noAgent: boolean; request: string | undefined; aborted: boolean }): Promise<void> {
    const slug = ref.creativeSlug;
    const { creative, latest } = o;
    const j = t().jobs;
    await this.clearStaleOutputs(store, slug, o.n, o.versions);
    await this.deps.git.commitAll(ref.projectDir, j.noOutputChangedCommit({ title: creative.title, n: latest.n }), { headWhenClean: true });
    if (o.sessionId !== undefined && isSessionId(o.sessionId) && o.sessionId !== latest.sessionId) {
      await store.updateVersion(slug, latest.n, (v) => ({ ...v, sessionId: o.sessionId! }));
    }
    o.live.savedVersion = true;
    o.live.savedN = latest.n;
    const brief = Boolean(await this.side.pendingBrief(ref.projectDir, slug));
    // As the saved path: a turn with no agent says what it was asked, and a late Stop is told.
    if (o.noAgent && o.request) await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: `${o.request} · ${j.noAgentNeeded}` });
    await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: j.noOutputChanged({ n: latest.n, brief }), keptVersion: latest.n });
    if (o.aborted) await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: j.lateCancelKept({ n: latest.n }) });
    // As after a saved version: a restart's intent is kept only by a turn with no agent; the stopped turn is over.
    const resumeFrom = o.noAgent && creative.resumeFrom ? { version: latest.n, sessionId: creative.resumeFrom.sessionId } : null;
    await store.update(slug, { status: latest.status === 'complete' ? 'ready' : 'incomplete', error: null, resumeFrom });
    await this.side.update(ref.projectDir, slug, () => ({ stoppedSession: undefined }));
    await this.commitState(ref, j.versionStateCommit({ title: creative.title, n: latest.n }));
    this.changed(ref);
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
    duration: { direct: true; base?: { durationSec: number | null; userDuration?: { durationSec: number } } } | { accepted: ReadonlyMap<string, number> } = { accepted: new Map() }): Promise<{ outputs: OutputFileInfo[]; problems: string[]; tools: string[]; renderCommand: null; compositions: VersionComposition[]; localizations?: VersionEntry['localizations']; durationOff?: { duration: number; target: number }; durationProblems: string[] }> {
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
    const off = a.check ? durationOffOf(a.check) : undefined;
    // Decision 1066: the problems that are only a duration off the brief, as the version records them (`checkTargets`).
    const v = messages(locale).validation;
    const durationProblems = (a.check?.checks ?? []).flatMap((c) => c.problems.filter((p) => p.key === 'composition.durationOffBrief')
      .map((p) => v.compositionProblem({ dir: c.dir, text: compositionProblemText(p, locale) })));
    return { outputs: a.outputs, problems: a.problems, tools: [], renderCommand: null, compositions: a.compositions, ...(localizations ? { localizations } : {}), ...(off ? { durationOff: off } : {}), durationProblems };
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

  private async buildContext(ref: CreativeRef, store: CreativeStore, creativeCodebases: LinkedCodebase[], services: Brief['services'], paidOff = false): Promise<{ context: CreativeContext; existing: string[] }> {
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
        // Decision 781: a stored folder whose path (or real path) has glob characters is left out, said in the chat.
        if (n && await codebaseHasGlobChars(n.path)) await note(t().jobs.codebaseIgnored({ path: n.path, reason: codebaseGlobCharsMessage(n.path) }));
        else if (n && await codebaseOverlaps(n.path, [ref.projectDir, ref.root])) await note(t().jobs.codebaseIgnored({ path: n.path, reason: codebaseOverlapMessage() }));
        else if (n) normalized.push(n);
      } catch (e) { await note(t().jobs.codebaseIgnored({ path: c.path, reason: (e as Error).message })); }
    }
    const checks = await checkCodebases(normalizeCodebaseList(normalized));
    for (const c of checks.filter((x) => !x.exists)) await note(t().jobs.codebaseMissing({ path: c.path }));
    const existing = checks.filter((c) => c.exists);
    return {
      context: { kit, hasGuidelines, assets, references, codebases: existing.map(({ path, note: n }) => ({ path, ...(n ? { note: n } : {}) })), missingCodebases: checks.filter((c) => !c.exists).map((c) => c.path), tools: this.deps.launcher.mcpActive() ? await availableTools(this.deps.vault, services, this.deps.keyChecks, paidOff) : [] },
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
    const q = (await this.side.read(ref.projectDir, ref.creativeSlug)).queued?.find((x) => x.clientId === clientId);
    if (q) return { entry: this.queuedEntry(q), outcome: 'queued' };
    const e = (await store.readConversation(ref.creativeSlug, { own: true })).find((x) => x.type === 'user' && x.clientId === clientId);
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
  /** `opts.bubble` (phase 3): the message went to several helpers at once: their entries share it as `fanout` (one bubble). */
  async postMessage(ref: CreativeRef, input: UserMessageInput & { mode: 'live' | 'queued' }, opts: { fanout?: FanoutTag; bubble?: string } = {}): Promise<MessageAnswer> {
    const m = checkLiveMessage(input);
    // Phase 15: nothing is queued for a discarded variant (it cannot be working: a working variant cannot be discarded).
    if ((await this.memberOf(ref))?.self.status === 'discarded') throw new CodedError(409, t().errors.variantDiscardedTurn, 'variant-discarded');
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    const answer = await this.answers.once(`${key}\0${m.clientId}`, async (): Promise<MessageAnswer> => {
      const known = await this.knownAnswer(ref, m.clientId);
      if (known) return known;
      if (input.mode === 'queued') return this.queueRequest(ref, m, 'queued', opts.fanout ? { fanout: opts.fanout } : {});
      const live = this.liveOf(key);
      // Another job of the creative (a translation) takes no messages; with no job at all, the turn is over.
      if (!live) return this.queueRequest(ref, m, this.isActive(key) ? 'queued-unsupported' : 'queued-after-finish');
      const step = await live.serial(() => this.liveMessage(ref, live, m, opts.bubble));
      if (!('wait' in step)) return step;
      const f = await step.wait.final;
      if (f === 'dropped') throw new CodedError(409, t().live.notRunning, 'not-running');
      return { entry: step.entry, outcome: f === 'queued' ? 'queued-after-finish' : 'delivered-pending' };
    });
    if (answer.outcome !== 'delivered-pending') void this.maybeAutoRun(ref);
    return answer;
  }

  private async liveMessage(ref: CreativeRef, live: LiveTurn, m: UserMessageInput, bubble?: string): Promise<MessageAnswer | { entry: ConversationEntry; wait: LiveMessage }> {
    if (live.messages.length >= LIVE_LIMITS.perTurn) throw new CodedError(409, t().live.tooManyLive({ max: LIVE_LIMITS.perTurn }), 'limit');
    if (!live.caps.liveInput) return this.queueRequest(ref, m, 'queued-unsupported');
    if (live.phase === 'finalizing' || live.phase === 'ended') return this.queueRequest(ref, m, 'queued-after-finish');
    const store = new CreativeStore(ref.projectDir);
    const entry: ConversationEntry = { type: 'user', at: now(), text: m.text, pins: m.pins, attachments: [], jobId: live.jobId, mode: 'live', clientId: m.clientId, ...(bubble ? { fanout: bubble } : {}) };
    await (live.write ? live.write(entry) : store.appendConversation(ref.creativeSlug, entry));
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
  private async queueRequest(ref: CreativeRef, m: UserMessageInput, outcome: Exclude<LiveMessageOutcome, 'delivered-pending'>, o: { limit?: boolean; note?: boolean; fanout?: FanoutTag } = {}): Promise<MessageAnswer> {
    const store = new CreativeStore(ref.projectDir);
    // Phase 3 of the single agent: what a helper could not take is the group's next request, for its variant.
    const helperLive = this.liveOf(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug));
    const helper = helperLive ? this.helpers.get(helperLive.jobId) : undefined;
    if (helper && this.router) {
      await this.router.queueForGroup(ref, m, helper.variant);
      if (outcome === 'queued-after-finish' && o.note !== false) {
        await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: t().live.queuedAfterFinish });
      }
      this.changed(ref);
      return { entry: this.queuedEntry({ clientId: m.clientId, text: m.text, pins: m.pins, at: now() }), outcome };
    }
    const pinsVersion = m.pins.length > 0 ? await this.pinsBase(ref) : undefined;
    const item: QueuedRequest = { clientId: m.clientId, text: m.text, pins: m.pins, at: now(), ...(pinsVersion !== undefined ? { pinsVersion } : {}), ...(o.fanout ? { fanout: o.fanout } : {}) };
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    this.refs.set(key, ref);
    await this.runLocked(ref, () => this.side.update(ref.projectDir, ref.creativeSlug, (c) => {
      const queued = c.queued ?? [];
      if (queued.some((x) => x.clientId === m.clientId)) return {};
      if (o.limit !== false && queued.length >= LIVE_LIMITS.queued) throw new CodedError(409, t().live.queueFull({ max: LIVE_LIMITS.queued }), 'limit');
      // Ruling T: queued by this process, so it may start by itself (in memory only).
      this.queuedHere.add(`${key}\0${m.clientId}`);
      return { queued: [...queued, item] };
    }));
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
    }, () => {
      // Phase 15: a removed request no longer has a variant run's hook (the run is told, so its card can go when nothing is left).
      // As soon as the queue write is through: the later reads of the answer must not decide whether the hook is dropped.
      const hookKey = `${creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug)}\0${clientId}`;
      const hook = this.queuedHooks.get(hookKey);
      this.queuedHooks.delete(hookKey);
      hook?.removed?.();
    });
  }

  /** PUT …/queue/:clientId: new text and pins, only while it waits. Changed pins refer to the version on screen now. */
  async editQueued(ref: CreativeRef, clientId: string, patch: { text: string; pins: Pin[] }): Promise<CreativeFile> {
    const m = checkLiveMessage({ clientId, ...patch });
    const now2 = m.pins.length > 0 ? await this.pinsBase(ref) : undefined;
    return this.editQueue(ref, (q) => {
      if (!q.some((x) => x.clientId === clientId)) throw new CodedError(404, t().live.notQueued, 'not-queued');
      return q.map((x) => {
        if (x.clientId !== clientId) return x;
        const same = JSON.stringify(x.pins) === JSON.stringify(m.pins);
        const { pinsVersion: _old, ...rest } = x;
        const pinsVersion = m.pins.length === 0 ? undefined : same ? x.pinsVersion : now2;
        return { ...rest, text: m.text, pins: m.pins, ...(pinsVersion !== undefined ? { pinsVersion } : {}) };
      });
    });
  }

  /** The version a pin placed now refers to: the one a turn started now would build on (a restore's, else the latest). */
  private async pinsBase(ref: CreativeRef): Promise<number | undefined> {
    const store = new CreativeStore(ref.projectDir);
    const c = await store.get(ref.creativeSlug);
    return c.resumeFrom?.version ?? (await store.readVersions(ref.creativeSlug)).at(-1)?.n;
  }

  /** PUT …/queue { order } (Ruling S): a permutation of the queue as it is now; anything else is refused. */
  async reorderQueue(ref: CreativeRef, order: string[]): Promise<CreativeFile> {
    return this.editQueue(ref, (q) => {
      const same = order.length === q.length && new Set(order).size === order.length && order.every((id) => q.some((x) => x.clientId === id));
      if (!same) throw new CodedError(409, t().live.queueChanged, 'queue-changed');
      return order.map((id) => q.find((x) => x.clientId === id)!);
    });
  }

  private async editQueue(ref: CreativeRef, fn: (q: QueuedRequest[]) => QueuedRequest[], written?: () => void): Promise<CreativeFile> {
    const store = new CreativeStore(ref.projectDir);
    await this.runLocked(ref, () => this.side.update(ref.projectDir, ref.creativeSlug, (c) => {
      const next = fn(c.queued ?? []);
      return { queued: next.length > 0 ? next : undefined };
    }));
    written?.();
    this.changed(ref);
    return this.side.merged(ref.projectDir, ref.creativeSlug, await store.get(ref.creativeSlug));
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
    let head: QueuedRequest | undefined;
    await this.side.update(ref.projectDir, ref.creativeSlug, (c) => {
      const [first, ...rest] = c.queued ?? [];
      head = first;
      return first ? { queued: rest.length > 0 ? rest : undefined } : {};
    });
    const taken = head;
    if (!taken) return null;
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    try {
      const job = await this.startLocked(ref, { text: taken.text, pins: taken.pins, ...(taken.pinsVersion !== undefined ? { pinsVersion: taken.pinsVersion } : {}) }, undefined, { clientId: taken.clientId }, undefined, taken.fanout);
      this.queuedHere.delete(`${key}\0${taken.clientId}`);
      return job;
    } catch (err) {
      await this.side.update(ref.projectDir, ref.creativeSlug, (c) => ({ queued: [taken, ...(c.queued ?? []).filter((x) => x.clientId !== taken.clientId)] }));
      throw err;
    }
  }

  /**
   * Starts the queue's first request when nothing runs for the creative, its last turn was not stopped, and this core
   * process queued it (Ruling T, kept in memory: after a restart, or for anything it did not queue, the queue waits for
   * "Run next"). Never throws.
   */
  async maybeAutoRun(ref: CreativeRef): Promise<JobSummary | null> {
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    // Phase 3 of the single agent: a grouped member's queue never starts by itself (its requests are the group's).
    if (this.router && await this.router.enabled(ref).catch(() => false)) return null;
    try {
      return await this.locks.run(key, async () => {
        if (this.isActive(key) || this.paused.has(key)) return null;
        const head = (await this.side.read(ref.projectDir, ref.creativeSlug)).queued?.[0];
        if (!head || !this.queuedHere.has(`${key}\0${head.clientId}`)) return null;
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
    // Phase 3 (review minor 5): a helper's entries are tagged until its turn is over; what runs after it (its after-turn
    // actions, a follow-up turn) is no longer one of its steps.
    const helper = this.helpers.get(jobId);
    if (helper) setHelperTag(ref.projectDir, ref.creativeSlug, null);
    // Phase 15: whatever the outcome, a brief the group changed meanwhile applies now that the turn is over.
    await this.briefAfterJob(ref);
    // Decision 917: what the agent asked to do after its turn (duplicates, renders, a follow-up turn…), before the queue.
    for (const hook of this.settleHooks) {
      await hook(ref, jobId, { state, savedVersion: live?.savedN ?? null, stopped: live?.stopped ?? false })
        .catch((err: Error) => console.warn(`Motion Studio: the actions after a turn of ${ref.creativeSlug} failed: ${err.message}`));
    }
    // Phase 3: a helper's queue is the group's.
    if (helper) { this.helpers.delete(jobId); return; }
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
    // Phase 15: a variant's pending brief applies once its translation is over.
    await this.briefAfterJob(ref);
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
          const entry: ConversationEntry = { type: 'user', at: now(), text: msg.text, pins: msg.pins, attachments: [], jobId, mode: 'redirect', clientId: msg.clientId };
          await (live.write ? live.write(entry) : store.appendConversation(ref.creativeSlug, entry));
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
        text: (msg) => interruptedRedirectText(REDIRECT_PARTIAL_NOTE, msg.text, msg.pins),
        answerBeforeStart: true,
      });
      return { outcome };
    });
  }

  /**
   * Phase 13: the session a stopped turn leaves to the next one (the one its agent reported), with the job.
   *
   * Final wave P4 (Task 4 live check): this is usually the BASE version's session id. An iteration turn resumes the base
   * session without a fork, and Claude Code then appends the turn to that same session (the id stays). So the remembered
   * id equals the base version's, yet the session it names holds the stopped turn's messages after the base's. The next
   * turn resumes it as a fork, so it continues from the stopped turn's messages (plus whatever partial files it left,
   * which the prompt's note mentions) while the base version's own record is never changed.
   */
  private stoppedOf(jobId: string): CreativeFile['stoppedSession'] {
    const sessionId = this.deps.queue.list().find((j) => j.id === jobId)?.sessionId;
    return sessionId ? { sessionId, at: now(), jobId } : undefined;
  }

  private async cancelled(ref: CreativeRef, store: CreativeStore, previous: CreativeStatus, hasVersions: boolean, stopped?: CreativeFile['stoppedSession']): Promise<'cancelled'> {
    const restored: CreativeStatus = previous === 'ready' || previous === 'incomplete' || previous === 'draft'
      ? previous : hasVersions ? 'ready' : 'draft';
    // Phase 13 (spec §3): the stopped turn's session is remembered for the next turn (only when its agent had started one).
    await store.update(ref.creativeSlug, { status: restored, error: null });
    if (stopped) await this.side.update(ref.projectDir, ref.creativeSlug, () => ({ stoppedSession: stopped }));
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

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  activeMembers, answeredVariants, askedNewVariants, bareCount, compareVariantIds, creativeJobKey, isSessionId, LIVE_LIMITS, letterOfSlug, MAX_NEW_VARIANTS, namedVariants, singleAgentOn, variantIdSchema,
  type ConversationEntry, type GroupTurnOutcome, type JobSummary, type LiveMessageOutcome, type Pin, type QueuedRequest, type RedirectOutcome,
  type ServerMessage, type VariantGroup, type VariantId, type WorkspaceSettings,
} from '@motion-studio/shared';
import type { AgentLauncher } from '../agent/launcher.ts';
import { AnswerCache, checkLiveMessage, liveMessageText, type LiveCapabilities, type UserMessageInput } from '../agent/live-session.ts';
import type { AgentRun } from '../agent/runner.ts';
import type { ApprovalBroker } from '../approvals/broker.ts';
import type { GroupTools } from '../bridge/bridge.ts';
import { JobFailedError, type JobQueue } from '../jobs/job-queue.ts';
import { stopJob } from '../jobs/stop.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { currentLocale, t } from '../i18n.ts';
import type { UsageLedger } from '../usage/usage-ledger.ts';
import { sumUsage } from '../usage/usage-tracker.ts';
import { CodedError } from '../workspace-store.ts';
import { buildCoordinatorPrompt, buildCoordinatorReport, groupDigest, type CoordinatorVariant, type ReportOutcome } from './coordinator-prompt.ts';
import { CreativeStore } from './creative-store.ts';
import { resumeErrorOf, type CreativeRef, type CreativeTurnService, type GroupRouter, type MessageAnswer } from './creative-turns.ts';
import { pinLine, quotePromptString } from './prompt.ts';
import { MAX_DIRECTION_CHARS, memberRef, VariantGroupService } from './variant-group.ts';
import { askPaidCard, paidCardPlan, type PaidCardDeps } from './paid-card.ts';

/**
 * Phase 3 of the single agent (decisions 977–983, spec `2026-10-18-single-agent-design.md` §3–§7): a variant group has ONE
 * agent the user talks to. A message to the group is a GROUP TURN, a job of kind `creative-group` in its own lane (it never
 * takes a main-lane slot its helpers need):
 *
 * 1. the coordinator run: a Claude session of the group (kept in the host's side state), read-only, no Bash, no paid tool.
 *    It answers, asks (AskUserQuestion, with the variants as options) or records a plan with `work_on_variants` (one
 *    instruction per variant) and `add_variants` (new variants, generated in this turn), then ends its run;
 * 2. the helpers: one per work item, TODAY's creative turn of that member (`CreativeTurnService.start` with `helper`): its
 *    own session, versions, checks, repair loop, decision 1060, two at a time per group (the existing slot);
 * 3. the report run: the coordinator's session resumed with each variant's outcome; it writes the closing message;
 * 4. the `group-turn` entry: what each variant did and the turn's whole usage.
 *
 * The ask rule of decision 979 is in the prompt and in the core: `work_on_variants` refuses a variant unless a pinned comment
 * targets it, the user named it, the user picked it answering a question of this turn, or this turn created it. Stop on the
 * group turn stops the coordinator and every helper; Stop on one helper stops that variant only. UI actions that already
 * name their variant (Genera on a card, a format's regenerate, a retry) are not group turns: they keep today's variant turns
 * (decision 1145), and the coordinator reads about them in its next prompt's digest.
 */

export const COORDINATOR_LANE = 'coordinator';
/** The group turn's job key: one group turn per group at a time (the queue refuses a second one). */
export const groupJobKey = (root: string, projectSlug: string, host: string): string => `group:${creativeJobKey(root, projectSlug, host)}`;
/** Characters of one work item's instruction. */
export const INSTRUCTION_MAX = 4000;
/** How much of a helper's last words the report run gets. */
const HELPER_TEXT_MAX = 1500;

/** One variant's work in a group turn (spec §4.3). `instruction` null: its first generation (a variant made in this turn). */
export interface WorkItem { variant: VariantId; instruction: string | null; formats?: string[]; pins: Pin[] }
/** What a group turn starts from: the user's message (its pins carry their variants) and any explicit targets. */
export interface GroupRequest { text: string; pins: Pin[]; variants?: VariantId[]; clientId?: string; queued?: boolean }

export interface GroupTurnDeps extends PaidCardDeps {
  queue: JobQueue; launcher: AgentLauncher; turns: CreativeTurnService; approvals: ApprovalBroker;
  settings: () => Promise<WorkspaceSettings>;
  model: () => Promise<string | null>;
  broadcast: (msg: ServerMessage) => void;
  /** Where every run's usage is recorded: the group turn sums its runs' and its helpers'. */
  ledger: UsageLedger;
}

type Phase = 'queued' | 'coordinator' | 'confirm' | 'helpers' | 'report' | 'ended';

/** A group turn while it lives (in memory: a restart ends it, see `recoverGroupTurns`). */
interface GroupRun {
  jobId: string; host: CreativeRef; title: string; request: GroupRequest;
  phase: Phase;
  /** The variants the message points to (pins, a queued request's own), named in its text, picked in a question, made now. */
  explicit: Set<VariantId>; named: Set<VariantId>; answered: Set<VariantId>; created: Set<VariantId>;
  plan: Map<VariantId, WorkItem>;
  helpers: Map<VariantId, string>;
  added: boolean;
  /** Review M3: how many new variants the user's own words of this turn ask for (the most any of them asks; 0: none). */
  askedNew: number;
  run: AgentRun | null;
  caps: LiveCapabilities;
  /** Messages that came before the coordinator run started: they join its prompt. */
  later: Array<{ text: string; pins: Pin[] }>;
  redirect: { text: string; pins: Pin[] } | null;
  /** The ordered writer of the turn's entries in the group's chat. */
  chain: Promise<void>;
  liveMessages: number;
}

interface HelperResult { state: string | undefined; savedVersion: number | null; stopped: boolean }
/** Phase 4: what the paid-services card decided for the helpers: covered (per variant, its rules) or paid services off. */
type Cover = { kind: 'covered'; rules: Partial<Record<VariantId, string[]>> } | { kind: 'off' } | null;

const now = () => new Date().toISOString();
const L = (id: VariantId) => id.toUpperCase();
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
const variantsOfPins = (pins: readonly Pin[]) => [...new Set(pins.map((p) => p.variant).filter((v): v is VariantId => Boolean(v)))];
const sameKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

const workSchema = z.strictObject({
  items: z.array(z.strictObject({
    variant: variantIdSchema,
    instruction: z.string().trim().min(1).max(INSTRUCTION_MAX),
    formats: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
  })).min(1).max(1000),
});
const addSchema = z.strictObject({
  items: z.array(z.strictObject({
    direction: z.string().trim().min(3).max(MAX_DIRECTION_CHARS),
    baseFrom: z.strictObject({ variant: variantIdSchema, version: z.number().int().min(1) }).optional(),
  })).min(1).max(MAX_NEW_VARIANTS),
});

/** An agent-facing refusal (English, like the other tool answers the agent reads): nothing was recorded. */
const refuse = (errors: string[]) => new CodedError(409, errors.join(' '), 'work-refused');

export class GroupTurnService implements GroupRouter {
  private readonly runs = new Map<string, GroupRun>();
  /** Helpers' outcomes, by job id, resolved by the turn service's settle hook. */
  private readonly results = new Map<string, { promise: Promise<HelperResult>; resolve: (r: HelperResult) => void }>();
  /** Ruling T for the group's queue: only the requests this process queued start by themselves. */
  private readonly queuedHere = new Set<string>();
  /** Groups whose last turn failed or was stopped: their queue waits for "Run next" (Ruling U). */
  private readonly paused = new Set<string>();
  private readonly answers = new AnswerCache(1000);
  private readonly locks = new KeyedMutex();

  constructor(private readonly deps: GroupTurnDeps) {
    deps.turns.setGroupRouter(this);
    // Review minor 3: only the helpers this service started are followed (never every creative turn of the app).
    deps.turns.onTurnSettled(async (_ref, jobId, o) => { this.results.get(jobId)?.resolve(o); });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Where a message goes.

  /** Whether `ref` belongs to a variant group that has one agent now (the `singleAgent` setting). */
  async enabled(ref: CreativeRef): Promise<boolean> {
    if (!singleAgentOn(await this.deps.settings().catch(() => null))) return false;
    const r = await this.svc(ref).resolve(ref).catch(() => null);
    return Boolean(r && !r.orphan && r.group);
  }

  private svc(ref: CreativeRef) { return new VariantGroupService({ store: new CreativeStore(ref.projectDir), turns: this.deps.turns }); }

  private async groupOf(ref: CreativeRef): Promise<{ host: CreativeRef; group: VariantGroup; missing: string[] }> {
    const r = await this.svc(ref).resolve(ref);
    if (r.orphan) throw new CodedError(409, t().errors.variantOrphan, 'variant-orphan');
    if (!r.group) throw new CodedError(409, t().errors.variantNoGroup, 'variant-no-group');
    return { host: r.host, group: r.group, missing: r.missing };
  }

  private keyOf(host: CreativeRef): string { return groupJobKey(host.root, host.projectSlug, host.creativeSlug); }
  private activeJob(host: CreativeRef): JobSummary | undefined {
    const key = this.keyOf(host);
    return this.deps.queue.list().find((j) => j.key === key && (j.state === 'queued' || j.state === 'running'));
  }
  /** The group turn of `ref`'s group running now (or waiting for its lane), if any. */
  activeRun(host: CreativeRef): GroupRun | undefined {
    const job = this.activeJob(host);
    return job ? this.runs.get(job.id) : undefined;
  }
  /** Review M3: whether the user pointed to variant `v` in group turn `jobId` (a discard by its coordinator needs it). */
  pointedIn(jobId: string, v: VariantId): boolean {
    const r = this.runs.get(jobId);
    return Boolean(r && this.pointedTo(r, v));
  }
  /** Phase 3: the variants a group turn works on (its coordinator may not discard them meanwhile). */
  planOf(jobId: string): ReadonlySet<VariantId> {
    const r = this.runs.get(jobId);
    return new Set(r ? [...r.plan.keys(), ...r.helpers.keys()] : []);
  }
  /** Whether a job is a group turn this service runs. */
  hasRun(jobId: string): boolean { return this.runs.has(jobId); }

  private changed(ref: CreativeRef) { this.deps.turns.changed(ref); }

  /** Pins without a variant were placed on the page they came from: the member `ref` names (spec §7). */
  private withVariants(ref: CreativeRef, pins: Pin[]): Pin[] {
    const own = letterOfSlug(ref.creativeSlug);
    return pins.map((p) => (p.variant ? p : { ...p, variant: own }));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Starting a group turn.

  /** `POST …/turns` with a message in a group with one agent: a group turn. 409 while one runs (its messages go live). */
  async start(ref: CreativeRef, req: GroupRequest): Promise<JobSummary> {
    const { host, group } = await this.groupOf(ref);
    const request = { ...req, pins: this.withVariants(ref, req.pins) };
    return this.locks.run(this.keyOf(host), () => this.startLocked(host, group, request));
  }

  private async startLocked(host: CreativeRef, group: VariantGroup, req: GroupRequest): Promise<JobSummary> {
    if (this.activeJob(host)) throw new CodedError(409, t().errors.generationRunning, 'job-running');
    await this.adoptMemberQueues(host, group);
    const store = new CreativeStore(host.projectDir);
    const title = (await store.get(host.creativeSlug)).title;
    const jobId = randomUUID();
    const ids = group.members.map((m) => m.letter);
    const r: GroupRun = {
      jobId, host, title, request: req, phase: 'queued',
      explicit: new Set([...variantsOfPins(req.pins), ...(req.variants ?? [])].filter((v) => ids.includes(v))),
      named: namedVariants(req.text, ids), answered: new Set(), created: new Set(),
      plan: new Map(), helpers: new Map(), added: false, askedNew: askedNewVariants(req.text), run: null, caps: { liveInput: false, interrupt: false },
      later: [], redirect: null, chain: Promise.resolve(), liveMessages: 0,
    };
    // Review minor 2: every group message has a client id, so a request put back in the queue by a restart is written once.
    const clientId = req.clientId ?? `group-${jobId}`;
    const written = req.clientId !== undefined && (await store.readConversation(host.creativeSlug)).some((e) => e.type === 'user' && e.group && e.clientId === req.clientId);
    if (!written) {
      await this.write(r, {
        type: 'user', at: now(), text: req.text, pins: req.pins, attachments: [], jobId, group: true, clientId,
        ...(req.queued ? { mode: 'queued' as const, deliveredAt: now() } : {}),
      });
    }
    // Until its run starts, the marker keeps the request (a restart puts it back in the queue: `recoverGroupTurns`).
    const side = this.deps.turns.side;
    await side.updateGroup(host.projectDir, host.creativeSlug, () => ({ turn: { jobId, at: now(), request: { clientId, text: req.text, pins: req.pins, at: now(), ...(req.variants?.length ? { variants: req.variants } : {}) } } }));
    const unmark = () => side.updateGroup(host.projectDir, host.creativeSlug, (g) => (g.turn?.jobId === jobId ? { turn: undefined } : {})).catch(() => {});
    this.runs.set(jobId, r);
    this.paused.delete(this.keyOf(host));
    let job: JobSummary;
    try {
      job = this.deps.queue.enqueue({
        id: jobId, key: this.keyOf(host), kind: 'creative-group', lane: COORDINATOR_LANE,
        label: t().jobs.groupLabel({ title }),
        run: (signal) => this.run(r, signal),
        onCancelledBeforeStart: async () => { await this.write(r, this.groupLine('info', t().jobs.cancelledNote)); r.phase = 'ended'; await unmark(); },
      });
    } catch (err) {
      this.runs.delete(jobId);
      await unmark();
      throw err;
    }
    void this.deps.queue.whenSettled(jobId).then((s) => this.afterTurn(r, s));
    this.changed(host);
    return job;
  }

  /** A line of the group in its chat (no variant). */
  private groupLine(level: 'info' | 'warning' | 'error', text: string): ConversationEntry {
    return { type: 'system', at: now(), level, text, group: true };
  }

  /**
   * Appends `entry` to the group's chat after every earlier write of the turn (the chat keeps its order). The clients are told
   * the creative changed, except for the agent's events (they already came over the socket, one by one).
   */
  private write(r: GroupRun, entry: ConversationEntry): Promise<void> {
    const store = new CreativeStore(r.host.projectDir);
    const mine = r.chain.then(() => store.appendConversation(r.host.creativeSlug, entry));
    r.chain = mine.catch(() => {});
    return mine.then(() => { if (entry.type !== 'agent') this.changed(r.host); });
  }

  private phase(r: GroupRun, p: Phase): void {
    r.phase = p;
    if (p !== 'ended' && p !== 'queued') this.deps.queue.patch(r.jobId, { groupPhase: p });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The turn.

  private async run(r: GroupRun, signal: AbortSignal): Promise<void | 'cancelled'> {
    const { host } = r;
    const side = this.deps.turns.side;
    // Started: from now a restart says the turn was cut (its message is in the chat; the request is not queued again).
    await side.updateGroup(host.projectDir, host.creativeSlug, () => ({ turn: { jobId: r.jobId, at: now(), started: true } }));
    try {
      // Decision 982: the chats are merged once the group is idle; until then the store's merged view serves the same chat.
      await this.svc(host).mergeChat(host).catch(() => 'none');
      this.phase(r, 'coordinator');
      if ((await this.coordinate(r, signal)) === 'cancelled') return await this.stopped(r, []);
      if (r.plan.size === 0) return;
      // Phase 4 (spec §9): one card for a plan of two or more variants, before any helper starts.
      const cover = await this.confirm(r, signal);
      if (cover === 'cancelled') return await this.stopped(r, []);
      this.phase(r, 'helpers');
      const outcomes = await this.dispatch(r, signal, cover);
      if (signal.aborted) return await this.stopped(r, outcomes);
      this.phase(r, 'report');
      let report: 'ok' | 'cancelled' = 'ok';
      try {
        report = await this.coordinate(r, signal, outcomes);
      } catch (err) {
        // The work is done whatever the closing message: the turn says so and still records what each variant did.
        await this.write(r, this.groupLine('warning', t().jobs.groupReportFailed({ text: err instanceof Error ? err.message : String(err) })));
      }
      await this.writeOutcome(r, outcomes, report === 'cancelled');
      if (report === 'cancelled') { await this.write(r, this.groupLine('info', t().jobs.cancelledNote)); return 'cancelled'; }
    } catch (err) {
      if (signal.aborted) return await this.stopped(r, []);
      const text = err instanceof Error ? err.message : String(err);
      await this.write(r, this.groupLine('error', t().jobs.groupFailed({ text })));
      throw new JobFailedError(text);
    } finally {
      r.phase = 'ended';
      await side.updateGroup(host.projectDir, host.creativeSlug, (g) => (g.turn?.jobId === r.jobId ? { turn: undefined } : {})).catch(() => {});
    }
  }

  /** Stop on the group turn: what was dispatched is recorded, then the cancel line. */
  private async stopped(r: GroupRun, outcomes: ReportOutcome[]): Promise<'cancelled'> {
    if (outcomes.length > 0) await this.writeOutcome(r, outcomes, true);
    await this.write(r, this.groupLine('info', t().jobs.cancelledNote));
    return 'cancelled';
  }

  private async writeOutcome(r: GroupRun, outcomes: ReportOutcome[], stopped: boolean): Promise<void> {
    const ids = new Set([r.jobId, ...r.helpers.values()]);
    const records = (await this.deps.ledger.read(r.host.projectDir).catch(() => [])).filter((x) => ids.has(x.jobId));
    const usage = sumUsage(records);
    const outcome: GroupTurnOutcome[] = outcomes.map(({ text: _t, ...o }) => o);
    await this.write(r, { type: 'group-turn', at: now(), jobId: r.jobId, outcome, group: true, ...(stopped ? { stopped: true } : {}), ...(usage ? { usage } : {}) });
  }

  /** After a group turn: the next queued request starts by itself only after one that succeeded (Ruling U). */
  private async afterTurn(r: GroupRun, settled: JobSummary | null): Promise<void> {
    this.runs.delete(r.jobId);
    for (const id of r.helpers.values()) this.results.delete(id);
    const key = this.keyOf(r.host);
    if (settled?.state !== 'succeeded') { this.paused.add(key); return; }
    await this.maybeAutoRun(r.host);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The coordinator's runs.

  /** The variants as the coordinator sees them (the `list_variants` data). */
  private async variantsInfo(host: CreativeRef, r?: GroupRun): Promise<{ group: VariantGroup; info: CoordinatorVariant[] }> {
    const { group, missing } = await this.groupOf(host);
    const store = new CreativeStore(host.projectDir);
    const info: CoordinatorVariant[] = [];
    for (const m of group.members) {
      const versions = await store.readVersions(m.slug).catch(() => []);
      const latest = versions.at(-1);
      const formats = latest ? [...new Set([...(latest.compositions ?? []).map((c) => c.format), ...latest.outputs.map((o) => o.format)])] : [];
      info.push({
        id: m.letter, direction: m.direction, status: m.status, missing: missing.includes(m.slug),
        // A variant made in this turn is idle until its helper starts.
        working: this.deps.turns.turnActive(memberRef(host, m.slug)) && !(r?.helpers.has(m.letter)),
        latest: latest ? formats.map((f) => ({ format: f, version: latest.n, status: latest.status, problems: latest.problems.length })) : [],
      });
    }
    return { group, info };
  }

  private picksOf(group: VariantGroup): Record<string, { variant: VariantId; version: number }> {
    const out: Record<string, { variant: VariantId; version: number }> = {};
    for (const [f, p] of Object.entries(group.picks)) {
      const m = group.members.find((x) => x.slug === p.slug);
      if (m) out[f] = { variant: m.letter, version: p.version };
    }
    return out;
  }

  /**
   * One coordinator phase: the plan run (no `outcomes`) or the report run. Its session is the group's (resumed); a session
   * Claude Code no longer has is replaced once, with the whole chat's digest (spec §4.2, the rule of `resumeErrorOf`). A
   * redirect during the plan run cuts it and the next run (the same session) takes the user's new words; the plan so far is
   * dropped.
   */
  private async coordinate(r: GroupRun, signal: AbortSignal, outcomes?: ReportOutcome[]): Promise<'ok' | 'cancelled'> {
    const { host } = r;
    const side = this.deps.turns.side;
    const store = new CreativeStore(host.projectDir);
    const locale = currentLocale();
    const model = (await this.deps.model()) ?? undefined;
    let fresh = false;
    let attempt = 0;
    for (;;) {
      attempt++;
      if (signal.aborted) return 'cancelled';
      const stored = (await side.group(host.projectDir, host.creativeSlug)).session?.sessionId;
      const groupSession = !fresh && isSessionId(stored) ? stored : undefined;
      // Decision 1423: a group made from a brief session has no coordinator session yet: its first run forks the brief
      // agent's (the coordinator is the agent the user talks to; the helpers get the brief as always).
      const briefLink = !groupSession && !fresh ? await side.briefResume(host.projectDir, host.creativeSlug) : null;
      const session = groupSession ?? briefLink?.sessionId;
      const fork = !groupSession && briefLink !== null;
      const { group, info } = await this.variantsInfo(host, r);
      const creative = await store.get(host.creativeSlug);
      const redirect = r.redirect;
      r.redirect = null;
      let prompt: string;
      if (outcomes) {
        prompt = buildCoordinatorReport({ locale, outcomes, ...(session ? {} : { context: groupDigest(await store.readConversation(host.creativeSlug), { full: true, exclude: r.jobId }).text }) });
      } else {
        // Review M2: a redirect drops the work recorded so far, but never a variant this turn made: its first generation stays.
        if (redirect) {
          for (const [v, item] of [...r.plan]) {
            if (r.created.has(v)) r.plan.set(v, { variant: v, instruction: null, pins: [] });
            else if (item.instruction !== null) r.plan.delete(v);
          }
        }
        const entries = await store.readConversation(host.creativeSlug);
        prompt = buildCoordinatorPrompt({
          title: creative.title, slug: host.creativeSlug, brief: creative.brief, locale, variants: info, picks: this.picksOf(group),
          request: r.request,
          explicit: [...r.explicit].sort(compareVariantIds),
          digest: groupDigest(entries, { exclude: r.jobId, full: !session, ...(r.request.clientId ? { skipClientId: r.request.clientId } : {}) }),
          ...(r.later.length ? { later: r.later.splice(0) } : {}),
          ...(redirect ? { redirect } : {}),
          ...(r.created.size ? { added: group.members.filter((m) => r.created.has(m.letter)).map((m) => ({ id: m.letter, direction: m.direction })) } : {}),
        });
      }
      let seenSession = false;
      let seenOutput = false;
      let sessionWrite: Promise<unknown> = Promise.resolve();
      const ids = group.members.map((m) => m.letter);
      const run = await this.deps.launcher.start({
        kind: 'creative-group', jobId: r.jobId, projectSlug: host.projectSlug, projectDir: host.projectDir, creativeSlug: host.creativeSlug,
        // Defence in depth: every editing tool and Bash are denied to this kind anyway.
        protectedDirs: [join(host.projectDir, 'creatives'), join(host.projectDir, 'assets')],
        request: { prompt, ...(session ? { resumeSessionId: session } : {}), forkSession: fork, ...(model ? { model } : {}) },
        usage: { version: null, attempt }, sandboxed: await this.deps.launcher.sandboxed(),
        appScope: { root: host.root, projectSlug: host.projectSlug, projectDir: host.projectDir, creativeSlug: host.creativeSlug, version: 0, group: true },
        groupTools: this.toolsFor(r),
        onWarning: (text) => this.write(r, this.groupLine('warning', text)),
        onEvent: (event) => {
          if (event.kind === 'session') seenSession = true;
          if (event.kind === 'text' || event.kind === 'tool_use') seenOutput = true;
          const sid = event.kind === 'session' || event.kind === 'result' ? event.sessionId : undefined;
          if (sid && isSessionId(sid)) {
            this.deps.queue.patch(r.jobId, { sessionId: sid });
            sessionWrite = sessionWrite.then(() => side.updateGroup(host.projectDir, host.creativeSlug, () => ({ session: { sessionId: sid, at: now() } }))).catch(() => {});
            // The group has its own session now: the brief's is not resumed again.
            if (fork) sessionWrite = sessionWrite.then(() => side.setBriefSession(host.projectDir, host.creativeSlug, null)).catch(() => {});
          }
          // Decision 979: the variants the user picked answering this turn's question may take work.
          if (event.kind === 'question_answered' && event.outcome === 'answered') {
            for (const item of event.items) {
              if (!item.answer) continue;
              for (const v of answeredVariants(item.answer, ids)) r.answered.add(v);
              // Re-review 2: only the user's own words of the answer ask for new variants, never an option the agent wrote;
              // re-review 3: once they asked, a number (typed, or chosen) is how many.
              if (item.other) r.askedNew = Math.max(r.askedNew, askedNewVariants(item.other));
              const count = r.askedNew > 0 ? bareCount(item.other ?? item.answer) : null;
              if (count !== null) r.askedNew = Math.max(r.askedNew, count);
            }
          }
          this.deps.broadcast({ type: 'agent', jobId: r.jobId, event });
          if (event.kind === 'usage' && event.live) return;
          void this.write(r, { type: 'agent', at: now(), jobId: r.jobId, event, group: true }).catch(() => {});
        },
      });
      r.run = run;
      r.caps = run.capabilities ?? { liveInput: false, interrupt: false };
      const onAbort = () => run.cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      const outcome = await run.done.finally(() => signal.removeEventListener('abort', onAbort));
      r.run = null;
      await sessionWrite;
      await r.chain;
      if (signal.aborted) return 'cancelled';
      // A redirect cut the run: the next run (same session) takes the new words.
      if (!outcomes && r.redirect) continue;
      if (outcome.status === 'cancelled') return 'cancelled';
      if (outcome.status === 'failed') {
        const lost = session && !fresh ? resumeErrorOf(outcome, { session: seenSession, output: seenOutput }) : null;
        if (lost) {
          fresh = true;
          if (lost === 'not-found' && !fork) await side.updateGroup(host.projectDir, host.creativeSlug, () => ({ session: undefined }));
          // Decision 1423: the brief's session is gone: the fresh run reads the whole chat, the brief's included.
          if (fork) await side.setBriefSession(host.projectDir, host.creativeSlug, null);
          await this.write(r, this.groupLine('info', fork ? t().briefSession.memoryUnavailable : t().live.stoppedSessionUnavailable));
          continue;
        }
        throw new Error(outcome.error ?? t().errors.turnFailed);
      }
      return 'ok';
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The coordinator's tools.

  private toolsFor(r: GroupRun): GroupTools {
    return {
      listVariants: async () => {
        const { group, info } = await this.variantsInfo(r.host, r);
        return {
          variants: info.map((v) => ({ ...v, variant: v.id, folder: `creatives/${group.members.find((m) => m.letter === v.id)!.slug}` })),
          picks: this.picksOf(group),
        };
      },
      workOnVariants: (args) => this.workOn(r, args),
      addVariants: (args) => this.addVariants(r, args),
    };
  }

  /** The ask guard (spec §7): may variant `v` take work in this turn? */
  private pointedTo(r: GroupRun, v: VariantId): boolean {
    return r.explicit.has(v) || r.named.has(v) || r.answered.has(v) || r.created.has(v);
  }

  private async workOn(r: GroupRun, args: Record<string, unknown>): Promise<unknown> {
    if (r.phase !== 'coordinator') throw refuse(['The work of this turn is already decided: do not call work_on_variants now. If more is needed, say so; the user will ask.']);
    const parsed = workSchema.safeParse(args);
    if (!parsed.success) throw refuse(['Give `items`: one `{ variant, instruction }` per variant (instruction: 1 to 4000 characters), with optional `formats`.']);
    const { group, info } = await this.variantsInfo(r.host, r);
    // The group's brief as it is now (a format the coordinator just added is in the host's pending brief while it works).
    const brief = (await this.deps.turns.side.pendingBrief(r.host.projectDir, r.host.creativeSlug))?.brief ?? (await new CreativeStore(r.host.projectDir).get(r.host.creativeSlug)).brief;
    const errors: string[] = [];
    const seen = new Set<VariantId>();
    for (const item of parsed.data.items) {
      const v = item.variant;
      const m = info.find((x) => x.id === v);
      if (seen.has(v)) { errors.push(`Variant ${L(v)} is listed twice: give one item per variant.`); continue; }
      seen.add(v);
      if (!m) { errors.push(`There is no variant ${L(v)} (the variants are ${activeMembers(group).map((x) => L(x.letter)).join(', ')}).`); continue; }
      if (m.status === 'discarded') { errors.push(`Variant ${L(v)} is discarded: restore it first (restore_variant) if the user wants it.`); continue; }
      if (m.missing) { errors.push(`The folder of variant ${L(v)} is missing: it cannot take work.`); continue; }
      if (m.working && !r.created.has(v)) { errors.push(`Variant ${L(v)} is working now: it cannot take work in this turn; tell the user.`); continue; }
      if (!this.pointedTo(r, v)) { errors.push(`The user did not point to variant ${L(v)}: ask the user which variant (AskUserQuestion, with the variants as options) before calling work_on_variants.`); continue; }
      const unknown = (item.formats ?? []).filter((f) => !brief.formats.includes(f));
      if (unknown.length) errors.push(`${L(v)}: ${unknown.map((f) => quotePromptString(oneLine(f).slice(0, 100))).join(', ')} ${unknown.length === 1 ? 'is not a format' : 'are not formats'} of the brief (${brief.formats.join(', ')}).`);
    }
    if (errors.length > 0) throw refuse(errors);
    for (const item of parsed.data.items) {
      r.plan.set(item.variant, { variant: item.variant, instruction: item.instruction, ...(item.formats ? { formats: item.formats } : {}), pins: r.request.pins.filter((p) => p.variant === item.variant) });
    }
    return {
      ok: true, plan: [...r.plan.values()].sort((a, b) => compareVariantIds(a.variant, b.variant)).map((i) => ({ variant: i.variant, ...(i.formats ? { formats: i.formats } : {}), firstGeneration: i.instruction === null })),
      note: 'Motion Studio starts the helpers when your run ends: end it now with one short sentence that says which variants you are working on.',
    };
  }

  private async addVariants(r: GroupRun, args: Record<string, unknown>): Promise<unknown> {
    if (r.phase !== 'coordinator') throw refuse(['The work of this turn is already decided: do not add variants now.']);
    // "New variant" runs once (decision 977): one add per group turn.
    if (r.added) throw refuse([`This turn already added ${[...r.created].map(L).join(', ')}: a request for new variants is done once.`]);
    // Review M3: only when the user's own words of this turn ask for new variants, and no more than they ask for.
    if (r.askedNew === 0) throw refuse(['The user did not ask for new variants in this turn: do not add any. If you think one would help, ask the user first (AskUserQuestion).']);
    const parsed = addSchema.safeParse(args);
    if (parsed.success && parsed.data.items.length > r.askedNew) throw refuse([`The user asked for ${r.askedNew} new ${r.askedNew === 1 ? 'variant' : 'variants'}: add at most ${r.askedNew}.`]);
    if (!parsed.success) throw refuse([`Give \`items\`: one \`{ direction }\` per new variant (one line of 3 to ${MAX_DIRECTION_CHARS} characters), with an optional \`baseFrom: { variant, version }\`.`]);
    const svc = this.svc(r.host);
    const before = (await this.groupOf(r.host)).group;
    const errors: string[] = [];
    const directions = parsed.data.items.map((i) => oneLine(i.direction));
    const taken = before.members.map((m) => m.direction).filter((d): d is string => Boolean(d)).map(sameKey);
    directions.forEach((d, i) => {
      if (d.length < 3) errors.push(`Direction ${i + 1} must be one line of 3 to ${MAX_DIRECTION_CHARS} characters.`);
      else if (directions.findIndex((x) => sameKey(x) === sameKey(d)) < i) errors.push(`Direction ${i + 1} repeats another one: the directions must be clearly different.`);
      else if (taken.includes(sameKey(d))) errors.push(`Direction ${i + 1} repeats the direction of an existing variant: it must be different.`);
    });
    const specs = parsed.data.items.map((item, i) => {
      const base = item.baseFrom ? before.members.find((m) => m.letter === item.baseFrom!.variant && m.status === 'active') : undefined;
      if (item.baseFrom && !base) errors.push(`baseFrom of item ${i + 1}: there is no active variant ${L(item.baseFrom.variant)}.`);
      return { direction: directions[i]!, ...(base ? { baseFrom: { slug: base.slug, version: item.baseFrom!.version } } : {}) };
    });
    if (errors.length > 0) throw refuse(errors);
    // Taken now (two calls at once never both add) and given back when the add fails: a refused add adds nothing.
    r.added = true;
    let g: VariantGroup;
    try {
      g = await svc.addVariants(r.host, () => ({ specs }));
    } catch (err) {
      r.added = false;
      throw err;
    }
    const added = g.members.filter((m) => !before.members.some((b) => b.letter === m.letter));
    for (const m of added) {
      r.created.add(m.letter);
      r.plan.set(m.letter, { variant: m.letter, instruction: null, pins: [] });
      await this.write(r, { type: 'system', at: now(), level: 'info', text: t().agentActions.variantAdded({ letter: L(m.letter), direction: m.direction ?? '' }), origin: 'agent', group: true });
    }
    return {
      ok: true, variants: added.map((m) => m.letter),
      note: 'Their first generation runs in this turn. Add work for other variants with work_on_variants if the user asked for it, then end your run with one short sentence.',
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The helpers.

  private resultOf(jobId: string) {
    let x = this.results.get(jobId);
    if (!x) {
      let resolve!: (r: HelperResult) => void;
      const promise = new Promise<HelperResult>((res) => { resolve = res; });
      x = { promise, resolve };
      this.results.set(jobId, x);
    }
    return x;
  }

  /**
   * Phase 4 of the single agent (spec §9, decisions 1125, 1126, 1144): a plan of two or more variants gets ONE paid-services
   * card (under the group turn's job: its Stop takes it away), listing only the services the formats of each variant's work
   * can use. Approved: the helpers run under its cover; declined, or expired: they run with the paid services off (the
   * agent uses free means); the card gone with the turn (Stop): nothing starts. A single work item has no card: each paid
   * call asks on its own, as for a creative outside a group.
   */
  private async confirm(r: GroupRun, signal: AbortSignal): Promise<Cover | 'cancelled'> {
    if (r.plan.size < 2) return null;
    const group = (await this.groupOf(r.host)).group;
    const targets = [...r.plan.values()].flatMap((i) => {
      const m = group.members.find((x) => x.letter === i.variant);
      return m ? [{ letter: i.variant, slug: m.slug, ...(i.formats ? { formats: i.formats } : {}) }] : [];
    });
    const plan = await paidCardPlan(this.deps, r.host, targets);
    if (!plan) return null;
    this.phase(r, 'confirm');
    const answer = await askPaidCard(this.deps.approvals, r.host, plan, r.jobId);
    if (signal.aborted || answer === 'cancelled') return 'cancelled';
    return answer === 'approved' ? { kind: 'covered', rules: plan.byVariant } : { kind: 'off' };
  }

  /** Starts one helper per work item (the slot gate runs two at a time) and waits for all of them; Stop stops them all. */
  private async dispatch(r: GroupRun, signal: AbortSignal, cover: Cover = null): Promise<ReportOutcome[]> {
    const { host } = r;
    const store = new CreativeStore(host.projectDir);
    const group = (await this.groupOf(host)).group;
    const items = [...r.plan.values()].sort((a, b) => compareVariantIds(a.variant, b.variant));
    const outcomes: ReportOutcome[] = [];
    const started: Array<{ item: WorkItem; slug: string; jobId: string; before: number | null }> = [];
    const userRequest = r.request.text || r.request.pins.length ? { text: r.request.text, pins: r.request.pins } : null;
    for (const item of items) {
      if (signal.aborted) break;
      const m = group.members.find((x) => x.letter === item.variant);
      const instruction = item.instruction ? { instruction: item.instruction } : {};
      if (!m) { outcomes.push({ variant: item.variant, version: null, kept: false, status: 'failed', error: t().errors.variantUnknown({ letter: L(item.variant) }), ...instruction }); continue; }
      const mref = memberRef(host, m.slug);
      const before = (await store.readVersions(m.slug).catch(() => [])).at(-1)?.n ?? null;
      try {
        const message = item.instruction ? { text: item.instruction, pins: item.pins } : undefined;
        // A covered (or paid-off) helper waits, held, until its cover is in place: never a paid call before it.
        const job = await this.deps.turns.start(mref, message, { ...(item.formats ? { formats: item.formats } : {}), ...(cover ? { hold: 'variant-confirm' as const } : {}), helper: { jobId: r.jobId, variant: item.variant, request: userRequest } });
        this.resultOf(job.id);
        r.helpers.set(item.variant, job.id);
        if (cover) {
          const { approvals, queue } = this.deps;
          if (cover.kind === 'covered') approvals.cover(job.id, cover.rules[item.variant] ?? [], Promise.resolve(true));
          else approvals.coverOff(job.id);
          void this.resultOf(job.id).promise.then(() => approvals.uncover(job.id));
          queue.setHold(job.id, null);
        }
        started.push({ item, slug: m.slug, jobId: job.id, before });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        outcomes.push({ variant: item.variant, version: null, kept: false, status: 'failed', error, ...instruction });
        await this.write(r, this.groupLine('warning', t().jobs.groupHelperNotStarted({ letter: L(item.variant), error })));
      }
    }
    const { queue, approvals } = this.deps;
    const onAbort = () => { for (const s of started) stopJob({ queue, approvals }, s.jobId); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      await Promise.all(started.map((s) => this.resultOf(s.jobId).promise));
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    const entries = await store.readConversation(host.creativeSlug);
    for (const s of started) {
      const res = await this.resultOf(s.jobId).promise;
      const summary = queue.list().find((j) => j.id === s.jobId);
      const versions = await store.readVersions(s.slug).catch(() => []);
      const text = [...entries].reverse().find((e) => e.type === 'agent' && e.jobId === s.jobId && e.event.kind === 'text');
      const said = text && text.type === 'agent' && text.event.kind === 'text' ? text.event.text.slice(0, HELPER_TEXT_MAX) : undefined;
      const base = { variant: s.item.variant, jobId: s.jobId, ...(said ? { text: said } : {}), ...(s.item.instruction ? { instruction: s.item.instruction } : {}) };
      if (res.savedVersion !== null && res.state === 'succeeded') {
        const kept = res.savedVersion === s.before;
        const v = versions.find((x) => x.n === res.savedVersion);
        outcomes.push({ ...base, version: res.savedVersion, kept, status: kept ? 'unchanged' : v?.status ?? 'complete' });
      } else if (res.state === 'cancelled' || res.stopped) {
        outcomes.push({ ...base, version: null, kept: false, status: 'stopped' });
      } else {
        outcomes.push({ ...base, version: null, kept: false, status: 'failed', ...(summary?.error ? { error: summary.error } : {}) });
      }
    }
    return outcomes.sort((a, b) => compareVariantIds(a.variant, b.variant));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Messages while a group turn works, the group's queue, redirect (spec §8 "Live messages").

  /**
   * `POST …/messages` in a group with one agent. While the coordinator runs, the message goes to it (live input), or joins its
   * first prompt when it has not started yet. While helpers work, a message whose comments all target working helpers goes
   * live to them (each with its own variant's comments, one bubble in the chat). Anything else is the group's next request.
   */
  async postMessage(ref: CreativeRef, input: UserMessageInput & { mode: 'live' | 'queued' }): Promise<MessageAnswer> {
    const { host, group } = await this.groupOf(ref);
    const m = checkLiveMessage({ ...input, pins: this.withVariants(ref, input.pins) });
    const key = this.keyOf(host);
    const answer = await this.answers.once(`${key}\0${m.clientId}`, async (): Promise<MessageAnswer> => {
      const known = await this.knownAnswer(host, m.clientId);
      if (known) return known;
      await this.adoptMemberQueues(host, group);
      if (input.mode === 'queued') return this.queueRequest(host, m, 'queued');
      const r = this.activeRun(host);
      if (!r || r.phase === 'ended' || r.phase === 'report') return this.queueRequest(host, m, 'queued-after-finish');
      if (r.liveMessages >= LIVE_LIMITS.perTurn) throw new CodedError(409, t().live.tooManyLive({ max: LIVE_LIMITS.perTurn }), 'limit');
      const ids = group.members.map((x) => x.letter);
      const entry: ConversationEntry = { type: 'user', at: now(), text: m.text, pins: m.pins, attachments: [], jobId: r.jobId, mode: 'live', clientId: m.clientId, group: true };
      const takes = () => {
        r.liveMessages++;
        this.deps.queue.patch(r.jobId, { liveMessages: r.liveMessages });
        for (const v of variantsOfPins(m.pins)) r.explicit.add(v);
        for (const v of namedVariants(m.text, ids)) r.named.add(v);
        r.askedNew = Math.max(r.askedNew, askedNewVariants(m.text));
        const count = r.askedNew > 0 ? bareCount(m.text) : null;
        if (count !== null) r.askedNew = Math.max(r.askedNew, count);
      };
      if (r.phase === 'queued') {
        takes();
        r.later.push({ text: m.text, pins: m.pins });
        await this.write(r, entry);
        return { entry, outcome: 'delivered-pending' };
      }
      if (r.phase === 'coordinator' && r.run && r.caps.liveInput) {
        const sent = await r.run.send?.({ text: liveMessageText(m.text, m.pins, pinLine), clientId: m.clientId });
        if (sent === 'written') {
          takes();
          await this.write(r, entry);
          return { entry, outcome: 'delivered-pending' };
        }
      }
      if (r.phase === 'helpers') {
        const targets = variantsOfPins(m.pins);
        const working = (v: VariantId) => {
          const id = r.helpers.get(v);
          return id !== undefined && this.deps.queue.list().some((j) => j.id === id && (j.state === 'queued' || j.state === 'running'));
        };
        if (targets.length > 0 && targets.every(working)) {
          r.liveMessages++;
          let first: MessageAnswer | null = null;
          for (const v of targets) {
            const mref = memberRef(host, group.members.find((x) => x.letter === v)!.slug);
            const a = await this.deps.turns.postMessage(mref, { clientId: m.clientId, text: m.text, pins: m.pins.filter((p) => p.variant === v), mode: 'live' }, { bubble: m.clientId });
            first ??= a;
          }
          return first!;
        }
      }
      return this.queueRequest(host, m, 'queued-after-finish');
    });
    if (answer.outcome !== 'delivered-pending') void this.maybeAutoRun(host);
    return answer;
  }

  /** The answer already given for `clientId`, rebuilt from the group's queue or chat. */
  private async knownAnswer(host: CreativeRef, clientId: string): Promise<MessageAnswer | null> {
    const q = (await this.deps.turns.side.group(host.projectDir, host.creativeSlug)).queued?.find((x) => x.clientId === clientId);
    if (q) return { entry: this.queuedEntry(q), outcome: 'queued' };
    const e = (await new CreativeStore(host.projectDir).readConversation(host.creativeSlug)).find((x) => x.type === 'user' && x.clientId === clientId);
    if (e && e.type === 'user') return { entry: e, outcome: e.mode === 'queued' ? 'queued' : 'delivered-pending' };
    return null;
  }

  private queuedEntry(q: Pick<QueuedRequest, 'clientId' | 'text' | 'pins' | 'at'>): ConversationEntry {
    return { type: 'user', at: q.at, text: q.text, pins: q.pins, attachments: [], mode: 'queued', clientId: q.clientId, group: true };
  }

  /** Appends a request to the group's queue (at most `LIVE_LIMITS.queued` from the user; never lost otherwise). */
  private async queueRequest(host: CreativeRef, m: UserMessageInput, outcome: Exclude<LiveMessageOutcome, 'delivered-pending'>, o: { limit?: boolean; note?: boolean; variants?: VariantId[] } = {}): Promise<MessageAnswer> {
    const item: QueuedRequest = { clientId: m.clientId, text: m.text, pins: m.pins, at: now(), ...(o.variants?.length ? { variants: o.variants } : {}) };
    const key = this.keyOf(host);
    await this.deps.turns.side.updateGroup(host.projectDir, host.creativeSlug, (g) => {
      const queued = g.queued ?? [];
      // Review M1: the parts of one message that several helpers could not take come back one by one with the same id: they
      // are one request, with every part's comments and variants (never a part dropped as a repeat).
      const same = queued.find((x) => x.clientId === m.clientId);
      if (same) {
        const key = (p: Pin) => JSON.stringify(p);
        const pins = [...same.pins, ...item.pins.filter((p) => !same.pins.some((q) => key(q) === key(p)))];
        const variants = [...new Set([...(same.variants ?? []), ...(item.variants ?? [])])].sort(compareVariantIds);
        if (pins.length === same.pins.length && variants.length === (same.variants ?? []).length) return {};
        return { queued: queued.map((x) => (x === same ? { ...x, pins, ...(variants.length ? { variants } : {}) } : x)) };
      }
      if (o.limit !== false && queued.length >= LIVE_LIMITS.queued) throw new CodedError(409, t().live.queueFull({ max: LIVE_LIMITS.queued }), 'limit');
      this.queuedHere.add(`${key}\0${m.clientId}`);
      return { queued: [...queued, item] };
    });
    if (outcome === 'queued-after-finish' && o.note !== false) {
      await new CreativeStore(host.projectDir).appendConversation(host.creativeSlug, this.groupLine('info', t().live.queuedAfterFinish));
    }
    this.changed(host);
    return { entry: this.queuedEntry(item), outcome };
  }

  /** `GroupRouter`: what a helper could not take joins the group's queue, for its variant (never lost). */
  async queueForGroup(ref: CreativeRef, m: UserMessageInput, variant: VariantId): Promise<void> {
    const { host } = await this.groupOf(ref);
    await this.queueRequest(host, { ...m, pins: m.pins.map((p) => (p.variant ? p : { ...p, variant })) }, 'queued-after-finish', { limit: false, note: false, variants: [variant] });
  }

  /**
   * Spec §10 and decision 1157: a member's own queued requests (written before its group had one agent) move to the group's
   * queue, in time order, each for its variant: its comments get the variant and the request names it. Only for idle
   * members (a working one keeps its queue until it is done).
   */
  async adoptMemberQueues(host: CreativeRef, group: VariantGroup): Promise<void> {
    const side = this.deps.turns.side;
    const moved: Array<{ slug: string; items: QueuedRequest[] }> = [];
    for (const mem of group.members) {
      const mref = memberRef(host, mem.slug);
      if (this.deps.turns.turnActive(mref)) continue;
      const own = (await side.read(host.projectDir, mem.slug).catch(() => null))?.queued ?? [];
      if (own.length === 0) continue;
      moved.push({ slug: mem.slug, items: own.map((q) => ({ ...q, pins: q.pins.map((p) => (p.variant ? p : { ...p, variant: mem.letter })), variants: [...new Set([...(q.variants ?? []), mem.letter])] })) });
    }
    if (moved.length === 0) return;
    const all = moved.flatMap((m) => m.items).sort((a, b) => a.at.localeCompare(b.at));
    // Review minor 6: the group's queue is written first, then each member's is cleared: a crash in between leaves the
    // requests in both, and the next adoption adds none twice (by client id).
    await side.updateGroup(host.projectDir, host.creativeSlug, (g) => ({ queued: [...(g.queued ?? []), ...all.filter((x) => !(g.queued ?? []).some((y) => y.clientId === x.clientId))] }));
    for (const m of moved) {
      const ids = new Set(m.items.map((q) => q.clientId));
      await side.update(host.projectDir, m.slug, (cur) => ({ queued: (cur.queued ?? []).filter((q) => !ids.has(q.clientId)) }));
    }
    this.changed(host);
  }

  /** The group's queue (the composer shows it on every member). */
  async queued(ref: CreativeRef): Promise<QueuedRequest[]> {
    const { host } = await this.groupOf(ref);
    return (await this.deps.turns.side.group(host.projectDir, host.creativeSlug)).queued ?? [];
  }

  private async editQueue(ref: CreativeRef, fn: (q: QueuedRequest[]) => QueuedRequest[]): Promise<void> {
    const { host } = await this.groupOf(ref);
    await this.deps.turns.side.updateGroup(host.projectDir, host.creativeSlug, (g) => ({ queued: fn(g.queued ?? []) }));
    this.changed(host);
  }

  async removeQueued(ref: CreativeRef, clientId: string): Promise<void> {
    await this.editQueue(ref, (q) => {
      if (!q.some((x) => x.clientId === clientId)) throw new CodedError(404, t().live.notQueued, 'not-queued');
      return q.filter((x) => x.clientId !== clientId);
    });
  }

  async editQueued(ref: CreativeRef, clientId: string, patch: { text: string; pins: Pin[] }): Promise<void> {
    const m = checkLiveMessage({ clientId, ...patch, pins: this.withVariants(ref, patch.pins) });
    await this.editQueue(ref, (q) => {
      if (!q.some((x) => x.clientId === clientId)) throw new CodedError(404, t().live.notQueued, 'not-queued');
      return q.map((x) => (x.clientId === clientId ? { ...x, text: m.text, pins: m.pins } : x));
    });
  }

  async reorderQueue(ref: CreativeRef, order: string[]): Promise<void> {
    await this.editQueue(ref, (q) => {
      const same = order.length === q.length && new Set(order).size === order.length && order.every((id) => q.some((x) => x.clientId === id));
      if (!same) throw new CodedError(409, t().live.queueChanged, 'queue-changed');
      return order.map((id) => q.find((x) => x.clientId === id)!);
    });
  }

  /** `POST …/queue/run-next`: the group's first queued request starts now. */
  async runNext(ref: CreativeRef): Promise<JobSummary> {
    const { host, group } = await this.groupOf(ref);
    return this.locks.run(this.keyOf(host), async () => {
      if (this.activeJob(host)) throw new CodedError(409, t().errors.generationRunning, 'job-running');
      const job = await this.startQueuedLocked(host, group);
      if (!job) throw new CodedError(409, t().live.queueEmpty, 'queue-empty');
      return job;
    });
  }

  private async startQueuedLocked(host: CreativeRef, group: VariantGroup): Promise<JobSummary | null> {
    let head: QueuedRequest | undefined;
    await this.deps.turns.side.updateGroup(host.projectDir, host.creativeSlug, (g) => {
      const [first, ...rest] = g.queued ?? [];
      head = first;
      return first ? { queued: rest } : {};
    });
    const taken = head;
    if (!taken) return null;
    try {
      const job = await this.startLocked(host, group, { text: taken.text, pins: taken.pins, clientId: taken.clientId, queued: true, ...(taken.variants ? { variants: taken.variants } : {}) });
      this.queuedHere.delete(`${this.keyOf(host)}\0${taken.clientId}`);
      return job;
    } catch (err) {
      await this.deps.turns.side.updateGroup(host.projectDir, host.creativeSlug, (g) => ({ queued: [taken, ...(g.queued ?? []).filter((x) => x.clientId !== taken.clientId)] }));
      throw err;
    }
  }

  /** The group's next request starts by itself after a group turn that succeeded, when this process queued it (Rulings T, U). */
  async maybeAutoRun(host: CreativeRef): Promise<JobSummary | null> {
    const key = this.keyOf(host);
    try {
      return await this.locks.run(key, async () => {
        if (this.activeJob(host) || this.paused.has(key)) return null;
        const head = (await this.deps.turns.side.group(host.projectDir, host.creativeSlug)).queued?.[0];
        if (!head || !this.queuedHere.has(`${key}\0${head.clientId}`)) return null;
        const { group } = await this.groupOf(host);
        return this.startQueuedLocked(host, group);
      });
    } catch {
      return null;
    }
  }

  /**
   * `POST /api/jobs/:id/redirect` on a group turn: while the coordinator runs, it is cut and its next run (the same session)
   * takes the new words; before it starts they join its first prompt; afterwards they are the group's next request.
   */
  async redirect(jobId: string, input: UserMessageInput): Promise<{ outcome: RedirectOutcome }> {
    const r = this.runs.get(jobId);
    if (!r || r.phase === 'ended') throw new CodedError(409, t().live.notRunning, 'not-running');
    const m = checkLiveMessage({ ...input, pins: this.withVariants(r.host, input.pins) });
    return this.answers.once(`redirect\0${jobId}\0${m.clientId}`, async () => {
      const ids = (await this.groupOf(r.host)).group.members.map((x) => x.letter);
      const entry: ConversationEntry = { type: 'user', at: now(), text: m.text, pins: m.pins, attachments: [], jobId, mode: 'redirect', clientId: m.clientId, group: true };
      const takes = () => {
        for (const v of variantsOfPins(m.pins)) r.explicit.add(v);
        for (const v of namedVariants(m.text, ids)) r.named.add(v);
        r.askedNew = Math.max(r.askedNew, askedNewVariants(m.text));
        const count = r.askedNew > 0 ? bareCount(m.text) : null;
        if (count !== null) r.askedNew = Math.max(r.askedNew, count);
      };
      if (r.phase === 'queued') {
        takes();
        r.later.push({ text: m.text, pins: m.pins });
        await this.write(r, entry);
        return { outcome: 'pending-start' as const };
      }
      if (r.phase === 'coordinator' && r.run) {
        takes();
        this.deps.approvals.cancelJob(jobId);
        r.redirect = { text: m.text, pins: m.pins };
        await this.write(r, entry);
        r.run.cancel();
        return { outcome: 'restarted' as const };
      }
      const a = await this.queueRequest(r.host, m, 'queued-after-finish');
      return { outcome: a.outcome as RedirectOutcome };
    });
  }
}

/**
 * At startup (spec §10, "restart recovery"): a group turn the restart cut is said in the group's chat and its marker cleared.
 * Its helpers are recovered as any variant's turn (interrupted, their sessions remembered); the coordinator's session stays,
 * so the next group turn resumes it. Its queue waits for "Run next" (Ruling T).
 */
export async function recoverGroupTurns(projectDir: string, slugs: readonly string[], side: CreativeTurnService['side'], isActive: (slug: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const store = new CreativeStore(projectDir);
  for (const slug of slugs) {
    const g = await side.group(projectDir, slug).catch(() => null);
    if (!g?.turn || isActive(slug)) continue;
    // Review minor 2: a turn cut before its run started goes back to the top of the queue (it waits for "Run next").
    const back = !g.turn.started ? g.turn.request : undefined;
    await side.updateGroup(projectDir, slug, (cur) => ({
      turn: undefined,
      ...(back && !(cur.queued ?? []).some((q) => q.clientId === back.clientId) ? { queued: [back, ...(cur.queued ?? [])] } : {}),
    })).catch(() => {});
    await store.appendConversation(slug, { type: 'system', at: now(), level: back ? 'warning' : 'error', text: back ? t().jobs.groupInterruptedQueued : t().jobs.groupInterrupted, group: true }).catch(() => {});
    out.push(slug);
  }
  return out;
}

import { QUESTION_DISPLAY } from '@motion-studio/shared';
import { compareVariantIds } from '@motion-studio/shared';
import type { AgentEvent, ApprovalRequest, Brief, ConversationEntry, ExplainContext, GroupTurnOutcome, JobSummary, LiveMessageOutcome, Pin, QueuedRequest, RedirectOutcome, UsageSummary, VariantGroup, VariantId } from '@motion-studio/shared';
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, ApiError, type VariantRunResult } from '../api.ts';
import { formatDate, formatNumber, TIME_OF_DAY, useLocale, useT } from '../i18n.tsx';
import { enter, isSubmitChord } from '../motion/index.ts';
import { isMac } from '../platform.ts';
import { clipRangeChip } from '../screens/pinModel.ts';
import { Button, Chip, Empty, Icon, Markdown, Spinner, Textarea, Tooltip, Typing, cx, type IconName } from '../ui/index.ts';
import { lastStep } from '../jobEvents.ts';
import { liveErrorText, newClientId } from './liveErrors.ts';
import { QueuedRequests } from './QueuedRequests.tsx';
import { SplitAction } from './SplitAction.tsx';
import { StopMenu } from './StopMenu.tsx';
import { defaultTargets } from '../screens/versionModel.ts';
import { VariantSelector, type ChatTarget } from '../screens/variants/VariantSelector.tsx';
import { errorCode, versionErrorText } from '../screens/versionErrors.ts';
import { message } from '../errors.ts';
import { ApprovalCard } from './ApprovalCard.tsx';
import { Clipped } from './QuestionCard.tsx';
import { groupTurnText } from './groupTurnText.ts';
import { ServicesChip } from './ServicesSelector.tsx';
import { explanationView, RiskChips } from './RiskChips.tsx';
import { useApprovalPresence, type ShownApproval } from './approvalPresence.ts';
import { commandLog, webExplainContext, WorkspacePathContext, type CommandLog, type CommandMark, type CommandRow } from './commandLog.ts';

/**
 * Events of a job across a page reload. `persisted` are the job's agent entries read from conversation.jsonl
 * (everything written before the last fetch), `live` the events received over the socket since page load. Both are
 * in emission order and `live` continues the persisted history, so the longest suffix of `persisted` that equals a
 * prefix of `live` is the overlap (a mid-job refetch persists events already seen live): it is shown once.
 */
export function mergeJobEvents(persisted: AgentEvent[], live: AgentEvent[]): AgentEvent[] {
  if (persisted.length === 0) return live;
  const p = persisted.map((e) => JSON.stringify(e));
  const l = live.map((e) => JSON.stringify(e));
  for (let k = Math.min(p.length, l.length); k > 0; k--) {
    let same = true;
    for (let i = 0; i < k && same; i++) same = p[p.length - k + i] === l[i];
    if (same) return [...persisted, ...live.slice(k)];
  }
  return [...persisted, ...live];
}

/**
 * Phase 15: the chat of a creative that belongs to a variant group. The selector (A · B · C · Tutte) sits on top of the panel;
 * "Tutte" sends the composer's request to every active variant (`runAll`), a letter sends to that variant (its page). Since
 * decision 980 the conversation shown is the group's whatever is chosen.
 */
export interface ConversationVariants {
  group: VariantGroup;
  /** The variant a message goes to (this page's). */
  current: VariantId;
  /** "Tutte" is on. */
  all: boolean;
  missing?: readonly VariantId[];
  onSelect(target: ChatTarget): void;
  /** The same request in every active variant; `null` is the first generation. */
  runAll(body: { text?: string; pins?: Pin[]; formats?: string[] } | null): Promise<VariantRunResult>;
}

export interface ConversationProps {
  slug: string;
  /** Creative slug. */
  creative: string;
  entries: ConversationEntry[];
  /** Pending approvals to show in the flow (the caller filters them to this creative). */
  approvals: ApprovalRequest[];
  /** The creative's latest job (active or finished). */
  job: JobSummary | undefined;
  /** Events of `job` received over the socket since page load. */
  live?: AgentEvent[];
  /** Pending comments (pins) sent with the next message. */
  pins?: Pin[];
  onRemovePin?(index: number): void;
  /** Reopens a pending comment for editing (its chip is then a button). */
  onEditPin?(index: number): void;
  /** Display name of a format id for the comment chips. */
  formatName?(id: string): string;
  /** No version yet: the composer offers Generate (an empty turn). */
  canGenerate?: boolean;
  /** After a successful send, with the pins that went with it (pins added meanwhile stay pending). */
  onSent?(sent: { pins: Pin[] }): void;
  /** Asked before a message goes out; false (or a rejection) keeps the text in the box (the editor's unsaved-draft prompt). */
  beforeSend?(): boolean | Promise<boolean>;
  onSelectVersion?(n: number): void;
  /** Extra content of a version card, e.g. its token usage (nothing when it returns null). */
  versionExtra?(n: number): ReactNode;
  /** A note under a version card, e.g. its large-file warnings (nothing when it returns null). */
  versionNote?(n: number): ReactNode;
  /** The edit summary of a version saved from the editor (its request), shown on its card; null for an agent's version. */
  versionSummary?(n: number): string | null;
  /** Socket snapshots received (EventsState.snapshots): a new one is the core's whole state, so stop waiting. */
  snapshots?: number;
  /** The composer's "Applies to" (spec §2.5): absent when there is nothing to choose (one primary, no version yet). */
  appliesTo?: AppliesTo;
  /** The creative's brief: with it the composer shows the "Services" chip, which saves the brief's services (Task 7). */
  brief?: Brief;
  /** After the chip saved the brief (reload the creative). */
  onBriefSaved?(): void;
  /** Phase 13: the creative's queued requests (`creative.json` `queued[]`), shown above the composer. */
  queued?: QueuedRequest[];
  /** After a message, a queue change or a Run next: the caller reloads the creative and its conversation. */
  onQueueChanged?(): void;
  /** Phase 15: absent for a creative outside any variant group (the panel is then exactly as before). */
  variants?: ConversationVariants;
  /**
   * Decision 980 (phase 2): in a variant group the chat is the group's, each entry with its variant's chip. `self` is the
   * variant of this page: a version card of another variant opens it (`onOpenVariant`) instead of "View vN" here.
   */
  self?: VariantId;
  onOpenVariant?(variant: VariantId): void;
  /** The other variants' latest turns with their live events: their running turns go on in this chat too. */
  memberJobs?: ReadonlyArray<{ job: JobSummary; live: AgentEvent[]; variant?: VariantId }>;
  /**
   * Phase 3 of the single agent: the group has one agent. The composer sends to the group (the core's routes take it to the
   * group turn): no selector, no "Applies to", and the other variants' pending comments (`otherPins`) go with the message.
   * `job` is then the group turn.
   */
  single?: boolean;
  otherPins?: Pin[];
  onRemoveOtherPin?(pin: Pin): void;
  /** The usage of a group turn, shown on its `group-turn` line (e.g. a usage badge). */
  usageOf?(usage: UsageSummary): ReactNode;
}

/** Phase 5: where a helper's row is (`working` with its latest step), from its entries and its group turn's outcome. */
type HelperState = { kind: 'working'; step: string | null } | { kind: 'version'; n: number; complete: boolean } | { kind: 'unchanged' } | { kind: 'failed' } | { kind: 'stopped' } | { kind: 'done' };

/** A message sent while the agent works, until the conversation file shows it (Phase 13). */
interface Outgoing { clientId: string; text: string; pins: Pin[]; at: string; mode: 'live' | 'redirect'; phase: 'sending' | 'pending' | 'pendingStart' }
/** What a message bubble says about its journey; none for an ordinary message (old conversations have none). */
type MessageState = 'sending' | 'pending' | 'pendingStart' | 'sent' | 'delivered' | 'queued' | 'notDelivered';
interface OutboxApi { add(o: Outgoing): void; phase(clientId: string, phase: Outgoing['phase']): void; drop(clientId: string): void }

/** What a change can apply to: the primary formats (with their followers' labels) and how a format maps to its primary. */
export interface AppliesTo {
  primaries: Array<{ id: string; label: string; followers: string[] }>;
  /** The primary a format follows, or null. */
  followerOf(id: string): string | null;
  /** The default when there are no comments (null: "All formats"); e.g. the format view's own format. */
  fallback?: string[] | null;
}

/** Decision 980: the variant(s) an entry belongs to, shown as chips (absent outside a variant group). */
type Item =
  | { key: string; kind: 'user'; at: string; text: string; pins: Pin[]; state?: MessageState; redirect?: boolean; variants?: VariantId[] }
  | { key: string; kind: 'agent'; at: string; text: string; summary: boolean; variant?: VariantId }
  | { key: string; kind: 'step'; at: string; text: string }
  | { key: string; kind: 'fold'; jobId: string; count: number; open: boolean }
  | { key: string; kind: 'error'; at: string; text: string; variant?: VariantId }
  | { key: string; kind: 'details'; jobId: string; entries: DetailEntry[]; open: boolean }
  | { key: string; kind: 'autoline'; jobId: string; log: CommandLog }
  | { key: string; kind: 'version'; at: string; n: number; complete: boolean; variant?: VariantId }
  /** `agent`: a line about something the agent did in the app with its tools (decision 917). */
  | { key: string; kind: 'system'; at: string; level: 'info' | 'warning' | 'error'; text: string; agent?: boolean; variant?: VariantId }
  | { key: string; kind: 'approval'; shown: ShownApproval }
  | { key: string; kind: 'typing' }
  | { key: string; kind: 'retried'; at: string }
  /**
   * Phase 5 of the single agent (decision 983): a group turn's helper, one row per variant ("B · al lavoro…", then "B · v4
   * pronta"); `children` are its detailed steps, shown when `open`; `cards` its open approvals, never folded away.
   */
  | { key: string; kind: 'helper'; variant: VariantId; groupJobId: string; open: boolean; state: HelperState; children: Item[]; cards: Item[] }
  /** Phase 3 of the single agent: what each variant did in a group turn (decision 980's "worked on" line). */
  | { key: string; kind: 'groupTurn'; at: string; outcome: GroupTurnOutcome[]; stopped: boolean; usage?: UsageSummary }
  /** User note 8: the agent's AskUserQuestion and what became of it. */
  | { key: string; kind: 'question'; at: string; event: Extract<AgentEvent, { kind: 'question_answered' }>; variant?: VariantId };

/** An Activity details row: a command (or Read) of the command log, or a raw technical event. */
type DetailEntry = { key: string; row: CommandRow } | { key: string; event: AgentEvent };

const active = (j: JobSummary | undefined) => !!j && (j.state === 'queued' || j.state === 'running');
// `auto_approved` (Phase 8) and Bash `tool_use` go to Activity details as command rows; `usage` and `approval_decided`
// are never rows (the live estimate has its own slot in the reducer, the final figure belongs to the version card; a
// decision shows as the mark of its command).
const TECHNICAL = new Set<AgentEvent['kind']>(['session', 'tool_use', 'tool_result', 'rate_limit', 'stderr', 'parse_error', 'auto_approved']);
const same = (a: string, b: string) => a.trim() === b.trim();
const samePins = (a: Pin[], b: Pin[]) => a.length === b.length
  && a.every((p, i) => { const q = b[i]!; return p.format === q.format && p.x === q.x && p.y === q.y && p.timeSec === q.timeSec && (p.note ?? '') === (q.note ?? ''); });

/**
 * User note 7: a message the user sent during the turn, placed before the turn's event number `anchor` (the number of the
 * turn's events that came before it), so the agent's answer and everything after it come below it.
 */
interface TurnInsert { anchor: number; item: Item }

/** One turn (the agent events of one job) as conversation items: messages, compact steps, summary, details. */
function turnItems(interruptedText: string, jobId: string, events: { at: string; event: AgentEvent }[], running: boolean, foldOpen: boolean, detailsOpen: boolean, logOf: (jobId: string, events: AgentEvent[], finished: boolean) => CommandLog, inserts: readonly TurnInsert[] = []): Item[] {
  const out: Item[] = [];
  // Stable: two messages with the same anchor keep the order they were sent in.
  const pending = [...inserts].sort((a, b) => a.anchor - b.anchor);
  const flush = (upTo: number) => { while (pending.length > 0 && pending[0]!.anchor <= upTo) out.push(pending.shift()!.item); };
  const steps: Item[] = [];
  const technical: DetailEntry[] = [];
  // Every command of the turn, with its explanation and whether it ran (see commandLog.ts).
  const log = logOf(jobId, events.map((e) => e.event), !running);
  const rowAt = new Map(log.rows.map((r) => [r.key, r]));
  let lastAgent: Extract<Item, { kind: 'agent' }> | null = null;
  let foldAt = -1;
  events.forEach(({ at, event: e }, i) => {
    const key = `${jobId}:${i}`;
    flush(i);
    if (TECHNICAL.has(e.kind)) {
      const row = rowAt.get(`c${i}`);
      // An automatic approval merged into its tool_use has no row of its own.
      if (row) technical.push({ key, row });
      else if (e.kind !== 'auto_approved') technical.push({ key, event: e });
      return;
    }
    if (e.kind === 'text') {
      if (!e.text.trim()) return;
      lastAgent = { key, kind: 'agent', at, text: e.text, summary: false };
      out.push(lastAgent);
    } else if (e.kind === 'question_answered') {
      out.push({ key, kind: 'question', at, event: e });
    } else if (e.kind === 'interrupted') {
      out.push({ key, kind: 'system', at, level: 'info', text: interruptedText });
    } else if (e.kind === 'progress') {
      const step: Item = { key, kind: 'step', at, text: e.text };
      steps.push(step);
      // A finished turn folds its steps behind one toggle, placed where the first step was.
      if (running) out.push(step);
      else if (foldAt < 0) foldAt = out.length;
    } else if (e.kind === 'result') {
      technical.push({ key, event: e });
      // Decision 804: the turn the user stopped is not an error (its `interrupted` row says what happened).
      if (!e.ok && !e.interrupted) out.push({ key, kind: 'error', at, text: e.error ?? '' });
      else if (e.text?.trim()) {
        // The final result usually repeats the last message: mark that one as the summary instead of repeating it.
        const last: Extract<Item, { kind: 'agent' }> | null = lastAgent;
        if (last && same(last.text, e.text)) last.summary = true;
        else out.push({ key, kind: 'agent', at, text: e.text, summary: true });
      }
    }
  });
  flush(Infinity);
  if (!running && steps.length > 0) {
    out.splice(foldAt, 0, { key: `${jobId}:fold`, kind: 'fold', jobId, count: steps.length, open: foldOpen }, ...(foldOpen ? steps : []));
  }
  // A finished turn says how many commands ran (whatever the automatic-approval setting: transparency always), as a
  // line that opens Activity details.
  if (!running && log.ran > 0) out.push({ key: `${jobId}:auto`, kind: 'autoline', jobId, log });
  if (technical.length > 0) out.push({ key: `${jobId}:details`, kind: 'details', jobId, entries: technical, open: detailsOpen });
  return out;
}

/**
 * Conversation of a creative (spec §6.2 #6, visual test points 25 and 32): one message per entry with its time,
 * agent steps as compact rows with ✓ (folded once the turn is over), the result as safe Markdown, technical events
 * only in "Activity details", the job's approvals in the flow, typing dots while the agent works (T9), and the
 * composer with the pending comment chips and ⌘↵.
 */
export function Conversation({ slug, creative, entries, approvals, job, live = [], pins = [], onRemovePin, onEditPin, formatName, canGenerate, onSent, beforeSend, onSelectVersion, versionExtra, versionNote, versionSummary, snapshots, appliesTo, brief, onBriefSaved, queued, onQueueChanged, variants, self, onOpenVariant, memberJobs, single, otherPins, onRemoveOtherPin, usageOf }: ConversationProps) {
  const t = useT();
  const c = t.web.chat;
  const working = active(job);
  const [outbox, setOutbox] = useState<Outgoing[]>([]);
  const outboxApi = useMemo<OutboxApi>(() => ({
    add: (o) => setOutbox((l) => [...l.filter((x) => x.clientId !== o.clientId), o].slice(-20)),
    phase: (clientId, phase) => setOutbox((l) => l.map((x) => (x.clientId === clientId ? { ...x, phase } : x))),
    drop: (clientId) => setOutbox((l) => l.filter((x) => x.clientId !== clientId)),
  }), []);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [detailsOpen, setDetailsOpen] = useState<ReadonlySet<string>>(new Set());
  // Phase 5 (decision 983): the helper rows opened by the user (closed by default).
  const [helpersOpen, setHelpersOpen] = useState<ReadonlySet<string>>(new Set());
  const { list: shownApprovals, gone } = useApprovalPresence(approvals);
  const workspace = useContext(WorkspacePathContext);
  const ctx = useMemo(() => webExplainContext(workspace, slug, creative), [workspace, slug, creative]);
  // The command log of each turn, kept while its events (count, first and last event), its state and the context are
  // the same: a live event recomputes only the turn it belongs to.
  const logCache = useRef(new Map<string, { n: number; first: AgentEvent | undefined; last: AgentEvent | undefined; finished: boolean; ctx: ExplainContext; log: CommandLog }>());
  const logOf = (jobId: string, events: AgentEvent[], finished: boolean): CommandLog => {
    const hit = logCache.current.get(jobId);
    const first = events[0];
    const last = events[events.length - 1];
    if (hit && hit.n === events.length && hit.first === first && hit.last === last && hit.finished === finished && hit.ctx === ctx) return hit.log;
    const log = commandLog(events, ctx, { finished });
    logCache.current.set(jobId, { n: events.length, first, last, finished, ctx, log });
    return log;
  };

  // First time each live event (not yet persisted) was seen: its time until the refetch brings the real one.
  const seenAt = useRef(new Map<string, string>());
  // User note 7: how many events of the latest turn were shown when a message not yet in the file first appeared.
  const outAnchor = useRef(new Map<string, number>());
  const items = useMemo(() => {
    const out: Item[] = [];
    const jobs = new Map<string, { at: string; event: AgentEvent }[]>();
    const firstIndex = new Map<string, number>();
    // Decision 980: the variant of each turn in a group's one chat (from its entries).
    const jobVariant = new Map<string, VariantId>();
    entries.forEach((e, i) => {
      if (e.type !== 'agent') return;
      if (!jobs.has(e.jobId)) { jobs.set(e.jobId, []); firstIndex.set(e.jobId, i); }
      jobs.get(e.jobId)!.push({ at: e.at, event: e.event });
      if (e.variant && !jobVariant.has(e.jobId)) jobVariant.set(e.jobId, e.variant);
    });
    // A job continues with its live events (shown once: see mergeJobEvents): the latest job of this page, and in a group the
    // other variants' turns (decision 980).
    const withLive = (jobId: string, events: AgentEvent[]) => {
      if (events.length === 0) return;
      const persisted = jobs.get(jobId) ?? [];
      const merged = mergeJobEvents(persisted.map((p) => p.event), events);
      const now = new Date().toISOString();
      jobs.set(jobId, merged.map((event, i) => {
        if (i < persisted.length) return persisted[i]!;
        const k = `${jobId}:${i}`;
        if (!seenAt.current.has(k)) seenAt.current.set(k, now);
        return { at: seenAt.current.get(k)!, event };
      }));
    };
    if (job) withLive(job.id, live);
    const others = (memberJobs ?? []).filter((m) => m.job.id !== job?.id);
    for (const m of others) {
      withLive(m.job.id, m.live);
      // A turn with only live events so far has no stamped entry yet: its chip comes from its member (review minor 8).
      if (m.variant && !jobVariant.has(m.job.id)) jobVariant.set(m.job.id, m.variant);
    }
    const runningIds = new Set([...(job && working ? [job.id] : []), ...others.filter((m) => active(m.job)).map((m) => m.job.id)]);
    // Phase 13: a message is "sent" when its `user_message_delivered` marker is in the conversation (persisted or live): it
    // was written to the session. "Delivered" only on the CLI's evidence, the `user_message_read` marker (decision 804: the
    // agent's turn on it started). Still in the queue: "queued".
    const delivered = new Set<string>();
    for (const e of entries) if (e.type === 'agent' && e.event.kind === 'user_message_delivered') delivered.add(e.event.clientId);
    for (const e of live) if (e.kind === 'user_message_delivered') delivered.add(e.clientId);
    const read = new Set<string>();
    for (const e of entries) if (e.type === 'agent' && e.event.kind === 'user_message_read') read.add(e.event.clientId);
    for (const e of live) if (e.kind === 'user_message_read') read.add(e.clientId);
    // Final wave Q7: the core says that no run took the words after all (the console turn ended first). It wins over "Sent".
    const notDelivered = new Set<string>();
    for (const e of entries) if (e.type === 'agent' && e.event.kind === 'user_message_not_delivered') notDelivered.add(e.event.clientId);
    for (const e of live) if (e.kind === 'user_message_not_delivered') notDelivered.add(e.clientId);
    const queuedIds = new Set((queued ?? []).map((q) => q.clientId));
    const known = new Set<string>();
    for (const e of entries) if (e.type === 'user' && e.clientId) known.add(e.clientId);
    const stateOf = (e: Extract<ConversationEntry, { type: 'user' }>): MessageState | undefined => {
      if (!e.clientId || !e.mode) return undefined;
      // Still in the queue wins (final wave P3): a message given to a run that never read it goes back to the queue.
      if (queuedIds.has(e.clientId)) return 'queued';
      if (notDelivered.has(e.clientId)) return 'notDelivered';
      if (read.has(e.clientId)) return 'delivered';
      if (delivered.has(e.clientId) || e.deliveredAt) return 'sent';
      if (e.jobId && e.jobId === job?.id && working) return job?.state === 'queued' && e.mode === 'redirect' ? 'pendingStart' : 'pending';
      return undefined;
    };
    const userItem = (e: Extract<ConversationEntry, { type: 'user' }>, key: string): Item => {
      const state = stateOf(e);
      // Phase 3: a message to the group shows the variants its comments are on.
      const pinned = e.group ? [...new Set(e.pins.map((p) => p.variant).filter((v): v is VariantId => Boolean(v)))].sort(compareVariantIds) : [];
      return { key, kind: 'user', at: e.at, text: e.text, pins: e.pins, ...(state ? { state } : {}), ...(e.mode === 'redirect' ? { redirect: true } : {}), ...(pinned.length ? { variants: pinned } : {}) };
    };
    // User note 7: a message of a job written after that job's first event was sent during the turn. It goes inside the
    // turn, after the job's events written before it (the core writes it in the same ordered chain), not below the turn.
    const inserts = new Map<string, TurnInsert[]>();
    const inside = new Set<number>();
    const counted = new Map<string, number>();
    entries.forEach((e, i) => {
      if (e.type === 'agent') { counted.set(e.jobId, (counted.get(e.jobId) ?? 0) + 1); return; }
      if (e.type !== 'user' || !e.jobId || !e.mode || !counted.has(e.jobId)) return;
      inside.add(i);
      if (!inserts.has(e.jobId)) inserts.set(e.jobId, []);
      inserts.get(e.jobId)!.push({ anchor: counted.get(e.jobId)!, item: userItem(e, `e${i}`) });
    });
    // Messages sent while the agent works that the conversation file does not hold yet: after the events shown when they
    // were sent (remembered at their first render), in the latest job's turn when it is shown, else last.
    const outItems: Item[] = [];
    for (const o of outbox) {
      if (known.has(o.clientId)) continue;
      const item: Item = { key: `out:${o.clientId}`, kind: 'user', at: o.at, text: o.text, pins: o.pins, state: notDelivered.has(o.clientId) ? 'notDelivered' : read.has(o.clientId) ? 'delivered' : delivered.has(o.clientId) ? 'sent' : o.phase, ...(o.mode === 'redirect' ? { redirect: true } : {}) };
      const turnJob = job && jobs.has(job.id) ? job.id : null;
      if (!turnJob) { outItems.push(item); continue; }
      const k = `${turnJob}\0${o.clientId}`;
      if (!outAnchor.current.has(k)) outAnchor.current.set(k, jobs.get(turnJob)!.length);
      if (!inserts.has(turnJob)) inserts.set(turnJob, []);
      inserts.get(turnJob)!.push({ anchor: outAnchor.current.get(k)!, item });
    }
    const approvalsOf = (jobId: string | null) => shownApprovals
      .filter((s) => (jobId === null ? !jobs.has(s.approval.jobId) : s.approval.jobId === jobId))
      .map((s): Item => ({ key: `ap:${s.approval.id}`, kind: 'approval', shown: s }));
    const turn = (jobId: string) => {
      const events = jobs.get(jobId)!;
      const cards = approvalsOf(jobId);
      // A message sent after the turn's last event and after its first open card was shown goes below the cards (review
      // fix): it answers what is on screen. Times compare on one machine (the core's clock, or the page's for the outbox).
      const since = shownApprovals.filter((x) => x.approval.jobId === jobId).map((x) => Date.parse(x.approval.createdAt)).filter(Number.isFinite);
      const cardAt = since.length > 0 ? Math.min(...since) : Infinity;
      const all = inserts.get(jobId) ?? [];
      const below = (x: TurnInsert) => x.anchor >= events.length && 'at' in x.item && Date.parse(x.item.at) >= cardAt;
      const variant = jobVariant.get(jobId);
      const own = turnItems(t.web.liveUi.interruptedRow, jobId, events, runningIds.has(jobId), unfolded.has(jobId), detailsOpen.has(jobId), logOf, all.filter((x) => !below(x)))
        .map((it): Item => (variant && (it.kind === 'agent' || it.kind === 'error' || it.kind === 'question' || it.kind === 'system') ? { ...it, variant } : it));
      return [
        ...own,
        ...cards,
        ...all.filter(below).map((x) => x.item),
      ];
    };

    // C2: a user turn sent again with the same text and comments right after its turn failed (Try again) is a compact
    // "Retried · HH:MM" label, not a second identical bubble. A turn failed when its agent result is an error or the
    // core wrote an error line; a version means it succeeded.
    // Per variant in a group's one chat (decision 980): another variant's failure never makes this one's message a retry.
    const lastUsers = new Map<string, { text: string; pins: Pin[]; failed: boolean }>();
    // The request a fan-out wrote once per variant ("Tutte"): one bubble with every variant's chip.
    let lastBubble: (Extract<Item, { kind: 'user' }> & { variants: VariantId[]; fanout?: string }) | null = null;
    // Phase 5 (decision 983): a group turn's helper entries go under one row per variant, where the first of them came.
    const outcomes = new Map<string, Extract<ConversationEntry, { type: 'group-turn' }>['outcome'][number]>();
    for (const e of entries) if (e.type === 'group-turn') for (const o of e.outcome) outcomes.set(`${e.jobId}\0${o.variant}`, o);
    const helperRows = new Map<string, Extract<Item, { kind: 'helper' }>>();
    const helperJob = (groupJobId: string, variant: VariantId) => (memberJobs ?? []).find((m) => m.job.parentJobId === groupJobId && (m.job.variant ?? m.variant) === variant);
    const rowOf = (groupJobId: string, variant: VariantId): Extract<Item, { kind: 'helper' }> => {
      const k = `${groupJobId}\0${variant}`;
      let row = helperRows.get(k);
      if (!row) {
        const hj = helperJob(groupJobId, variant);
        row = { key: `hp:${k}`, kind: 'helper', variant, groupJobId, open: helpersOpen.has(k), state: hj && active(hj.job) ? { kind: 'working', step: lastStep(hj.live) } : { kind: 'done' }, children: [], cards: [] };
        helperRows.set(k, row);
        out.push(row);
      }
      return row;
    };
    const helperTurn = (row: Extract<Item, { kind: 'helper' }>, jobId: string) => {
      for (const it of turn(jobId)) (it.kind === 'approval' ? row.cards : row.children).push(it);
    };
    entries.forEach((e, i) => {
      if (e.groupJobId && e.variant && e.type !== 'user') {
        const row = rowOf(e.groupJobId, e.variant);
        const key = `e${i}`;
        if (e.type === 'agent') { if (firstIndex.get(e.jobId) === i) helperTurn(row, e.jobId); return; }
        if (e.type === 'version') {
          row.children.push({ key, kind: 'version', at: e.at, n: e.n, complete: e.status === 'complete', variant: e.variant });
          if (row.state.kind !== 'working') row.state = { kind: 'version', n: e.n, complete: e.status === 'complete' };
        } else if (e.type === 'system') {
          row.children.push({ key, kind: 'system', at: e.at, level: e.level, text: e.text, ...(e.origin === 'agent' ? { agent: true } : {}), variant: e.variant });
          if (row.state.kind !== 'working' && typeof e.keptVersion === 'number') row.state = { kind: 'unchanged' };
          else if (row.state.kind !== 'working' && e.level === 'error') row.state = { kind: 'failed' };
        }
        return;
      }
      const lane = e.variant ?? '';
      const lastUser = lastUsers.get(lane) ?? null;
      if (e.type === 'agent') {
        if (lastUser && e.event.kind === 'result' && !e.event.ok && !e.event.interrupted) lastUser.failed = true;
        if (firstIndex.get(e.jobId) === i) { lastBubble = null; out.push(...turn(e.jobId)); }
        return;
      }
      const key = `e${i}`;
      if (e.type === 'user' && inside.has(i)) {
        // Already shown inside its turn.
        lastUsers.set(lane, { text: e.text, pins: e.pins, failed: false });
      } else if (e.type === 'user') {
        const prev: (Extract<Item, { kind: 'user' }> & { variants: VariantId[]; fanout?: string }) | null = lastBubble;
        // Decision 1166: the shares of one request sent to several variants carry its one id.
        if (e.variant && e.fanout && prev && prev.fanout === e.fanout && !prev.variants.includes(e.variant)) {
          prev.variants.push(e.variant);
        } else {
          const retried = lastUser !== null && lastUser.failed && same(lastUser.text, e.text) && samePins(lastUser.pins, e.pins);
          const item = retried ? { key, kind: 'retried' as const, at: e.at } : userItem(e, key);
          out.push(item);
          lastBubble = item.kind === 'user' && e.variant ? { ...item, variants: [e.variant], ...(e.fanout ? { fanout: e.fanout } : {}) } : null;
          if (lastBubble) out[out.length - 1] = lastBubble;
        }
        lastUsers.set(lane, { text: e.text, pins: e.pins, failed: false });
      } else if (e.type === 'version') {
        if (lastUser) lastUser.failed = false;
        out.push({ key, kind: 'version', at: e.at, n: e.n, complete: e.status === 'complete', ...(e.variant ? { variant: e.variant } : {}) });
      } else if (e.type === 'system') {
        if (lastUser && e.level === 'error') lastUser.failed = true;
        out.push({ key, kind: 'system', at: e.at, level: e.level, text: e.text, ...(e.origin === 'agent' ? { agent: true } : {}), ...(e.variant ? { variant: e.variant } : {}) });
      } else if (e.type === 'group-turn') {
        out.push({ key, kind: 'groupTurn', at: e.at, outcome: e.outcome, stopped: e.stopped === true, ...(e.usage ? { usage: e.usage } : {}) });
      }
    });
    // A job with nothing persisted yet (only live events) comes last.
    if (job && jobs.has(job.id) && !firstIndex.has(job.id)) out.push(...turn(job.id));
    for (const m of others) {
      if (!jobs.has(m.job.id) && !(m.job.parentJobId && active(m.job))) continue;
      if (firstIndex.has(m.job.id)) continue;
      // A helper with only live events so far: its row (with its live steps), under its group turn.
      const v = m.job.variant ?? m.variant;
      if (m.job.parentJobId && v) { const row = rowOf(m.job.parentJobId, v); if (jobs.has(m.job.id)) helperTurn(row, m.job.id); continue; }
      out.push(...turn(m.job.id));
    }
    // The group turn's outcome is the final word on each helper's row.
    for (const [k, row] of helperRows) {
      if (row.state.kind === 'working') continue;
      const o = outcomes.get(k);
      if (!o) continue;
      row.state = o.status === 'stopped' ? { kind: 'stopped' } : o.status === 'failed' ? { kind: 'failed' } : o.status === 'unchanged' ? { kind: 'unchanged' }
        : o.version !== null ? { kind: 'version', n: o.version, complete: o.status === 'complete' } : row.state;
    }
    out.push(...approvalsOf(null));
    out.push(...outItems);
    const waiting = shownApprovals.some((s) => !s.leaving && s.approval.jobId === job?.id);
    if (working && !waiting) out.push({ key: 'typing', kind: 'typing' });
    return out;
  }, [entries, job, live, working, unfolded, detailsOpen, helpersOpen, shownApprovals, ctx, outbox, queued, t, memberJobs]);

  // Items present at the first render appear with the panel; later ones enter from +8 px (T9).
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);

  // Follow the end of the conversation while the user is there.
  const listRef = useRef<HTMLOListElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [items.length]);
  // The dock (wait note, queue, composer) floats over the bottom of the list: the list is padded by its live height, so the
  // last message can always scroll above it, and a dock that grows (a longer text, chips) keeps the end in view.
  const convoRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const convo = convoRef.current;
    if (!dock || !convo) return;
    const measure = () => {
      const h = `${dock.offsetHeight}px`;
      if (convo.style.getPropertyValue('--ms-dock-h') === h) return;
      convo.style.setProperty('--ms-dock-h', h);
      const list = listRef.current;
      if (list && atEnd.current) list.scrollTop = list.scrollHeight;
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(dock);
    return () => ro.disconnect();
  }, []);
  const onScroll = () => {
    const el = listRef.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const toggleIn = (set: typeof setUnfolded) => (jobId: string) => set((s) => {
    const n = new Set(s);
    if (n.has(jobId)) n.delete(jobId); else n.add(jobId);
    return n;
  });
  const toggleFold = toggleIn(setUnfolded);
  const toggleDetails = toggleIn(setDetailsOpen);
  const toggleHelper = (key: string) => setHelpersOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  // "Details" on the automatic-approval line: opens that turn's Activity details and moves the focus there.
  const openDetails = (jobId: string) => {
    setDetailsOpen((s) => (s.has(jobId) ? s : new Set(s).add(jobId)));
    requestAnimationFrame(() => {
      const el = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-details]') ?? [])].find((b) => b.dataset.details === jobId);
      el?.focus();
      el?.scrollIntoView?.({ block: 'nearest' });
    });
  };

  const empty = items.length === 0;
  return (
    <div ref={convoRef} className="ms-convo">
      {variants && !single ? <VariantSelector group={variants.group} current={variants.current} all={variants.all} missing={variants.missing ?? []} onSelect={variants.onSelect} /> : null}
      <ol ref={listRef} className="ms-convo-list" role="log" aria-label={c.label} onScroll={onScroll}>
        {empty && <li className="ms-convo-empty"><Empty icon="comment" title={c.emptyTitle} sub={c.emptySub} /></li>}
        {items.map((item) => {
          const view = (it: Item) => <ItemView key={it.key} item={it} formatName={formatName} onToggleFold={toggleFold} onToggleDetails={toggleDetails} onOpenDetails={openDetails} onSelectVersion={onSelectVersion} versionExtra={versionExtra} versionNote={versionNote} versionSummary={versionSummary} onGone={gone} self={self} onOpenVariant={onOpenVariant} usageOf={usageOf} />;
          return (
            <Row key={item.key} animate={mounted.current && item.kind !== 'approval'}>
              {item.kind === 'helper' ? <HelperRow item={item} onToggle={() => toggleHelper(item.key.slice(3))}>{item.children.map(view)}</HelperRow> : view(item)}
              {item.kind === 'helper' ? item.cards.map((c) => <div key={c.key} className="ms-convo-helper-card">{view(c)}</div>) : null}
            </Row>
          );
        })}
      </ol>
      {/* The composer floats over the list (liquid glass): the dock is its live height, which pads the list (--ms-dock-h). */}
      <div ref={dockRef} className="ms-convo-dock">
        {job?.waitReason ? <p className="ms-convo-wait" role="status"><Icon name="clock" size={12} />{t.web.variantGroup.waitReasons[job.waitReason]}</p> : null}
        {/* Always mounted (it renders nothing for an empty queue): an edit the queue overtook is kept even when the queue empties. */}
        <QueuedRequests slug={slug} creative={creative} queued={queued ?? []} working={working} onChanged={() => onQueueChanged?.()} />
        <Composer outbox={outboxApi} onQueueChanged={onQueueChanged} slug={slug} creative={creative} job={working && (single || !variants?.all) ? job : undefined} fanout={variants?.all && !single ? variants.runAll : undefined} latestJobId={job?.id} snapshots={snapshots} pins={pins} onRemovePin={onRemovePin} onEditPin={onEditPin} formatName={formatName} canGenerate={canGenerate} onSent={onSent} beforeSend={beforeSend} appliesTo={single ? undefined : appliesTo} brief={brief} onBriefSaved={onBriefSaved}
          {...(single ? { single: { others: otherPins ?? [], ...(onRemoveOtherPin ? { onRemoveOther: onRemoveOtherPin } : {}) } } : {})} />
      </div>
    </div>
  );
}

/** Phase 5 (decision 983): a helper's row, folded; a click opens its detailed steps below it. */
function HelperRow({ item, onToggle, children }: { item: Extract<Item, { kind: 'helper' }>; onToggle(): void; children: ReactNode }) {
  const h = useT().web.conversation.helperRow;
  const s = item.state;
  const text = s.kind === 'working' ? (s.step ? h.workingStep({ step: s.step }) : h.working)
    : s.kind === 'version' ? (s.complete ? h.ready({ n: s.n }) : h.incomplete({ n: s.n }))
      : s.kind === 'unchanged' ? h.unchanged : s.kind === 'failed' ? h.failed : s.kind === 'stopped' ? h.stopped : h.done;
  return (
    <div className="ms-convo-helper" data-helper={item.variant}>
      <button type="button" className="ms-convo-fold ms-convo-helper-row" aria-expanded={item.open} onClick={onToggle}>
        {s.kind === 'working' ? <Spinner decorative /> : <span className="ms-step-check" aria-hidden="true"><Icon name={s.kind === 'failed' ? 'warn' : 'check'} size={13} strokeWidth={2} /></span>}
        <VariantChips list={[item.variant]} />
        <span className="ms-convo-helper-text" title={text}>{text}</span>
        <Icon name="chevron" size={12} className="ms-chev" />
      </button>
      {item.open ? <div className="ms-convo-helper-steps">{children}</div> : null}
    </div>
  );
}

/** List row; enters from +8 px when it appears after the first render (T9). */
function Row({ animate, children }: { animate: boolean; children: ReactNode }) {
  const ref = useRef<HTMLLIElement>(null);
  const animateOnMount = useRef(animate);
  useLayoutEffect(() => {
    if (animateOnMount.current) void enter(ref.current?.firstElementChild ?? null, { y: 8 });
  }, []);
  return <li ref={ref}>{children}</li>;
}

function When({ at }: { at: string }) {
  const locale = useLocale();
  if (Number.isNaN(new Date(at).getTime())) return null;
  return <time dateTime={at}>{formatDate(locale, at, TIME_OF_DAY)}</time>;
}

const AgentMark = () => (
  <span className="ms-msg-avatar ms-agent" aria-hidden="true">
    <svg width="10" height="10" viewBox="0 0 12 12"><path d="M3 2.5v7l6-3.5-6-3.5Z" fill="currentColor" /></svg>
  </span>
);

function pinText(p: Pin, n: number, formatName: ((id: string) => string) | undefined, t: ReturnType<typeof useT>, locale: ReturnType<typeof useLocale>) {
  const format = formatName?.(p.format) ?? p.format;
  // A comment on a clip or a time range reads `Reel · "Title" clip` / `Reel · 2.0–3.5 s` (Phase 10b); older ones as always.
  const special = clipRangeChip(p, format, t, locale);
  if (special) return special;
  const base = t.web.chat.pin({ n, format });
  if (p.timeSec === null) return base;
  return `${base} ${t.web.conversation.atSeconds({ time: formatNumber(locale, p.timeSec, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}`;
}

/** A comment chip's text: number, format and time, then the comment's own words (ellipsized). */
function PinLabel({ pin, text }: { pin: Pin; text: string }) {
  return (
    <span className="ms-pin-label">
      <span className="ms-pin-ref">{text}</span>
      {pin.note ? <span className="ms-pin-note">{pin.note}</span> : null}
    </span>
  );
}

/** User note 8: a question the agent asked, with the user's answer (plain text: the agent wrote the question). */
function AnsweredQuestion({ at, event, variant }: { at: string; event: Extract<AgentEvent, { kind: 'question_answered' }>; variant?: VariantId }) {
  const t = useT();
  const q = t.web.questionUi;
  const none = event.outcome === 'expired' ? q.expired : event.outcome === 'cancelled' ? q.cancelled : q.skipped;
  return (
    <article className="ms-msg" aria-label={q.historyLabel}>
      <AgentMark />
      <div className="ms-msg-body">
        <span className="ms-msg-meta"><b>{q.historyLabel}</b>·<When at={at} /><VariantChips list={variant ? [variant] : undefined} /></span>
        {/* Only text is rendered (review fix): a stored line with another value (an old `__proto__` answer) shows as unanswered. */}
        {(Array.isArray(event.items) ? event.items : []).map((it, i) => (
          <div key={i} className="ms-question-done">
            {typeof it.header === 'string' && it.header && <Clipped className="ms-question-header" text={it.header} max={QUESTION_DISPLAY.header} />}
            {typeof it.question === 'string' && <Clipped className="ms-question-text" text={it.question} max={QUESTION_DISPLAY.question} />}
            {typeof it.answer === 'string'
              ? <span className="ms-question-answer"><b>{q.yourAnswer}</b><span>{it.answer}</span></span>
              : <span className="ms-approval-note">{none}</span>}
          </div>
        ))}
      </div>
    </article>
  );
}

/** Decision 980: the chips of the variants an entry belongs to (upper case on screen), each named for screen readers. */
function VariantChips({ list }: { list: readonly VariantId[] | undefined }) {
  const vg = useT().web.variantGroup;
  if (!list?.length) return null;
  return <>{list.map((v) => <span key={v} className="ms-vchip" title={vg.letterLabel({ letter: v.toUpperCase() })}>{v.toUpperCase()}</span>)}</>;
}

function ItemView({ item, formatName, onToggleFold, onToggleDetails, onOpenDetails, onSelectVersion, versionExtra, versionNote, versionSummary, onGone, self, onOpenVariant, usageOf }: {
  item: Item; formatName?(id: string): string; onToggleFold(jobId: string): void; onToggleDetails(jobId: string): void; onOpenDetails(jobId: string): void;
  onSelectVersion?(n: number): void; versionExtra?(n: number): ReactNode; versionNote?(n: number): ReactNode; versionSummary?(n: number): string | null; onGone(id: string): void;
  self?: VariantId; onOpenVariant?(variant: VariantId): void; usageOf?(usage: UsageSummary): ReactNode;
}) {
  const t = useT();
  const locale = useLocale();
  const c = t.web.chat;
  switch (item.kind) {
    case 'user':
      return (
        <article className="ms-msg ms-you" aria-label={c.you}>
          <span className="ms-msg-avatar ms-you" aria-hidden="true"><Icon name="user" size={13} /></span>
          <div className="ms-msg-body">
            <span className="ms-msg-meta">
              <b>{c.you}</b>·<When at={item.at} /><VariantChips list={item.variants} />
              {item.redirect && <span className="ms-pill ms-accent">{t.web.liveUi.state.redirect}</span>}
              {item.state && (
                <span className={cx('ms-pill', item.state === 'delivered' ? 'ms-ok' : item.state === 'notDelivered' ? 'ms-warn' : 'ms-neutral')} data-state={item.state}
                  title={item.state === 'sent' ? t.web.liveUi.sentHint : item.state === 'delivered' ? t.web.liveUi.deliveredHint : undefined}>
                  {t.web.liveUi.state[item.state]}
                </span>
              )}
            </span>
            {item.text && <div className="ms-msg-bubble">{item.text}</div>}
            {item.state === 'notDelivered' && <p className="ms-composer-note" role="status">{t.web.liveUi.notDeliveredReason}</p>}
            {item.pins.length > 0 && (
              <div className="ms-msg-pins">{item.pins.map((p, k) => <span key={k} className="ms-chip" title={p.note || undefined}><Icon name="comment" size={11} /><PinLabel pin={p} text={pinText(p, k + 1, formatName, t, locale)} /></span>)}</div>
            )}
          </div>
        </article>
      );
    case 'question':
      return <AnsweredQuestion at={item.at} event={item.event} variant={item.variant} />;
    case 'retried':
      return (
        <div className="ms-convo-retried">
          <Icon name="refresh" size={11} />
          <span>{c.retried({ time: formatDate(locale, item.at, TIME_OF_DAY) })}</span>
        </div>
      );
    case 'agent':
      return (
        <article className={cx('ms-msg', item.summary && 'ms-summary')} aria-label={item.summary ? c.summary : c.agent}>
          <AgentMark />
          <div className="ms-msg-body">
            <span className="ms-msg-meta"><b>{c.agent}</b>·<When at={item.at} /><VariantChips list={item.variant ? [item.variant] : undefined} />{item.summary && <span className="ms-pill ms-ok">{c.summary}</span>}</span>
            <div className="ms-msg-bubble"><Markdown text={item.text} /></div>
          </div>
        </article>
      );
    case 'step':
      return (
        <div className="ms-step">
          <span className="ms-step-check" aria-hidden="true"><Icon name="check" size={13} strokeWidth={2} /></span>
          <span className="ms-step-text">{item.text}</span>
          <When at={item.at} />
        </div>
      );
    case 'fold':
      return (
        <button type="button" className="ms-convo-fold" aria-expanded={item.open} onClick={() => onToggleFold(item.jobId)}>
          <span className="ms-step-check" aria-hidden="true"><Icon name="check" size={13} strokeWidth={2} /></span>
          {c.steps({ count: item.count })}
          <Icon name="chevron" size={12} className="ms-chev" />
        </button>
      );
    case 'error':
      return <p role="alert" className="ms-convo-error"><VariantChips list={item.variant ? [item.variant] : undefined} />{c.failed({ error: item.text })}</p>;
    case 'details':
      return <Details jobId={item.jobId} entries={item.entries} open={item.open} onToggle={() => onToggleDetails(item.jobId)} />;
    case 'autoline':
      return <AutoLine jobId={item.jobId} log={item.log} onOpen={onOpenDetails} />;
    case 'version': {
      // Decision 980: another variant's version is not this page's vN: its card opens that variant instead, with no extras.
      const other = item.variant !== undefined && self !== undefined && item.variant !== self ? item.variant : null;
      const summary = other ? null : versionSummary?.(item.n) ?? null;
      return (
        <div className="ms-convo-version">
          <VariantChips list={item.variant ? [item.variant] : undefined} />
          <span className={cx('ms-pill', item.complete ? 'ms-ok' : 'ms-warn')}>v{item.n} · {item.complete ? t.web.status.ready : t.web.status.incomplete}</span>
          {summary ? <span className="ms-convo-version-summary">{summary}</span> : null}
          <span className="ms-grow" />
          {other ? null : versionExtra?.(item.n) ?? null}
          {other
            ? (onOpenVariant ? <Button size="sm" variant="outline" onClick={() => onOpenVariant(other)}>{t.web.conversation.openVariantVersion({ letter: other.toUpperCase(), n: item.n })}</Button> : null)
            : <Button size="sm" variant="outline" onClick={() => onSelectVersion?.(item.n)}>{t.web.conversation.viewVersion({ n: item.n })}</Button>}
          {other ? null : versionNote?.(item.n) ?? null}
        </div>
      );
    }
    case 'system': {
      const chip = <VariantChips list={item.variant ? [item.variant] : undefined} />;
      if (item.level === 'error') return <p role="alert" className="ms-convo-system ms-error">{chip}{item.text}</p>;
      // Something to know that did not fail the turn (an unlinked follower, earlier outputs that changed): set apart.
      if (item.level === 'warning') return <p className="ms-convo-system ms-warning"><Icon name="warn" size={13} />{chip}<span>{item.text}</span></p>;
      // Decision 917: what the agent did in the app, said apart from the core's own notes.
      if (item.agent) return <p className="ms-convo-system ms-convo-action"><Icon name="sparkle" size={12} />{chip}<span className="ms-convo-action-tag">{t.web.conversation.agentAction}</span><span>{item.text}</span></p>;
      return <p className="ms-convo-system">{chip}{item.text}</p>;
    }
    case 'approval':
      return (
        <div className="ms-convo-approval">
          <ApprovalCard approval={item.shown.approval} leaving={item.shown.leaving} onGone={onGone} />
        </div>
      );
    case 'groupTurn': {
      // Decision 980: the agent's message says which variants it worked on (and what became of each).
      return (
        <div className="ms-convo-groupturn" data-group-turn>
          <Icon name="check" size={12} />
          <span>{groupTurnText(t, item.outcome)}{item.stopped ? ` · ${t.web.conversation.groupTurn.turnStopped}` : ''}</span>
          <span className="ms-grow" />
          {item.usage ? usageOf?.(item.usage) ?? null : null}
        </div>
      );
    }
    case 'typing':
      return (
        <div className="ms-msg ms-convo-typing">
          <AgentMark />
          <div className="ms-msg-bubble"><Typing /></div>
        </div>
      );
  }
}

/**
 * Technical events of one turn (tools, outputs, logs): folded by default, scrolls inside a bounded box. Every command
 * (and automatic Read) is a compact row: its mark, the plain summary and the risk chips; the command opens below.
 */
function Details({ jobId, entries, open, onToggle }: { jobId: string; entries: DetailEntry[]; open: boolean; onToggle(): void }) {
  const t = useT();
  const k = t.web.chat.detailKinds;
  const id = useId();
  const line = (e: AgentEvent): [string, ReactNode, boolean?] => {
    switch (e.kind) {
      case 'session': return [k.session, e.model ? `${e.sessionId} · ${e.model}` : e.sessionId];
      case 'text': return [k.text, e.text];
      case 'tool_use': return [k.tool, <><b>{e.name}</b><pre>{JSON.stringify(e.input, null, 2)}</pre></>];
      case 'tool_result': return [e.isError ? k.error : k.result, <pre>{e.content}</pre>, e.isError];
      case 'rate_limit': return [k.limit, e.status];
      case 'progress': return [k.step, e.text];
      case 'stderr': return [k.log, e.text, true];
      case 'parse_error': return [k.unreadable, e.line, true];
      // `usage` and `approval_decided` are never handed to Details (see TECHNICAL); commands have their own row below.
      // `question_answered` (user note 8) is a conversation row of its own, never a detail line.
      case 'usage': case 'auto_approved': case 'approval_decided': case 'question_answered': return ['', ''];
      // Phase 13 markers: shown by the conversation's own rows (Task 3), never as a detail line.
      case 'user_message_delivered': case 'user_message_not_delivered': case 'user_message_read': case 'interrupted': return ['', ''];
      case 'result': return e.ok ? [k.done, e.text ?? ''] : e.interrupted ? [k.stopped, e.text ?? ''] : [k.failed, e.error ?? '', true];
    }
  };
  return (
    <div className="ms-convo-details">
      <button type="button" className="ms-convo-fold" aria-expanded={open} aria-controls={id} data-details={jobId} onClick={onToggle}>
        <Icon name="terminal" size={12} />{t.web.chat.details({ count: entries.length })}<Icon name="chevron" size={12} className="ms-chev" />
      </button>
      {open && (
        <ul id={id} className="ms-convo-log" tabIndex={0}>
          {entries.map((d) => {
            if ('row' in d) return <CommandRowView key={d.key} row={d.row} />;
            const [kind, value, err] = line(d.event);
            return <li key={d.key}><span className="ms-kind">{kind}</span><span className={cx('ms-val', err && 'ms-err')}>{value}</span></li>;
          })}
        </ul>
      )}
    </div>
  );
}

/** First line of a command, at most 120 characters: the row title when the explanation is missing. */
const firstLine = (s: string) => { const l = s.split('\n', 1)[0] ?? ''; return l.length > 120 ? `${l.slice(0, 119)}\u2026` : l; };

/** End-of-turn line: how many commands ran (and how many you approved); "Details" (described by the line) opens Activity details. */
function AutoLine({ jobId, log, onOpen }: { jobId: string; log: CommandLog; onOpen(jobId: string): void }) {
  const c = useT().web.chat;
  const id = useId();
  return (
    <p className="ms-convo-autoline">
      <span className="ms-step-check" aria-hidden="true"><Icon name={log.sandboxed ? 'shield' : 'terminal'} size={13} /></span>
      <span id={id}>{c.commandsRan({ count: log.ran, approved: log.approved, sandbox: log.sandboxed, attempted: log.attempted })}</span>
      <span aria-hidden="true">·</span>
      <Button size="sm" variant="ghost" aria-describedby={id} onClick={() => onOpen(jobId)}>{c.autoDetails}</Button>
    </p>
  );
}

const MARK_ICON: Record<CommandMark, IconName> = { auto: 'check', approved: 'user', denied: 'close', notRun: 'minus', error: 'warn', interrupted: 'pause' };

/**
 * One command of the log (or an automatic Read): its mark (a check when it ran without asking, "You approved",
 * "Denied", "Didn't run", "Ended with an error", "Interrupted"), the summary phrase and the chips; the command expands below. Also
 * the brand activity rows.
 */
export function CommandRowView({ row }: { row: CommandRow }) {
  const t = useT();
  const c = t.web.chat;
  const [open, setOpen] = useState(false);
  const id = useId();
  // A persisted event may be malformed (older or damaged log): never throw, show the tool and the command instead.
  const view = explanationView(row.explanation, t);
  const full = row.kind === 'read' ? row.file : row.command;
  const mark: CommandMark = row.kind === 'read' ? 'auto' : row.mark;
  const title = row.kind === 'read' ? c.readFile({ file: firstLine(row.file) }) : view?.title || `Bash: ${firstLine(row.command)}`;
  return (
    <li className={cx('ms-convo-auto', row.kind === 'command' && !row.counted && 'ms-convo-auto-off')} data-mark={row.kind === 'read' ? 'read' : row.mark}>
      <button type="button" className="ms-convo-auto-row" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span className="ms-step-check" aria-hidden="true"><Icon name={row.kind === 'read' ? 'eye' : MARK_ICON[mark]} size={13} strokeWidth={2} /></span>
        <span className="ms-convo-auto-text">{title}</span>
        {mark !== 'auto' ? <span className="ms-convo-mark">{c.commandMarks[mark]}</span> : null}
        {view && row.explanation ? <RiskChips explanation={row.explanation} /> : null}
        <Icon name="chevron" size={12} className="ms-chev" />
      </button>
      {open && <pre id={id} tabIndex={0} aria-label={t.web.approvalUi.fullCommand}>{full}</pre>}
    </li>
  );
}

/** Coded refusals of a turn that have their own message (versionErrorText); any other keeps the generic handling. */
const SEND_CODES = new Set(['formats-not-in-brief', 'job-running']);

/** Longest wait for the job a send started before the composer unlocks anyway. */
export const AWAIT_JOB_MS = 10_000;

function Composer({ outbox, onQueueChanged, slug, creative, job, fanout, latestJobId, snapshots, pins: ownPins, onRemovePin, onEditPin, formatName, canGenerate, onSent, beforeSend, appliesTo, brief, onBriefSaved, single }: {
  outbox: OutboxApi; onQueueChanged?(): void;
  /** Phase 3 of the single agent: the composer is the group's; `others`: the other variants' pending comments, sent too. */
  single?: { others: Pin[]; onRemoveOther?(p: Pin): void };
  slug: string; creative: string; job: JobSummary | undefined; /** Phase 15 "Tutte": sends to every active variant instead of this creative. */ fanout?: ConversationVariants['runAll']; latestJobId: string | undefined; snapshots: number | undefined; pins: Pin[]; onRemovePin?(i: number): void; onEditPin?(i: number): void; formatName?(id: string): string; canGenerate?: boolean; onSent?(sent: { pins: Pin[] }): void; beforeSend?(): boolean | Promise<boolean>;
  appliesTo?: AppliesTo; brief?: Brief; onBriefSaved?(): void;
}) {
  const t = useT();
  const locale = useLocale();
  const c = t.web.chat;
  const u = t.web.liveUi;
  const id = useId();
  // Phase 3: with one agent, every variant's pending comments go with the group's message (this page's first).
  const others = single?.others ?? [];
  const pins = useMemo(() => (others.length ? [...ownPins, ...others] : ownPins), [ownPins, others]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Synchronous guard: two keystrokes in the same tick both see `sending` false.
  const inFlight = useRef(false);
  // Id of the job a successful send started, until that job reaches this panel: no second send in between.
  const [awaiting, setAwaiting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stopAwaiting = () => { setAwaiting(null); inFlight.current = false; };
  useEffect(() => {
    if (awaiting && latestJobId === awaiting) stopAwaiting();
  }, [awaiting, latestJobId]);
  // Never blocked for good: the job message may be lost (socket down, core restarted between the POST and the
  // broadcast). After AWAIT_JOB_MS, or on a new snapshot (the core's full state), the composer unlocks; a second
  // turn sent too early is refused by the core with a 409, which the error message explains.
  useEffect(() => {
    if (!awaiting) return;
    const id = setTimeout(stopAwaiting, AWAIT_JOB_MS);
    return () => clearTimeout(id);
  }, [awaiting]);
  const lastSnapshots = useRef(snapshots);
  useEffect(() => {
    if (snapshots === lastSnapshots.current) return;
    lastSnapshots.current = snapshots;
    stopAwaiting();
  }, [snapshots]);

  // Phase 13: while the agent works the box stays active. What the running Claude Code can do decides the send action;
  // until it is known (or when it cannot be read) both are off: "Queue for after" is always available.
  const working = Boolean(job);
  const [capsNow, setCaps] = useState<{ liveInput: boolean } | null>(null);
  useEffect(() => {
    setCaps(null);
    if (!working) return;
    let alive = true;
    Promise.resolve().then(() => api.getAgentCapabilities())
      .then((k) => { if (alive) setCaps({ liveInput: k?.liveInput === true }); })
      .catch(() => { if (alive) setCaps({ liveInput: false }); /* off: the fallback path */ });
    return () => { alive = false; };
  }, [working]);
  // Pending (null): a neutral state, so the send action does not flip from the fallback to the split button.
  const caps = capsNow ?? { liveInput: false };
  const [redirect, setRedirect] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!working) setRedirect(false); }, [working]);
  useEffect(() => { if (redirect) field.current?.focus(); }, [redirect]);
  // One client id per message: a double click, or a retry of the same words after a failure, is one message.
  const draftId = useRef<{ id: string; kind: string } | null>(null);

  // "Applies to": the user's choice (null: All formats) or, until they choose, the comments' formats (else the fallback).
  const [choice, setChoice] = useState<string[] | null | undefined>(undefined);
  // Residual fix (decisions log 865): in "Tutte" the comments are never sent, so they never make a request on their own: only
  // the text or formats chosen by hand can (else the request would be empty, the first-generation path).
  const handFormats = Array.isArray(choice) && choice.length > 0;
  const hasContent = text.trim().length > 0 || (fanout ? handFormats : pins.length > 0);
  const idleBusy = sending || awaiting !== null;
  const busy = working || idleBusy;
  const canSend = working ? hasContent && !sending && (capsNow !== null || redirect) : !idleBusy && hasContent;
  const primaryIds = appliesTo?.primaries.map((p) => p.id) ?? [];
  const primaryOf = (id: string) => appliesTo?.followerOf(id) ?? id;
  // Phase 15 (final wave M2): the comments are the open variant's own; "Tutte" never sends them, nor the formats they chose.
  const sentPins = fanout ? [] : pins;
  const fromPins = appliesTo ? (sentPins.length ? defaultTargets(sentPins.map((p) => p.format), primaryOf, primaryIds) : appliesTo.fallback?.filter((id) => primaryIds.includes(id)) ?? null) : null;
  // A chosen format that is no longer a primary of the brief (removed, or now linked) is dropped; nothing left: the default.
  const kept = Array.isArray(choice) ? choice.filter((id) => primaryIds.includes(id)) : choice;
  const targets = appliesTo ? (kept === undefined || (Array.isArray(kept) && kept.length === 0) ? (fromPins?.length ? fromPins : null) : kept) : null;
  const primaryKey = primaryIds.join(',');
  useEffect(() => {
    setChoice((ch) => {
      if (!Array.isArray(ch)) return ch;
      const next = ch.filter((id) => primaryKey.split(',').includes(id));
      return next.length === ch.length ? ch : next.length ? next : undefined;
    });
  }, [primaryKey]);
  const toggleTarget = (id: string) => {
    const now = targets ?? [];
    const next = now.includes(id) ? now.filter((x) => x !== id) : primaryIds.filter((x) => x === id || now.includes(x));
    setChoice(next.length === 0 || next.length === primaryIds.length ? null : next);
  };

  /** `first`: the first generation of a never-started group ("Genera"), the only send that may be an empty request. */
  const send = async (body: { text?: string; pins?: Pin[]; formats?: string[] }, first = false) => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setError(null); setNotice(null); setSending(true);
    try {
      if (beforeSend && !(await beforeSend())) { inFlight.current = false; return; }
      if (fanout) {
        // "Tutte": one request for every active variant; the answer says which started, waited or were refused.
        const empty = !body.text && !body.pins?.length && !body.formats?.length;
        // Never a `null` request from the chat (residual fix, decisions log 865): only "Genera" of a never-started group is one.
        if (empty && !first) { inFlight.current = false; return; }
        const r = await fanout(empty ? null : body);
        inFlight.current = false;
        const refused = [...r.skipped.map((l) => l.toUpperCase()), ...Object.entries(r.failed).map(([l, why]) => `${l.toUpperCase()} (${why})`)];
        setText('');
        setChoice(undefined);
        setNotice(`${t.web.variantGroup.sentToAll({ count: Object.keys(r.jobs).length + r.queued.length })}${refused.length ? ` · ${t.web.variantGroup.sentToAllRefused({ list: refused.join(', ') })}` : ''}`);
        onSent?.({ pins: body.pins ?? [] });
        return;
      }
      const started = await api.sendCreativeTurn(slug, creative, body);
      if (started && typeof started.id === 'string' && started.id !== latestJobId) setAwaiting(started.id);
      else inFlight.current = false;
      setText('');
      setChoice(undefined);
      onSent?.({ pins: body.pins ?? [] });
    } catch (e) {
      // The text stays in the box: explain and say what to do; a 409 means a turn is already running.
      // A coded refusal (e.g. `formats-not-in-brief`) has its own clear message; a 409 means a turn is already running.
      if (fanout) { setError(t.web.variantGroup.sendAllFailed({ detail: message(e) })); inFlight.current = false; return; }
      setError(SEND_CODES.has(errorCode(e) ?? '') ? versionErrorText(e, t, { label: '' }) : e instanceof ApiError && e.status === 409 ? c.sendBusy : c.sendFailed({ detail: message(e) }));
      inFlight.current = false;
    } finally { setSending(false); }
  };

  // A message while the agent works: into the turn (`live`), for after it (`queued`) or a redirect (stop the step, then the
  // words). The box keeps its words on any refusal, with the core's translated reason.
  const sendWhileWorking = async (kind: 'live' | 'queued' | 'redirect') => {
    if (!job || !canSend || inFlight.current) return;
    inFlight.current = true;
    setError(null); setNotice(null); setSending(true);
    // A retry of the same words in another mode is another request: it gets its own id.
    if (draftId.current?.kind !== kind) draftId.current = { id: newClientId(), kind };
    const clientId = draftId.current.id;
    const words = text.trim();
    const sentPins = pins;
    if (kind !== 'queued') outbox.add({ clientId, text: words, pins: sentPins, at: new Date().toISOString(), mode: kind === 'redirect' ? 'redirect' : 'live', phase: 'sending' });
    try {
      let outcome: LiveMessageOutcome | RedirectOutcome;
      if (kind === 'redirect') outcome = (await api.redirectJob(job.id, { clientId, text: words, ...(sentPins.length ? { pins: sentPins } : {}) })).outcome;
      else outcome = (await api.postLiveMessage(slug, creative, { clientId, text: words, ...(sentPins.length ? { pins: sentPins } : {}), mode: kind })).outcome;
      if (outcome === 'delivered-pending' || outcome === 'restarted' || outcome === 'interrupted') outbox.phase(clientId, 'pending');
      else if (outcome === 'pending-start') outbox.phase(clientId, 'pendingStart');
      else outbox.drop(clientId); // queued: the queue list shows it (the core writes the "after the agent finished" notice itself)
      if (outcome === 'queued' || outcome === 'queued-unsupported' || outcome === 'restarted' || outcome === 'interrupted') setNotice(u.outcome[outcome]);
      draftId.current = null;
      setText('');
      setRedirect(false);
      onSent?.({ pins: sentPins });
      onQueueChanged?.();
    } catch (e) {
      outbox.drop(clientId);
      // A refusal of the core (a limit, a turn that is over) is already explained, in the user's language; anything else is a failed send.
      const detail = liveErrorText(e, t);
      const refused = e instanceof ApiError && e.status >= 400 && e.status < 500;
      setError(kind === 'redirect' ? u.redirectFailed({ detail }) : refused ? detail : c.sendFailed({ detail }));
    } finally { inFlight.current = false; setSending(false); }
  };
  const mainKind = redirect ? 'redirect' : caps.liveInput ? 'live' : 'queued';
  const submit = () => {
    if (!canSend) return;
    if (working) void sendWhileWorking(mainKind);
    else void send({ text: text.trim(), pins: sentPins, ...(targets ? { formats: targets } : {}) });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The app-wide submit chord: ⌘↵ on macOS, Ctrl+↵ elsewhere (a held key does not send twice).
    if (isSubmitChord(e.nativeEvent) && !e.repeat) { e.preventDefault(); submit(); return; }
    // While the agent works Enter is the primary action (Shift+Enter writes a line). A redirect stops the agent's step, so
    // it takes the button or the chord: Enter writes a line. Esc does nothing here: stopping is always an explicit click.
    if (working && !redirect && e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!e.repeat) submit();
    }
  };

  const keys = isMac() ? '⌘↵' : 'Ctrl+↵';
  const kbd = <kbd className="ms-composer-keys" aria-hidden="true">{keys}</kbd>;
  const placeholderBase = !working ? c.placeholder : redirect ? u.redirectPlaceholder : caps.liveInput ? u.livePlaceholder : u.queuePlaceholder;
  const placeholder = `${placeholderBase} · ${c.sendHint({ keys })}`;
  const hint = !working ? c.sendHint({ keys }) : redirect ? u.redirectHint({ keys }) : caps.liveInput ? u.liveHint : u.queueHint;

  return (
    <form className="ms-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="ms-composer-box">
        {pins.length > 0 && (
          <div className="ms-composer-pins">
            {fanout && !text.trim() ? <span className="ms-composer-pins-note">{t.web.variantGroup.pinsNotSentToAll}</span> : null}
            {pins.map((p, k) => k >= ownPins.length ? (
              <span key={k} className="ms-chip ms-on ms-composer-pin">
                <VariantChips list={p.variant ? [p.variant] : undefined} />
                <Icon name="comment" size={11} /><PinLabel pin={p} text={pinText(p, k + 1, formatName, t, locale)} />
                {single?.onRemoveOther ? <button type="button" className="ms-x" aria-label={t.web.conversation.removeComment({ n: k + 1 })} onClick={() => single.onRemoveOther?.(p)}><Icon name="close" size={10} /></button> : null}
              </span>
            ) : (
              <span key={k} className="ms-chip ms-on ms-composer-pin">
                {single && p.variant ? <VariantChips list={[p.variant]} /> : null}
                {onEditPin ? (
                  <button type="button" className="ms-pin-edit" title={p.note || undefined}
                    aria-label={`${t.web.conversation.editComment({ n: k + 1 })} · ${p.note || pinText(p, k + 1, formatName, t, locale)}`} onClick={() => onEditPin(k)}>
                    <Icon name="comment" size={11} /><PinLabel pin={p} text={pinText(p, k + 1, formatName, t, locale)} />
                  </button>
                ) : <><Icon name="comment" size={11} /><PinLabel pin={p} text={pinText(p, k + 1, formatName, t, locale)} /></>}
                <button type="button" className="ms-x" aria-label={t.web.conversation.removeComment({ n: k + 1 })} onClick={() => onRemovePin?.(k)}><Icon name="close" size={10} /></button>
              </span>
            ))}
          </div>
        )}
        {appliesTo && !working ? (
          <div className="ms-composer-applies" role="group" aria-label={c.appliesTo} title={c.appliesHint}>
            <span className="ms-composer-applies-label" aria-hidden="true">{c.appliesTo}</span>
            <Chip on={targets === null} onClick={() => setChoice(null)}>{c.appliesAll}</Chip>
            {appliesTo.primaries.map((p) => (
              <span key={p.id} className="ms-composer-applies-group">
                <Chip on={targets?.includes(p.id) ?? false} onClick={() => toggleTarget(p.id)}>{p.label}</Chip>
                {p.followers.map((f) => (
                  <Chip key={f} disabled onClick={() => {}} icon="link" title={c.followsBoth({ follower: f, primary: p.label })}>{f}</Chip>
                ))}
              </span>
            ))}
          </div>
        ) : null}
        {appliesTo && targets && !working ? appliesTo.primaries.filter((p) => targets.includes(p.id)).flatMap((p) => p.followers.map((f) => (
          <p key={`${p.id}:${f}`} className="ms-composer-follows"><Icon name="link" size={11} />{c.followsBoth({ follower: f, primary: p.label })}</p>
        ))) : null}
        <label htmlFor={id} className="ms-composer-label">{t.web.conversation.requestChange}</label>
        <Textarea id={id} ref={field} rows={2} maxLength={10_000} value={text} onChange={(e) => { setText(e.target.value); draftId.current = null; setNotice(null); }} onKeyDown={onKeyDown}
          placeholder={placeholder} aria-keyshortcuts={isMac() ? 'Meta+Enter' : 'Control+Enter'} />
        {working && redirect && <p className="ms-composer-note">{u.redirectNote}</p>}
        {working && !redirect && capsNow && !caps.liveInput && <p className="ms-composer-note">{u.queueOnly}</p>}
        {working && !redirect && capsNow && caps.liveInput && <p className="ms-composer-note">{u.liveNote}</p>}
        {single && !working ? <p className="ms-composer-note ms-composer-group">{t.web.variantGroup.singleHint}</p> : null}
        {notice && <p role="status" className="ms-composer-note">{notice}</p>}
        {error && <p role="alert" className="ms-composer-error">{error}</p>}
        <div className="ms-composer-foot">
          {brief ? <ServicesChip slug={slug} creative={creative} brief={brief} busy={busy} onSaved={() => onBriefSaved?.()} /> : null}
          <span className="ms-composer-hint">{hint}</span>
          {job && <StopMenu job={job} onError={setError} onRedirect={() => { setRedirect(true); setError(null); field.current?.focus(); }} />}
          {canGenerate && !job && (
            <Button size="sm" variant="accent" aria-label={t.web.newCreative.generate} disabled={busy} onClick={() => void send({}, true)}>
              <Icon name="sparkle" size={13} />{t.web.newCreative.generate}
            </Button>
          )}
          {!working && (
            <Button type="submit" size="sm" variant="accent" className="ms-composer-send" aria-label={t.web.common.send} disabled={!canSend}>
              <Icon name="send" size={13} strokeWidth={1.6} />{kbd}
            </Button>
          )}
          {working && redirect && (
            <>
              <Tooltip label={u.cancelRedirect} whenHidden=".ms-composer-text"><Button size="sm" variant="ghost" className="ms-composer-act" aria-label={u.cancelRedirect} onClick={() => setRedirect(false)}><Icon name="close" size={12} /><span className="ms-composer-text">{u.cancelRedirect}</span></Button></Tooltip>
              <Tooltip label={u.redirect} whenHidden=".ms-composer-text"><Button type="submit" size="sm" variant="accent" className="ms-composer-act" aria-label={u.redirect} disabled={!canSend}><Icon name="forward" size={13} /><span className="ms-composer-text">{u.redirect}</span></Button></Tooltip>
            </>
          )}
          {working && !redirect && capsNow === null && (
            <Tooltip label={u.send} whenHidden=".ms-composer-text"><Button type="submit" size="sm" variant="accent" className="ms-composer-act" aria-label={u.send} loading disabled><Icon name="send" size={13} strokeWidth={1.6} /><span className="ms-composer-text">{u.send}</span>{kbd}</Button></Tooltip>
          )}
          {working && !redirect && capsNow && !caps.liveInput && (
            <Tooltip label={u.queue} whenHidden=".ms-composer-text"><Button type="submit" size="sm" variant="accent" className="ms-composer-act" aria-label={u.queue} disabled={!canSend}><Icon name="send" size={13} strokeWidth={1.6} /><span className="ms-composer-text">{u.queue}</span>{kbd}</Button></Tooltip>
          )}
          {working && !redirect && capsNow && caps.liveInput && (
            <SplitAction variant="accent" menuLabel={u.sendMore} groupLabel={u.send} disabled={!canSend}
              primary={<Tooltip label={u.send} whenHidden=".ms-composer-text"><Button type="submit" size="sm" variant="accent" className="ms-composer-act" aria-label={u.send} disabled={!canSend}><Icon name="send" size={13} strokeWidth={1.6} /><span className="ms-composer-text">{u.send}</span>{kbd}</Button></Tooltip>}
              items={[{ key: 'queue', label: u.queue, onSelect: () => void sendWhileWorking('queued') }]} />
          )}
        </div>
      </div>
    </form>
  );
}

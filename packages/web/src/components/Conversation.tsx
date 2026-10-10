import type { AgentEvent, ApprovalRequest, ConversationEntry, ExplainContext, JobSummary, Pin } from '@motion-studio/shared';
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, ApiError } from '../api.ts';
import { formatDate, formatNumber, TIME_OF_DAY, useLocale, useT } from '../i18n.tsx';
import { enter, isSubmitChord } from '../motion/index.ts';
import { isMac } from '../platform.ts';
import { Button, Chip, Empty, Icon, Markdown, Textarea, Typing, cx, type IconName } from '../ui/index.ts';
import { defaultTargets } from '../screens/versionModel.ts';
import { errorCode, versionErrorText } from '../screens/versionErrors.ts';
import { message } from '../errors.ts';
import { ApprovalCard } from './ApprovalCard.tsx';
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
  onSelectVersion?(n: number): void;
  /** Extra content of a version card, e.g. its token usage (nothing when it returns null). */
  versionExtra?(n: number): ReactNode;
  /** A note under a version card, e.g. its large-file warnings (nothing when it returns null). */
  versionNote?(n: number): ReactNode;
  /** Socket snapshots received (EventsState.snapshots): a new one is the core's whole state, so stop waiting. */
  snapshots?: number;
  /** The composer's "Applies to" (spec §2.5): absent when there is nothing to choose (one primary, no version yet). */
  appliesTo?: AppliesTo;
}

/** What a change can apply to: the primary formats (with their followers' labels) and how a format maps to its primary. */
export interface AppliesTo {
  primaries: Array<{ id: string; label: string; followers: string[] }>;
  /** The primary a format follows, or null. */
  followerOf(id: string): string | null;
  /** The default when there are no comments (null: "All formats"); e.g. the format view's own format. */
  fallback?: string[] | null;
}

type Item =
  | { key: string; kind: 'user'; at: string; text: string; pins: Pin[] }
  | { key: string; kind: 'agent'; at: string; text: string; summary: boolean }
  | { key: string; kind: 'step'; at: string; text: string }
  | { key: string; kind: 'fold'; jobId: string; count: number; open: boolean }
  | { key: string; kind: 'error'; at: string; text: string }
  | { key: string; kind: 'details'; jobId: string; entries: DetailEntry[]; open: boolean }
  | { key: string; kind: 'autoline'; jobId: string; log: CommandLog }
  | { key: string; kind: 'version'; at: string; n: number; complete: boolean }
  | { key: string; kind: 'system'; at: string; level: 'info' | 'warning' | 'error'; text: string }
  | { key: string; kind: 'approval'; shown: ShownApproval }
  | { key: string; kind: 'typing' }
  | { key: string; kind: 'retried'; at: string };

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

/** One turn (the agent events of one job) as conversation items: messages, compact steps, summary, details. */
function turnItems(jobId: string, events: { at: string; event: AgentEvent }[], running: boolean, foldOpen: boolean, detailsOpen: boolean, logOf: (jobId: string, events: AgentEvent[], finished: boolean) => CommandLog): Item[] {
  const out: Item[] = [];
  const steps: Item[] = [];
  const technical: DetailEntry[] = [];
  // Every command of the turn, with its explanation and whether it ran (see commandLog.ts).
  const log = logOf(jobId, events.map((e) => e.event), !running);
  const rowAt = new Map(log.rows.map((r) => [r.key, r]));
  let lastAgent: Extract<Item, { kind: 'agent' }> | null = null;
  let foldAt = -1;
  events.forEach(({ at, event: e }, i) => {
    const key = `${jobId}:${i}`;
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
    } else if (e.kind === 'progress') {
      const step: Item = { key, kind: 'step', at, text: e.text };
      steps.push(step);
      // A finished turn folds its steps behind one toggle, placed where the first step was.
      if (running) out.push(step);
      else if (foldAt < 0) foldAt = out.length;
    } else if (e.kind === 'result') {
      technical.push({ key, event: e });
      if (!e.ok) out.push({ key, kind: 'error', at, text: e.error ?? '' });
      else if (e.text?.trim()) {
        // The final result usually repeats the last message: mark that one as the summary instead of repeating it.
        const last: Extract<Item, { kind: 'agent' }> | null = lastAgent;
        if (last && same(last.text, e.text)) last.summary = true;
        else out.push({ key, kind: 'agent', at, text: e.text, summary: true });
      }
    }
  });
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
export function Conversation({ slug, creative, entries, approvals, job, live = [], pins = [], onRemovePin, onEditPin, formatName, canGenerate, onSent, onSelectVersion, versionExtra, versionNote, snapshots, appliesTo }: ConversationProps) {
  const t = useT();
  const c = t.web.chat;
  const working = active(job);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [detailsOpen, setDetailsOpen] = useState<ReadonlySet<string>>(new Set());
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
  const items = useMemo(() => {
    const out: Item[] = [];
    const jobs = new Map<string, { at: string; event: AgentEvent }[]>();
    const firstIndex = new Map<string, number>();
    entries.forEach((e, i) => {
      if (e.type !== 'agent') return;
      if (!jobs.has(e.jobId)) { jobs.set(e.jobId, []); firstIndex.set(e.jobId, i); }
      jobs.get(e.jobId)!.push({ at: e.at, event: e.event });
    });
    // The latest job continues with the live events (shown once: see mergeJobEvents).
    if (job && live.length > 0) {
      const persisted = jobs.get(job.id) ?? [];
      const merged = mergeJobEvents(persisted.map((p) => p.event), live);
      const now = new Date().toISOString();
      jobs.set(job.id, merged.map((event, i) => {
        if (i < persisted.length) return persisted[i]!;
        const k = `${job.id}:${i}`;
        if (!seenAt.current.has(k)) seenAt.current.set(k, now);
        return { at: seenAt.current.get(k)!, event };
      }));
    }
    const approvalsOf = (jobId: string | null) => shownApprovals
      .filter((s) => (jobId === null ? !jobs.has(s.approval.jobId) : s.approval.jobId === jobId))
      .map((s): Item => ({ key: `ap:${s.approval.id}`, kind: 'approval', shown: s }));
    const turn = (jobId: string) => [
      ...turnItems(jobId, jobs.get(jobId)!, jobId === job?.id && working, unfolded.has(jobId), detailsOpen.has(jobId), logOf),
      ...approvalsOf(jobId),
    ];

    // C2: a user turn sent again with the same text and comments right after its turn failed (Try again) is a compact
    // "Retried · HH:MM" label, not a second identical bubble. A turn failed when its agent result is an error or the
    // core wrote an error line; a version means it succeeded.
    let lastUser: { text: string; pins: Pin[]; failed: boolean } | null = null;
    entries.forEach((e, i) => {
      if (e.type === 'agent') {
        if (lastUser && e.event.kind === 'result' && !e.event.ok) lastUser.failed = true;
        if (firstIndex.get(e.jobId) === i) out.push(...turn(e.jobId));
        return;
      }
      const key = `e${i}`;
      if (e.type === 'user') {
        const retried = lastUser !== null && lastUser.failed && same(lastUser.text, e.text) && samePins(lastUser.pins, e.pins);
        out.push(retried ? { key, kind: 'retried', at: e.at } : { key, kind: 'user', at: e.at, text: e.text, pins: e.pins });
        lastUser = { text: e.text, pins: e.pins, failed: false };
      } else if (e.type === 'version') {
        if (lastUser) lastUser.failed = false;
        out.push({ key, kind: 'version', at: e.at, n: e.n, complete: e.status === 'complete' });
      } else {
        if (lastUser && e.level === 'error') lastUser.failed = true;
        out.push({ key, kind: 'system', at: e.at, level: e.level, text: e.text });
      }
    });
    // A job with nothing persisted yet (only live events) comes last.
    if (job && jobs.has(job.id) && !firstIndex.has(job.id)) out.push(...turn(job.id));
    out.push(...approvalsOf(null));
    const waiting = shownApprovals.some((s) => !s.leaving && s.approval.jobId === job?.id);
    if (working && !waiting) out.push({ key: 'typing', kind: 'typing' });
    return out;
  }, [entries, job, live, working, unfolded, detailsOpen, shownApprovals, ctx]);

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
    <div className="ms-convo">
      <ol ref={listRef} className="ms-convo-list" role="log" aria-label={c.label} onScroll={onScroll}>
        {empty && <li className="ms-convo-empty"><Empty icon="comment" title={c.emptyTitle} sub={c.emptySub} /></li>}
        {items.map((item) => (
          <Row key={item.key} animate={mounted.current && item.kind !== 'approval'}>
            <ItemView item={item} formatName={formatName} onToggleFold={toggleFold} onToggleDetails={toggleDetails} onOpenDetails={openDetails} onSelectVersion={onSelectVersion} versionExtra={versionExtra} versionNote={versionNote} onGone={gone} />
          </Row>
        ))}
      </ol>
      <Composer slug={slug} creative={creative} job={working ? job : undefined} latestJobId={job?.id} snapshots={snapshots} pins={pins} onRemovePin={onRemovePin} onEditPin={onEditPin} formatName={formatName} canGenerate={canGenerate} onSent={onSent} appliesTo={appliesTo} />
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
  const base = t.web.chat.pin({ n, format: formatName?.(p.format) ?? p.format });
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

function ItemView({ item, formatName, onToggleFold, onToggleDetails, onOpenDetails, onSelectVersion, versionExtra, versionNote, onGone }: {
  item: Item; formatName?(id: string): string; onToggleFold(jobId: string): void; onToggleDetails(jobId: string): void; onOpenDetails(jobId: string): void;
  onSelectVersion?(n: number): void; versionExtra?(n: number): ReactNode; versionNote?(n: number): ReactNode; onGone(id: string): void;
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
            <span className="ms-msg-meta"><b>{c.you}</b>·<When at={item.at} /></span>
            {item.text && <div className="ms-msg-bubble">{item.text}</div>}
            {item.pins.length > 0 && (
              <div className="ms-msg-pins">{item.pins.map((p, k) => <span key={k} className="ms-chip" title={p.note || undefined}><Icon name="comment" size={11} /><PinLabel pin={p} text={pinText(p, k + 1, formatName, t, locale)} /></span>)}</div>
            )}
          </div>
        </article>
      );
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
            <span className="ms-msg-meta"><b>{c.agent}</b>·<When at={item.at} />{item.summary && <span className="ms-pill ms-ok">{c.summary}</span>}</span>
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
      return <p role="alert" className="ms-convo-error">{c.failed({ error: item.text })}</p>;
    case 'details':
      return <Details jobId={item.jobId} entries={item.entries} open={item.open} onToggle={() => onToggleDetails(item.jobId)} />;
    case 'autoline':
      return <AutoLine jobId={item.jobId} log={item.log} onOpen={onOpenDetails} />;
    case 'version':
      return (
        <div className="ms-convo-version">
          <span className={cx('ms-pill', item.complete ? 'ms-ok' : 'ms-warn')}>v{item.n} · {item.complete ? t.web.status.ready : t.web.status.incomplete}</span>
          <span className="ms-grow" />
          {versionExtra?.(item.n) ?? null}
          <Button size="sm" variant="outline" onClick={() => onSelectVersion?.(item.n)}>{t.web.conversation.viewVersion({ n: item.n })}</Button>
          {versionNote?.(item.n) ?? null}
        </div>
      );
    case 'system':
      if (item.level === 'error') return <p role="alert" className="ms-convo-system ms-error">{item.text}</p>;
      // Something to know that did not fail the turn (an unlinked follower, earlier outputs that changed): set apart.
      if (item.level === 'warning') return <p className="ms-convo-system ms-warning"><Icon name="warn" size={13} /><span>{item.text}</span></p>;
      return <p className="ms-convo-system">{item.text}</p>;
    case 'approval':
      return (
        <div className="ms-convo-approval">
          <ApprovalCard approval={item.shown.approval} leaving={item.shown.leaving} onGone={onGone} />
        </div>
      );
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
      case 'usage': case 'auto_approved': case 'approval_decided': return ['', ''];
      case 'result': return e.ok ? [k.done, e.text ?? ''] : [k.failed, e.error ?? '', true];
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

/** Longest wait for the job a send started before the composer unlocks anyway. */
export const AWAIT_JOB_MS = 10_000;

function Composer({ slug, creative, job, latestJobId, snapshots, pins, onRemovePin, onEditPin, formatName, canGenerate, onSent, appliesTo }: {
  slug: string; creative: string; job: JobSummary | undefined; latestJobId: string | undefined; snapshots: number | undefined; pins: Pin[]; onRemovePin?(i: number): void; onEditPin?(i: number): void; formatName?(id: string): string; canGenerate?: boolean; onSent?(sent: { pins: Pin[] }): void;
  appliesTo?: AppliesTo;
}) {
  const t = useT();
  const locale = useLocale();
  const c = t.web.chat;
  const id = useId();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Synchronous guard: two keystrokes in the same tick both see `sending` false.
  const inFlight = useRef(false);
  // Id of the job a successful send started, until that job reaches this panel: no second send in between.
  const [awaiting, setAwaiting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const busy = Boolean(job) || sending || awaiting !== null;
  const canSend = !busy && (text.trim().length > 0 || pins.length > 0);

  // "Applies to": the user's choice (null: All formats) or, until they choose, the comments' formats (else the fallback).
  const [choice, setChoice] = useState<string[] | null | undefined>(undefined);
  const primaryIds = appliesTo?.primaries.map((p) => p.id) ?? [];
  const primaryOf = (id: string) => appliesTo?.followerOf(id) ?? id;
  const fromPins = appliesTo ? (pins.length ? defaultTargets(pins.map((p) => p.format), primaryOf, primaryIds) : appliesTo.fallback?.filter((id) => primaryIds.includes(id)) ?? null) : null;
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

  const send = async (body: { text?: string; pins?: Pin[]; formats?: string[] }) => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setError(null); setSending(true);
    try {
      const started = await api.sendCreativeTurn(slug, creative, body);
      if (started && typeof started.id === 'string' && started.id !== latestJobId) setAwaiting(started.id);
      else inFlight.current = false;
      setText('');
      setChoice(undefined);
      onSent?.({ pins: body.pins ?? [] });
    } catch (e) {
      // The text stays in the box: explain and say what to do; a 409 means a turn is already running.
      // A coded refusal (e.g. `formats-not-in-brief`) has its own clear message; a 409 means a turn is already running.
      setError(errorCode(e) ? versionErrorText(e, t, { label: '' }) : e instanceof ApiError && e.status === 409 ? c.sendBusy : c.sendFailed({ detail: message(e) }));
      inFlight.current = false;
    } finally { setSending(false); }
  };
  const submit = () => { if (canSend) void send({ text: text.trim(), pins, ...(targets ? { formats: targets } : {}) }); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The app-wide submit chord: ⌘↵ on macOS, Ctrl+↵ elsewhere (a held key does not send twice).
    if (isSubmitChord(e.nativeEvent) && !e.repeat) { e.preventDefault(); submit(); }
  };
  const cancel = () => { if (job) api.cancelJob(job.id).catch(() => setError(c.cancelFailed)); };

  return (
    <form className="ms-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="ms-composer-box">
        {pins.length > 0 && (
          <div className="ms-composer-pins">
            {pins.map((p, k) => (
              <span key={k} className="ms-chip ms-on ms-composer-pin">
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
        {appliesTo ? (
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
        {appliesTo && targets ? appliesTo.primaries.filter((p) => targets.includes(p.id)).flatMap((p) => p.followers.map((f) => (
          <p key={`${p.id}:${f}`} className="ms-composer-follows"><Icon name="link" size={11} />{c.followsBoth({ follower: f, primary: p.label })}</p>
        ))) : null}
        <label htmlFor={id} className="ms-composer-label">{t.web.conversation.requestChange}</label>
        <Textarea id={id} rows={2} maxLength={10_000} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
          placeholder={job ? c.busyPlaceholder : c.placeholder} aria-keyshortcuts={isMac() ? 'Meta+Enter' : 'Control+Enter'} />
        {error && <p role="alert" className="ms-composer-error">{error}</p>}
        <div className="ms-composer-foot">
          {job
            ? <span className="ms-composer-hint">{c.working}</span>
            : <span className="ms-composer-hint">{c.sendHint({ keys: isMac() ? '⌘↵' : 'Ctrl ↵' })}</span>}
          {job && <Button size="sm" variant="ghost" onClick={cancel}>{t.common.cancel}</Button>}
          {canGenerate && !job && (
            <Button size="sm" variant="accent" aria-label={t.web.newCreative.generate} disabled={busy} onClick={() => void send({})}>
              <Icon name="sparkle" size={13} />{t.web.newCreative.generate}
            </Button>
          )}
          <Button type="submit" size="sm" variant="accent" icon className="ms-composer-send" aria-label={t.web.common.send} disabled={!canSend}>
            <Icon name="upload" size={13} strokeWidth={1.8} />
          </Button>
        </div>
      </div>
    </form>
  );
}

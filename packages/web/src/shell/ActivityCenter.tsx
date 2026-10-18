import { DEFAULT_FORMATS, SUPPORTED_LOCALES, turnEndOf, type AgentEvent, type ApprovalRequest, type ConversationEntry, type JobSummary } from '@motion-studio/shared';
import { instanceName, presetFor } from '../instances.ts';
import { localeName } from '../screens/creative/languagesModel.ts';
import { useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import { ConsoleMessageBox } from '../components/ConsoleMessageBox.tsx';
import { StopMenu } from '../components/StopMenu.tsx';
import { useApprovalPresence } from '../components/approvalPresence.ts';
import type { EventsState } from '../eventsReducer.ts';
import { formatDate, formatNumber, TIME_OF_DAY, useLocale, useT } from '../i18n.tsx';
import { href } from '../routes.ts';
import { Button, Empty, Icon, Popover, ProgressBar, Spinner, Tabs, cx, toast } from '../ui/index.ts';
import { renderPct } from '../screens/renderModel.ts';
import { stageText } from '../screens/exportModel.ts';
import { message } from '../errors.ts';
import { canAskNotifications } from './notify.ts';
import { go, ShellContext, type ActivityTab } from './ShellContext.tsx';
import { lastStep } from '../jobEvents.ts';
import { jobFinalTokens, jobLiveTokens, jobUsagePartial, todayTokens } from '../usageLive.ts';
import { formatTokens, TokenCount } from './Tokens.tsx';
import { ProblemList } from '../components/ProblemList.tsx';
import { svgRefusalsOf } from '../screens/svgRefusals.ts';
import { jobVariantLetter } from '../screens/variants/variantModel.ts';

/** Results kept in the Done tab (the latest of this session). */
export const DONE_MAX = 20;

const active = (j: JobSummary) => j.state === 'queued' || j.state === 'running';
const finished = (j: JobSummary) => !active(j);
const finishedAt = (j: JobSummary) => j.finishedAt ?? j.startedAt ?? j.createdAt;

export function activityLists(live: EventsState) {
  const jobs = Object.values(live.jobs);
  const approvals = Object.values(live.approvals).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const running = jobs.filter(active).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const done = jobs.filter(finished).sort((a, b) => finishedAt(b).localeCompare(finishedAt(a))).slice(0, DONE_MAX);
  return { approvals, running, done };
}

/**
 * Where a job belongs, from its key. The core's keys are `creative:<root>:<project>:<creative>`,
 * `render:<root>:<project>:<creative>:v<n>` (a follow-up: `…:v<n>:<k>`), `brand:<root>:<project>` (analysis and asset descriptions) and
 * `project:<root>:<project>` and `generate:<id>:<project>` (Assets Generate); the root may contain ':' (Windows), slugs never do.
 * Phase 15: a group's directions turn is `variant-directions:creative:<root>:<project>:<host>`, the host's creative key behind
 * a prefix: it belongs to the host (its link and its variant tag).
 */
export function jobPlace(job: JobSummary): { project: string; creative: string | null } | null {
  if (job.key.startsWith('variant-directions:')) return jobPlace({ ...job, key: job.key.slice('variant-directions:'.length) });
  const parts = job.key.split(':');
  const kind = parts[0];
  if (kind === 'creative' && parts.length >= 4) return { project: parts.at(-2)!, creative: parts.at(-1)! };
  // Decision 974: an export `export:<root>:<project>:<creative>:<id>`, a render for one export `render-export:…:v<n>:<id>`.
  if (kind === 'export' && parts.length >= 5) return { project: parts.at(-3)!, creative: parts.at(-2)! };
  if (kind === 'render-export' && parts.length >= 6) return { project: parts.at(-4)!, creative: parts.at(-3)! };
  if (kind === 'render' && parts.length >= 5) {
    // A follow-up job of a version (`…:v<n>:<k>`, core I3) has one more part.
    const end = /^\d+$/.test(parts.at(-1)!) && /^v\d+$/.test(parts.at(-2)!) ? -1 : 0;
    return { project: parts.at(-3 + end)!, creative: parts.at(-2 + end)! };
  }
  if ((kind === 'brand' || kind === 'project' || kind === 'generate') && parts.length >= 3) return { project: parts.at(-1)!, creative: null };
  return null;
}

/** The page a job's row opens: its creative, the brand (analysis), the assets (descriptions) or the project. */
export function jobHref(job: JobSummary): string | null {
  const at = jobPlace(job);
  if (!at || !at.project) return null;
  if (at.creative) return href.creative(at.project, at.creative);
  if (job.kind === 'brand-analysis') return href.project(at.project, 'brand');
  if (job.kind === 'asset-description' || job.kind === 'asset-generation') return href.project(at.project, 'assets');
  return href.project(at.project);
}

/** A saved version, or (decision 1066) the latest version a turn kept because nothing changed. */
type Made = { n: number; status: 'complete' | 'incomplete' } | { n: number; kept: true };

/**
 * The version each job of a creative produced: agent entries carry the job id, the version entry follows them. In a variant
 * group's one chat (decision 980) the turns of several variants interleave: each variant's entries are followed apart.
 */
export function versionsByJob(entries: ConversationEntry[]): Record<string, Made> {
  const out: Record<string, Made> = {};
  const lastOf = new Map<string, string | null>();
  for (const e of entries) {
    const lane = e.variant ?? '';
    const last = lastOf.get(lane) ?? null;
    if (e.type === 'agent') lastOf.set(lane, e.jobId);
    else if (e.type === 'user') lastOf.set(lane, null);
    else if (last && !out[last]) {
      const end = turnEndOf(e);
      if (end) out[last] = end.kept || end.status === null ? { n: end.n, kept: true } : { n: end.n, status: end.status };
    }
  }
  return out;
}

/**
 * Versions made by the finished generations in `jobs`, read from their creatives' conversations (one read per
 * creative) while `enabled`. Jobs whose version is not found simply have none: nothing is guessed.
 */
function useMadeVersions(jobs: JobSummary[], enabled: boolean): Record<string, Made> {
  const [made, setMade] = useState<Record<string, Made>>({});
  const wanted = jobs.filter((j) => j.kind === 'creative' && j.state === 'succeeded' && !made[j.id]);
  const creatives = [...new Set(wanted.map((j) => { const at = jobPlace(j); return at?.creative ? `${at.project}\n${at.creative}` : null; }).filter((x): x is string => x !== null))];
  const key = enabled ? `${creatives.join('|')}#${wanted.map((j) => j.id).join(',')}` : '';
  useEffect(() => {
    if (!key) return;
    let alive = true;
    for (const c of creatives) {
      const [project, creative] = c.split('\n') as [string, string];
      Promise.resolve().then(() => api.getConversation(project, creative))
        .then((entries) => { if (alive) setMade((m) => ({ ...m, ...versionsByJob(entries) })); })
        .catch(() => { /* the row keeps its plain state */ });
    }
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return made;
}

/** The error a failed job reported: its summary's, else the agent's result event. */
function failureOf(job: JobSummary, events: AgentEvent[] | undefined): string | null {
  if (job.error) return job.error;
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const e = events![i]!;
    if (e.kind === 'result' && !e.ok && e.error?.trim()) return e.error.trim();
  }
  return null;
}

/**
 * Activity center (spec §6.2 point 15): popover body with Needs you (full approval cards), Running (active jobs with
 * their latest step) and Done (latest results of the session), all derived from the live event state.
 */
export function ActivityCenter({ live, initialTab, request = 0, where }: { live: EventsState; initialTab: ActivityTab | null; /** Changes with each request to show `initialTab`, also while open. */ request?: number; where(project: string, creative: string | null): string }) {
  const t = useT();
  const a = t.web.shell.activity;
  const { approvals, running, done } = useMemo(() => activityLists(live), [live]);
  const [tab, setTab] = useState<ActivityTab>(initialTab ?? (approvals.length ? 'needs' : 'running'));
  // Resolved requests collapse out of "Needs you" (T15) while it is shown; on another tab they are dropped at once.
  const needs = useApprovalPresence(approvals, tab === 'needs');
  const pending = needs.list.filter((s) => !s.leaving).length;
  const [, rerender] = useState(0);
  // A request to show a tab while the center is already open (e.g. "N running" or Review) switches to it.
  const lastRequest = useRef(request);
  useEffect(() => {
    if (request === lastRequest.current) return;
    lastRequest.current = request;
    if (initialTab) setTab(initialTab);
  }, [request, initialTab]);
  const made = useMadeVersions(done, tab === 'done');
  const panel = `${useId()}-panel`;
  const askNotifications = () => {
    const done = () => rerender((n) => n + 1);
    // Older Safari only has the callback form (it returns undefined): pass the callback and wrap the result.
    void Promise.resolve(Notification.requestPermission(done)).then(done, () => {});
  };

  return (
    <div className="ms-activity" aria-label={a.label} role="region">
      <div className="ms-activity-head">
        <Tabs
          label={a.sections}
          variant="bar"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'needs', label: a.needsYou, count: pending, controls: panel },
            { value: 'running', label: a.running, count: running.length, controls: panel },
            { value: 'done', label: a.done, count: done.length, controls: panel },
          ]}
        />
      </div>
      <div id={panel} role="tabpanel" tabIndex={-1} className="ms-activity-body">
        {tab === 'needs' && canAskNotifications() && (
          <Button size="sm" variant="outline" className="ms-activity-ask" onClick={askNotifications}>
            <Icon name="bell" size={13} />{a.enableNotifications}
          </Button>
        )}
        {tab === 'needs' && (needs.list.length
          ? needs.list.map(({ approval: ap, leaving }) => <NeedsYou key={ap.id} approval={ap} leaving={leaving} onGone={needs.gone} where={where} />)
          : <Empty icon="check" title={a.emptyNeeds} sub={a.emptyNeedsSub} />)}
        {tab === 'running' && (running.length ? (
          <ul className="ms-activity-list">
            {running.map((j) => (j.kind === 'render'
              ? <RenderRow key={j.id} job={j} />
              : j.kind === 'export' ? <ExportRow key={j.id} job={j} />
              : <RunningRow key={j.id} job={j} step={lastStep(live.events[j.id])} tokens={jobLiveTokens(live, j.id)} partial={jobUsagePartial(live, j.id)} events={live.events[j.id]} />))}
          </ul>
        ) : <Empty icon="clock" title={a.emptyRunning} sub={a.emptyRunningSub} />)}
        {tab === 'done' && (done.length ? (
          <ul className="ms-activity-list">
            {done.map((j) => <DoneRow key={j.id} job={j} made={made[j.id] ?? null} failure={j.state === 'failed' ? failureOf(j, live.events[j.id]) : null} tokens={jobFinalTokens(live, j.id)} partial={jobUsagePartial(live, j.id)} />)}
          </ul>
        ) : <Empty icon="check" title={a.emptyDone} sub={a.emptyDoneSub} />)}
      </div>
      <TodayFooter tokens={todayTokens(live)} />
    </div>
  );
}

function NeedsYou({ approval, leaving, onGone, where }: { approval: ApprovalRequest; leaving: boolean; onGone(id: string): void; where(project: string, creative: string | null): string }) {
  const t = useT();
  const target = approval.creativeSlug ? href.creative(approval.projectSlug, approval.creativeSlug) : href.project(approval.projectSlug);
  return (
    <div className="ms-activity-need">
      <div className="ms-activity-context" hidden={leaving}>
        <span className="ms-activity-where">{where(approval.projectSlug, approval.creativeSlug)}</span>
        <Button size="sm" variant="ghost" onClick={() => go(target)}>{t.web.shell.activity.open}<Icon name="forward" size={12} /></Button>
      </div>
      <ApprovalCard approval={approval} leaving={leaving} onGone={onGone} />
    </div>
  );
}

/** A row of the Running or Done list: a link to where the job belongs, when its key tells; `after` sits beside the link. */
function Row({ job, className, children, after }: { job: JobSummary; className?: string; children: ReactNode; after?: ReactNode }) {
  const to = jobHref(job);
  return (
    <li className={cx('ms-activity-item', after !== undefined && 'ms-activity-with-after')}>
      {to ? <a className={cx('ms-activity-row ms-activity-link', className)} href={to}>{children}</a> : <div className={cx('ms-activity-row', className)}>{children}</div>}
      {after}
    </li>
  );
}

/** A format's name for a progress line (the built-in catalog; a custom preset shows its id). */
function useFormatLabel(job: JobSummary) {
  const locale = useLocale();
  const shell = useContext(ShellContext);
  // The creative's labels of format instances, from the catalog of the projects visited (absent: "Name #k").
  const at = jobPlace(job);
  const labels = at?.creative ? shell?.catalog.creatives[at.project]?.find((c) => c.slug === at.creative)?.formatLabels : undefined;
  const name = (id: string) => instanceName(presetFor(DEFAULT_FORMATS, id), id, locale, labels);
  // A localized render's format is `<instance>.<language tag>` (Phase 12): the instance's name and the language's.
  return (id: string) => {
    const dot = id.lastIndexOf('.');
    const tag = dot > 0 ? id.slice(dot + 1) : '';
    return SUPPORTED_LOCALES.some((l) => l.tag === tag) ? `${name(id.slice(0, dot))} (${localeName(tag, locale)})` : name(id);
  };
}

/**
 * The render lane (carry 10): a queued render says how many renders are ahead of it ("Queued · 2 renders ahead"); a running
 * one its format and frames done out of the total, with a bar; both can be cancelled (the core kills the browser and ffmpeg
 * groups and removes the temp files).
 */
function RenderRow({ job }: { job: JobSummary }) {
  const t = useT();
  const r = t.web.render;
  const locale = useLocale();
  const label = useFormatLabel(job);
  const queued = job.state === 'queued';
  const p = job.progress;
  const sub = queued ? (job.queuePosition ? r.queuedAhead({ count: job.queuePosition }) : r.queued)
    : !p ? r.starting
      : p.phase === 'media' ? r.mediaProgress({ format: label(p.format), done: p.done, total: p.total })
        : p.phase === 'finishing' ? r.finishing({ format: label(p.format) })
          : r.framesProgress({ format: label(p.format), done: formatNumber(locale, p.done), total: formatNumber(locale, p.total) });
  const [cancelling, setCancelling] = useState(false);
  const cancel = () => {
    setCancelling(true);
    Promise.resolve().then(() => api.cancelJob(job.id))
      .catch((e: unknown) => { setCancelling(false); toast.show(r.cancelFailed({ detail: message(e) })); });
  };
  return (
    <Row job={job} className="ms-tall" after={(
      <Button size="sm" variant="ghost" className="ms-activity-cancel" loading={cancelling} disabled={cancelling} aria-label={r.cancelRender({ label: job.label })} onClick={cancel}>
        {r.cancel}
      </Button>
    )}>
      <span className={cx('ms-activity-glyph', queued && 'ms-muted')}>{queued ? <Icon name="clock" size={14} /> : <Spinner decorative />}</span>
      <span className="ms-activity-text">
        <b>{job.label}</b>
        <span className="ms-activity-sub">{sub}</span>
        {!queued && p?.phase === 'frames' ? <ProgressBar className="ms-activity-bar" value={renderPct(job, p.format)} label={sub} /> : null}
      </span>
    </Row>
  );
}

/**
 * An export in the background (decision 974, user report 20): its renders' progress (a bar), then the copy; cancelling it
 * stops the export and the renders it started.
 */
function ExportRow({ job }: { job: JobSummary }) {
  const t = useT();
  const x = t.web.exportUi;
  const queued = job.state === 'queued';
  const sub = queued ? t.web.shell.activity.queued : stageText(job, x);
  const pct = job.export?.stage === 'rendering' && job.export.renders?.length ? job.export.pct : null;
  const [cancelling, setCancelling] = useState(false);
  const cancel = () => {
    setCancelling(true);
    Promise.resolve().then(() => api.cancelJob(job.id))
      .catch((e: unknown) => { setCancelling(false); toast.show(t.web.render.cancelFailed({ detail: message(e) })); });
  };
  return (
    <Row job={job} className="ms-tall" after={(
      <Button size="sm" variant="ghost" className="ms-activity-cancel" loading={cancelling} disabled={cancelling} aria-label={x.cancelOf({ label: job.label })} onClick={cancel}>
        {t.web.render.cancel}
      </Button>
    )}>
      <span className={cx('ms-activity-glyph', queued && 'ms-muted')}>{queued ? <Icon name="clock" size={14} /> : <Spinner decorative />}</span>
      <span className="ms-activity-text">
        <b>{job.label}</b>
        <span className="ms-activity-sub">{sub}</span>
        {pct !== null && pct !== undefined ? <ProgressBar className="ms-activity-bar" value={pct} label={sub} /> : null}
      </span>
    </Row>
  );
}

/** "Today · 38.2k tokens" and the Usage link (prototype footer); says so while the day total is not known. */
function TodayFooter({ tokens }: { tokens: number | null }) {
  const t = useT();
  const u = t.web.usage;
  const locale = useLocale();
  return (
    <div className="ms-activity-foot">
      <span className="ms-activity-today">{tokens === null ? u.todayUnknown : u.today({ count: formatTokens(locale, tokens) })}</span>
      <a className="ms-activity-usage" href={href.settings('usage')}>{u.open}</a>
    </div>
  );
}

/** Phase 15: " · B" after a variant's job (a sister from its slug; the host's "A" when its creative lists a group); empty otherwise. */
function useVariantTag(job: JobSummary): string {
  const shell = useContext(ShellContext);
  if (job.kind !== 'creative') return '';
  const at = jobPlace(job);
  const letter = at?.creative ? jobVariantLetter(at.creative, shell?.catalog.creatives[at.project]) : null;
  return letter ? ` · ${letter.toUpperCase()}` : '';
}

function RunningRow({ job, step, tokens, partial, events }: { job: JobSummary; step: string | null; tokens: number | null; partial: boolean; events?: AgentEvent[] }) {
  const t = useT();
  const tag = useVariantTag(job);
  const queued = job.state === 'queued';
  return (
    // Phase 13: the same Stop menu as the conversation (a creative or console turn can also be redirected; the others have Stop only).
    <Row job={job} className="ms-tall" after={(
      <>
        {job.kind === 'console' && job.state === 'running' ? <ConsoleMessage job={job} events={events} /> : null}
        <StopMenu job={job} className="ms-activity-cancel" />
      </>
    )}>
      <span className={cx('ms-activity-glyph', queued && 'ms-muted')}>{queued ? <Icon name="clock" size={14} /> : <Spinner decorative />}</span>
      <span className="ms-activity-text">
        <b>{job.label}{tag}</b>
        <span className="ms-activity-sub">{queued ? (job.waitReason ? t.web.variantGroup.waitReasons[job.waitReason] : t.web.shell.activity.queued) : step ?? t.web.jobState.running}</span>
      </span>
      <TokenCount tokens={tokens} live partial={partial} className="ms-activity-tokens" />
    </Row>
  );
}

/**
 * A message to a running console turn (Phase 13, spec §2), from its row: a button that opens the message box in a popover.
 * The console has no queue, so with live input off the box only explains that.
 */
function ConsoleMessage({ job, events }: { job: JobSummary; events?: AgentEvent[] }) {
  const u = useT().web.liveUi;
  const [open, setOpen] = useState(false);
  // null = the capabilities are being asked (neutral state); it is reset on every open so the previous value is never shown.
  const [liveInput, setLiveInput] = useState<boolean | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement | null>(null);
  const openNow = useRef(false);
  openNow.current = open;
  useEffect(() => {
    if (!open) return;
    setLiveInput(null);
    panel.current = anchor.current?.closest<HTMLElement>('[role="tabpanel"]') ?? null;
    let alive = true;
    Promise.resolve().then(() => api.getAgentCapabilities())
      .then((k) => { if (alive) setLiveInput(k?.liveInput === true); })
      .catch(() => { if (alive) setLiveInput(false); });
    return () => { alive = false; };
  }, [open]);
  // The job ended while the popover was open: the row (and the popover with it) goes away. Focus moves to the list panel
  // instead of falling to the page body.
  useEffect(() => () => {
    if (!openNow.current) return;
    const a = document.activeElement;
    if (!a || a === document.body) panel.current?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <Button ref={anchor} size="sm" variant="ghost" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{u.consoleOpen}</Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-end" width={320} label={u.consoleMessage}>
        <ConsoleMessageBox jobId={job.id} liveInput={liveInput} events={events} />
      </Popover>
    </>
  );
}

/** What a finished job did: the version a generation made, the reason of a failure, its notes; else its state. */
function DoneRow({ job, made, failure, tokens, partial }: { job: JobSummary; made: Made | null; failure: string | null; tokens: number | null; partial: boolean }) {
  const t = useT();
  const tag = useVariantTag(job);
  const a = t.web.shell.activity;
  const locale = useLocale();
  const ok = job.state === 'succeeded';
  const state = t.web.jobState[job.state];
  // An export (decision 974): how many files, and where.
  const exported = ok && job.kind === 'export' && job.export?.files ? t.web.exportUi.doneRow({ count: job.export.files.length, folder: job.export.destination }) : null;
  const what = exported ?? (made ? ('kept' in made ? a.versionKept({ n: made.n }) : made.status === 'complete' ? a.versionReady({ n: made.n }) : a.versionIncomplete({ n: made.n }))
    : failure ? `${state} · ${failure}`
    : ok && job.notes?.length ? job.notes[0]!
    : state);
  // A failed render's SVG refusals: the English reasons behind "Details" (decision 767), outside the row's link.
  const refusals = !ok ? svgRefusalsOf(job.notes ?? []) : [];
  return (
    <Row job={job} after={refusals.length > 0 ? <ProblemList className="ms-activity-details" problems={refusals} /> : undefined}>
      <span className={cx('ms-activity-mark', ok ? 'ms-ok' : 'ms-warn')}><Icon name={ok ? 'check' : 'warn'} size={11} strokeWidth={2} /></span>
      <span className="ms-activity-text ms-line">
        <b>{job.label}{tag}</b>
        <span className="ms-activity-sub">{what}</span>
      </span>
      <span className="ms-activity-side">
        <time className="ms-activity-time" dateTime={finishedAt(job)}>{formatDate(locale, finishedAt(job), TIME_OF_DAY)}</time>
        <TokenCount tokens={tokens} partial={partial} className="ms-activity-tokens" />
      </span>
    </Row>
  );
}

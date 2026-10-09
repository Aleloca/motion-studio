import type { AgentEvent, ApprovalRequest, ConversationEntry, JobSummary } from '@motion-studio/shared';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import { useApprovalPresence } from '../components/approvalPresence.ts';
import type { EventsState } from '../eventsReducer.ts';
import { formatDate, TIME_OF_DAY, useLocale, useT } from '../i18n.tsx';
import { href } from '../routes.ts';
import { Button, Empty, Icon, Spinner, Tabs, cx } from '../ui/index.ts';
import { canAskNotifications } from './notify.ts';
import { go, type ActivityTab } from './ShellContext.tsx';
import { lastStep } from '../jobEvents.ts';

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
 * Where a job belongs, from its key. The core's keys are `creative:<root>:<project>:<creative>`, `brand:<root>:<project>`
 * (analysis and asset descriptions) and `project:<root>:<project>`; the root may contain ':' (Windows), slugs never do.
 */
export function jobPlace(job: JobSummary): { project: string; creative: string | null } | null {
  const parts = job.key.split(':');
  const kind = parts[0];
  if (kind === 'creative' && parts.length >= 4) return { project: parts.at(-2)!, creative: parts.at(-1)! };
  if ((kind === 'brand' || kind === 'project') && parts.length >= 3) return { project: parts.at(-1)!, creative: null };
  return null;
}

/** The page a job's row opens: its creative, the brand (analysis), the assets (descriptions) or the project. */
export function jobHref(job: JobSummary): string | null {
  const at = jobPlace(job);
  if (!at || !at.project) return null;
  if (at.creative) return href.creative(at.project, at.creative);
  if (job.kind === 'brand-analysis') return href.project(at.project, 'brand');
  if (job.kind === 'asset-description') return href.project(at.project, 'assets');
  return href.project(at.project);
}

type Made = { n: number; status: 'complete' | 'incomplete' };

/** The version each job of a creative produced: agent entries carry the job id, the version entry follows them. */
export function versionsByJob(entries: ConversationEntry[]): Record<string, Made> {
  const out: Record<string, Made> = {};
  let last: string | null = null;
  for (const e of entries) {
    if (e.type === 'agent') last = e.jobId;
    else if (e.type === 'user') last = null;
    else if (e.type === 'version' && last && !out[last]) out[last] = { n: e.n, status: e.status };
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
      <div id={panel} role="tabpanel" className="ms-activity-body">
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
            {running.map((j) => <RunningRow key={j.id} job={j} step={lastStep(live.events[j.id])} />)}
          </ul>
        ) : <Empty icon="clock" title={a.emptyRunning} sub={a.emptyRunningSub} />)}
        {tab === 'done' && (done.length ? (
          <ul className="ms-activity-list">
            {done.map((j) => <DoneRow key={j.id} job={j} made={made[j.id] ?? null} failure={j.state === 'failed' ? failureOf(j, live.events[j.id]) : null} />)}
          </ul>
        ) : <Empty icon="check" title={a.emptyDone} sub={a.emptyDoneSub} />)}
      </div>
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

/** A row of the Running or Done list: a link to where the job belongs, when its key tells. */
function Row({ job, className, children }: { job: JobSummary; className?: string; children: ReactNode }) {
  const to = jobHref(job);
  return (
    <li className="ms-activity-item">
      {to ? <a className={cx('ms-activity-row ms-activity-link', className)} href={to}>{children}</a> : <div className={cx('ms-activity-row', className)}>{children}</div>}
    </li>
  );
}

function RunningRow({ job, step }: { job: JobSummary; step: string | null }) {
  const t = useT();
  const queued = job.state === 'queued';
  return (
    <Row job={job} className="ms-tall">
      <span className={cx('ms-activity-glyph', queued && 'ms-muted')}>{queued ? <Icon name="clock" size={14} /> : <Spinner decorative />}</span>
      <span className="ms-activity-text">
        <b>{job.label}</b>
        <span className="ms-activity-sub">{queued ? t.web.shell.activity.queued : step ?? t.web.jobState.running}</span>
      </span>
    </Row>
  );
}

/** What a finished job did: the version a generation made, the reason of a failure, its notes; else its state. */
function DoneRow({ job, made, failure }: { job: JobSummary; made: Made | null; failure: string | null }) {
  const t = useT();
  const a = t.web.shell.activity;
  const locale = useLocale();
  const ok = job.state === 'succeeded';
  const state = t.web.jobState[job.state];
  const what = made ? (made.status === 'complete' ? a.versionReady({ n: made.n }) : a.versionIncomplete({ n: made.n }))
    : failure ? `${state} · ${failure}`
    : ok && job.notes?.length ? job.notes[0]!
    : state;
  return (
    <Row job={job}>
      <span className={cx('ms-activity-mark', ok ? 'ms-ok' : 'ms-warn')}><Icon name={ok ? 'check' : 'warn'} size={11} strokeWidth={2} /></span>
      <span className="ms-activity-text ms-line">
        <b>{job.label}</b>
        <span className="ms-activity-sub">{what}</span>
      </span>
      <time className="ms-activity-time" dateTime={finishedAt(job)}>{formatDate(locale, finishedAt(job), TIME_OF_DAY)}</time>
    </Row>
  );
}

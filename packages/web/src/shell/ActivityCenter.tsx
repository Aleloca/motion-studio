import type { AgentEvent, ApprovalRequest, JobSummary } from '@motion-studio/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { formatDate, TIME_OF_DAY, useLocale, useT } from '../i18n.tsx';
import { href } from '../routes.ts';
import { Button, Empty, Icon, Spinner, Tabs, cx } from '../ui/index.ts';
import { canAskNotifications } from './notify.ts';
import { go, type ActivityTab } from './ShellContext.tsx';

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

/** Latest step the job reported (agent progress), if any. */
function lastStep(events: AgentEvent[] | undefined): string | null {
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'progress' && e.text.trim()) return e.text.trim();
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
  const [, rerender] = useState(0);
  // A request to show a tab while the center is already open (e.g. "N running" or Review) switches to it.
  const lastRequest = useRef(request);
  useEffect(() => {
    if (request === lastRequest.current) return;
    lastRequest.current = request;
    if (initialTab) setTab(initialTab);
  }, [request, initialTab]);
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
            { value: 'needs', label: a.needsYou, count: approvals.length, controls: panel },
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
        {tab === 'needs' && (approvals.length
          ? approvals.map((ap) => <NeedsYou key={ap.id} approval={ap} where={where} />)
          : <Empty icon="check" title={a.emptyNeeds} sub={a.emptyNeedsSub} />)}
        {tab === 'running' && (running.length ? (
          <ul className="ms-activity-list">
            {running.map((j) => <RunningRow key={j.id} job={j} step={lastStep(live.events[j.id])} />)}
          </ul>
        ) : <Empty icon="clock" title={a.emptyRunning} sub={a.emptyRunningSub} />)}
        {tab === 'done' && (done.length ? (
          <ul className="ms-activity-list">
            {done.map((j) => <DoneRow key={j.id} job={j} />)}
          </ul>
        ) : <Empty icon="check" title={a.emptyDone} sub={a.emptyDoneSub} />)}
      </div>
    </div>
  );
}

function NeedsYou({ approval, where }: { approval: ApprovalRequest; where(project: string, creative: string | null): string }) {
  const t = useT();
  const target = approval.creativeSlug ? href.creative(approval.projectSlug, approval.creativeSlug) : href.project(approval.projectSlug);
  return (
    <div className="ms-activity-need">
      <div className="ms-activity-context">
        <span className="ms-activity-where">{where(approval.projectSlug, approval.creativeSlug)}</span>
        <Button size="sm" variant="ghost" onClick={() => go(target)}>{t.web.shell.activity.open}<Icon name="forward" size={12} /></Button>
      </div>
      <ApprovalCard approval={approval} />
    </div>
  );
}

function RunningRow({ job, step }: { job: JobSummary; step: string | null }) {
  const t = useT();
  const queued = job.state === 'queued';
  return (
    <li className="ms-activity-row ms-tall">
      <span className={cx('ms-activity-glyph', queued && 'ms-muted')}>{queued ? <Icon name="clock" size={14} /> : <Spinner decorative />}</span>
      <span className="ms-activity-text">
        <b>{job.label}</b>
        <span className="ms-activity-sub">{queued ? t.web.shell.activity.queued : step ?? t.web.jobState.running}</span>
      </span>
    </li>
  );
}

function DoneRow({ job }: { job: JobSummary }) {
  const t = useT();
  const locale = useLocale();
  const ok = job.state === 'succeeded';
  return (
    <li className="ms-activity-row">
      <span className={cx('ms-activity-mark', ok ? 'ms-ok' : 'ms-warn')}><Icon name={ok ? 'check' : 'warn'} size={11} strokeWidth={2} /></span>
      <span className="ms-activity-text ms-line">
        <b>{job.label}</b>
        <span className="ms-activity-sub">{t.web.jobState[job.state]}{job.error ? ` · ${job.error}` : ''}</span>
      </span>
      <time className="ms-activity-time" dateTime={finishedAt(job)}>{formatDate(locale, finishedAt(job), TIME_OF_DAY)}</time>
    </li>
  );
}

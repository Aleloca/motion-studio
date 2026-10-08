import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { AgentConsole } from '../components/AgentConsole.tsx';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import { sessionIdOf, type EventsState } from '../eventsReducer.ts';
import { useT } from '../i18n.tsx';

/**
 * The project's agent console (expert test turns in the project folder), moved out of the old ProjectPage unchanged.
 * Spec §3.2 folds it into Activity details: Task 15/16 removes it.
 */
export function ProjectConsole({ slug, live, expert }: { slug: string; live: EventsState; expert: boolean }) {
  const t = useT();
  const [jobKey, setJobKey] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectTick = live.projectTicks[slug] ?? 0;

  useEffect(() => {
    let alive = true;
    setError(null);
    api.getProject(slug)
      .then((r) => { if (alive) setJobKey(r.jobKey); })
      .catch((e: unknown) => { if (alive) setError(t.web.project.loadFailed({ detail: e instanceof Error ? e.message : String(e) })); });
    return () => { alive = false; };
  }, [slug, projectTick, t]);

  // After a reload, re-attach to this project's active job (its past events are lost until phase 2 persists them).
  useEffect(() => {
    if (jobId || !jobKey) return;
    const active = Object.values(live.jobs).find((j) => j.key === jobKey && (j.state === 'queued' || j.state === 'running'));
    if (active) setJobId(active.id);
  }, [jobId, jobKey, live.jobs]);

  const job = jobId ? live.jobs[jobId] : undefined;
  const events = useMemo(() => (jobId ? live.events[jobId] ?? [] : []), [jobId, live.events]);
  const approvals = jobId ? Object.values(live.approvals).filter((a) => a.jobId === jobId) : [];
  const busy = job?.state === 'queued' || job?.state === 'running';
  const sessionId = job?.sessionId ?? sessionIdOf(events);

  const cancel = (id: string) => {
    api.cancelJob(id).catch((e: unknown) => setError(t.web.project.cancelFailed({ detail: e instanceof Error ? e.message : String(e) })));
  };

  const send = async () => {
    setError(null);
    try {
      const j = await api.startTurn(slug, prompt, sessionId);
      setJobId(j.id);
      setPrompt('');
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  };

  return (
    <main className="page stack">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label htmlFor="prompt"><strong>{t.web.project.askAgent}</strong> <span className="muted">{t.web.project.askAgentHint}</span></label>
        <textarea id="prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t.web.project.promptPlaceholder} />
        <div className="row">
          {sessionId && <span className="muted mono">{t.web.project.session({ id: sessionId })}</span>}
          <div style={{ flex: 1 }} />
          <button type="submit" className="primary" disabled={busy || !prompt.trim()}>{t.web.common.send}</button>
        </div>
        {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      </form>
      {approvals.map((a) => <ApprovalCard key={a.id} approval={a} />)}
      {jobId && <AgentConsole job={job} events={events} expert={expert} onCancel={() => cancel(jobId)} />}
    </main>
  );
}

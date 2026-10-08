import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import { AgentConsole } from '../components/AgentConsole.tsx';
import { useT } from '../i18n.tsx';
import { sessionIdOf, type EventsState } from '../eventsReducer.ts';
import { href, type ProjectTab } from '../routes.ts';
import { AssetsPage } from './AssetsPage.tsx';
import { BrandPage } from './BrandPage.tsx';
import { CreativeList } from './CreativeList.tsx';
import { ReferencesPage } from './ReferencesPage.tsx';
import { ProjectSettings } from './ProjectSettings.tsx';

const TABS: ProjectTab[] = ['creatives', 'brand', 'assets', 'references', 'settings', 'console'];

function ProjectConsole({ slug, jobKey, live, expert }: { slug: string; jobKey: string | null; live: EventsState; expert: boolean }) {
  const t = useT();
  const [prompt, setPrompt] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div className="stack">
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
    </div>
  );
}

export function ProjectPage({ slug, tab, live, expert }: { slug: string; tab: ProjectTab; live: EventsState; expert: boolean }) {
  const t = useT();
  const [name, setName] = useState<string>(slug);
  const [jobKey, setJobKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectTick = live.projectTicks[slug] ?? 0;
  useEffect(() => {
    let alive = true;
    setError(null);
    api.getProject(slug)
      .then((r) => { if (alive) { setName(r.project.name); setJobKey(r.jobKey); } })
      .catch((e: unknown) => { if (alive) setError(t.web.project.loadFailed({ detail: e instanceof Error ? e.message : String(e) })); });
    return () => { alive = false; };
  }, [slug, projectTick, t]);
  const waiting = useMemo(() => new Set(Object.values(live.approvals).flatMap((a) => (a.projectSlug === slug && a.creativeSlug ? [a.creativeSlug] : []))), [live.approvals, slug]);
  const tick = Object.entries(live.creativeTicks).filter(([k]) => k.startsWith(`${slug}/`)).reduce((a, [, v]) => a + v, 0);
  return (
    <main className="page stack">
      <a href={href.projects()} className="muted">{t.web.project.back}</a>
      <h1 style={{ margin: 0, fontSize: 24 }}>{name}</h1>
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      <nav className="tabs" aria-label={t.web.project.sections}>
        {TABS.map((id) => <a key={id} href={href.project(slug, id)} aria-current={tab === id ? 'page' : undefined}>{t.web.project.tabs[id]}</a>)}
      </nav>
      {tab === 'creatives' && <CreativeList slug={slug} tick={tick} waiting={waiting} />}
      {tab === 'settings' && <ProjectSettings key={slug} slug={slug} tick={projectTick} />}
      {tab === 'console' && <ProjectConsole slug={slug} jobKey={jobKey} live={live} expert={expert} />}
      {tab === 'brand' && <BrandPage key={slug} slug={slug} live={live} />}
      {tab === 'assets' && <AssetsPage key={slug} slug={slug} live={live} />}
      {tab === 'references' && <ReferencesPage key={slug} slug={slug} live={live} />}
    </main>
  );
}

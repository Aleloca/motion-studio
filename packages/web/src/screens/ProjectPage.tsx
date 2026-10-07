import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { AgentConsole } from '../components/AgentConsole.tsx';
import { sessionIdOf, type EventsState } from '../eventsReducer.ts';
import { href, type ProjectTab } from '../routes.ts';
import { AssetsPage } from './AssetsPage.tsx';
import { BrandPage } from './BrandPage.tsx';
import { CreativeList } from './CreativeList.tsx';
import { ReferencesPage } from './ReferencesPage.tsx';
import { ProjectSettings } from './ProjectSettings.tsx';

const TABS: Array<[ProjectTab, string]> = [['creatives', 'Creatività'], ['brand', 'Brand'], ['assets', 'Asset'], ['references', 'Riferimenti'], ['settings', 'Impostazioni'], ['console', 'Console agente']];

function ProjectConsole({ slug, jobKey, live, expert }: { slug: string; jobKey: string | null; live: EventsState; expert: boolean }) {
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
  const busy = job?.state === 'queued' || job?.state === 'running';
  const sessionId = job?.sessionId ?? sessionIdOf(events);

  const cancel = (id: string) => {
    api.cancelJob(id).catch((e: unknown) => setError(`Impossibile annullare: ${e instanceof Error ? e.message : String(e)}`));
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
        <label htmlFor="prompt"><strong>Chiedi all'agente</strong> <span className="muted">(sessione di prova nella cartella del progetto)</span></label>
        <textarea id="prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Es. elenca i file del progetto" />
        <div className="row">
          {sessionId && <span className="muted mono">sessione {sessionId}</span>}
          <div style={{ flex: 1 }} />
          <button type="submit" className="primary" disabled={busy || !prompt.trim()}>Invia</button>
        </div>
        {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      </form>
      {jobId && <AgentConsole job={job} events={events} expert={expert} onCancel={() => cancel(jobId)} />}
    </div>
  );
}

export function ProjectPage({ slug, tab, live, expert }: { slug: string; tab: ProjectTab; live: EventsState; expert: boolean }) {
  const [name, setName] = useState<string>(slug);
  const [jobKey, setJobKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    api.getProject(slug)
      .then((r) => { if (alive) { setName(r.project.name); setJobKey(r.jobKey); } })
      .catch((e: unknown) => { if (alive) setError(`Impossibile caricare il progetto: ${e instanceof Error ? e.message : String(e)}`); });
    return () => { alive = false; };
  }, [slug]);
  const tick = Object.entries(live.creativeTicks).filter(([k]) => k.startsWith(`${slug}/`)).reduce((a, [, v]) => a + v, 0);
  return (
    <main className="page stack">
      <a href={href.projects()} className="muted">← Progetti</a>
      <h1 style={{ margin: 0, fontSize: 24 }}>{name}</h1>
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      <nav className="tabs" aria-label="Sezioni progetto">
        {TABS.map(([t, label]) => <a key={t} href={href.project(slug, t)} aria-current={tab === t ? 'page' : undefined}>{label}</a>)}
      </nav>
      {tab === 'creatives' && <CreativeList slug={slug} tick={tick} />}
      {tab === 'settings' && <ProjectSettings key={slug} slug={slug} tick={live.projectTicks[slug] ?? 0} />}
      {tab === 'console' && <ProjectConsole slug={slug} jobKey={jobKey} live={live} expert={expert} />}
      {tab === 'brand' && <BrandPage key={slug} slug={slug} live={live} />}
      {tab === 'assets' && <AssetsPage key={slug} slug={slug} live={live} />}
      {tab === 'references' && <ReferencesPage key={slug} slug={slug} live={live} />}
    </main>
  );
}

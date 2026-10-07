import type { ProjectFile } from '@motion-studio/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { AgentConsole } from '../components/AgentConsole.tsx';
import { sessionIdOf, type EventsState } from '../eventsReducer.ts';

export function ProjectPage({ slug, live, expert }: { slug: string; live: EventsState; expert: boolean }) {
  const [project, setProject] = useState<ProjectFile | null>(null);
  const [prompt, setPrompt] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobKey, setJobKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getProject(slug).then((r) => { setProject(r.project); setJobKey(r.jobKey); }).catch((e) => setError(String(e.message)));
  }, [slug]);

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
    <main className="page stack">
      <a href="#/" className="muted">← Progetti</a>
      <h1 style={{ margin: 0, fontSize: 24 }}>{project?.name ?? slug}</h1>
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
    </main>
  );
}

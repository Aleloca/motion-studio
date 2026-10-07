import type { ProjectFile } from '@motion-studio/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { AgentConsole } from '../components/AgentConsole.tsx';
import { sessionIdOf, type EventsState } from '../eventsReducer.ts';

export function ProjectPage({ slug, live, expert }: { slug: string; live: EventsState; expert: boolean }) {
  const [project, setProject] = useState<ProjectFile | null>(null);
  const [prompt, setPrompt] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.getProject(slug).then((r) => setProject(r.project)).catch((e) => setError(String(e.message))); }, [slug]);

  const job = jobId ? live.jobs[jobId] : undefined;
  const events = useMemo(() => (jobId ? live.events[jobId] ?? [] : []), [jobId, live.events]);
  const busy = job?.state === 'queued' || job?.state === 'running';

  const send = async () => {
    setError(null);
    try {
      const j = await api.startTurn(slug, prompt, sessionIdOf(events));
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
          {sessionIdOf(events) && <span className="muted mono">sessione {sessionIdOf(events)}</span>}
          <div style={{ flex: 1 }} />
          <button type="submit" className="primary" disabled={busy || !prompt.trim()}>Invia</button>
        </div>
        {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      </form>
      {jobId && <AgentConsole job={job} events={events} expert={expert} onCancel={() => void api.cancelJob(jobId)} />}
    </main>
  );
}

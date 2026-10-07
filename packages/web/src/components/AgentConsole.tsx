import type { AgentEvent, JobSummary } from '@motion-studio/shared';

const STATE_LABEL: Record<JobSummary['state'], string> = {
  queued: 'In coda', running: 'In lavorazione', succeeded: 'Completato', failed: 'Errore', cancelled: 'Annullato',
};
const STATE_CLASS: Record<JobSummary['state'], string> = { queued: 'run', running: 'run', succeeded: 'ok', failed: 'err', cancelled: '' };

function SimpleLine({ e }: { e: AgentEvent }) {
  if (e.kind === 'text') return <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{e.text}</p>;
  if (e.kind === 'tool_use') return <p className="muted" style={{ margin: 0 }}>Usa lo strumento {e.name}</p>;
  if (e.kind === 'rate_limit' && e.status !== 'allowed') return <p className="warn" style={{ margin: 0 }}>Limite di utilizzo: {e.status}</p>;
  return null;
}

function ExpertLine({ e }: { e: AgentEvent }) {
  const tag = (t: string) => <span style={{ color: 'var(--accent-ink)', minWidth: 90, display: 'inline-block' }}>{t}</span>;
  switch (e.kind) {
    case 'session': return <div>{tag('session')}{e.sessionId}</div>;
    case 'text': return <div>{tag('text')}<span style={{ whiteSpace: 'pre-wrap' }}>{e.text}</span></div>;
    case 'tool_use': return <div>{tag(`tool ${e.name}`)}<pre style={{ margin: 0, display: 'inline', whiteSpace: 'pre-wrap' }}>{JSON.stringify(e.input, null, 2)}</pre></div>;
    case 'tool_result': return <div>{tag(e.isError ? 'result ✗' : 'result')}<span style={{ whiteSpace: 'pre-wrap' }}>{e.content}</span></div>;
    case 'stderr': return <div>{tag('stderr')}<span className="error">{e.text}</span></div>;
    case 'parse_error': return <div>{tag('parse')}<span className="error">{e.line}</span></div>;
    case 'rate_limit': return <div>{tag('limit')}{e.status}</div>;
    case 'result': return <div>{tag('done')}{e.ok ? 'ok' : e.error}{e.costUsd !== undefined ? ` · $${e.costUsd.toFixed(4)}` : ''}</div>;
  }
}

export function AgentConsole({ job, events, expert, onCancel }: { job?: JobSummary; events: AgentEvent[]; expert: boolean; onCancel: () => void }) {
  const active = job && (job.state === 'queued' || job.state === 'running');
  return (
    <section className="card stack" aria-label="Attività dell'agente">
      {job && (
        <div className="row">
          <span className={`badge ${STATE_CLASS[job.state]}`}>{STATE_LABEL[job.state]}</span>
          <span className="muted">{job.label}</span>
          <div style={{ flex: 1 }} />
          {active && <button type="button" onClick={onCancel}>Annulla</button>}
        </div>
      )}
      {job?.state === 'failed' && <p role="alert" className="error" style={{ margin: 0 }}>{job.error}</p>}
      <div className={expert ? 'mono stack' : 'stack'} style={{ gap: expert ? 4 : 8 }}>
        {events.map((e, i) => (expert ? <ExpertLine key={i} e={e} /> : <SimpleLine key={i} e={e} />))}
      </div>
    </section>
  );
}

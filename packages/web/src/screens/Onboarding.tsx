import type { DoctorCheck, WorkspaceProblem } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { desktop } from '../desktop.ts';

function workspaceProblemText(problem: WorkspaceProblem, path: string | null): string {
  const where = path ?? '';
  switch (problem.code) {
    case 'not-found': return `Cartella non trovata: ${where}, scegline un'altra`;
    case 'invalid': return `Contenuto non valido in ${where}: ${problem.message}`;
    case 'not-writable': return problem.message;
  }
}

export function Onboarding({ checks, workspacePath, workspaceError, error: loadError, onRecheck, onWorkspaceSet }: {
  checks: DoctorCheck[] | null;
  workspacePath: string | null;
  workspaceError?: WorkspaceProblem | null;
  error?: string | null;
  onRecheck: () => void;
  onWorkspaceSet: () => void;
}) {
  const [path, setPath] = useState(workspacePath ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The configured path usually arrives after mount: prefill it unless the user already typed something.
  useEffect(() => { if (workspacePath) setPath((p) => p || workspacePath); }, [workspacePath]);

  const save = async () => {
    setBusy(true); setError(null);
    try { await api.setWorkspace(path.trim()); onWorkspaceSet(); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const bridge = desktop();
  const choose = async () => {
    try { const picked = await bridge?.pickFolder('Scegli la cartella di lavoro', path.trim() || undefined); if (picked) setPath(picked); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <main className="page stack" style={{ maxWidth: 720 }}>
      <h1 style={{ margin: 0, fontSize: 28 }}>Benvenuto in Motion Studio</h1>
      <section className="card stack" aria-label="Controllo ambiente">
        <div className="row"><strong>Controllo ambiente</strong><div style={{ flex: 1 }} /><button type="button" onClick={onRecheck}>Ricontrolla</button></div>
        {loadError && <p role="alert" className="error" style={{ margin: 0 }}>Impossibile contattare il server di Motion Studio: {loadError}</p>}
        {!checks && !loadError && <p className="muted">Controllo in corso…</p>}
        {checks?.map((c) => (
          <div key={c.id} className="row" style={{ alignItems: 'flex-start' }}>
            <span className={`badge ${c.ok ? 'ok' : c.required ? 'err' : ''}`}>{c.ok ? 'OK' : c.required ? 'Manca' : 'Consigliato'}</span>
            <div className="stack" style={{ gap: 2, flex: 1 }}>
              <span><strong>{c.label}</strong>{c.version ? <span className="muted"> · {c.version}</span> : null} — {c.message}</span>
              {c.fix && <code className="mono">{c.fix}</code>}
            </div>
          </div>
        ))}
      </section>
      <section className="card stack" aria-label="Workspace">
        <label htmlFor="ws-path"><strong>Cartella di lavoro</strong></label>
        <p className="muted" style={{ margin: 0 }}>Qui Motion Studio salva tutti i progetti. Se non esiste, viene creata.</p>
        <div className="row" style={{ gap: 8 }}>
          <input id="ws-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/tuonome/MotionStudio" style={{ flex: '1 1 240px', width: 'auto' }} />
          {bridge && <button type="button" disabled={busy} onClick={choose}>Scegli cartella…</button>}
        </div>
        {workspaceError && !error && (
          <p role="alert" className="error" style={{ margin: 0 }}>{workspaceProblemText(workspaceError, workspacePath)}</p>
        )}
        {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
        <div className="row"><button type="button" className="primary" disabled={busy || !path.trim()} onClick={save}>Usa questa cartella</button></div>
      </section>
    </main>
  );
}

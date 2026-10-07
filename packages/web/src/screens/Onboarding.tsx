import type { DoctorCheck } from '@motion-studio/shared';
import { useState } from 'react';
import { api, ApiError } from '../api.ts';

export function Onboarding({ checks, workspacePath, error: loadError, onRecheck, onWorkspaceSet }: {
  checks: DoctorCheck[] | null;
  workspacePath: string | null;
  error?: string | null;
  onRecheck: () => void;
  onWorkspaceSet: () => void;
}) {
  const [path, setPath] = useState(workspacePath ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true); setError(null);
    try { await api.setWorkspace(path.trim()); onWorkspaceSet(); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
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
        <input id="ws-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/tuonome/MotionStudio" />
        {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
        <div className="row"><button type="button" className="primary" disabled={busy || !path.trim()} onClick={save}>Usa questa cartella</button></div>
      </section>
    </main>
  );
}

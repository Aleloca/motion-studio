import type { DoctorCheck, Messages, WorkspaceProblem } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { desktop } from '../desktop.ts';
import { useT } from '../i18n.tsx';

function workspaceProblemText(problem: WorkspaceProblem, path: string | null, t: Messages): string {
  const where = path ?? '';
  switch (problem.code) {
    case 'not-found': return t.web.onboarding.workspaceNotFound({ path: where });
    case 'invalid': return t.web.onboarding.workspaceInvalid({ path: where, detail: problem.message });
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
  const t = useT();
  const o = t.web.onboarding;
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
    try { const picked = await bridge?.pickFolder(o.pickFolderTitle, path.trim() || undefined); if (picked) setPath(picked); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <main className="page stack" style={{ maxWidth: 720 }}>
      <h1 style={{ margin: 0, fontSize: 28 }}>{o.welcome}</h1>
      <section className="card stack" aria-label={o.environmentCheck}>
        <div className="row"><strong>{o.environmentCheck}</strong><div style={{ flex: 1 }} /><button type="button" onClick={onRecheck}>{o.recheck}</button></div>
        {loadError && <p role="alert" className="error" style={{ margin: 0 }}>{o.serverUnreachable({ detail: loadError })}</p>}
        {!checks && !loadError && <p className="muted">{o.checking}</p>}
        {checks?.map((c) => (
          <div key={c.id} className="row" style={{ alignItems: 'flex-start' }}>
            <span className={`badge ${c.ok ? 'ok' : c.required ? 'err' : ''}`}>{c.ok ? o.ok : c.required ? o.missing : o.recommended}</span>
            <div className="stack" style={{ gap: 2, flex: 1 }}>
              <span><strong>{c.label}</strong>{c.version ? <span className="muted"> · {c.version}</span> : null} — {c.message}</span>
              {c.fix && <code className="mono">{c.fix}</code>}
            </div>
          </div>
        ))}
      </section>
      <section className="card stack" aria-label={o.workspace}>
        <label htmlFor="ws-path"><strong>{o.workingFolder}</strong></label>
        <p className="muted" style={{ margin: 0 }}>{o.workingFolderHelp}</p>
        <div className="row" style={{ gap: 8 }}>
          <input id="ws-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder={o.pathPlaceholder} style={{ flex: '1 1 240px', width: 'auto' }} />
          {bridge && <button type="button" disabled={busy} onClick={choose}>{t.web.common.chooseFolder}</button>}
        </div>
        {workspaceError && !error && (
          <p role="alert" className="error" style={{ margin: 0 }}>{workspaceProblemText(workspaceError, workspacePath, t)}</p>
        )}
        {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
        <div className="row"><button type="button" className="primary" disabled={busy || !path.trim()} onClick={save}>{o.useFolder}</button></div>
      </section>
    </main>
  );
}

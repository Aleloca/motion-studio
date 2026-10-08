import type { ApprovalDecision, ApprovalRequest } from '@motion-studio/shared';
import { useState } from 'react';
import { api, ApiError } from '../api.ts';

/** The detail is agent-controlled text: it is rendered as plain text only, never as HTML. */
export function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (d: ApprovalDecision) => {
    setBusy(true); setError(null);
    try { await api.decideApproval(approval.id, d); }
    catch (e) { setError(e instanceof ApiError && e.status === 404 ? 'Richiesta già gestita' : e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const expires = new Date(approval.expiresAt);
  return (
    <div role="group" aria-label={approval.title} className="warn stack" style={{ gap: 8 }}>
      <strong>{approval.title}</strong>
      <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', maxHeight: '7.5em', overflow: 'auto' }}>{approval.detail}</pre>
      {!Number.isNaN(expires.getTime()) && <span style={{ fontSize: 12 }}>Scade alle {expires.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>}
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="primary" disabled={busy} onClick={() => void decide('once')}>{approval.kind === 'provider' ? 'Genera' : 'Consenti una volta'}</button>
        {approval.alwaysRule && <button type="button" disabled={busy} title={approval.alwaysRule} onClick={() => void decide('always')}>Sempre per questo progetto</button>}
        <button type="button" disabled={busy} onClick={() => void decide('deny')}>Nega</button>
      </div>
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}

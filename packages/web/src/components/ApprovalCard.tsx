import type { ApprovalDecision, ApprovalRequest } from '@motion-studio/shared';
import { useState } from 'react';
import { api, ApiError } from '../api.ts';
import { formatDate, TIME_OF_DAY, useLocale, useT } from '../i18n.tsx';

/** The detail is agent-controlled text: it is rendered as plain text only, never as HTML. */
export function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const t = useT();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (d: ApprovalDecision) => {
    setBusy(true); setError(null);
    try { await api.decideApproval(approval.id, d); }
    catch (e) { setError(e instanceof ApiError && e.status === 404 ? t.web.approvalUi.alreadyHandled : e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const expires = new Date(approval.expiresAt);
  return (
    <div role="group" aria-label={approval.title} className="warn stack" style={{ gap: 8 }}>
      <strong>{approval.title}</strong>
      <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', maxHeight: '7.5em', overflow: 'auto' }}>{approval.detail}</pre>
      {!Number.isNaN(expires.getTime()) && <span style={{ fontSize: 12 }}>{t.web.approvalUi.expiresAt({ time: formatDate(locale, approval.expiresAt, TIME_OF_DAY) })}</span>}
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="primary" disabled={busy} onClick={() => void decide('once')}>{approval.kind === 'provider' ? t.web.approvalUi.generate : t.web.approvalUi.allowOnce}</button>
        {approval.alwaysRule && <button type="button" disabled={busy} title={approval.alwaysRule} onClick={() => void decide('always')}>{t.web.approvalUi.always}</button>}
        <button type="button" disabled={busy} onClick={() => void decide('deny')}>{t.web.approvalUi.deny}</button>
      </div>
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}

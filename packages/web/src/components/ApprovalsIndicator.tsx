import type { ApprovalRequest } from '@motion-studio/shared';
import { useState } from 'react';
import { useT } from '../i18n.tsx';
import { href } from '../routes.ts';
import { ApprovalCard } from './ApprovalCard.tsx';

export function ApprovalsIndicator({ approvals }: { approvals: ApprovalRequest[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (approvals.length === 0) return null;
  const canAsk = typeof Notification !== 'undefined' && Notification.permission === 'default';
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="badge warn-badge" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {t.web.approvalUi.pending({ count: approvals.length })}
      </button>
      {open && (
        <div className="card stack" style={{ position: 'absolute', right: 0, top: '110%', width: 380, zIndex: 40 }}>
          {canAsk && <button type="button" onClick={() => void Notification.requestPermission()}>{t.web.approvalUi.enableNotifications}</button>}
          {approvals.map((a) => (
            <div key={a.id} className="stack" style={{ gap: 4 }}>
              <span className="muted" style={{ fontSize: 12 }}>{a.projectSlug}{a.creativeSlug ? ` · ${a.creativeSlug}` : ''} <a href={a.creativeSlug ? href.creative(a.projectSlug, a.creativeSlug) : href.project(a.projectSlug)}>{t.web.approvalUi.open}</a></span>
              <ApprovalCard approval={a} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

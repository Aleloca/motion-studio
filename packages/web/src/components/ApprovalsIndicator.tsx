import type { ApprovalRequest } from '@motion-studio/shared';
import { useState } from 'react';
import { href } from '../routes.ts';
import { ApprovalCard } from './ApprovalCard.tsx';

export function ApprovalsIndicator({ approvals }: { approvals: ApprovalRequest[] }) {
  const [open, setOpen] = useState(false);
  if (approvals.length === 0) return null;
  const canAsk = typeof Notification !== 'undefined' && Notification.permission === 'default';
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="badge warn-badge" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {approvals.length === 1 ? '1 approvazione in attesa' : `${approvals.length} approvazioni in attesa`}
      </button>
      {open && (
        <div className="card stack" style={{ position: 'absolute', right: 0, top: '110%', width: 380, zIndex: 40 }}>
          {canAsk && <button type="button" onClick={() => void Notification.requestPermission()}>Attiva le notifiche</button>}
          {approvals.map((a) => (
            <div key={a.id} className="stack" style={{ gap: 4 }}>
              <span className="muted" style={{ fontSize: 12 }}>{a.projectSlug}{a.creativeSlug ? ` · ${a.creativeSlug}` : ''} <a href={a.creativeSlug ? href.creative(a.projectSlug, a.creativeSlug) : href.project(a.projectSlug)}>Apri</a></span>
              <ApprovalCard approval={a} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

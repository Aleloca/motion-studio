import type { CreativeStatus } from '@motion-studio/shared';
import { useT } from '../i18n.tsx';

export const STATUSES: CreativeStatus[] = ['draft', 'working', 'ready', 'incomplete', 'error', 'interrupted'];
const CLASS: Record<CreativeStatus, string> = { draft: '', working: 'run', ready: 'ok', incomplete: 'warn-badge', error: 'err', interrupted: 'warn-badge' };

export function StatusBadge({ status, waiting }: { status: CreativeStatus; waiting?: boolean }) {
  const t = useT();
  if (waiting) return <span className="badge warn-badge">{t.web.status.awaitingApproval}</span>;
  return <span className={`badge ${CLASS[status]}`}>{t.web.status[status]}</span>;
}

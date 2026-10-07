import type { CreativeStatus } from '@motion-studio/shared';

export const STATUS_LABEL: Record<CreativeStatus, string> = {
  draft: 'Bozza', working: 'In lavorazione', ready: 'Pronta', incomplete: 'Incompleta', error: 'Errore', interrupted: 'Interrotta',
};
const CLASS: Record<CreativeStatus, string> = { draft: '', working: 'run', ready: 'ok', incomplete: 'warn-badge', error: 'err', interrupted: 'warn-badge' };

export function StatusBadge({ status }: { status: CreativeStatus }) {
  return <span className={`badge ${CLASS[status]}`}>{STATUS_LABEL[status]}</span>;
}

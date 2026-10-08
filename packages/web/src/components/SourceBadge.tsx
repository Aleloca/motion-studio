import type { SourceRef } from '@motion-studio/shared';
import { useT } from '../i18n.tsx';

export function SourceBadge({ source }: { source: SourceRef }) {
  const t = useT();
  if (source.kind === 'website' && source.ref) {
    let host = source.ref;
    try { host = new URL(source.ref).hostname; } catch { /* keep raw */ }
    return <span className="badge" title={source.ref}>{t.web.source.website({ host })}</span>;
  }
  if (source.kind === 'image' && source.ref) return <span className="badge" title={source.ref}>{t.web.source.image({ name: source.ref.split('/').pop() ?? '' })}</span>;
  return <span className="badge">{t.web.source.manual}</span>;
}

import type { SourceRef } from '@motion-studio/shared';

export function SourceBadge({ source }: { source: SourceRef }) {
  if (source.kind === 'website' && source.ref) {
    let host = source.ref;
    try { host = new URL(source.ref).hostname; } catch { /* keep raw */ }
    return <span className="badge" title={source.ref}>Sito: {host}</span>;
  }
  if (source.kind === 'image' && source.ref) return <span className="badge" title={source.ref}>Immagine: {source.ref.split('/').pop()}</span>;
  return <span className="badge">Manuale</span>;
}

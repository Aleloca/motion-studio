import type { AssetKind } from '@motion-studio/shared';
import { MediaThumb } from './MediaThumb.tsx';

export function AssetPreview({ url, kind, name }: { url: string; kind: AssetKind; name: string }) {
  if (kind === 'image' || kind === 'svg') return <img src={url} alt={name} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />;
  if (kind === 'video') return <MediaThumb src={url} alt={name} />;
  const label = kind === 'font' ? 'Aa' : (name.split('.').pop() ?? '').toUpperCase();
  return <span style={{ fontSize: kind === 'font' ? 40 : 18, fontFamily: kind === 'font' ? 'Georgia, serif' : 'var(--mono)', color: 'var(--muted)' }}>{label}</span>;
}

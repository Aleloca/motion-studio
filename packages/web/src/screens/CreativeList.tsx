import type { CreativeListItem, CreativeStatus } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { MediaThumb } from '../components/MediaThumb.tsx';
import { STATUS_LABEL, StatusBadge } from '../components/StatusBadge.tsx';
import { href } from '../routes.ts';

export function CreativeList({ slug, tick }: { slug: string; tick: number }) {
  const [items, setItems] = useState<CreativeListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CreativeStatus | 'all'>('all');
  useEffect(() => {
    let alive = true; // a slow response for a previous slug/tick must not overwrite a newer one
    api.listCreatives(slug)
      .then((r) => { if (alive) { setItems(r); setError(null); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [slug, tick]);

  // Unreadable creatives have no status: they stay visible under every filter so they are never forgotten.
  const visible = (items ?? []).filter((i) => filter === 'all' || !i.ok || i.status === filter);
  return (
    <section className="stack" aria-label="Creatività">
      <div className="row">
        <div className="row" role="group" aria-label="Filtra per stato" style={{ gap: 6 }}>
          <button type="button" className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Tutte</button>
          {(Object.keys(STATUS_LABEL) as CreativeStatus[]).map((s) => (
            <button key={s} type="button" className="chip" aria-pressed={filter === s} onClick={() => setFilter(s)}>{STATUS_LABEL[s]}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <a className="button primary" href={href.newCreative(slug)} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 36, padding: '0 14px', borderRadius: 8, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 700, textDecoration: 'none' }}>+ Nuova creatività</a>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {items?.length === 0 && <p className="muted">Nessuna creatività: creane una dal brief.</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {visible.map((it) => it.ok ? (
          <a key={it.slug} href={href.creative(slug, it.slug)} className="card stack" style={{ textDecoration: 'none', color: 'inherit', gap: 8, padding: 12 }}>
            <div className="dots" style={{ aspectRatio: '16 / 10', borderRadius: 10, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {it.cover ? <MediaThumb src={api.fileUrl(slug, it.slug, it.cover)} alt={it.title} /> : <span className="muted">Nessun output</span>}
            </div>
            <div className="row" style={{ gap: 8 }}><strong style={{ flex: 1 }}>{it.title}</strong><StatusBadge status={it.status} /></div>
            <span className="muted" style={{ fontSize: 13 }}>{it.formats.length} formati · {it.versions} versioni</span>
            <span className="muted" style={{ fontSize: 12 }}>Aggiornata {new Date(it.updatedAt).toLocaleDateString('it-IT')}</span>
          </a>
        ) : (
          <div key={it.slug} className="card stack" style={{ gap: 4 }}>
            <strong>{it.slug}</strong>
            <span className="badge err" style={{ alignSelf: 'flex-start' }}>Non leggibile</span>
            <span className="mono" style={{ overflowWrap: 'anywhere' }}>{it.error}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

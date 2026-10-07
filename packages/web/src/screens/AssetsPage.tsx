import type { AssetEntry, AssetKind, AssetOrigin } from '@motion-studio/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { AssetPreview } from '../components/AssetPreview.tsx';
import { UploadZone } from '../components/UploadZone.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { useProjectData } from '../useProjectData.ts';

const ORIGIN: Record<AssetOrigin, string> = { upload: 'Caricato', website: 'Da sito', generated: 'Generato', stock: 'Stock' };
const KINDS: AssetKind[] = ['image', 'svg', 'video', 'font', 'audio', 'other'];
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Detail({ slug, asset, onChanged, onClose }: { slug: string; asset: AssetEntry; onChanged(): void; onClose(): void }) {
  // Edits live in `edit` (null = untouched): a live reload never overwrites what is being typed.
  const [edit, setEdit] = useState<{ description: string; tags: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const description = edit?.description ?? asset.description;
  const tags = edit?.tags ?? asset.tags.join(', ');
  const parseTags = (t: string) => t.split(',').map((x) => x.trim()).filter(Boolean);
  const edited = edit !== null && (edit.description !== asset.description || edit.tags !== asset.tags.join(', '));
  useEffect(() => { if (edit && !edited) setEdit(null); }, [edit, edited]);
  const run = async (fn: () => Promise<unknown>, close = false) => {
    setError(null);
    try { await fn(); onChanged(); if (close) onClose(); } catch (e) { setError(msg(e)); }
  };
  return (
    <aside aria-label="Dettaglio asset" className="card stack" style={{ flex: '1 1 300px', maxWidth: 380 }}>
      <div className="dots" style={{ height: 180, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <AssetPreview url={api.projectFileUrl(slug, `assets/${asset.file}`)} kind={asset.kind} name={asset.file} />
      </div>
      <strong className="mono" style={{ overflowWrap: 'anywhere' }}>{asset.file}</strong>
      <span className="muted" style={{ fontSize: 13 }}>{ORIGIN[asset.origin]} · aggiunto il {new Date(asset.addedAt).toLocaleDateString('it-IT')}{asset.width ? ` · ${asset.width}×${asset.height}` : ''}</span>
      {asset.sourceUrl && <a href={asset.sourceUrl} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>{asset.sourceUrl}</a>}
      <label htmlFor="ad-desc">Descrizione</label>
      <textarea id="ad-desc" rows={3} value={description} onChange={(e) => setEdit({ description: e.target.value, tags })} />
      <label htmlFor="ad-tags">Tag (separati da virgola)</label>
      <input id="ad-tags" value={tags} onChange={(e) => setEdit({ description, tags: e.target.value })} />
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      <div className="row">
        <button type="button" onClick={() => void run(() => api.deleteAsset(slug, asset.file), true)}>Elimina</button>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onClose}>Chiudi</button>
        <button type="button" className="primary" onClick={() => void run(() => api.updateAsset(slug, asset.file, { description, tags: parseTags(tags) }))}>Salva</button>
      </div>
    </aside>
  );
}

export function AssetsPage({ slug, live }: { slug: string; live: EventsState }) {
  const tick = live.projectTicks[slug] ?? 0;
  const { data, error, reload } = useProjectData(() => Promise.all([api.listAssets(slug), api.getBrand(slug).then((b) => b.jobKey).catch(() => null)]), [slug, tick]);
  const [kind, setKind] = useState<AssetKind | 'all'>('all');
  const [origin, setOrigin] = useState<AssetOrigin | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listing = data?.[0];
  const jobKey = data?.[1] ?? null;
  const job = Object.values(live.jobs).find((j) => j.key === jobKey && (j.state === 'queued' || j.state === 'running'));
  const visible = useMemo(() => (listing?.assets ?? []).filter((a) =>
    (kind === 'all' || a.kind === kind) && (origin === 'all' || a.origin === origin)
    && (!query.trim() || `${a.file} ${a.description} ${a.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))), [listing, kind, origin, query]);
  const act = async (fn: () => Promise<unknown>) => { setActionError(null); try { await fn(); reload(); } catch (e) { setActionError(msg(e)); } };

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!listing) return <p className="muted">Caricamento…</p>;
  const current = listing.assets.find((a) => a.file === selected);
  return (
    <div className="stack">
      {listing.error && <p role="alert" className="error">{listing.error}</p>}
      {actionError && <p role="alert" className="error">{actionError}</p>}
      <UploadZone label="Carica asset" disabled={Boolean(listing.error)} onFiles={async (files) => { await api.uploadFiles(slug, 'assets', files); reload(); }} />
      {listing.unregistered.length > 0 && (
        <div className="warn row">
          <span style={{ flex: 1 }}>{listing.unregistered.length} file nella cartella assets/ non sono registrati</span>
          <button type="button" onClick={() => void act(() => api.registerAssets(slug, listing.unregistered))}>Registra</button>
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <label className="row" style={{ gap: 6 }}>Tipo
          <select aria-label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as AssetKind | 'all')}>
            <option value="all">Tutti</option>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label className="row" style={{ gap: 6 }}>Origine
          <select aria-label="Origine" value={origin} onChange={(e) => setOrigin(e.target.value as AssetOrigin | 'all')}>
            <option value="all">Tutte</option>{(Object.keys(ORIGIN) as AssetOrigin[]).map((o) => <option key={o} value={o}>{ORIGIN[o]}</option>)}
          </select>
        </label>
        <input aria-label="Cerca negli asset" placeholder="Cerca per nome, descrizione o tag" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, width: 'auto' }} />
        {job ? <span className="badge run">Descrizione in corso…</span> : null}
        <button type="button" disabled={Boolean(job)} onClick={() => void act(() => api.describeAssets(slug))}>Descrivi con l'agente</button>
      </div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: '999 1 480px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
          {visible.map((a) => (
            <button key={a.file} type="button" aria-label={`Apri ${a.file}`} onClick={() => setSelected(a.file)} className="card stack"
              style={{ padding: 8, gap: 6, textAlign: 'left', borderColor: selected === a.file ? 'var(--accent)' : undefined }}>
              <span className="dots" style={{ height: 110, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                <AssetPreview url={api.projectFileUrl(slug, `assets/${a.file}`)} kind={a.kind} name={a.file} />
              </span>
              <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{a.file}</span>
              <span className="row" style={{ gap: 6 }}><span className="badge">{ORIGIN[a.origin]}</span>{a.width && <span className="muted" style={{ fontSize: 12 }}>{a.width}×{a.height}</span>}</span>
            </button>
          ))}
          {visible.length === 0 && <p className="muted">Nessun asset.</p>}
        </div>
        {current && <Detail key={current.file} slug={slug} asset={current} onChanged={reload} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}

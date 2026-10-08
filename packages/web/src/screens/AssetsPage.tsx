import type { AssetEntry, AssetKind, AssetOrigin } from '@motion-studio/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { AssetPreview } from '../components/AssetPreview.tsx';
import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { UploadZone } from '../components/UploadZone.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { formatDate, useLocale, useT } from '../i18n.tsx';
import { brandJobFailedText, brandJobRunningText, isActiveJob, isDescribeJob } from '../labels.ts';
import { useProjectData } from '../useProjectData.ts';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Detail({ slug, asset, onChanged, onClose }: { slug: string; asset: AssetEntry; onChanged(): void; onClose(): void }) {
  const t = useT();
  const locale = useLocale();
  // Edits live in `edit` (null = untouched): a live reload never overwrites what is being typed.
  const [edit, setEdit] = useState<Partial<{ description: string; tags: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const description = edit.description ?? asset.description;
  const tags = edit.tags ?? asset.tags.join(', ');
  const parseTags = (t: string) => t.split(',').map((x) => x.trim()).filter(Boolean);
  // Per field: only what is being typed is held (and sent); the other field keeps following the server.
  const changes = () => ({
    ...(edit.description !== undefined ? { description: edit.description } : {}),
    ...(edit.tags !== undefined ? { tags: parseTags(edit.tags) } : {}),
  });
  useEffect(() => {
    const same = { description: edit.description === asset.description, tags: edit.tags === asset.tags.join(', ') };
    if (same.description || same.tags) setEdit(({ description: d, tags: t }) => ({ ...(same.description ? {} : { description: d }), ...(same.tags ? {} : { tags: t }) }));
  }, [edit, asset]);
  const run = async (fn: () => Promise<unknown>, close = false) => {
    setError(null);
    try { await fn(); onChanged(); if (close) onClose(); } catch (e) { setError(msg(e)); }
  };
  return (
    <aside aria-label={t.web.assets.detail} className="card stack" style={{ flex: '1 1 300px', maxWidth: 380 }}>
      <div className="dots" style={{ height: 180, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <AssetPreview url={api.projectFileUrl(slug, `assets/${asset.file}`)} kind={asset.kind} name={asset.file} />
      </div>
      <strong className="mono" style={{ overflowWrap: 'anywhere' }}>{asset.file}</strong>
      <span className="muted" style={{ fontSize: 13 }}>{t.web.labels.assetOrigins[asset.origin]} · {t.web.assets.addedOn({ date: formatDate(locale, asset.addedAt) })}{asset.width ? ` · ${asset.width}×${asset.height}` : ''}</span>
      {asset.attribution && <span style={{ fontSize: 13 }}>{t.web.assets.credit({ text: asset.attribution })}</span>}
      {asset.sourceUrl && <a href={asset.sourceUrl} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>{asset.sourceUrl}</a>}
      <label htmlFor="ad-desc">{t.web.assets.description}</label>
      <textarea id="ad-desc" rows={3} value={description} onChange={(e) => setEdit((x) => ({ ...x, description: e.target.value }))} />
      <label htmlFor="ad-tags">{t.web.assets.tags}</label>
      <input id="ad-tags" value={tags} onChange={(e) => setEdit((x) => ({ ...x, tags: e.target.value }))} />
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      <div className="row">
        <ConfirmButton label={t.web.common.delete} onConfirm={() => void run(() => api.deleteAsset(slug, asset.file), true)} />
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onClose}>{t.common.close}</button>
        <button type="button" className="primary" onClick={() => void run(() => api.updateAsset(slug, asset.file, changes()))}>{t.common.save}</button>
      </div>
    </aside>
  );
}

export function AssetsPage({ slug, live }: { slug: string; live: EventsState }) {
  const t = useT();
  const tick = live.projectTicks[slug] ?? 0;
  const { data, error, reload } = useProjectData(() => Promise.all([api.listAssets(slug), api.getBrand(slug).then((b) => b.jobKey).catch(() => null)]), [slug, tick]);
  const [kind, setKind] = useState<AssetKind | 'all'>('all');
  const [origin, setOrigin] = useState<AssetOrigin | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listing = data?.[0];
  const jobKey = data?.[1] ?? null;
  const jobs = Object.values(live.jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Newest brand job of this project; with the key unknown (brand overview unreadable) a running brand job of a
  // project with this slug still blocks the button: the server would answer 409 anyway.
  const job = jobKey ? jobs.find((j) => j.key === jobKey) : jobs.find((j) => isActiveJob(j) && j.key.startsWith('brand:') && j.key.endsWith(`:${slug}`));
  const running = isActiveJob(job);
  useEffect(() => {
    if (listing && selected && !listing.assets.some((a) => a.file === selected)) setSelected(null);
  }, [listing, selected]);
  const visible = useMemo(() => (listing?.assets ?? []).filter((a) =>
    (kind === 'all' || a.kind === kind) && (origin === 'all' || a.origin === origin)
    && (!query.trim() || `${a.file} ${a.description} ${a.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))), [listing, kind, origin, query]);
  const act = async (fn: () => Promise<unknown>) => { setActionError(null); try { await fn(); reload(); } catch (e) { setActionError(msg(e)); } };

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!listing) return <p className="muted">{t.common.loading}</p>;
  const current = listing.assets.find((a) => a.file === selected);
  return (
    <div className="stack">
      {listing.error && <p role="alert" className="error">{listing.error}</p>}
      {actionError && <p role="alert" className="error">{actionError}</p>}
      <UploadZone label={t.web.assets.upload} disabled={Boolean(listing.error)} onFiles={async (files) => { await api.uploadFiles(slug, 'assets', files); reload(); }} />
      {listing.unregistered.length > 0 && (
        <div className="warn row">
          <span style={{ flex: 1 }}>{t.web.assets.unregistered({ count: listing.unregistered.length })}</span>
          <button type="button" onClick={() => void act(() => api.registerAssets(slug, listing.unregistered))}>{t.web.assets.register}</button>
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <label className="row" style={{ gap: 6 }}>{t.web.assets.type}
          <select aria-label={t.web.assets.type} value={kind} onChange={(e) => setKind(e.target.value as AssetKind | 'all')}>
            <option value="all">{t.web.assets.allTypes}</option>{(Object.keys(t.web.labels.assetKinds) as AssetKind[]).map((k) => <option key={k} value={k}>{t.web.labels.assetKinds[k]}</option>)}
          </select>
        </label>
        <label className="row" style={{ gap: 6 }}>{t.web.assets.origin}
          <select aria-label={t.web.assets.origin} value={origin} onChange={(e) => setOrigin(e.target.value as AssetOrigin | 'all')}>
            <option value="all">{t.web.assets.allOrigins}</option>{(Object.keys(t.web.labels.assetOrigins) as AssetOrigin[]).map((o) => <option key={o} value={o}>{t.web.labels.assetOrigins[o]}</option>)}
          </select>
        </label>
        <input aria-label={t.web.assets.search} placeholder={t.web.assets.searchPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, width: 'auto' }} />
        {job && running ? <span className="badge run">{brandJobRunningText(job, t)}</span> : null}
        <button type="button" disabled={running} onClick={() => void act(() => api.describeAssets(slug))}>{t.web.assets.describe}</button>
      </div>
      {job && !running && isDescribeJob(job) && job.state === 'failed' && <p className="error" style={{ margin: 0 }}>{brandJobFailedText(job, t)}</p>}
      {job && !running && isDescribeJob(job) && (job.notes ?? []).map((n) => <p key={n} className="warn" style={{ margin: 0 }}>{n}</p>)}
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: '999 1 480px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
          {visible.map((a) => (
            <button key={a.file} type="button" aria-label={t.web.assets.open({ file: a.file })} title={a.attribution ?? undefined} onClick={() => setSelected(a.file)} className="card stack"
              style={{ padding: 8, gap: 6, textAlign: 'left', borderColor: selected === a.file ? 'var(--accent)' : undefined }}>
              <span className="dots" style={{ height: 110, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                <AssetPreview url={api.projectFileUrl(slug, `assets/${a.file}`)} kind={a.kind} name={a.file} />
              </span>
              <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{a.file}</span>
              <span className="row" style={{ gap: 6 }}><span className="badge">{t.web.labels.assetOrigins[a.origin]}</span>{a.width && <span className="muted" style={{ fontSize: 12 }}>{a.width}×{a.height}</span>}</span>
            </button>
          ))}
          {visible.length === 0 && <p className="muted">{t.web.assets.none}</p>}
        </div>
        {current && <Detail key={current.file} slug={slug} asset={current} onChanged={reload} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}

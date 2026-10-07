import type { AssetEntry, BrandKit, BrandNote } from '@motion-studio/shared';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { MediaThumb } from '../components/MediaThumb.tsx';
import { ProposalReview } from '../components/ProposalReview.tsx';
import { SourceBadge } from '../components/SourceBadge.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { useProjectData } from '../useProjectData.ts';

const MANUAL = { kind: 'manual' as const, ref: null };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const nextId = (prefix: string, ids: string[]) => { for (let n = 1; ; n++) if (!ids.includes(`${prefix}-${n}`)) return `${prefix}-${n}`; };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="card stack" aria-label={title}><h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>{children}</section>;
}

function NoteList({ label, prefix, items, disabled, onChange }: { label: string; prefix: string; items: BrandNote[]; disabled: boolean; onChange(next: BrandNote[]): void }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {items.map((n, k) => (
        <div key={n.id} className="row" style={{ gap: 6 }}>
          <input aria-label={`${label} ${k + 1}`} value={n.text} disabled={disabled} style={{ flex: 1, width: 'auto' }}
            onChange={(e) => onChange(items.map((x, i) => (i === k ? { ...x, text: e.target.value, source: MANUAL } : x)))} />
          <SourceBadge source={n.source} />
          <button type="button" disabled={disabled} aria-label={`Rimuovi ${label.toLowerCase()} ${k + 1}`} onClick={() => onChange(items.filter((_, i) => i !== k))}>Rimuovi</button>
        </div>
      ))}
      <button type="button" disabled={disabled} style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...items, { id: nextId(prefix, items.map((i) => i.id)), text: 'Nuova regola', source: MANUAL }])}>+ Regola</button>
    </div>
  );
}

export function BrandPage({ slug, live }: { slug: string; live: EventsState }) {
  const tick = live.projectTicks[slug] ?? 0;
  const { data, error, reload } = useProjectData(() => Promise.all([api.getBrand(slug), api.listAssets(slug).catch(() => ({ assets: [] as AssetEntry[], error: null, unregistered: [] }))]), [slug, tick]);
  const [draft, setDraft] = useState<BrandKit | null>(null);
  const [guidelines, setGuidelines] = useState('');
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const overview = data?.[0];
  const assets = data?.[1].assets ?? [];
  useEffect(() => { if (overview) { setDraft(overview.kit); setGuidelines(overview.guidelines); } }, [overview]);
  const job = useMemo(() => Object.values(live.jobs).filter((j) => j.key === overview?.jobKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0], [live.jobs, overview?.jobKey]);
  const running = job && (job.state === 'queued' || job.state === 'running');
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setActionError(null); setStatus(null);
    try { await fn(); if (ok) setStatus(ok); reload(); } catch (e) { setActionError(msg(e)); }
  };

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!overview || !draft) return <p className="muted">Caricamento…</p>;
  const locked = Boolean(overview.kitError);
  const dirty = JSON.stringify(draft) !== JSON.stringify(overview.kit);
  const set = <K extends keyof BrandKit>(k: K, v: BrandKit[K]) => setDraft({ ...draft, [k]: v });
  const openProposal = overview.proposals.find((p) => p.status === 'open');

  return (
    <div className="stack">
      {overview.kitError && <p role="alert" className="error">Il file brand/brand-kit.json non è leggibile: correggilo o eliminalo per continuare. ({overview.kitError})</p>}
      {overview.sourcesError && <p className="error">{overview.sourcesError}</p>}
      {actionError && <p role="alert" className="error">{actionError}</p>}
      {openProposal && <ProposalReview key={openProposal.id} slug={slug} proposal={openProposal} onDone={reload} />}

      <Section title="Palette">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
          {draft.colors.map((c, k) => {
            const edit = (patch: Partial<typeof c>) => set('colors', draft.colors.map((x, i) => (i === k ? { ...x, ...patch, source: MANUAL } : x)));
            return (
              <div key={c.id} className="stack" style={{ gap: 6, padding: 10, border: '1px solid var(--border)', borderRadius: 10 }}>
                <div style={{ height: 48, borderRadius: 8, background: /^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : 'transparent', border: '1px solid var(--border)' }} />
                <input aria-label={`Nome colore ${k + 1}`} value={c.name} disabled={locked} onChange={(e) => edit({ name: e.target.value })} />
                <input aria-label={`Hex colore ${k + 1}`} className="mono" value={c.hex} disabled={locked} onChange={(e) => edit({ hex: e.target.value })} />
                <select aria-label={`Ruolo colore ${k + 1}`} value={c.role} disabled={locked} onChange={(e) => edit({ role: e.target.value as typeof c.role })}>
                  {['primary', 'secondary', 'accent', 'background', 'text', 'other'].map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <div className="row" style={{ gap: 6 }}><SourceBadge source={c.source} /><div style={{ flex: 1 }} />
                  <button type="button" disabled={locked} aria-label={`Rimuovi colore ${k + 1}`} onClick={() => set('colors', draft.colors.filter((_, i) => i !== k))}>Rimuovi</button></div>
              </div>
            );
          })}
        </div>
        <button type="button" disabled={locked} style={{ alignSelf: 'flex-start' }} onClick={() => set('colors', [...draft.colors, { id: nextId('colore', draft.colors.map((c) => c.id)), name: 'Nuovo colore', hex: '#000000', role: 'other', source: MANUAL }])}>+ Colore</button>
      </Section>

      <Section title="Font">
        {draft.fonts.map((f, k) => {
          const edit = (patch: Partial<typeof f>) => set('fonts', draft.fonts.map((x, i) => (i === k ? { ...x, ...patch, source: MANUAL } : x)));
          return (
            <div key={f.id} className="row" style={{ gap: 6 }}>
              <input aria-label={`Famiglia font ${k + 1}`} value={f.family} disabled={locked} onChange={(e) => edit({ family: e.target.value })} style={{ flex: '1 1 160px', width: 'auto' }} />
              <select aria-label={`Ruolo font ${k + 1}`} value={f.role} disabled={locked} onChange={(e) => edit({ role: e.target.value as typeof f.role })}>
                {['heading', 'body', 'accent', 'other'].map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <input aria-label={`Pesi font ${k + 1}`} value={f.weights.join(', ')} disabled={locked} style={{ width: 120 }}
                onChange={(e) => edit({ weights: e.target.value.split(',').map((w) => Number(w.trim())).filter((w) => Number.isInteger(w) && w >= 100 && w <= 900) })} />
              <select aria-label={`File font ${k + 1}`} value={f.file ?? ''} disabled={locked} onChange={(e) => edit({ file: e.target.value || null })}>
                <option value="">Nessun file</option>
                {assets.filter((a) => a.kind === 'font').map((a) => <option key={a.file} value={`assets/${a.file}`}>{a.file}</option>)}
              </select>
              <span style={{ fontFamily: `'${f.family}', var(--font)`, fontSize: 18 }}>Aa Bb Cc 123</span>
              <SourceBadge source={f.source} />
              <button type="button" disabled={locked} aria-label={`Rimuovi font ${k + 1}`} onClick={() => set('fonts', draft.fonts.filter((_, i) => i !== k))}>Rimuovi</button>
            </div>
          );
        })}
        <button type="button" disabled={locked} style={{ alignSelf: 'flex-start' }} onClick={() => set('fonts', [...draft.fonts, { id: nextId('font', draft.fonts.map((x) => x.id)), family: 'Nuovo font', role: 'body', weights: [400], file: null, source: MANUAL }])}>+ Font</button>
      </Section>

      <Section title="Loghi">
        <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
          {draft.logos.map((l, k) => {
            const edit = (patch: Partial<typeof l>) => set('logos', draft.logos.map((x, i) => (i === k ? { ...x, ...patch, source: MANUAL } : x)));
            return (
              <div key={l.id} className="stack" style={{ gap: 6, width: 180 }}>
                <div style={{ height: 100, borderRadius: 8, background: l.background === 'dark' ? 'var(--logo-bg-dark)' : 'var(--logo-bg-light)', border: '1px solid var(--border)', overflow: 'hidden' }}>
                  <MediaThumb src={api.projectFileUrl(slug, l.file)} alt={`Logo ${l.id}`} style={{ objectFit: 'contain' }} />
                </div>
                <select aria-label={`Variante logo ${k + 1}`} value={l.variant} disabled={locked} onChange={(e) => edit({ variant: e.target.value as typeof l.variant })}>
                  {['primary', 'secondary', 'mono', 'icon', 'other'].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <select aria-label={`Sfondo logo ${k + 1}`} value={l.background} disabled={locked} onChange={(e) => edit({ background: e.target.value as typeof l.background })}>
                  {['light', 'dark', 'any'].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <SourceBadge source={l.source} />
                <button type="button" disabled={locked} aria-label={`Rimuovi logo ${k + 1}`} onClick={() => set('logos', draft.logos.filter((_, i) => i !== k))}>Rimuovi</button>
              </div>
            );
          })}
        </div>
        <select aria-label="Aggiungi logo dagli asset" value="" disabled={locked} onChange={(e) => e.target.value && set('logos', [...draft.logos, { id: nextId('logo', draft.logos.map((x) => x.id)), file: e.target.value, variant: 'primary', background: 'any', source: MANUAL }])}>
          <option value="">Aggiungi logo dagli asset…</option>
          {assets.filter((a) => a.kind === 'svg' || a.kind === 'image').map((a) => <option key={a.file} value={`assets/${a.file}`}>{a.file}</option>)}
        </select>
      </Section>

      <Section title="Tono e stile">
        <label htmlFor="bp-tone"><strong>Tono di voce</strong></label>
        <textarea id="bp-tone" rows={2} disabled={locked} value={draft.tone?.text ?? ''} onChange={(e) => set('tone', e.target.value.trim() ? { id: 'tone', text: e.target.value, source: MANUAL } : null)} />
        <label htmlFor="bp-photo"><strong>Stile fotografico</strong></label>
        <textarea id="bp-photo" rows={2} disabled={locked} value={draft.photoStyle?.text ?? ''} onChange={(e) => set('photoStyle', e.target.value.trim() ? { id: 'photo-style', text: e.target.value, source: MANUAL } : null)} />
        <strong>Fare</strong>
        <NoteList label="Fare" prefix="fare" items={draft.dos} disabled={locked} onChange={(v) => set('dos', v)} />
        <strong>Evitare</strong>
        <NoteList label="Evitare" prefix="evitare" items={draft.donts} disabled={locked} onChange={(v) => set('donts', v)} />
      </Section>

      <div className="row">
        <div style={{ flex: 1 }} />
        {status && <span role="status" className="muted">{status}</span>}
        <button type="button" disabled={!dirty || locked} onClick={() => setDraft(overview.kit)}>Annulla modifiche</button>
        <button type="button" className="primary" disabled={!dirty || locked} onClick={() => void act(() => api.saveBrandKit(slug, draft), 'Brand kit salvato')}>Salva brand kit</button>
      </div>

      <Section title="Linee guida">
        <label htmlFor="bp-guidelines" className="muted">Linee guida (Markdown)</label>
        <textarea id="bp-guidelines" rows={10} className="mono" value={guidelines} onChange={(e) => setGuidelines(e.target.value)} />
        <button type="button" style={{ alignSelf: 'flex-end' }} disabled={guidelines === overview.guidelines} onClick={() => void act(() => api.saveGuidelines(slug, guidelines), 'Linee guida salvate')}>Salva linee guida</button>
      </Section>

      <Section title="Sorgenti e analisi">
        {overview.sources.map((s) => (
          <div key={s.id} className="row" style={{ gap: 8 }}>
            <span className="badge">{s.kind === 'website' ? 'Sito' : 'Immagine'}</span>
            <span className="mono" style={{ overflowWrap: 'anywhere', flex: 1 }}>{s.url ?? s.file}</span>
            <span className="muted" style={{ fontSize: 12 }}>{s.lastAnalyzedAt ? `Analizzata il ${new Date(s.lastAnalyzedAt).toLocaleDateString('it-IT')}` : 'Mai analizzata'}</span>
            <button type="button" aria-label={`Rimuovi sorgente ${s.id}`} onClick={() => void act(() => api.removeBrandSource(slug, s.id))}>Rimuovi</button>
          </div>
        ))}
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.addBrandSource(slug, { kind: 'website', url: url.trim() }); setUrl(''); }); }}>
          <input aria-label="Indirizzo del sito" placeholder="https://www.esempio.it" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1, width: 'auto' }} />
          <button type="submit" disabled={!url.trim()}>Aggiungi sito</button>
        </form>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Le immagini si aggiungono dalla scheda Riferimenti, spuntando "Usa per l'analisi brand".</p>
        <div className="row">
          {running && <><span className="badge run">Analisi in corso…</span><button type="button" onClick={() => void api.cancelJob(job!.id).catch((e: unknown) => setActionError(msg(e)))}>Annulla</button></>}
          {job?.state === 'failed' && <span className="error">Analisi non riuscita: {job.error}</span>}
          <div style={{ flex: 1 }} />
          <button type="button" className="primary" disabled={Boolean(running)} onClick={() => void act(() => api.analyzeBrand(slug))}>Analizza brand</button>
        </div>
        {overview.proposals.filter((p) => p.status !== 'open').slice(0, 5).map((p) => (
          <span key={p.id} className="muted" style={{ fontSize: 12 }}>{new Date(p.createdAt).toLocaleString('it-IT')} · proposta {p.status === 'applied' ? 'applicata' : 'scartata'}</span>
        ))}
      </Section>
    </div>
  );
}

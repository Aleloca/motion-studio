import type { AssetEntry, BrandColor, BrandFont, BrandKit, BrandLogo, BrandNote } from '@motion-studio/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import { MediaThumb } from '../components/MediaThumb.tsx';
import { ProposalReview } from '../components/ProposalReview.tsx';
import { SourceBadge } from '../components/SourceBadge.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { formatDate, formatDateTime, useLocale, useT } from '../i18n.tsx';
import { brandJobFailedText, brandJobRunningText, isActiveJob, isDescribeJob } from '../labels.ts';
import { useProjectData } from '../useProjectData.ts';

const MANUAL = { kind: 'manual' as const, ref: null };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const nextId = (prefix: string, ids: string[]) => { for (let n = 1; ; n++) if (!ids.includes(`${prefix}-${n}`)) return `${prefix}-${n}`; };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="card stack" aria-label={title}><h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>{children}</section>;
}

function NoteList({ itemLabel, removeLabel, prefix, items, disabled, onChange }: { itemLabel(n: number): string; removeLabel(n: number): string; prefix: string; items: BrandNote[]; disabled: boolean; onChange(next: BrandNote[]): void }) {
  const t = useT();
  return (
    <div className="stack" style={{ gap: 6 }}>
      {items.map((n, k) => (
        <div key={n.id} className="row" style={{ gap: 6 }}>
          <input aria-label={itemLabel(k + 1)} value={n.text} disabled={disabled} style={{ flex: 1, width: 'auto' }}
            onChange={(e) => onChange(items.map((x, i) => (i === k ? { ...x, text: e.target.value, source: MANUAL } : x)))} />
          <SourceBadge source={n.source} />
          <button type="button" disabled={disabled} aria-label={removeLabel(k + 1)} onClick={() => onChange(items.filter((_, i) => i !== k))}>{t.web.common.remove}</button>
        </div>
      ))}
      <button type="button" disabled={disabled} style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...items, { id: nextId(prefix, items.map((i) => i.id)), text: t.web.brand.newRule, source: MANUAL }])}>{t.web.brand.addRule}</button>
    </div>
  );
}

export function BrandPage({ slug, live }: { slug: string; live: EventsState }) {
  const t = useT();
  const locale = useLocale();
  const tick = live.projectTicks[slug] ?? 0;
  const { data, error, reload } = useProjectData(() => Promise.all([api.getBrand(slug), api.listAssets(slug).catch(() => ({ assets: [] as AssetEntry[], error: null, unregistered: [] }))]), [slug, tick]);
  const [draft, setDraft] = useState<BrandKit | null>(null);
  const [guidelines, setGuidelines] = useState('');
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rawWeights, setRawWeights] = useState<Record<string, string>>({});
  const [rawText, setRawText] = useState<{ tone?: string; photo?: string }>({});
  const seeded = useRef<{ kit: string; guidelines: string } | null>(null);

  const overview = data?.[0];
  const assets = data?.[1].assets ?? [];
  // Reseed each field from the server only when it has no unsaved edits (it still equals what was seeded last).
  useEffect(() => {
    if (!overview) return;
    const prev = seeded.current;
    setDraft((d) => (d === null || !prev || JSON.stringify(d) === prev.kit ? overview.kit : d));
    setGuidelines((g) => (!prev || g === prev.guidelines ? overview.guidelines : g));
    seeded.current = { kit: JSON.stringify(overview.kit), guidelines: overview.guidelines };
  }, [overview]);
  const job = useMemo(() => Object.values(live.jobs).filter((j) => j.key === overview?.jobKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0], [live.jobs, overview?.jobKey]);
  const running = isActiveJob(job);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setActionError(null); setStatus(null);
    try { await fn(); if (ok) setStatus(ok); reload(); } catch (e) { setActionError(msg(e)); }
  };

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!overview || !draft) return <p className="muted">{t.common.loading}</p>;
  const locked = Boolean(overview.kitError);
  const dirty = JSON.stringify(draft) !== JSON.stringify(overview.kit);
  const set = <K extends keyof BrandKit>(k: K, v: BrandKit[K]) => setDraft({ ...draft, [k]: v });
  const openProposal = overview.proposals.find((p) => p.status === 'open');
  // A failed analysis stays visible only until a newer proposal exists (a later analysis succeeded).
  const failure = job?.state === 'failed' && (isDescribeJob(job) || !overview.proposals.some((p) => p.createdAt > job.createdAt)) ? brandJobFailedText(job, t) : null;

  return (
    <div className="stack">
      {overview.kitError && <p role="alert" className="error">{t.web.brand.kitUnreadable({ error: overview.kitError })}</p>}
      {overview.sourcesError && <p className="error">{overview.sourcesError}</p>}
      {actionError && <p role="alert" className="error">{actionError}</p>}
      {openProposal && <ProposalReview key={openProposal.id} slug={slug} proposal={openProposal} onDone={reload} />}

      <Section title={t.web.brand.palette}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
          {draft.colors.map((c, k) => {
            const edit = (patch: Partial<typeof c>) => set('colors', draft.colors.map((x, i) => (i === k ? { ...x, ...patch, source: MANUAL } : x)));
            return (
              <div key={c.id} className="stack" style={{ gap: 6, padding: 10, border: '1px solid var(--border)', borderRadius: 10 }}>
                <div style={{ height: 48, borderRadius: 8, background: /^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : 'transparent', border: '1px solid var(--border)' }} />
                <input aria-label={t.web.brand.colorName({ n: k + 1 })} value={c.name} disabled={locked} onChange={(e) => edit({ name: e.target.value })} />
                <input aria-label={t.web.brand.colorHex({ n: k + 1 })} className="mono" value={c.hex} disabled={locked} onChange={(e) => edit({ hex: e.target.value })} />
                <select aria-label={t.web.brand.colorRole({ n: k + 1 })} value={c.role} disabled={locked} onChange={(e) => edit({ role: e.target.value as typeof c.role })}>
                  {(Object.keys(t.web.labels.colorRoles) as Array<BrandColor['role']>).map((r) => <option key={r} value={r}>{t.web.labels.colorRoles[r]}</option>)}
                </select>
                <div className="row" style={{ gap: 6 }}><SourceBadge source={c.source} /><div style={{ flex: 1 }} />
                  <button type="button" disabled={locked} aria-label={t.web.brand.removeColor({ n: k + 1 })} onClick={() => set('colors', draft.colors.filter((_, i) => i !== k))}>{t.web.common.remove}</button></div>
              </div>
            );
          })}
        </div>
        <button type="button" disabled={locked} style={{ alignSelf: 'flex-start' }} onClick={() => set('colors', [...draft.colors, { id: nextId('colore', draft.colors.map((c) => c.id)), name: t.web.brand.newColor, hex: '#000000', role: 'other', source: MANUAL }])}>{t.web.brand.addColor}</button>
      </Section>

      <Section title={t.web.brand.fonts}>
        {draft.fonts.map((f, k) => {
          const edit = (patch: Partial<typeof f>) => set('fonts', draft.fonts.map((x, i) => (i === k ? { ...x, ...patch, source: MANUAL } : x)));
          return (
            <div key={f.id} className="row" style={{ gap: 6 }}>
              <input aria-label={t.web.brand.fontFamily({ n: k + 1 })} value={f.family} disabled={locked} onChange={(e) => edit({ family: e.target.value })} style={{ flex: '1 1 160px', width: 'auto' }} />
              <select aria-label={t.web.brand.fontRole({ n: k + 1 })} value={f.role} disabled={locked} onChange={(e) => edit({ role: e.target.value as typeof f.role })}>
                {(Object.keys(t.web.labels.fontRoles) as Array<BrandFont['role']>).map((r) => <option key={r} value={r}>{t.web.labels.fontRoles[r]}</option>)}
              </select>
              <input aria-label={t.web.brand.fontWeights({ n: k + 1 })} value={rawWeights[f.id] ?? f.weights.join(', ')} disabled={locked} style={{ width: 120 }}
                onChange={(e) => { setRawWeights({ ...rawWeights, [f.id]: e.target.value }); edit({ weights: e.target.value.split(',').map((w) => Number(w.trim())).filter((w) => Number.isInteger(w) && w >= 100 && w <= 900) }); }}
                onBlur={() => setRawWeights(({ [f.id]: _drop, ...rest }) => rest)} />
              <select aria-label={t.web.brand.fontFile({ n: k + 1 })} value={f.file ?? ''} disabled={locked} onChange={(e) => edit({ file: e.target.value || null })}>
                <option value="">{t.web.brand.noFile}</option>
                {assets.filter((a) => a.kind === 'font').map((a) => <option key={a.file} value={`assets/${a.file}`}>{a.file}</option>)}
              </select>
              <span style={{ fontFamily: `'${f.family}', var(--font)`, fontSize: 18 }}>Aa Bb Cc 123</span>
              <SourceBadge source={f.source} />
              <button type="button" disabled={locked} aria-label={t.web.brand.removeFont({ n: k + 1 })} onClick={() => set('fonts', draft.fonts.filter((_, i) => i !== k))}>{t.web.common.remove}</button>
            </div>
          );
        })}
        <button type="button" disabled={locked} style={{ alignSelf: 'flex-start' }} onClick={() => set('fonts', [...draft.fonts, { id: nextId('font', draft.fonts.map((x) => x.id)), family: t.web.brand.newFont, role: 'body', weights: [400], file: null, source: MANUAL }])}>{t.web.brand.addFont}</button>
      </Section>

      <Section title={t.web.brand.logos}>
        <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
          {draft.logos.map((l, k) => {
            const edit = (patch: Partial<typeof l>) => set('logos', draft.logos.map((x, i) => (i === k ? { ...x, ...patch, source: MANUAL } : x)));
            return (
              <div key={l.id} className="stack" style={{ gap: 6, width: 180 }}>
                <div style={{ height: 100, borderRadius: 8, background: l.background === 'dark' ? 'var(--logo-bg-dark)' : 'var(--logo-bg-light)', border: '1px solid var(--border)', overflow: 'hidden' }}>
                  <MediaThumb src={api.projectFileUrl(slug, l.file)} alt={t.web.brand.logoAlt({ id: l.id })} style={{ objectFit: 'contain' }} />
                </div>
                <select aria-label={t.web.brand.logoVariant({ n: k + 1 })} value={l.variant} disabled={locked} onChange={(e) => edit({ variant: e.target.value as typeof l.variant })}>
                  {(Object.keys(t.web.labels.logoVariants) as Array<BrandLogo['variant']>).map((v) => <option key={v} value={v}>{t.web.labels.logoVariants[v]}</option>)}
                </select>
                <select aria-label={t.web.brand.logoBackground({ n: k + 1 })} value={l.background} disabled={locked} onChange={(e) => edit({ background: e.target.value as typeof l.background })}>
                  {(Object.keys(t.web.labels.logoBackgrounds) as Array<BrandLogo['background']>).map((v) => <option key={v} value={v}>{t.web.labels.logoBackgrounds[v]}</option>)}
                </select>
                <SourceBadge source={l.source} />
                <button type="button" disabled={locked} aria-label={t.web.brand.removeLogo({ n: k + 1 })} onClick={() => set('logos', draft.logos.filter((_, i) => i !== k))}>{t.web.common.remove}</button>
              </div>
            );
          })}
        </div>
        <select aria-label={t.web.brand.addLogoFromAssets} value="" disabled={locked} onChange={(e) => e.target.value && set('logos', [...draft.logos, { id: nextId('logo', draft.logos.map((x) => x.id)), file: e.target.value, variant: 'primary', background: 'any', source: MANUAL }])}>
          <option value="">{t.web.brand.addLogoFromAssetsOption}</option>
          {assets.filter((a) => a.kind === 'svg' || a.kind === 'image').map((a) => <option key={a.file} value={`assets/${a.file}`}>{a.file}</option>)}
        </select>
      </Section>

      <Section title={t.web.brand.toneAndStyle}>
        <label htmlFor="bp-tone"><strong>{t.web.brand.toneOfVoice}</strong></label>
        <textarea id="bp-tone" rows={2} disabled={locked} value={rawText.tone ?? draft.tone?.text ?? ''} onBlur={() => setRawText({ ...rawText, tone: undefined })}
          onChange={(e) => { setRawText({ ...rawText, tone: e.target.value }); set('tone', e.target.value.trim() ? { id: 'tone', text: e.target.value.trim(), source: MANUAL } : null); }} />
        <label htmlFor="bp-photo"><strong>{t.web.brand.photoStyle}</strong></label>
        <textarea id="bp-photo" rows={2} disabled={locked} value={rawText.photo ?? draft.photoStyle?.text ?? ''} onBlur={() => setRawText({ ...rawText, photo: undefined })}
          onChange={(e) => { setRawText({ ...rawText, photo: e.target.value }); set('photoStyle', e.target.value.trim() ? { id: 'photo-style', text: e.target.value.trim(), source: MANUAL } : null); }} />
        <strong>{t.web.brand.doHeading}</strong>
        <NoteList itemLabel={(n) => t.web.brand.doItem({ n })} removeLabel={(n) => t.web.brand.removeDo({ n })} prefix="fare" items={draft.dos} disabled={locked} onChange={(v) => set('dos', v)} />
        <strong>{t.web.brand.avoidHeading}</strong>
        <NoteList itemLabel={(n) => t.web.brand.avoidItem({ n })} removeLabel={(n) => t.web.brand.removeAvoid({ n })} prefix="evitare" items={draft.donts} disabled={locked} onChange={(v) => set('donts', v)} />
      </Section>

      <div className="row">
        <div style={{ flex: 1 }} />
        {status && <span role="status" className="muted">{status}</span>}
        <button type="button" disabled={!dirty || locked} onClick={() => { setDraft(overview.kit); setRawWeights({}); setRawText({}); }}>{t.web.brand.discard}</button>
        <button type="button" className="primary" disabled={!dirty || locked} onClick={() => void act(async () => { await api.saveBrandKit(slug, draft); if (seeded.current) seeded.current.kit = JSON.stringify(draft); }, t.web.brand.kitSaved)}>{t.web.brand.saveKit}</button>
      </div>

      <Section title={t.web.brand.guidelines}>
        <label htmlFor="bp-guidelines" className="muted">{t.web.brand.guidelinesLabel}</label>
        <textarea id="bp-guidelines" rows={10} className="mono" value={guidelines} onChange={(e) => setGuidelines(e.target.value)} />
        <button type="button" style={{ alignSelf: 'flex-end' }} disabled={guidelines === overview.guidelines} onClick={() => void act(async () => { await api.saveGuidelines(slug, guidelines); if (seeded.current) seeded.current.guidelines = guidelines; }, t.web.brand.guidelinesSaved)}>{t.web.brand.saveGuidelines}</button>
      </Section>

      <Section title={t.web.brand.sourcesAndAnalysis}>
        {overview.sources.map((s) => (
          <div key={s.id} className="row" style={{ gap: 8 }}>
            <span className="badge">{s.kind === 'website' ? t.web.brand.sourceWebsite : t.web.brand.sourceImage}</span>
            <span className="mono" style={{ overflowWrap: 'anywhere', flex: 1 }}>{s.url ?? s.file}</span>
            <span className="muted" style={{ fontSize: 12 }}>{s.lastAnalyzedAt ? t.web.brand.analyzedOn({ date: formatDate(locale, s.lastAnalyzedAt) }) : t.web.brand.neverAnalyzed}</span>
            <button type="button" aria-label={t.web.brand.removeSource({ id: s.id })} onClick={() => void act(() => api.removeBrandSource(slug, s.id))}>{t.web.common.remove}</button>
          </div>
        ))}
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.addBrandSource(slug, { kind: 'website', url: url.trim() }); setUrl(''); }); }}>
          <input aria-label={t.web.brand.siteAddress} placeholder={t.web.brand.sitePlaceholder} value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1, width: 'auto' }} />
          <button type="submit" disabled={!url.trim()}>{t.web.brand.addSite}</button>
        </form>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{t.web.brand.imagesHint}</p>
        {job && Object.values(live.approvals).filter((a) => a.jobId === job.id).map((a) => <ApprovalCard key={a.id} approval={a} />)}
        <div className="row">
          {running && <><span className="badge run">{brandJobRunningText(job!, t)}</span><button type="button" onClick={() => void api.cancelJob(job!.id).catch((e: unknown) => setActionError(msg(e)))}>{t.common.cancel}</button></>}
          {failure && <span className="error">{failure}</span>}
          <div style={{ flex: 1 }} />
          <button type="button" className="primary" disabled={Boolean(running)} onClick={() => void act(() => api.analyzeBrand(slug))}>{t.web.brand.analyze}</button>
        </div>
        {overview.proposals.filter((p) => p.status !== 'open').slice(0, 5).map((p) => (
          <span key={p.id} className="muted" style={{ fontSize: 12 }}>{(p.status === 'applied' ? t.web.brand.proposalApplied : t.web.brand.proposalDiscarded)({ date: formatDateTime(locale, p.createdAt) })}</span>
        ))}
      </Section>
    </div>
  );
}

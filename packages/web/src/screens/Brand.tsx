import type { AssetEntry, BrandKit, BrandLogo, BrandOverview, BrandProposal, JobSummary, ReferenceEntry } from '@motion-studio/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type UIEvent } from 'react';
import { api } from '../api.ts';
import type { EventsState } from '../eventsReducer.ts';
import { useT } from '../i18n.tsx';
import { D, enter, isActivePage, useEnter } from '../motion/index.ts';
import { anyLayerOpen, Button, Empty, Icon, Input, NavItem, Pill, Spinner, toast } from '../ui/index.ts';
import { applyChanges, brandIsEmpty, latestBrandJob, undoChanges, MANUAL, nextId, normalizeUrl } from './brandModel.ts';
import { useBrandSaver, type BrandSaver } from './brandSave.ts';
import { isActive, BrandCtx, type SectionId, type Ctx } from './brandContext.tsx';
import { BrandReview, type AppliedProposal } from './BrandReview.tsx';
import { Colors, Typography, Logos } from './BrandKitSections.tsx';
import { Overview, Voice, PhotoStyle, Guidelines } from './BrandTextSections.tsx';
import { ProposalReady, AnalysisCard, AnalysisFailure, Sources, Health, History } from './BrandSide.tsx';
import './brand.css';
import { message } from './common.tsx';

/**
 * Project · Brand (spec §6.2 #8), ported from the prototype's BrandPage / Colors / Typography / Logos / Voice /
 * Sources / AnalysisCard and the Brand boards: section navigation with scroll-spy, an editable kit that saves itself
 * (point 14), live analysis from the job's events (point 2), the proposal review sheet (point 11) and a brand health
 * checklist derived only from the kit.
 */
export function Brand({ slug, live }: { slug: string; live: EventsState }) {
  const t = useT();
  const b = t.web.brand;
  const tick = live.projectTicks[slug] ?? 0;
  const [nonce, setNonce] = useState(0);
  const [overview, setOverview] = useState<BrandOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [references, setReferences] = useState<ReferenceEntry[]>([]);
  const [projectName, setProjectName] = useState<string | null>(null);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true; // a slow response for an older tick must not overwrite a newer one
    Promise.resolve().then(() => api.getBrand(slug))
      .then((o) => { if (alive) { setOverview(o); setLoadError(null); } })
      .catch((e: unknown) => { if (alive) setLoadError(message(e)); });
    Promise.resolve().then(() => api.listAssets(slug)).then((r) => { if (alive) setAssets(r.assets); }).catch(() => { /* pickers stay empty */ });
    Promise.resolve().then(() => api.listReferences(slug)).then((r) => { if (alive) setReferences(r.references); }).catch(() => { /* no reference images */ });
    return () => { alive = false; };
  }, [slug, tick, nonce]);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getProject(slug)).then((p) => { if (alive) setProjectName(p.project.name); }).catch(() => { /* the slug stands in */ });
    return () => { alive = false; };
  }, [slug]);

  const saver = useBrandSaver(slug, overview?.kit ?? null, reload);
  const job = overview ? latestBrandJob(live.jobs, overview.jobKey) : undefined;
  const [manual, setManual] = useState(false);

  if (loadError && !overview) {
    return (
      <div className="ms-brand-center">
        <Empty icon="warn" title={b.loadFailed({ error: loadError })} action={<Button onClick={() => { setLoadError(null); reload(); }}>{b.retry}</Button>} />
      </div>
    );
  }
  if (!overview || !saver.kit) return <div className="ms-brand-center"><Spinner size={20} /></div>;
  if (!manual && brandIsEmpty(overview, job)) return <EmptyBrand slug={slug} onManual={() => setManual(true)} onStarted={reload} />;
  return (
    <BrandPageBody slug={slug} live={live} overview={overview} setOverview={setOverview} kit={saver.kit} saver={saver} job={job}
      assets={assets} setAssets={setAssets} references={references} projectName={projectName} reload={reload} />
  );
}

interface BodyProps {
  slug: string; live: EventsState; overview: BrandOverview; setOverview(f: (o: BrandOverview | null) => BrandOverview | null): void;
  kit: BrandKit; saver: BrandSaver; job: JobSummary | undefined; assets: AssetEntry[]; setAssets(a: AssetEntry[]): void;
  references: ReferenceEntry[]; projectName: string | null; reload(): void;
}

function BrandPageBody({ slug, live, overview, setOverview, kit, saver, job, assets, setAssets, references, projectName, reload }: BodyProps) {
  const t = useT();
  const b = t.web.brand;
  const root = useEnter<HTMLDivElement>([]);
  const scroller = useRef<HTMLElement>(null);
  const settled = useRef(false);
  useEffect(() => { settled.current = true; }, []);
  const [section, setSection] = useState<SectionId>('overview');
  const locked = Boolean(overview.kitError);

  // Sections: the nav highlights the one being read (scroll-spy) and scrolls to the one clicked.
  const go = useCallback((id: SectionId) => {
    setSection(id);
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>(`[data-sec="${id}"]`);
    if (box && el && typeof box.scrollTo === 'function') box.scrollTo({ top: el.offsetTop - 20, behavior: 'smooth' });
  }, []);
  const onScroll = (e: UIEvent<HTMLElement>) => {
    const box = e.currentTarget;
    const y = box.scrollTop + 80;
    let cur: SectionId = 'overview';
    box.querySelectorAll<HTMLElement>('[data-sec]').forEach((s) => { if (s.offsetTop <= y) cur = s.dataset.sec as SectionId; });
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) cur = 'guidelines';
    if (cur !== section) setSection(cur);
  };

  // Logo upload: a hidden file input; `target` is the background the new logo is for (the "Missing: …" tile).
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<BrandLogo['background']>('any');
  const [uploading, setUploading] = useState(false);
  const addLogos = useCallback((files: string[], background: BrandLogo['background']) => {
    saver.edit((k) => {
      const logos = [...k.logos];
      for (const file of files) {
        if (logos.some((l) => l.file === file)) continue;
        logos.push({ id: nextId('logo', logos.map((l) => l.id)), file, variant: logos.length ? 'secondary' : 'primary', background, source: MANUAL });
      }
      return { ...k, logos };
    });
  }, [saver]);
  const upload = useCallback((background: BrandLogo['background']) => {
    uploadTarget.current = background;
    fileInput.current?.click();
  }, []);
  const onFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setUploading(true);
    try {
      const res = (await api.uploadFiles(slug, 'assets', files)) as { assets?: AssetEntry[] };
      const added = res.assets ?? [];
      if (added.length) {
        setAssets([...assets.filter((a) => !added.some((x) => x.file === a.file)), ...added]);
        addLogos(added.filter((a) => a.kind === 'image' || a.kind === 'svg').map((a) => `assets/${a.file}`), uploadTarget.current);
        toast.show(b.logos.added, { tone: 'ok' });
      }
    } catch (e) {
      toast.show(message(e));
    } finally {
      setUploading(false);
    }
  };

  const ctx: Ctx = {
    slug, kit, locked, saver, assets, settled, upload, go,
    addLogoFromAsset: (file, background) => addLogos([file], background),
  };

  // Analysis: the review opens by itself when an analysis this page watched ends with a proposal (point 9).
  const analysis = job?.kind === 'brand-analysis' ? job : undefined;
  const openProposal = overview.proposals.find((p) => p.status === 'open');
  const [reviewOpen, setReviewOpen] = useState(false);
  const watched = useRef<string | null>(null);
  if (analysis && isActive(analysis)) watched.current = analysis.id;
  useEffect(() => {
    if (!analysis || watched.current !== analysis.id || isActive(analysis)) return;
    if (analysis.state !== 'succeeded' || !openProposal || openProposal.createdAt < analysis.createdAt) return;
    watched.current = null;
    toast.show(b.analysis.ready, { action: { label: b.analysis.review, run: () => setReviewOpen(true) } });
    // Only when nothing would end up underneath: no popover or dialog open, no edit waiting to be saved. Otherwise
    // the toast and the "Suggestions ready" card wait for the user.
    if (isActivePage(root.current) && !anyLayerOpen() && !saver.pending()) setReviewOpen(true);
  }, [analysis, openProposal, b, root]);
  // Proposals whose Apply was undone in this session (the API keeps them "applied"): History says so.
  const [undone, setUndone] = useState<Set<string>>(() => new Set());
  const onApplied = useCallback((a: AppliedProposal) => {
    saver.rebase(a.kit, (k) => applyChanges(k, a.changes));
    if (a.guidelines) { const text = a.guidelines.after; setOverview((o) => (o ? { ...o, guidelines: text } : o)); }
    reload();
  }, [saver, setOverview, reload]);
  const guidelinesNow = useRef(overview.guidelines);
  guidelinesNow.current = overview.guidelines;
  const onUndo = useCallback((a: AppliedProposal) => {
    // An inverse of what was applied, on the kit as it is now, through the saver: later edits are kept.
    saver.edit((k) => undoChanges(k, a.changes));
    const g = a.guidelines;
    // The guidelines go back only while they still hold the proposed text (an edit made since wins).
    if (g && guidelinesNow.current === g.after) {
      void saver.saveGuidelines(g.before).then((ok) => { if (ok) setOverview((o) => (o ? { ...o, guidelines: g.before } : o)); });
    }
    setUndone((s) => new Set(s).add(a.proposalId));
    toast.show(t.web.brandReview.restored, { tone: 'ok' });
  }, [saver, setOverview, t]);
  const shownProposal = useRef<BrandProposal | null>(null);
  if (openProposal) shownProposal.current = openProposal;

  const nav: Array<[SectionId, string, number | undefined]> = [
    ['overview', b.nav.overview, undefined], ['colors', b.nav.colors, kit.colors.length], ['type', b.nav.type, kit.fonts.length],
    ['logos', b.nav.logos, kit.logos.length], ['voice', b.nav.voice, undefined], ['photo', b.nav.photo, undefined], ['guidelines', b.nav.guidelines, undefined],
  ];

  return (
    <BrandCtx.Provider value={ctx}>
      <div className="ms-bpage" ref={root}>
        <nav className="ms-brand-nav" aria-label={b.sections}>
          {nav.map(([id, label, n]) => <NavItem key={id} on={section === id} count={n} onClick={() => go(id)}>{label}</NavItem>)}
          <div className="ms-grow" />
          {!saver.status.saving && !saver.status.error ? <span className="ms-brand-allsaved">{b.save.allSaved}</span> : null}
        </nav>
        <main className="ms-brand-main" ref={scroller} onScroll={onScroll}>
          <SavePill saver={saver} />
          {overview.kitError ? <Alert>{b.kitUnreadable({ error: overview.kitError })} {b.kitLocked}</Alert> : null}
          {overview.sourcesError ? <Alert>{overview.sourcesError}</Alert> : null}
          <Overview overview={overview} projectName={projectName} />
          <Colors />
          <Typography />
          <Logos uploading={uploading} />
          <Voice />
          <div className="ms-bgrid2">
            <PhotoStyle references={references} />
            <Guidelines text={overview.guidelines} onSaved={(text) => setOverview((o) => (o ? { ...o, guidelines: text } : o))} />
          </div>
        </main>
        <aside className="ms-brand-side" aria-label={b.sources.title}>
          {openProposal ? <ProposalReady project={slug} proposal={openProposal} onReview={() => setReviewOpen(true)} /> : null}
          {analysis && isActive(analysis) ? <AnalysisCard job={analysis} live={live} /> : null}
          <AnalysisFailure job={job} proposals={overview.proposals} onRetry={reload} />
          <Sources overview={overview} job={job} reload={reload} />
          <Health />
          <History project={slug} proposals={overview.proposals} undone={undone} />
        </aside>
        <input ref={fileInput} type="file" accept="image/*,.svg" multiple hidden aria-hidden="true" tabIndex={-1} onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
      </div>
      {shownProposal.current ? (
        <BrandReview open={reviewOpen && Boolean(openProposal)} slug={slug} proposal={shownProposal.current} kit={kit} guidelines={overview.guidelines}
          sources={overview.sources} onClose={() => setReviewOpen(false)} onApplied={onApplied} onUndo={onUndo} onChanged={reload} />
      ) : null}
    </BrandCtx.Provider>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return <div className="ms-brand-alert" role="alert"><Icon name="warn" size={15} /><span>{children}</span></div>;
}

/** T12: the pill drops in on Saving…, turns into ✓ Saved, then leaves; an error stays with Retry. */
function SavePill({ saver }: { saver: BrandSaver }) {
  const t = useT();
  const s = saver.status;
  const ref = useRef<HTMLDivElement>(null);
  const shown = s.saving || s.saved || Boolean(s.error);
  const wasShown = useRef(false);
  useLayoutEffect(() => {
    if (shown && !wasShown.current) void enter(ref.current, { y: -8, ms: D.s });
    wasShown.current = shown;
  }, [shown]);
  if (!shown) return null;
  return (
    <div className="ms-brand-savepill" ref={ref} aria-live="polite">
      {s.error ? (
        <span className="ms-brand-saveerr" role="alert">
          <Pill tone="warn" dot>{t.web.brand.save.failed({ error: s.error.message })}</Pill>
          <Button size="sm" onClick={saver.retry}>{t.web.brand.save.retry}</Button>
        </span>
      ) : s.saving ? <Pill spinner>{t.web.brand.save.saving}</Pill> : <Pill tone="ok"><Icon name="check" size={11} strokeWidth={2.4} />{t.web.brand.save.saved}</Pill>}
    </div>
  );
}

/* ---------- empty project ---------- */

function EmptyBrand({ slug, onManual, onStarted }: { slug: string; onManual(): void; onStarted(): void }) {
  const t = useT();
  const e = t.web.brand.empty;
  const root = useEnter<HTMLDivElement>([]);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The source added by an earlier attempt whose analysis failed: Retry reuses it instead of adding a duplicate.
  const added = useRef<string | null>(null);
  const analyze = async (ev: FormEvent) => {
    ev.preventDefault();
    const u = normalizeUrl(url);
    if (!u) { setError(t.web.brand.sources.invalidUrl); return; }
    setBusy(true); setError(null);
    try {
      if (added.current !== u) {
        await api.addBrandSource(slug, { kind: 'website', url: u });
        added.current = u;
      }
      await api.analyzeBrand(slug);
      onStarted();
    } catch (err) { setError(message(err)); setBusy(false); }
  };
  return (
    <div className="ms-brand-empty" ref={root}>
      <form className="ms-card ms-brand-empty-card" onSubmit={(ev) => void analyze(ev)} data-enter>
        <span className="ms-bready-icon" aria-hidden="true"><Icon name="sparkle" size={16} /></span>
        <h1>{e.title}</h1>
        <p>{e.sub}</p>
        <div className="ms-brow ms-bnowrap">
          <Input className="ms-grow" value={url} aria-label={e.website} placeholder={e.placeholder} autoFocus onChange={(ev) => { setUrl(ev.target.value); setError(null); }} />
          <Button type="submit" variant="ink" loading={busy} disabled={!url.trim()}>{e.analyze}</Button>
        </div>
        {error ? <span className="ms-bwarn" role="alert">{error}</span> : null}
        <button type="button" className="ms-blink-btn ms-bstart" onClick={onManual}>{e.manual}</button>
      </form>
    </div>
  );
}

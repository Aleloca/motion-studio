import type { AssetEntry, BrandColor, BrandFont, BrandKit, BrandLogo, BrandNote, BrandOverview, BrandProposal, BrandSource, JobSummary, ReferenceEntry } from '@motion-studio/shared';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject, type UIEvent } from 'react';
import { api } from '../api.ts';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { formatDate, relativeTime, useLocale, useT } from '../i18n.tsx';
import { collapse, D, enter, isActivePage, useEnter } from '../motion/index.ts';
import { Button, Chip, cx, Empty, initials, Field, Icon, Input, Markdown, Modal, NavItem, Pill, Popover, Segmented, Select, Spinner, Tag, Textarea, toast, Typing } from '../ui/index.ts';
import { BrandReview } from './BrandReview.tsx';
import { specimenFamily, useFontPreview } from './brandFonts.ts';
import { analysisSteps, brandIsEmpty, hasLogoFor, healthChecks, hostOf, latestBrandJob, MANUAL, nextId, normalizeFamily, normalizeHex, normalizeUrl, parseWeights, ratioText, stageColor, swatchText, websiteHosts, type HealthId } from './brandModel.ts';
import { useBrandSaver, TYPING_MS, type BrandSaver } from './brandSave.ts';
import { deferRemoval } from './deferred.ts';
import './brand.css';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const IMAGE = /\.(png|jpe?g|webp|gif|svg|avif)$/i;
const SECTIONS = ['overview', 'colors', 'type', 'logos', 'voice', 'photo', 'guidelines'] as const;
type SectionId = (typeof SECTIONS)[number];
const RULES_SHOWN = 3;
const isActive = (j: JobSummary | undefined) => Boolean(j && (j.state === 'queued' || j.state === 'running'));

/** What every section needs: the kit being edited, its saver and whether editing is allowed. */
interface Ctx {
  slug: string;
  kit: BrandKit;
  locked: boolean;
  saver: BrandSaver;
  assets: AssetEntry[];
  /** True once the first data has rendered: items mounted after that are new and enter with scale(.96) (T14). */
  settled: RefObject<boolean>;
  upload(background: BrandLogo['background']): void;
  addLogoFromAsset(file: string, background: BrandLogo['background']): void;
  go(id: SectionId): void;
}
const BrandCtx = createContext<Ctx | null>(null);
const useBrand = () => useContext(BrandCtx)!;

/** T14: an item added after the page settled enters with scale(.96). */
function useAppear<T extends HTMLElement>(ref: RefObject<T | null>) {
  const { settled } = useBrand();
  useLayoutEffect(() => {
    if (settled.current) void enter(ref.current, { y: 6, scale: 0.96, ms: D.m });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** T15: collapse the element, then remove the item; the toast's Undo puts it back where it was. */
async function removeWithUndo(el: HTMLElement | null, run: () => void) {
  if (await collapse(el)) run();
}

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

  const saver = useBrandSaver(slug, overview?.kit ?? null, () => {});
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
    if (isActivePage(root.current)) setReviewOpen(true);
  }, [analysis, openProposal, b, root]);
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
          {openProposal ? <ProposalReady proposal={openProposal} onReview={() => setReviewOpen(true)} /> : null}
          {analysis && isActive(analysis) ? <AnalysisCard job={analysis} live={live} /> : null}
          <AnalysisFailure job={job} proposals={overview.proposals} onRetry={reload} />
          <Sources overview={overview} job={job} reload={reload} />
          <Health />
          <History proposals={overview.proposals} />
        </aside>
        <input ref={fileInput} type="file" accept="image/*,.svg" multiple hidden aria-hidden="true" tabIndex={-1} onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
      </div>
      {shownProposal.current ? (
        <BrandReview open={reviewOpen && Boolean(openProposal)} slug={slug} proposal={shownProposal.current} kit={kit} guidelines={overview.guidelines}
          sources={overview.sources} onClose={() => setReviewOpen(false)} onChanged={reload} />
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

/* ---------- overview ---------- */

function Overview({ overview, projectName }: { overview: BrandOverview; projectName: string | null }) {
  const t = useT();
  const b = t.web.brand;
  const locale = useLocale();
  const { slug, kit } = useBrand();
  const primary = kit.logos.find((l) => l.variant === 'primary') ?? kit.logos[0];
  const stage = primary ? stageColor(primary.background === 'dark' ? 'dark' : 'light', kit.colors) : null;
  const analyzed = overview.sources.map((s) => s.lastAnalyzedAt).filter((x): x is string => Boolean(x)).sort().at(-1);
  const hosts = websiteHosts(overview.sources).join(', ');
  const summary = [...overview.proposals].filter((p) => p.status !== 'discarded' && p.summary.trim()).sort((a, c) => c.createdAt.localeCompare(a.createdAt))[0]?.summary;
  const name = projectName ?? slug;
  return (
    <section data-sec="overview" className="ms-boverview" aria-label={b.nav.overview} data-enter>
      <div className={cx('ms-boverview-tile', !primary && 'ms-initials', primary?.background === 'dark' && !stage && 'ms-dark')} style={stage ? { background: stage } : undefined}>
        {primary ? <img src={api.projectFileUrl(slug, primary.file)} alt={b.logos.alt({ file: primary.file })} /> : <span aria-hidden="true">{initials(name)}</span>}
      </div>
      <div className="ms-boverview-text">
        <h1>{name}</h1>
        <p>{summary ?? b.overview.intro}</p>
        <span className="ms-faint">{analyzed && hosts ? b.overview.learnedFrom({ hosts, when: relativeTime(locale, analyzed) }) : b.overview.notAnalyzed}</span>
      </div>
    </section>
  );
}

/* ---------- colors ---------- */

const COLOR_ROLES: Array<BrandColor['role']> = ['primary', 'secondary', 'accent', 'background', 'text', 'other'];

function Colors() {
  const t = useT();
  const b = t.web.brand;
  const { kit, locked, saver } = useBrand();
  const [fresh, setFresh] = useState<string | null>(null);
  const add = () => {
    const id = nextId('color', kit.colors.map((c) => c.id));
    saver.edit((k) => ({ ...k, colors: [...k.colors, { id, name: b.colors.newName, hex: '#A3A3A3', role: 'other', source: MANUAL }] })); // color-data: neutral grey for a new swatch
    setFresh(id);
  };
  return (
    <section data-sec="colors" className="ms-bsection" aria-labelledby="ms-bcolors" data-enter>
      <div className="ms-bsection-head">
        <h2 id="ms-bcolors">{b.nav.colors}</h2>
        {kit.colors.length ? <span className="ms-faint">{b.colors.hint}</span> : null}
        <Button variant="ghost" size="sm" className="ms-blink" disabled={locked} onClick={add}>{b.colors.add}</Button>
      </div>
      {kit.colors.length ? (
        <div className="ms-bswatches">
          {kit.colors.map((c) => <Swatch key={c.id} c={c} autoOpen={fresh === c.id} />)}
        </div>
      ) : <p className="ms-bempty-line">{b.colors.empty}</p>}
    </section>
  );
}

function Swatch({ c, autoOpen }: { c: BrandColor; autoOpen: boolean }) {
  const t = useT();
  const b = t.web.brand;
  const { kit, locked, saver } = useBrand();
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(autoOpen);
  const [name, setName] = useState(c.name);
  const [hex, setHex] = useState(c.hex.slice(1));
  useAppear(wrap);
  // Keep the fields in step with the kit while closed (an Undo, a reload).
  useEffect(() => { if (!open) { setName(c.name); setHex(c.hex.slice(1)); } }, [c.name, c.hex, open]);
  const text = swatchText(c.hex, kit.colors);
  const update = (patch: Partial<BrandColor>, wait = 0) =>
    saver.edit((k) => ({ ...k, colors: k.colors.map((x) => (x.id === c.id ? { ...x, ...patch, source: MANUAL } : x)) }), wait);
  const close = () => { setOpen(false); saver.flush(); };
  const hexOk = normalizeHex(hex) !== null;
  const remove = () => {
    setOpen(false);
    const index = kit.colors.findIndex((x) => x.id === c.id);
    void removeWithUndo(wrap.current, () => {
      saver.edit((k) => ({ ...k, colors: k.colors.filter((x) => x.id !== c.id) }));
      toast.show(b.colors.removed({ name: c.name }), {
        action: { label: b.undo, run: () => saver.edit((k) => (k.colors.some((x) => x.id === c.id) ? k : { ...k, colors: [...k.colors.slice(0, index), c, ...k.colors.slice(index)] })) },
      });
    });
  };
  return (
    <div className="ms-bswatch-wrap" ref={wrap}>
      <button ref={btn} type="button" className={cx('ms-bswatch', open && 'ms-on')} aria-label={b.colors.edit({ name: c.name })} aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <span className="ms-bswatch-color" style={{ background: c.hex }}>
          <span className="ms-bswatch-aa" style={{ color: text.color }} title={b.colors.contrast({ ratio: ratioText(text.ratio), name: text.name ?? text.color })}>{`Aa ${ratioText(text.ratio)}`}</span>
        </span>
        <span className="ms-bswatch-meta">
          <b>{c.name}</b>
          <span className="ms-mono">{c.hex.slice(1)}</span>
          <span className="ms-faint">{t.web.labels.colorRoles[c.role]}</span>
        </span>
      </button>
      <Popover open={open} onClose={close} anchor={btn} width={250}>
        <div className="ms-bpop">
          <span className="ms-cap">{b.colors.popTitle}</span>
          <label className="ms-bpop-field">
            <span>{b.colors.name}</span>
            <Input value={name} disabled={locked} aria-label={b.colors.name} aria-invalid={!name.trim() || undefined}
              onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) update({ name: e.target.value.trim() }, TYPING_MS); }} />
          </label>
          <div className="ms-bpop-field">
            <span>{b.colors.hex}</span>
            <div className="ms-bhex">
              <span className="ms-bhex-chip" style={{ background: normalizeHex(hex) ?? c.hex }} aria-hidden="true" />
              <Field prefix="#" className="ms-grow">
                <input value={hex} maxLength={7} disabled={locked} aria-label={b.colors.hex} aria-invalid={!hexOk || undefined} spellCheck={false}
                  onChange={(e) => { const v = e.target.value.replace(/[^0-9a-fA-F#]/g, '').replace(/^#/, '').toUpperCase(); setHex(v); const n = normalizeHex(v); if (n) update({ hex: n }, TYPING_MS); }} />
              </Field>
            </div>
            {!hexOk ? <small className="ms-bwarn">{b.colors.hexInvalid}</small> : null}
          </div>
          <div className="ms-bpop-field">
            <span>{b.colors.role}</span>
            <div className="ms-bchips">
              {COLOR_ROLES.map((r) => <Chip key={r} on={c.role === r} onClick={locked ? undefined : () => update({ role: r })}>{t.web.labels.colorRoles[r]}</Chip>)}
            </div>
          </div>
          <Button variant="danger" size="sm" disabled={locked} onClick={remove}><Icon name="trash" size={13} />{b.colors.remove}</Button>
        </div>
      </Popover>
    </div>
  );
}

/* ---------- typography ---------- */

function Typography() {
  const t = useT();
  const b = t.web.brand;
  const { kit, locked, saver } = useBrand();
  const [fresh, setFresh] = useState<string | null>(null);
  const add = () => {
    const id = nextId('font', kit.fonts.map((f) => f.id));
    saver.edit((k) => ({ ...k, fonts: [...k.fonts, { id, family: b.fonts.newFamily, role: 'body', weights: [400], file: null, source: MANUAL }] }));
    setFresh(id);
  };
  return (
    <section data-sec="type" className="ms-bsection" aria-labelledby="ms-btype" data-enter>
      <div className="ms-bsection-head">
        <h2 id="ms-btype">{b.nav.type}</h2>
        <span className="ms-faint">{b.fonts.hint}</span>
        <Button variant="ghost" size="sm" className="ms-blink" disabled={locked} onClick={add}>{b.fonts.add}</Button>
      </div>
      {kit.fonts.length ? (
        <div className="ms-bfonts">{kit.fonts.map((f) => <FontCard key={f.id} f={f} autoOpen={fresh === f.id} />)}</div>
      ) : <p className="ms-bempty-line">{b.fonts.empty}</p>}
    </section>
  );
}

function FontCard({ f, autoOpen }: { f: BrandFont; autoOpen: boolean }) {
  const t = useT();
  const b = t.web.brand;
  const { slug } = useBrand();
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(autoOpen);
  useAppear(wrap);
  const preview = useFontPreview(f.file ? api.projectFileUrl(slug, f.file) : null);
  const family = specimenFamily(preview);
  return (
    <div className="ms-card ms-bfont" ref={wrap}>
      <div className="ms-bfont-top">
        <Tag>{t.web.labels.fontRoles[f.role]}</Tag>
        {f.file ? <span className="ms-bok">{b.fonts.inProject}</span> : <span className="ms-bwarn">{b.fonts.noFile}</span>}
      </div>
      <span className="ms-bfont-specimen" style={{ fontFamily: family }}>{b.fonts.specimen}</span>
      <span className="ms-bfont-sample" style={{ fontFamily: family }}>{b.fonts.sample}</span>
      {preview.state === 'none' ? <span className="ms-bnote">{b.fonts.noPreview}</span> : null}
      {preview.state === 'failed' ? <span className="ms-bnote">{b.fonts.loadFailed}</span> : null}
      <div className="ms-bfont-foot">
        <b className="ms-ell">{f.family}</b>
        <span className="ms-mono ms-muted">{f.weights.join(' · ')}</span>
        <button ref={btn} type="button" className="ms-blink-btn" aria-label={b.fonts.edit({ family: f.family })} aria-expanded={open} onClick={() => setOpen(!open)}>{t.web.brand.voice.edit}</button>
      </div>
      <FontEditor f={f} open={open} onClose={() => setOpen(false)} anchor={btn} wrap={wrap} />
    </div>
  );
}

function FontEditor({ f, open, onClose, anchor, wrap }: { f: BrandFont; open: boolean; onClose(): void; anchor: RefObject<HTMLButtonElement | null>; wrap: RefObject<HTMLDivElement | null> }) {
  const t = useT();
  const b = t.web.brand;
  const { kit, locked, saver, assets } = useBrand();
  const [family, setFamily] = useState(f.family);
  const [weights, setWeights] = useState(f.weights.join(', '));
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (!open) { setFamily(f.family); setWeights(f.weights.join(', ')); setNote(null); } }, [open, f.family, f.weights]);
  const update = (patch: Partial<BrandFont>) => saver.edit((k) => ({ ...k, fonts: k.fonts.map((x) => (x.id === f.id ? { ...x, ...patch, source: MANUAL } : x)) }));
  // Point 15: a pasted CSS stack keeps only its first family, and says so.
  const commitFamily = () => {
    const raw = family.trim();
    const first = normalizeFamily(raw);
    if (!first) return;
    setNote(first !== raw ? b.fonts.familyNormalized({ family: first }) : null);
    setFamily(first);
    if (first !== f.family) update({ family: first });
  };
  const commitWeights = () => {
    const w = parseWeights(weights);
    if (w && w.join() !== f.weights.join()) update({ weights: w });
    setWeights((w ?? f.weights).join(', '));
  };
  const close = () => { commitFamily(); commitWeights(); onClose(); };
  const fontAssets = assets.filter((a) => a.kind === 'font');
  const fileOptions = [{ value: '', label: b.fonts.noFileOption }, ...fontAssets.map((a) => ({ value: `assets/${a.file}`, label: a.file }))];
  if (f.file && !fileOptions.some((o) => o.value === f.file)) fileOptions.push({ value: f.file, label: f.file });
  const remove = () => {
    onClose();
    const index = kit.fonts.findIndex((x) => x.id === f.id);
    void removeWithUndo(wrap.current, () => {
      saver.edit((k) => ({ ...k, fonts: k.fonts.filter((x) => x.id !== f.id) }));
      toast.show(b.fonts.removed({ family: f.family }), {
        action: { label: b.undo, run: () => saver.edit((k) => (k.fonts.some((x) => x.id === f.id) ? k : { ...k, fonts: [...k.fonts.slice(0, index), f, ...k.fonts.slice(index)] })) },
      });
    });
  };
  return (
    <Popover open={open} onClose={close} anchor={anchor} width={280} placement="bottom-end">
      <form className="ms-bpop" onSubmit={(e) => { e.preventDefault(); commitFamily(); commitWeights(); }}>
        <span className="ms-cap">{b.fonts.popTitle}</span>
        <label className="ms-bpop-field">
          <span>{b.fonts.family}</span>
          <Input value={family} disabled={locked} aria-label={b.fonts.family} aria-invalid={!family.trim() || undefined} onChange={(e) => { setFamily(e.target.value); setNote(null); }} onBlur={commitFamily} />
          {!family.trim() ? <small className="ms-bwarn">{b.fonts.familyRequired}</small> : note ? <small className="ms-bnote" role="status">{note}</small> : null}
        </label>
        <div className="ms-bpop-field">
          <span>{b.fonts.role}</span>
          <Select value={f.role} label={b.fonts.role} onChange={(role) => update({ role })} options={(Object.keys(t.web.labels.fontRoles) as Array<BrandFont['role']>).map((r) => ({ value: r, label: t.web.labels.fontRoles[r] }))} />
        </div>
        <label className="ms-bpop-field">
          <span>{b.fonts.weights}</span>
          <Input value={weights} disabled={locked} aria-label={b.fonts.weights} placeholder={b.fonts.weightsHint} onChange={(e) => setWeights(e.target.value)} onBlur={commitWeights} />
        </label>
        <div className="ms-bpop-field">
          <span>{b.fonts.file}</span>
          <Select value={f.file ?? ''} label={b.fonts.file} onChange={(file) => update({ file: file || null })} options={fileOptions} />
          {!fontAssets.length ? <small className="ms-bnote">{b.fonts.noFontAssets}</small> : null}
        </div>
        <Button variant="danger" size="sm" disabled={locked} onClick={remove}><Icon name="trash" size={13} />{b.fonts.remove}</Button>
      </form>
    </Popover>
  );
}

/* ---------- logos ---------- */

function Logos({ uploading }: { uploading: boolean }) {
  const t = useT();
  const b = t.web.brand;
  const { kit, locked, upload } = useBrand();
  const addBtn = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const missing: Array<'light' | 'dark'> = (['light', 'dark'] as const).filter((bg) => !hasLogoFor(kit, bg));
  return (
    <section data-sec="logos" className="ms-bsection" aria-labelledby="ms-blogos" data-enter>
      <div className="ms-bsection-head">
        <h2 id="ms-blogos">{b.nav.logos}</h2>
        {uploading ? <span className="ms-faint ms-brow"><Spinner decorative size={12} />{b.logos.uploading}</span> : null}
        <Button ref={addBtn} variant="ghost" size="sm" className="ms-blink" disabled={locked} aria-expanded={adding} onClick={() => setAdding(!adding)}>{b.logos.add}</Button>
        <AssetPicker open={adding} onClose={() => setAdding(false)} anchor={addBtn} background="any" />
      </div>
      <div className="ms-blogos">
        {kit.logos.map((l) => <LogoCard key={l.id} l={l} />)}
        {missing.map((bg) => <MissingLogo key={bg} bg={bg} disabled={locked || uploading} onUpload={() => upload(bg)} />)}
      </div>
    </section>
  );
}

function MissingLogo({ bg, disabled, onUpload }: { bg: 'light' | 'dark'; disabled: boolean; onUpload(): void }) {
  const t = useT();
  const b = t.web.brand;
  const pick = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  return (
    <div className="ms-blogo-missing">
      <b>{bg === 'light' ? b.logos.missingLight : b.logos.missingDark}</b>
      <span>{bg === 'light' ? b.logos.missingLightSub : b.logos.missingDarkSub}</span>
      <span className="ms-brow">
        {/* The API has no way to ask the brand agent for one: the action is the upload (ruling). */}
        <Button size="sm" variant="outline" disabled={disabled} onClick={onUpload}><Icon name="upload" size={13} />{b.logos.uploadLogo}</Button>
        <Button ref={pick} size="sm" variant="ghost" disabled={disabled} aria-expanded={picking} onClick={() => setPicking(!picking)}>{b.logos.fromAssets}</Button>
      </span>
      <AssetPicker open={picking} onClose={() => setPicking(false)} anchor={pick} background={bg} />
    </div>
  );
}

/** "+ Add logo" / "From Assets": upload a file or pick an image already in Assets. */
function AssetPicker({ open, onClose, anchor, background }: { open: boolean; onClose(): void; anchor: RefObject<HTMLButtonElement | null>; background: BrandLogo['background'] }) {
  const t = useT();
  const b = t.web.brand;
  const { slug, kit, assets, upload, addLogoFromAsset } = useBrand();
  const images = assets.filter((a) => (a.kind === 'image' || a.kind === 'svg') && !kit.logos.some((l) => l.file === `assets/${a.file}`));
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} width={280} placement="bottom-end">
      <div className="ms-bpop ms-bpicker">
        <button type="button" className="ms-bmenu-row" data-row onClick={() => { onClose(); upload(background); }}><Icon name="upload" size={14} />{b.logos.upload}</button>
        <span className="ms-cap">{b.logos.fromAssets}</span>
        {images.length ? (
          <div className="ms-bpicker-list">
            {images.map((a) => (
              <button key={a.file} type="button" className="ms-bmenu-row" data-row onClick={() => { onClose(); addLogoFromAsset(`assets/${a.file}`, background); }}>
                <img src={api.projectFileUrl(slug, `assets/${a.file}`)} alt="" />
                <span className="ms-ell">{a.file}</span>
              </button>
            ))}
          </div>
        ) : <span className="ms-bnote">{b.logos.noAssets}</span>}
      </div>
    </Popover>
  );
}

function LogoCard({ l }: { l: BrandLogo }) {
  const t = useT();
  const b = t.web.brand;
  const { slug, kit, locked, saver } = useBrand();
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useAppear(wrap);
  const stage = stageColor(l.background === 'dark' ? 'dark' : 'light', kit.colors);
  const update = (patch: Partial<BrandLogo>) => saver.edit((k) => ({ ...k, logos: k.logos.map((x) => (x.id === l.id ? { ...x, ...patch, source: MANUAL } : x)) }));
  const remove = () => {
    setOpen(false);
    const index = kit.logos.findIndex((x) => x.id === l.id);
    void removeWithUndo(wrap.current, () => {
      saver.edit((k) => ({ ...k, logos: k.logos.filter((x) => x.id !== l.id) }));
      toast.show(b.logos.removed, {
        action: { label: b.undo, run: () => saver.edit((k) => (k.logos.some((x) => x.id === l.id) ? k : { ...k, logos: [...k.logos.slice(0, index), l, ...k.logos.slice(index)] })) },
      });
    });
  };
  const bgLabel = l.background === 'light' ? b.logos.onLight : l.background === 'dark' ? b.logos.onDark : b.logos.onAny;
  return (
    <div className="ms-card ms-blogo" ref={wrap}>
      <button ref={btn} type="button" className={cx('ms-blogo-stage', `ms-bg-${l.background}`)} style={stage ? { background: stage } : undefined}
        aria-label={b.logos.edit({ file: l.file })} aria-expanded={open} onClick={() => setOpen(!open)}>
        <img src={api.projectFileUrl(slug, l.file)} alt={b.logos.alt({ file: l.file })} />
      </button>
      <div className="ms-blogo-meta">
        <span className="ms-brow"><b>{t.web.labels.logoVariants[l.variant]}</b><Tag>{bgLabel}</Tag></span>
        <span className="ms-mono ms-faint ms-ell" title={l.file}>{l.file}</span>
      </div>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} width={260}>
        <div className="ms-bpop">
          <span className="ms-cap">{b.logos.popTitle}</span>
          <div className="ms-bpop-field">
            <span>{b.logos.variant}</span>
            <Select value={l.variant} label={b.logos.variant} onChange={(variant) => update({ variant })}
              options={(Object.keys(t.web.labels.logoVariants) as Array<BrandLogo['variant']>).map((v) => ({ value: v, label: t.web.labels.logoVariants[v] }))} />
          </div>
          <div className="ms-bpop-field">
            <span>{b.logos.background}</span>
            <Segmented value={l.background} label={b.logos.background} disabled={locked} onChange={(background) => update({ background })}
              options={(['light', 'dark', 'any'] as const).map((v) => ({ value: v, label: t.web.labels.logoBackgrounds[v] }))} />
          </div>
          <Button variant="danger" size="sm" disabled={locked} onClick={remove}><Icon name="trash" size={13} />{b.logos.remove}</Button>
        </div>
      </Popover>
    </div>
  );
}

/* ---------- voice, photo style, guidelines ---------- */

/** A note of the kit (tone, photo style) shown as text, edited in place. */
function NoteText({ note, field, label, placeholder, empty }: { note: BrandNote | null; field: 'tone' | 'photoStyle'; label: string; placeholder: string; empty: string }) {
  const t = useT();
  const v = t.web.brand.voice;
  const { locked, saver } = useBrand();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const start = () => { setText(note?.text ?? ''); setEditing(true); };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    saver.edit((k) => ({ ...k, [field]: value ? { id: field === 'tone' ? 'tone' : 'photo-style', text: value, source: MANUAL } : null }));
    setEditing(false);
  };
  if (editing) {
    return (
      <form className="ms-bnote-edit" onSubmit={save}>
        <Textarea rows={4} value={text} aria-label={label} placeholder={placeholder} autoFocus onChange={(e) => setText(e.target.value)} />
        <span className="ms-brow">
          <Button type="submit" variant="ink" size="sm">{v.save}</Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>{v.cancel}</Button>
        </span>
      </form>
    );
  }
  return (
    <>
      {note ? <p className="ms-btext">{note.text}</p> : <p className="ms-bempty-line">{empty}</p>}
      <Button variant="ghost" size="sm" className="ms-blink ms-bstart" disabled={locked} onClick={start}>{note ? v.edit : v.write}</Button>
    </>
  );
}

function Voice() {
  const t = useT();
  const v = t.web.brand.voice;
  const { kit } = useBrand();
  return (
    <section data-sec="voice" className="ms-bvoice" aria-label={t.web.brand.nav.voice} data-enter>
      <div className="ms-card ms-bcard">
        <h2>{t.web.brand.nav.voice}</h2>
        <NoteText note={kit.tone} field="tone" label={v.toneLabel} placeholder={v.placeholder} empty={v.empty} />
      </div>
      <RuleCard kind="dos" />
      <RuleCard kind="donts" />
    </section>
  );
}

function RuleCard({ kind }: { kind: 'dos' | 'donts' }) {
  const t = useT();
  const v = t.web.brand.voice;
  const { kit, locked, saver } = useBrand();
  const items = kit[kind];
  const [more, setMore] = useState(false);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const title = kind === 'dos' ? v.do : v.avoid;
  const add = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    saver.edit((k) => ({ ...k, [kind]: [...k[kind], { id: nextId(kind === 'dos' ? 'do' : 'avoid', k[kind].map((x) => x.id)), text: value, source: MANUAL }] }));
    setText('');
    setAdding(false);
    setMore(true);
  };
  const shown = more ? items : items.slice(0, RULES_SHOWN);
  return (
    <div className="ms-card ms-bcard ms-brules">
      <span className="ms-brules-head">
        <span className={cx('ms-brules-icon', kind === 'dos' ? 'ms-ok' : 'ms-warn')} aria-hidden="true"><Icon name={kind === 'dos' ? 'check' : 'close'} size={9} strokeWidth={2.4} /></span>
        <h3>{title}</h3>
        <span className="ms-faint">{items.length}</span>
      </span>
      {items.length ? (
        <ul className="ms-brules-list" aria-label={title}>
          {shown.map((n, i) => <Rule key={n.id} n={n} kind={kind} first={i === 0} />)}
        </ul>
      ) : <p className="ms-bempty-line">{v.noRules}</p>}
      <span className="ms-brow">
        {items.length > RULES_SHOWN ? <button type="button" className="ms-blink-btn" onClick={() => setMore(!more)}>{more ? v.less : v.more({ count: items.length - RULES_SHOWN })}</button> : null}
        <button type="button" className="ms-blink-btn ms-bpush" disabled={locked} onClick={() => { setAdding(!adding); setText(''); }}>{v.addRule}</button>
      </span>
      {adding ? (
        <form className="ms-brow" onSubmit={add}>
          <Input className="ms-grow ms-bsmall" autoFocus value={text} aria-label={kind === 'dos' ? v.doLabel : v.avoidLabel} placeholder={kind === 'dos' ? v.doPlaceholder : v.avoidPlaceholder} onChange={(e) => setText(e.target.value)} />
          <Button type="submit" variant="ink" size="sm" disabled={!text.trim()}>{v.add}</Button>
        </form>
      ) : null}
    </div>
  );
}

function Rule({ n, kind, first }: { n: BrandNote; kind: 'dos' | 'donts'; first: boolean }) {
  const t = useT();
  const v = t.web.brand.voice;
  const { kit, locked, saver } = useBrand();
  const ref = useRef<HTMLLIElement>(null);
  useAppear(ref);
  const remove = () => {
    const index = kit[kind].findIndex((x) => x.id === n.id);
    void removeWithUndo(ref.current, () => {
      saver.edit((k) => ({ ...k, [kind]: k[kind].filter((x) => x.id !== n.id) }));
      toast.show(v.ruleRemoved, {
        action: { label: t.web.brand.undo, run: () => saver.edit((k) => (k[kind].some((x) => x.id === n.id) ? k : { ...k, [kind]: [...k[kind].slice(0, index), n, ...k[kind].slice(index)] })) },
      });
    });
  };
  return (
    <li ref={ref} className={cx('ms-brule', first && 'ms-first')}>
      <span>{n.text}</span>
      <Button variant="ghost" size="sm" icon className="ms-brule-x" disabled={locked} aria-label={v.removeRule({ text: n.text })} onClick={remove}><Icon name="close" size={11} /></Button>
    </li>
  );
}

function PhotoStyle({ references }: { references: ReferenceEntry[] }) {
  const t = useT();
  const b = t.web.brand;
  const { slug, kit } = useBrand();
  const images = references.filter((r) => r.useForBrand && IMAGE.test(r.file)).slice(0, 3);
  return (
    <section data-sec="photo" className="ms-card ms-bcard" aria-labelledby="ms-bphoto" data-enter>
      <h2 id="ms-bphoto">{b.nav.photo}</h2>
      <NoteText note={kit.photoStyle} field="photoStyle" label={b.photo.label} placeholder={b.photo.placeholder} empty={b.photo.empty} />
      {images.length ? (
        <div className="ms-bphotos">{images.map((r) => <img key={r.file} src={api.projectFileUrl(slug, `references/${r.file}`)} alt={r.note || r.file} />)}</div>
      ) : null}
    </section>
  );
}

function Guidelines({ text, onSaved }: { text: string; onSaved(text: string): void }) {
  const t = useT();
  const g = t.web.brand.guidelines;
  const { saver } = useBrand();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const show = (edit: boolean) => { setDraft(text); setEditing(edit); setOpen(true); };
  const save = async () => {
    setBusy(true);
    const ok = await saver.saveGuidelines(draft);
    setBusy(false);
    if (ok) { onSaved(draft); setEditing(false); }
  };
  const changed = editing && draft !== text;
  return (
    <section data-sec="guidelines" className="ms-card ms-bcard" aria-labelledby="ms-bguide" data-enter>
      <div className="ms-bsection-head">
        <h2 id="ms-bguide">{t.web.brand.nav.guidelines}</h2>
        {text.trim() ? <Button variant="ghost" size="sm" className="ms-blink" onClick={() => show(false)}>{g.open}</Button> : null}
      </div>
      {text.trim() ? (
        <div className="ms-bguide-preview"><Markdown text={text} headings /></div>
      ) : (
        <>
          <p className="ms-bempty-line">{g.empty}</p>
          <Button size="sm" className="ms-bstart" onClick={() => show(true)}><Icon name="edit" size={13} />{g.write}</Button>
        </>
      )}
      <Modal open={open} onClose={() => setOpen(false)} label={t.web.brand.nav.guidelines} width={760} dismissible={!changed && !busy}>
        <div className="ms-bguide-dialog">
          <div className="ms-bguide-head">
            <h2>{t.web.brand.nav.guidelines}</h2>
            {!editing ? <Button size="sm" onClick={() => { setDraft(text); setEditing(true); }}><Icon name="edit" size={13} />{g.edit}</Button> : null}
            <Button variant="ghost" size="sm" icon aria-label={g.close} disabled={busy} onClick={() => setOpen(false)}><Icon name="close" size={12} /></Button>
          </div>
          <div className="ms-bguide-body">
            {editing ? <Textarea rows={18} className="ms-mono" value={draft} aria-label={g.label} onChange={(e) => setDraft(e.target.value)} /> : <Markdown text={text} headings />}
          </div>
          {editing ? (
            <div className="ms-bguide-foot">
              <Button variant="ghost" disabled={busy} onClick={() => (text.trim() ? setEditing(false) : setOpen(false))}>{g.cancel}</Button>
              <Button variant="ink" loading={busy} disabled={draft === text} onClick={() => void save()}>{g.save}</Button>
            </div>
          ) : null}
        </div>
      </Modal>
    </section>
  );
}

/* ---------- side column: analysis, sources, health, history ---------- */

function ProposalReady({ proposal, onReview }: { proposal: BrandProposal; onReview(): void }) {
  const t = useT();
  const a = t.web.brand.analysis;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { void enter(ref.current, { y: 8 }); }, []);
  const count = proposal.changes.length + (proposal.guidelines ? 1 : 0);
  return (
    <div className="ms-bready" ref={ref}>
      <span className="ms-bready-icon" aria-hidden="true"><Icon name="sparkle" size={15} /></span>
      <span className="ms-bready-text"><b>{a.readyTitle}</b><span className="ms-muted">{a.readySub({ count })}</span></span>
      <Button variant="ink" size="sm" onClick={onReview}>{a.review}</Button>
    </div>
  );
}

function AnalysisCard({ job, live }: { job: JobSummary; live: EventsState }) {
  const t = useT();
  const a = t.web.brand.analysis;
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => { void enter(ref.current, { y: 8 }); }, []);
  const steps = analysisSteps(live.events[job.id]);
  const approvals = Object.values(live.approvals).filter((x) => x.jobId === job.id);
  const [cancelling, setCancelling] = useState(false);
  const cancel = () => {
    setCancelling(true);
    api.cancelJob(job.id).then(() => toast.show(a.canceled), (e: unknown) => toast.show(message(e))).finally(() => setCancelling(false));
  };
  return (
    <section className="ms-banalysis" ref={ref} aria-labelledby="ms-banalysis-title">
      <div className="ms-brow">
        <Spinner decorative size={14} />
        <b id="ms-banalysis-title">{a.title}</b>
        <Button variant="ghost" size="sm" className="ms-bpush" loading={cancelling} onClick={cancel}>{a.cancel}</Button>
      </div>
      {/* report_progress carries text only: the bar is indeterminate, never a made-up percentage. */}
      <div className="ms-bbar" role="progressbar" aria-label={a.progress} aria-busy="true"><i /></div>
      <ol className="ms-bsteps">
        {job.state === 'queued' ? <li className="ms-muted">{a.queued}</li> : null}
        {job.state === 'running' && !steps.length ? <li className="ms-muted">{a.starting}</li> : null}
        {steps.map((s, i) => <Step key={`${i}:${s}`} text={s} done={i < steps.length - 1} />)}
      </ol>
      {job.state === 'running' ? <span className="ms-brow ms-muted ms-bworking"><Typing label={a.working} />{a.working}</span> : null}
      {approvals.map((x) => <ApprovalCard key={x.id} approval={x} />)}
    </section>
  );
}

function Step({ text, done }: { text: string; done: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => { void enter(ref.current, { y: 6 }); }, []);
  return (
    <li ref={ref} className={cx('ms-bstep', done && 'ms-done')}>
      <span className="ms-bstep-mark" aria-hidden="true">{done ? <Icon name="check" size={12} strokeWidth={2.2} /> : <i />}</span>
      <span>{text}</span>
    </li>
  );
}

function AnalysisFailure({ job, proposals, onRetry }: { job: JobSummary | undefined; proposals: BrandProposal[]; onRetry(): void }) {
  const t = useT();
  const a = t.web.brand.analysis;
  const { slug } = useBrand();
  const [busy, setBusy] = useState(false);
  // A failed analysis stays visible only until a newer proposal exists (a later analysis succeeded).
  if (!job || job.state !== 'failed' || proposals.some((p) => p.createdAt > job.createdAt)) return null;
  const text = job.kind === 'asset-description' ? t.web.labels.describeFailed({ error: job.error ?? null }) : a.failed({ error: job.error ?? '—' });
  const retry = () => {
    setBusy(true);
    api.analyzeBrand(slug).then(onRetry, (e: unknown) => toast.show(message(e))).finally(() => setBusy(false));
  };
  return (
    <div className="ms-bfailed" role="alert">
      <Icon name="warn" size={15} />
      <span>{text}</span>
      {job.kind === 'brand-analysis' ? <Button size="sm" loading={busy} onClick={retry}>{a.retry}</Button> : null}
    </div>
  );
}

function Sources({ overview, job, reload }: { overview: BrandOverview; job: JobSummary | undefined; reload(): void }) {
  const t = useT();
  const s = t.web.brand.sources;
  const locale = useLocale();
  const { slug } = useBrand();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'add' | 'analyze' | null>(null);
  const active = isActive(job);
  const analyzing = active && job?.kind === 'brand-analysis';
  const describing = active && job?.kind === 'asset-description';
  const sites = overview.sources.filter((x) => x.kind === 'website' && !hidden.has(x.id));
  const images = overview.sources.filter((x) => x.kind === 'image').length;
  const usable = sites.length + images > 0;
  const analyzedOnce = overview.sources.some((x) => x.lastAnalyzedAt);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const u = normalizeUrl(url);
    if (!u) { setError(s.invalidUrl); return; }
    setBusy('add'); setError(null);
    try {
      await api.addBrandSource(slug, { kind: 'website', url: u });
      setUrl('');
      toast.show(s.added, { tone: 'ok' });
      reload();
    } catch (err) { setError(message(err)); } finally { setBusy(null); }
  };
  const analyze = async () => {
    setBusy('analyze'); setError(null);
    try { await api.analyzeBrand(slug); reload(); } catch (err) { setError(message(err)); } finally { setBusy(null); }
  };
  const remove = (src: BrandSource) => {
    const host = hostOf(src.url);
    setHidden((h) => new Set(h).add(src.id));
    deferRemoval({
      text: s.removed({ host }), undoLabel: t.web.brand.undo,
      commit: () => api.removeBrandSource(slug, src.id).then(reload),
      restore: () => setHidden((h) => { const n = new Set(h); n.delete(src.id); return n; }),
      onError: (err) => setError(message(err)),
    });
  };

  return (
    <section className="ms-bsources" aria-labelledby="ms-bsources-title">
      <span className="ms-cap" id="ms-bsources-title">{s.title}</span>
      {sites.map((src) => (
        <SourceRow key={src.id} src={src} onRemove={() => remove(src)}
          meta={analyzing ? s.inProgress : src.lastAnalyzedAt ? s.analyzedAt({ when: relativeTime(locale, src.lastAnalyzedAt) }) : s.never} live={analyzing} />
      ))}
      {!sites.length ? <span className="ms-muted ms-bsmall-text">{s.empty}</span> : null}
      <form className="ms-brow ms-bnowrap" onSubmit={(e) => void add(e)}>
        <Input className="ms-grow ms-bsmall" value={url} aria-label={s.addLabel} placeholder={s.addPlaceholder} onChange={(e) => { setUrl(e.target.value); setError(null); }} />
        <Button type="submit" variant="ink" size="sm" loading={busy === 'add'} disabled={!url.trim()}>{s.add}</Button>
      </form>
      {error ? <span className="ms-bwarn" role="alert">{error}</span> : null}
      <span className="ms-muted ms-bsmall-text">{images ? s.images({ count: images }) : s.noImages}</span>
      <Button className="ms-bwide" loading={busy === 'analyze'} disabled={active || !usable} onClick={() => void analyze()}>
        <Icon name="refresh" size={14} strokeWidth={1.6} />{analyzedOnce ? s.analyzeAgain : s.analyze}
      </Button>
      {describing ? <span className="ms-muted ms-bsmall-text">{s.busyDescribe}</span> : !usable ? <span className="ms-muted ms-bsmall-text">{s.needSource}</span> : null}
    </section>
  );
}

function SourceRow({ src, meta, live, onRemove }: { src: BrandSource; meta: string; live: boolean; onRemove(): void }) {
  const t = useT();
  const s = t.web.brand.sources;
  const ref = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useAppear(ref);
  const host = hostOf(src.url);
  return (
    <div className="ms-bsource" ref={ref}>
      <div className="ms-brow ms-bnowrap">
        <span className="ms-bsource-icon" aria-hidden="true"><Icon name="globe" size={12} /></span>
        <b className="ms-ell" title={src.url ?? undefined}>{host}</b>
        <Button ref={more} variant="ghost" size="sm" icon className="ms-bpush" aria-label={s.actions({ host })} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="more" size={14} /></Button>
      </div>
      <span className={cx('ms-bsmall-text', live ? 'ms-baccent' : 'ms-muted')}>{live ? <Spinner decorative size={10} /> : null}{meta}</span>
      <Popover open={open} onClose={() => setOpen(false)} anchor={more} width={180} placement="bottom-end">
        <div className="ms-bpop">
          <button type="button" className="ms-bmenu-row ms-danger" data-row onClick={() => { setOpen(false); onRemove(); }}><Icon name="trash" size={13} />{s.remove}</button>
        </div>
      </Popover>
    </div>
  );
}

const HEALTH_SECTION: Record<HealthId, SectionId> = { palette: 'colors', fonts: 'type', rules: 'voice', lightLogo: 'logos' };

/** Ruling R5: a checklist derived from the kit only; each item is a real pass/fail with the action that fixes it. */
function Health() {
  const t = useT();
  const h = t.web.brand.health;
  const { kit, locked, go, upload } = useBrand();
  const checks = useMemo(() => healthChecks(kit), [kit]);
  return (
    <section className="ms-bhealth" aria-labelledby="ms-bhealth-title">
      <span className="ms-cap" id="ms-bhealth-title">{h.title}</span>
      <div className="ms-bhealth-list">
        {checks.map((c) => (
          <div key={c.id} className="ms-bhealth-row" data-state={c.ok ? 'ok' : 'todo'}>
            <span className={cx('ms-bhealth-dot', c.ok ? 'ms-ok' : 'ms-warn')} aria-hidden="true">{c.ok ? <Icon name="check" size={9} strokeWidth={2.4} /> : '!'}</span>
            <span className="ms-grow">{h[c.id]}<span className="ms-sr">{`: ${c.ok ? h.ok : h.todo}`}</span></span>
            {!c.ok ? (
              <button type="button" className="ms-blink-btn" disabled={locked && c.id === 'lightLogo'} onClick={() => (c.id === 'lightLogo' ? upload('light') : go(HEALTH_SECTION[c.id]))}>{h.fix[c.id]}</button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

/** The analyses so far (the API exposes proposals with their date and outcome; kit edits have no history). */
function History({ proposals }: { proposals: BrandProposal[] }) {
  const t = useT();
  const h = t.web.brand.history;
  const locale = useLocale();
  if (!proposals.length) return null;
  const list = [...proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
  return (
    <section className="ms-bhistory" aria-labelledby="ms-bhistory-title">
      <b id="ms-bhistory-title">{h.title}</b>
      {list.map((p) => (
        <span key={p.id} className="ms-muted ms-bsmall-text">
          {`${formatDate(locale, p.createdAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${p.status === 'applied' ? h.applied : p.status === 'discarded' ? h.discarded : h.open}`}
        </span>
      ))}
    </section>
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
  const analyze = async (ev: FormEvent) => {
    ev.preventDefault();
    const u = normalizeUrl(url);
    if (!u) { setError(t.web.brand.sources.invalidUrl); return; }
    setBusy(true); setError(null);
    try {
      await api.addBrandSource(slug, { kind: 'website', url: u });
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

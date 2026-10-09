// Brand page side column: proposal ready, live analysis, sources, brand health and the analyses so far.
import { shownTotal, type BrandOverview, type BrandProposal, type BrandSource, type JobSummary } from '@motion-studio/shared';
import { useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { formatWhen, relativeTime, useLocale, useT } from '../i18n.tsx';
import { enter } from '../motion/index.ts';
import { Button, cx, Icon, Input, Popover, Spinner, toast, Typing } from '../ui/index.ts';
import { analysisSteps, healthChecks, hostOf, normalizeUrl, type HealthId } from './brandModel.ts';
import { KEEPALIVE, deferRemoval, flushDeferred, isPendingRemoval, removalKey, usePendingRemovals } from './deferred.ts';
import { isActive, useBrand, useAppear, type SectionId } from './brandContext.tsx';
import { message } from './common.tsx';
import { formatTokens, TokenCount } from '../shell/Tokens.tsx';
import { jobLiveTokens } from '../usageLive.ts';

/** An analysis' tokens from its proposal; null for proposals from before usage tracking. */
const proposalTokens = (p: BrandProposal) => (p.usage ? shownTotal(p.usage.tokens) : null);
/* ---------- side column: analysis, sources, health, history ---------- */

export function ProposalReady({ proposal, onReview }: { proposal: BrandProposal; onReview(): void }) {
  const t = useT();
  const a = t.web.brand.analysis;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { void enter(ref.current, { y: 8 }); }, []);
  const count = proposal.changes.length + (proposal.guidelines ? 1 : 0);
  return (
    <div className="ms-bready" ref={ref}>
      <span className="ms-bready-icon" aria-hidden="true"><Icon name="sparkle" size={15} /></span>
      <span className="ms-bready-text"><b>{a.readyTitle}</b><span className="ms-muted">{a.readySub({ count })}</span>
        <TokenCount tokens={proposalTokens(proposal)} className="ms-btokens" /></span>
      <Button variant="ink" size="sm" onClick={onReview}>{a.review}</Button>
    </div>
  );
}

export function AnalysisCard({ job, live }: { job: JobSummary; live: EventsState }) {
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
        <TokenCount tokens={jobLiveTokens(live, job.id)} live className="ms-btokens" />
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

export function AnalysisFailure({ job, proposals, onRetry }: { job: JobSummary | undefined; proposals: BrandProposal[]; onRetry(): void }) {
  const t = useT();
  const a = t.web.brand.analysis;
  const { slug } = useBrand();
  const [busy, setBusy] = useState(false);
  // A failed analysis stays visible only until a newer proposal exists (a later analysis succeeded).
  if (!job || job.state !== 'failed' || proposals.some((p) => p.createdAt > job.createdAt)) return null;
  const text = job.kind === 'asset-description' ? t.web.labels.describeFailed({ error: job.error ?? null }) : a.failed({ error: job.error ?? '—' });
  const retry = () => {
    setBusy(true);
    flushDeferred().then(() => api.analyzeBrand(slug)).then(onRetry, (e: unknown) => toast.show(message(e))).finally(() => setBusy(false));
  };
  return (
    <div className="ms-bfailed" role="alert">
      <Icon name="warn" size={15} />
      <span>{text}</span>
      {job.kind === 'brand-analysis' ? <Button size="sm" loading={busy} onClick={retry}>{a.retry}</Button> : null}
    </div>
  );
}

export function Sources({ overview, job, reload }: { overview: BrandOverview; job: JobSummary | undefined; reload(): void }) {
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
  // A source removed before this screen was opened again (Undo still running) stays hidden; once its delete goes out
  // the brand reloads.
  usePendingRemovals((keys) => {
    const gone = overview.sources.filter((x) => keys.includes(removalKey('brand-source', slug, x.id))).map((x) => x.id);
    if (!gone.length) return;
    setHidden((h) => new Set([...h, ...gone]));
    reload();
  });
  const sites = overview.sources.filter((x) => x.kind === 'website' && !hidden.has(x.id) && !isPendingRemoval(removalKey('brand-source', slug, x.id)));
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
    try {
      // Sources being removed (Undo still on screen) are deleted first, so they are not analyzed.
      await flushDeferred();
      await api.analyzeBrand(slug);
      reload();
    } catch (err) { setError(message(err)); } finally { setBusy(null); }
  };
  const remove = (src: BrandSource) => {
    const host = hostOf(src.url);
    setHidden((h) => new Set(h).add(src.id));
    deferRemoval({
      text: s.removed({ host }), undoLabel: t.web.brand.undo,
      keys: [removalKey('brand-source', slug, src.id)],
      commit: () => api.removeBrandSource(slug, src.id, KEEPALIVE).then(reload),
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
export function Health() {
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
export function History({ proposals, undone }: { proposals: BrandProposal[]; undone: Set<string> }) {
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
          {`${formatWhen(locale, p.createdAt)} · ${p.status === 'applied' ? h.applied : p.status === 'discarded' ? h.discarded : h.open}${undone.has(p.id) ? ` · ${h.undone}` : ''}`}
          {p.usage ? <span className="ms-btokens">{` · ${t.web.usage.tokens({ count: formatTokens(locale, proposalTokens(p)!) })}`}</span> : null}
        </span>
      ))}
    </section>
  );
}

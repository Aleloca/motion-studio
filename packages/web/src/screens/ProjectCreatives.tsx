import { formatName, type CreativeListItem, type CreativeSummary, type FormatPreset } from '@motion-studio/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { api } from '../api.ts';
import type { EventsState } from '../eventsReducer.ts';
import { relativeTime, useLocale, useT } from '../i18n.tsx';
import { enter, useEnter } from '../motion/index.ts';
import { href } from '../routes.ts';
import { go } from '../shell/ShellContext.tsx';
import { Button, ChannelMark, CountdownRing, Empty, Icon, Pill, Segmented, Tag, cx, toast } from '../ui/index.ts';
import { CREATIVE_FILTERS, channelOf, frames, liveCreative, matches, retryTurn, type CreativeFilter, type LiveCreative } from './creativeState.ts';
import './creatives.css';
import { message } from './common.tsx';

const VIDEO = /\.(mp4|webm|mov)$/i;
/** Preview stage: frames up to 164 px tall in a row of at most 300 px (prototype CreativeCard). */
const STAGE = { height: 164, maxWidth: 300, gap: 10 };
/** Dashed frames drawn for a creative without output; the rest is a "+N more" note. */
const MAX_FRAMES = 3;
const MAX_TAGS = 4;
const CASCADE_MS = 40;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const ratio = (p: FormatPreset) => { const d = gcd(p.width, p.height); return `${p.width / d}:${p.height / d}`; };

/**
 * Project · Creatives (spec §6.2 #4), ported from the prototype's Creatives / CreativeCard and the Creatives boards:
 * status segments with counts, search, cards with the format previews in proportion and the state in plain words
 * (approval with Review, generation with its step, failure with Try again, draft with Generate).
 */
export function ProjectCreatives({ slug, live }: { slug: string; live: EventsState }) {
  const t = useT();
  const c = t.web.creatives;
  const [items, setItems] = useState<CreativeListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [filter, setFilter] = useState<CreativeFilter>('all');
  const [query, setQuery] = useState('');
  const tick = useMemo(() => Object.entries(live.creativeTicks).filter(([k]) => k.startsWith(`${slug}/`)).reduce((a, [, v]) => a + v, 0), [live.creativeTicks, slug]);

  useEffect(() => {
    let alive = true; // a slow response for an older tick must not overwrite a newer one
    Promise.resolve().then(() => api.listCreatives(slug))
      .then((r) => { if (alive) { setItems(r); setError(null); } })
      .catch((e: unknown) => { if (alive) setError(message(e)); });
    return () => { alive = false; };
  }, [slug, tick, nonce]);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getFormats()).then((cat) => { if (alive) setPresets(cat.presets); }).catch(() => { /* frames fall back to squares */ });
    return () => { alive = false; };
  }, []);

  const states = useMemo(() => {
    const map = new Map<string, LiveCreative>();
    for (const it of items ?? []) if (it.ok) map.set(it.slug, liveCreative(it, slug, live));
    return map;
  }, [items, slug, live]);
  const ordered = useMemo(() => [...(items ?? [])].sort((a, b) => (b.ok ? b.updatedAt : '').localeCompare(a.ok ? a.updatedAt : '')), [items]);
  const count = (f: CreativeFilter) => (f === 'all' ? ordered.length : ordered.filter((i) => i.ok && matches(f, states.get(i.slug)!.state)).length);
  const q = query.trim().toLocaleLowerCase();
  // Unreadable creatives have no state: they stay visible under every filter so they are never forgotten.
  const shown = ordered.filter((i) => !i.ok || (matches(filter, states.get(i.slug)!.state) && (!q || i.title.toLocaleLowerCase().includes(q) || i.slug.includes(q))));

  // T14: the cards come in as a cascade on the first appearance and on a filter change; new ones (a creative created
  // elsewhere while this page is open) enter with scale(.96).
  const loaded = items !== null;
  const root = useEnter<HTMLDivElement>([loaded, filter]);
  const known = useRef<Set<string> | null>(null);
  useLayoutEffect(() => { if (items) known.current = new Set(items.map((i) => i.slug)); }, [items]);

  const showAll = () => { setFilter('all'); setQuery(''); };
  const retryLoad = () => { setError(null); setNonce((n) => n + 1); };

  if (items && items.length === 0) {
    return (
      <div className="ms-creatives ms-creatives-empty" ref={root}>
        <section className="ms-card ms-cempty" data-enter aria-labelledby="ms-cempty-title">
          <span className="ms-cempty-icon" aria-hidden="true"><Icon name="sparkle" size={18} /></span>
          <h1 id="ms-cempty-title">{c.emptyTitle}</h1>
          <p>{c.emptyBody}</p>
          <div className="ms-cempty-actions">
            <Button variant="outline" onClick={() => go(href.project(slug, 'brand'))}>{c.setUpBrand}</Button>
            <Button variant="ink" onClick={() => go(href.newCreative(slug))}><Icon name="plus" size={13} strokeWidth={1.8} />{c.newCreative}</Button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="ms-creatives" ref={root}>
      <div className="ms-creatives-head">
        <h1>{c.title}</h1>
        {loaded ? (
          <Segmented
            className="ms-creatives-seg"
            label={c.filter}
            value={filter}
            onChange={setFilter}
            options={CREATIVE_FILTERS.map((f) => ({ value: f, label: c.filters[f], count: count(f), accent: f === 'needs' }))}
          />
        ) : null}
        <div className="ms-grow" />
        {loaded ? (
          <label className="ms-csearch">
            <Icon name="search" size={14} />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={c.search} aria-label={c.search} />
          </label>
        ) : null}
        <Button variant="ink" onClick={() => go(href.newCreative(slug))}><Icon name="plus" size={13} strokeWidth={1.8} />{c.newCreative}</Button>
      </div>

      {error ? (
        <div className="ms-creatives-alert" role="alert">
          <Icon name="warn" size={16} />
          <span>{c.loadFailed({ detail: error })}</span>
          <Button size="sm" variant="outline" onClick={retryLoad}>{c.tryAgain}</Button>
        </div>
      ) : null}

      {!loaded && !error ? (
        <div className="ms-creatives-grid" aria-busy="true">
          <span className="ms-sr" role="status">{c.loading}</span>
          {[0, 1, 2].map((i) => <div key={i} className="ms-card ms-ccard ms-cskel" aria-hidden="true"><div className="ms-ccard-stage" /><div className="ms-ccard-body"><i /><i /></div></div>)}
        </div>
      ) : null}

      {loaded && shown.length === 0 ? (
        <Empty icon="check" title={c.noMatchTitle} sub={c.noMatchBody} action={<Button variant="outline" size="sm" onClick={showAll}>{c.showAll}</Button>} />
      ) : null}

      {loaded && shown.length > 0 ? (
        <div className="ms-creatives-grid">
          {shown.map((it, i) => it.ok ? (
            <CreativeCard
              key={it.slug} slug={slug} c={it} info={states.get(it.slug)!} presets={presets} index={i}
              fresh={known.current !== null && !known.current.has(it.slug)}
            />
          ) : (
            <article key={it.slug} className="ms-card ms-ccard ms-broken" data-enter data-delay={i * CASCADE_MS}>
              <div className="ms-ccard-body">
                <div className="ms-ccard-head"><h3>{it.slug}</h3><Pill tone="warn" dot>{c.unreadable}</Pill></div>
                <code className="ms-ccard-error">{it.error}</code>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface CardProps { slug: string; c: CreativeSummary; info: LiveCreative; presets: FormatPreset[]; index: number; fresh: boolean }

function CreativeCard({ slug, c, info, presets, index, fresh }: CardProps) {
  const t = useT();
  const s = t.web.creatives;
  const locale = useLocale();
  const ref = useRef<HTMLElement>(null);
  const { state, approval, job, step } = info;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // T14: a creative that appeared while the page was open.
  useLayoutEffect(() => { if (fresh) void enter(ref.current, { y: 16, scale: 0.96 }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A started generation shows up as a state change (the job event): the button is done waiting.
  useEffect(() => { setBusy(false); }, [state]);
  // The list has no error text: the failed creative's own file does.
  useEffect(() => {
    if (state !== 'failed') return;
    let alive = true;
    Promise.resolve().then(() => api.getCreative(slug, c.slug))
      .then((d) => { if (alive) setFailure(d.creative.error); })
      .catch(() => { /* the generic text stays */ });
    return () => { alive = false; };
  }, [state, slug, c.slug, c.updatedAt]);

  const open = href.creative(slug, c.slug);
  // The page may be gone when a request returns: never pull the user back to the creative then.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Generate: an empty turn, the core generates from the brief. Try again: the failed user turn again (text and
  // pins, read from the conversation), or an empty turn when the failure was a generation without a message.
  const start = async (then: 'stay' | 'open', fail: (p: { detail: string }) => string) => {
    setBusy(true);
    try {
      const body = then === 'stay' ? retryTurn(await api.getConversation(slug, c.slug)) : {};
      await api.sendCreativeTurn(slug, c.slug, body);
      if (then === 'open' && mounted.current) go(open);
    } catch (e) {
      if (!mounted.current) return;
      setBusy(false);
      toast.show(fail({ detail: message(e) }), { tone: 'neutral' });
    }
  };

  const when = state === 'draft' ? s.draft : relativeTime(locale, c.updatedAt);
  const known = c.formats.map((id) => ({ id, preset: presets.find((p) => p.id === id) ?? null }));
  return (
    <article
      ref={ref}
      className={cx('ms-card', 'ms-ccard', `ms-st-${state}`, state === 'needs' && 'ms-needs')}
      data-enter={fresh ? undefined : ''}
      data-delay={index * CASCADE_MS}
    >
      <div className="ms-ccard-stage">
        <Previews slug={slug} c={c} presets={presets} state={state} />
      </div>
      <div className="ms-ccard-body">
        <div className="ms-ccard-head">
          <h3><a href={open} className="ms-ccard-link">{c.title}</a></h3>
          <span className="ms-ccard-when">{when}</span>
        </div>
        {known.length ? (
          <div className="ms-ccard-tags">
            {known.slice(0, MAX_TAGS).map(({ id, preset }) => (
              <Tag key={id} className="ms-ftag">
                {preset ? <ChannelMark channel={channelOf(preset.channel)} /> : null}
                <span className="ms-ftag-name">{preset ? formatName(preset, locale) : id}</span>
              </Tag>
            ))}
            {known.length > MAX_TAGS ? <Tag className="ms-ftag">{s.moreFormats({ n: known.length - MAX_TAGS })}</Tag> : null}
          </div>
        ) : null}

        {state === 'needs' && approval ? (
          <div className="ms-cc-needs">
            <span className="ms-dot" aria-hidden="true" />
            <b className="ms-cc-needs-title">{approval.title}</b>
            <CountdownRing createdAt={Date.parse(approval.createdAt)} ttlSec={Math.max(0, (Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)) / 1000)} />
            <Button size="sm" variant="ink" className="ms-cc-act" onClick={() => go(open)}>{s.review}</Button>
          </div>
        ) : null}
        {state === 'running' ? (
          <div className="ms-cc-run">
            <span className="ms-cc-step">{job?.state === 'queued' ? s.queued : step ?? s.working}</span>
            {/* Indeterminate: progress events carry text only, so no percentage is claimed. */}
            <div className="ms-progress ms-indet" role="progressbar" aria-label={t.web.ui.progress}><i /></div>
          </div>
        ) : null}
        {state === 'ready' ? <span className="ms-cc-ok"><span className="ms-dot" aria-hidden="true" />{s.readyVersion({ n: c.versions })}</span> : null}
        {state === 'incomplete' ? <span className="ms-cc-warn"><Icon name="warn" size={13} />{s.incomplete({ n: c.versions })}</span> : null}
        {state === 'failed' || state === 'interrupted' ? (
          <div className="ms-cc-fail">
            <span className="ms-cc-fail-text">{state === 'failed' ? failure ?? s.failed : s.interrupted}</span>
            <Button size="sm" variant="outline" className="ms-cc-act" loading={busy} onClick={() => void start('stay', s.retryFailed)}>
              <Icon name="refresh" size={13} />{s.tryAgain}
            </Button>
          </div>
        ) : null}
        {state === 'draft' ? (
          <div className="ms-cc-draft">
            <span className="ms-cc-note">{s.draftNote}</span>
            <Button size="sm" variant="accent" className="ms-cc-act" aria-label={s.generateOf({ title: c.title })} loading={busy} onClick={() => void start('open', s.generateFailed)}>
              <Icon name="sparkle" size={13} />{s.generate}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** The cover in the proportion of its own pixels (the first format's until it loads); dashed frames without output. */
function Previews({ slug, c, presets, state }: { slug: string; c: CreativeSummary; presets: FormatPreset[]; state: LiveCreative['state'] }) {
  const s = useT().web.creatives;
  const [natural, setNatural] = useState<number | null>(null);
  if (c.cover && c.versions > 0) {
    const preset = presets.find((p) => p.id === c.formats[0]) ?? null;
    const aspect = natural ?? (preset ? preset.width / preset.height : 1);
    const h = Math.min(STAGE.height, STAGE.maxWidth / aspect);
    const src = api.fileUrl(slug, c.slug, c.cover);
    const onLoad = (e: SyntheticEvent<HTMLImageElement | HTMLVideoElement>) => {
      const el = e.currentTarget;
      const [w, hh] = el instanceof HTMLVideoElement ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight];
      if (w > 0 && hh > 0) setNatural(w / hh);
    };
    return (
      <>
        <div className="ms-ccard-frame ms-ccard-frame-out" style={{ width: Math.round(h * aspect), height: Math.round(h) }}>
          {VIDEO.test(c.cover)
            ? <video src={src} muted preload="metadata" aria-hidden="true" onLoadedMetadata={onLoad} />
            : <img src={src} alt="" onLoad={onLoad} />}
          {state === 'running' ? <span className="ms-shimmer" aria-hidden="true" /> : null}
          {state === 'failed' || state === 'interrupted' ? <span className="ms-ccard-frame-warn" aria-hidden="true"><Icon name="warn" size={16} strokeWidth={1.6} /></span> : null}
        </div>
        {c.formats.length > 1 ? <span className="ms-stage-more">{s.moreFormats({ n: c.formats.length - 1 })}</span> : null}
      </>
    );
  }
  const list = frames(c.formats.slice(0, MAX_FRAMES), presets, STAGE);
  return (
    <>
      {list.map((f) => (
        <div key={f.id} className={cx('ms-ccard-frame', 'ms-ccard-frame-empty', state === 'running' && 'ms-ccard-frame-busy')} style={{ width: f.width, height: f.height }}>
          {f.preset ? ratio(f.preset) : null}
          {state === 'running' ? <span className="ms-shimmer" aria-hidden="true" /> : null}
        </div>
      ))}
      {c.formats.length > MAX_FRAMES ? <span className="ms-stage-more">{s.moreFormats({ n: c.formats.length - MAX_FRAMES })}</span> : null}
    </>
  );
}

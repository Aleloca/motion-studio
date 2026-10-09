import { formatName, type BrandOverview, type CreativeListItem, type FormatPreset, type ProjectFile, type ProjectListItem, type RecentCreative } from '@motion-studio/shared';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import type { EventsState } from '../eventsReducer.ts';
import { relativeTime, useLocale, useT } from '../i18n.tsx';
import { enter, flash, useEnter } from '../motion/index.ts';
import { href } from '../routes.ts';
import { useNewProjectIntent } from '../shell/intents.ts';
import { go, ShellContext } from '../shell/ShellContext.tsx';
import { Button, Icon, Input, Pill, Select, cx, initials, toast } from '../ui/index.ts';
import { liveCreative } from './creativeState.ts';
import './projects.css';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const RECENT = 3;
const COVERS = 3;
const PALETTE_MAX = 8;
const THUMB_H = 78;
const CASCADE_MS = 40;

type Sort = 'recent' | 'name';
type Readable = Extract<ProjectListItem, { ok: true }>;

/** #RGB / #RRGGBB / #RRGGBBAA (alpha ignored) → #RRGGBB; null for anything else. */
export function hex6(hex: string): string | null {
  const h = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) return `#${[...h].map((c) => c + c).join('')}`;
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return `#${h.slice(0, 6)}`;
  return null;
}

/** Relative luminance (WCAG) of a hex colour; an unreadable value counts as black. */
export function luminance(hex: string): number {
  const h = hex6(hex) ?? '#000000'; // color-data: unreadable brand hex counts as black
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x! + 0.05) / (y! + 0.05); };

/** The brand's own colours for a cover without images: its background colour (or the lightest) and the colour that reads best on it. */
function paletteFace(all: BrandOverview['kit']['colors']): { bg: string; fg: string } | null {
  const colors = all.filter((c) => hex6(c.hex));
  if (colors.length < 2) return null;
  const bg = colors.find((c) => c.role === 'background')?.hex ?? [...colors].sort((a, b) => luminance(b.hex) - luminance(a.hex))[0]!.hex;
  const fg = colors.filter((c) => c.hex !== bg).sort((a, b) => contrast(b.hex, bg) - contrast(a.hex, bg))[0]!.hex;
  return contrast(fg, bg) >= 3 ? { bg, fg } : null;
}

/**
 * Projects, the home (spec §6.2 #3), ported from the prototype's Projects / ProjectCard and the Projects boards:
 * "Jump back in" with the latest creatives of every project, the project grid (cover from the latest creatives and the
 * brand palette strip) and the inline "New project".
 */
export function Projects({ live }: { live: EventsState }) {
  const t = useT();
  const p = t.web.projects;
  const shell = useContext(ShellContext);
  const [items, setItems] = useState<ProjectListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [recent, setRecent] = useState<RecentCreative[]>([]);
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [sort, setSort] = useState<Sort>('recent');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  // Latest activity of each project as its card shows it (project or creatives): what "Last edited" sorts by.
  const [activity, setActivity] = useState<Readonly<Record<string, string>>>({});
  const onActivity = useCallback((slug: string, iso: string) => setActivity((a) => (a[slug] === iso ? a : { ...a, [slug]: iso })), []);
  const field = useRef<HTMLInputElement>(null);

  const focusNew = useCallback(() => { field.current?.focus(); void flash(field.current); }, []);
  // "New project" from the project switcher (and the header button): bring the name field forward.
  useNewProjectIntent(focusNew);

  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.listProjects())
      .then((r) => { if (alive) { setItems(r); setError(null); } })
      .catch((e: unknown) => { if (alive) setError(message(e)); });
    return () => { alive = false; };
  }, [nonce]);
  // Any creative change may reorder "Jump back in".
  const creativeTick = useMemo(() => Object.values(live.creativeTicks).reduce((a, v) => a + v, 0), [live.creativeTicks]);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.recentCreatives(RECENT)).then((r) => { if (alive) setRecent(r); }).catch(() => { /* the section stays hidden */ });
    return () => { alive = false; };
  }, [creativeTick, nonce]);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getFormats()).then((cat) => { if (alive) setPresets(cat.presets); }).catch(() => { /* square thumbnails */ });
    return () => { alive = false; };
  }, []);

  const sorted = useMemo(() => {
    const list = [...(items ?? [])];
    const key = (i: ProjectListItem) => (i.ok ? i.project.name : i.slug);
    return sort === 'name'
      ? list.sort((a, b) => key(a).localeCompare(key(b)))
      : list.sort((a, b) => lastEdited(b, activity).localeCompare(lastEdited(a, activity)));
  }, [items, sort, activity]);

  const create = async () => {
    const text = name.trim();
    if (!text) { focusNew(); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const { slug, project } = await api.createProject(text);
      setItems((list) => [{ slug, ok: true, project } as Readable, ...(list ?? []).filter((i) => i.slug !== slug)]);
      setFresh((f) => new Set(f).add(slug));
      setName('');
      shell?.catalog.refresh();
      toast.show(p.created({ name: project.name }), { tone: 'ok', action: { label: p.open, run: () => go(href.project(slug)) } });
    } catch (e) {
      setCreateError(p.createFailed({ detail: message(e) }));
    } finally { setCreating(false); }
  };

  const loaded = items !== null;
  // T14: the cards come in as a cascade when the list arrives (the page itself enters with T1); "Jump back in" enters
  // when it appears.
  const root = useEnter<HTMLDivElement>([loaded]);
  const hasRecent = recent.length > 0;
  const jump = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (hasRecent) void enter(jump.current); }, [hasRecent]);
  const waiting = (slug: string) => Object.values(live.approvals).filter((a) => a.projectSlug === slug).length;

  return (
    <div className="ms-projects" ref={root}>
      {hasRecent ? (
        <section className="ms-jump" aria-labelledby="ms-jump-title" ref={jump}>
          <div className="ms-jump-head"><h2 id="ms-jump-title">{p.jumpBackIn}</h2><span>{p.recentCreatives}</span></div>
          <div className="ms-jump-grid">
            {recent.map((c) => <JumpTile key={`${c.project.slug}/${c.slug}`} c={c} live={live} presets={presets} />)}
            <a className="ms-jump-new" href={href.newCreative(recent[0]!.project.slug)}>
              <Icon name="plus" size={14} />
              <span>{p.newCreativeIn({ project: recent[0]!.project.name })}</span>
            </a>
          </div>
        </section>
      ) : null}

      <section className="ms-projects-list" aria-labelledby="ms-projects-title">
        <div className="ms-projects-head">
          <h1 id="ms-projects-title">{p.title}</h1>
          {loaded ? <span className="ms-projects-count">{items.length}</span> : null}
          <div className="ms-grow" />
          {items && items.length > 1 ? (
            <Select<Sort> className="ms-projects-sort" label={p.sort} value={sort} onChange={setSort} options={[{ value: 'recent', label: p.sortRecent }, { value: 'name', label: p.sortName }]} />
          ) : null}
          <Button variant="ink" onClick={focusNew}><Icon name="plus" size={13} strokeWidth={1.8} />{p.newProject}</Button>
        </div>

        {error ? (
          <div className="ms-projects-alert" role="alert">
            <Icon name="warn" size={16} />
            <span>{p.loadFailed({ detail: error })}</span>
            <Button size="sm" variant="outline" onClick={() => { setError(null); setNonce((n) => n + 1); }}>{p.tryAgain}</Button>
          </div>
        ) : null}
        {items?.length === 0 ? (
          <div className="ms-projects-empty" data-enter><b>{p.emptyTitle}</b><span>{p.emptyBody}</span></div>
        ) : null}

        <div className="ms-projects-grid" aria-busy={!loaded && !error ? true : undefined}>
          {!loaded && !error ? (
            <>
              <span className="ms-sr" role="status">{p.loading}</span>
              {[0, 1].map((i) => <div key={i} className="ms-card ms-pcard ms-pskel" aria-hidden="true"><div className="ms-pcover" /><div className="ms-pcard-body"><i /><i /></div></div>)}
            </>
          ) : null}
          {sorted.map((it, i) => it.ok
            ? <ProjectCard key={it.slug} item={it} live={live} waiting={waiting(it.slug)} fresh={fresh.has(it.slug)} index={i} onActivity={onActivity} />
            : (
              <div key={it.slug} className="ms-card ms-pcard ms-broken" data-enter data-delay={i * CASCADE_MS}>
                <div className="ms-pcard-body">
                  <div className="ms-pcard-row"><b className="ms-pcard-name">{it.slug}</b><Pill tone="warn" dot>{p.unreadable}</Pill></div>
                  <code className="ms-pcard-error">{it.error}</code>
                </div>
              </div>
            ))}
          {/* Always there (also while loading): the switcher's "New project" focuses its field on arrival. */}
          <form className="ms-pnew" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <span className="ms-pnew-icon" aria-hidden="true"><Icon name="plus" size={18} /></span>
            <div className="ms-pnew-text"><b>{p.startTitle}</b><span>{p.startBody}</span></div>
            <div className="ms-pnew-row">
              <label className="ms-sr" htmlFor="new-project">{p.nameLabel}</label>
              <Input
                id="new-project" ref={field} value={name} placeholder={p.nameLabel} autoComplete="off"
                aria-invalid={createError ? true : undefined} aria-describedby={createError ? 'new-project-error' : undefined}
                onChange={(e) => { setName(e.target.value); setCreateError(null); }}
              />
              <Button type="submit" variant="ink" loading={creating}>{p.create}</Button>
            </div>
            {createError ? <p className="ms-pnew-error" id="new-project-error" role="alert">{createError}</p> : null}
          </form>
        </div>
      </section>
    </div>
  );
}

/** A "Jump back in" tile: the cover in the proportion of the first format, the project, and the state. */
function JumpTile({ c, live, presets }: { c: RecentCreative; live: EventsState; presets: FormatPreset[] }) {
  const t = useT();
  const p = t.web.projects;
  const s = t.web.creatives;
  const locale = useLocale();
  const { state, job, step } = liveCreative(c, c.project.slug, live);
  const first = presets.find((f) => f.id === c.formats[0]);
  const width = Math.round(Math.min(120, Math.max(40, THUMB_H * (first ? first.width / first.height : 1))));
  const what = c.formats.length === 1 && first ? formatName(first, locale) : p.formats({ n: c.formats.length });
  return (
    <a className="ms-card ms-jump-tile" href={href.creative(c.project.slug, c.slug)}>
      <span className="ms-jump-thumb" style={{ width }}>
        {c.cover ? <Cover src={api.fileUrl(c.project.slug, c.slug, c.cover)} /> : <Icon name={first?.kind === 'image' ? 'image' : 'video'} size={16} />}
      </span>
      <span className="ms-jump-text">
        <b className="ms-jump-title">{c.title}</b>
        <span className="ms-jump-sub">{c.project.name} · {what}</span>
        <span className="ms-jump-state">
          {state === 'needs' ? <span className="ms-js ms-js-warn"><span className="ms-dot" aria-hidden="true" />{p.waiting}</span> : null}
          {state === 'running' ? (
            <span className="ms-js ms-js-run">
              <span className="ms-js-step">{job?.state === 'queued' ? s.queued : step ? p.rendering({ step }) : s.working}</span>
              <span className="ms-progress ms-indet" role="progressbar" aria-label={t.web.ui.progress}><i /></span>
            </span>
          ) : null}
          {state === 'ready' || state === 'incomplete' ? <span className="ms-js ms-js-ok"><span className="ms-dot" aria-hidden="true" />{p.readyWhen({ when: relativeTime(locale, c.updatedAt) })}</span> : null}
          {state === 'draft' ? <span className="ms-js">{s.draft}</span> : null}
          {state === 'failed' ? <span className="ms-js ms-js-fail">{s.failed}</span> : null}
          {state === 'interrupted' ? <span className="ms-js ms-js-fail">{s.interrupted}</span> : null}
        </span>
      </span>
    </a>
  );
}

const VIDEO = /\.(mp4|webm|mov)$/i;
function Cover({ src }: { src: string }) {
  return VIDEO.test(src) ? <video src={src} muted preload="metadata" aria-hidden="true" /> : <img src={src} alt="" />;
}

const later = (a: string, b: string) => (a.localeCompare(b) >= 0 ? a : b);
function lastEdited(item: ProjectListItem, activity: Readonly<Record<string, string>>): string {
  if (!item.ok) return '';
  const seen = activity[item.slug];
  return seen ? later(seen, item.project.updatedAt) : item.project.updatedAt;
}

/** A source of the card: `done` once a load answered (success or failure); data stays on screen while reloading. */
interface Source<T> { value: T | null; done: boolean }
const NONE = { value: null, done: false };

/** Loads `call` on every change of `deps`; a response for older deps is dropped. */
function useSource<T>(call: () => Promise<T>, deps: unknown[]): Source<T> {
  const [src, setSrc] = useState<Source<T>>(NONE);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(call)
      .then((value) => { if (alive) setSrc({ value, done: true }); })
      .catch(() => { if (alive) setSrc((s) => ({ ...s, done: true })); });
    return () => { alive = false; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return src;
}

interface CardProps { item: Readable; live: EventsState; waiting: number; fresh: boolean; index: number; onActivity(slug: string, iso: string): void }

function ProjectCard({ item, live, waiting, fresh, index, onActivity }: CardProps) {
  const t = useT();
  const p = t.web.projects;
  const locale = useLocale();
  const { slug, project } = item;
  const ref = useRef<HTMLAnchorElement>(null);
  // Creatives follow their own ticks; the brand and the library follow the project's.
  const creativeTick = Object.entries(live.creativeTicks).filter(([k]) => k.startsWith(`${slug}/`)).reduce((a, [, v]) => a + v, 0);
  const projectTick = live.projectTicks[slug] ?? 0;
  const creatives = useSource(() => api.listCreatives(slug), [slug, creativeTick]);
  const brand = useSource(() => api.getBrand(slug), [slug, projectTick]);
  const assets = useSource(() => api.listAssets(slug).then((r) => r.assets.length), [slug, projectTick]);

  // T14: a project created inline enters with scale(.96) from 16 px.
  useLayoutEffect(() => { if (fresh) void enter(ref.current, { y: 16, scale: 0.96 }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const readable = (creatives.value ?? []).flatMap((c) => (c.ok ? [c] : []));
  const covers = readable.filter((c) => c.cover).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, COVERS);
  const colors = (brand.value?.kit.colors ?? []).filter((c) => hex6(c.hex));
  const fonts = brand.value?.kit.fonts.length ?? 0;
  const face = paletteFace(colors);
  const site = siteOf(brand.value, project);
  const updated = readable.reduce((a, c) => later(a, c.updatedAt), project.updatedAt);
  useEffect(() => { onActivity(slug, updated); }, [onActivity, slug, updated]);
  // The name stands in for the cover only once we know there is no cover (no flash of the word before the images).
  const settled = creatives.done && brand.done;
  const data = { creatives: creatives.value, assets: assets.value };

  return (
    <a
      ref={ref} href={href.project(slug)} className="ms-card ms-pcard"
      data-enter={fresh ? undefined : ''} data-delay={index * CASCADE_MS}
    >
      <div
        className={cx('ms-pcover', covers.length > 0 && `ms-n${covers.length}`)}
        style={!covers.length && face ? { background: face.bg } : undefined} // color-data
      >
        {covers.map((c) => <Cover key={c.slug} src={api.fileUrl(slug, c.slug, c.cover!)} />)}
        {!covers.length && settled ? (
          <span className={cx('ms-pcover-word', project.name.length > 18 && 'ms-long')} style={face ? { color: face.fg } : undefined}>{project.name}</span> // color-data
        ) : null}
        {colors.length ? (
          <div className="ms-pstrip" aria-hidden="true">
            {colors.slice(0, PALETTE_MAX).map((c) => <span key={c.id} style={{ background: c.hex }} />)}{/* color-data */}
          </div>
        ) : null}
        {waiting ? <span className="ms-pcover-wait"><span className="ms-dot" aria-hidden="true" />{p.approvalsWaiting({ n: waiting })}</span> : null}
      </div>
      <div className="ms-pcard-body">
        <div className="ms-pcard-row">
          <span
            className="ms-pmono" aria-hidden="true"
            style={face ? { background: colors[0]!.hex, color: contrast(colors[0]!.hex, face.bg) >= 3 ? face.bg : face.fg } : undefined} // color-data
          >
            {initials(project.name)}
          </span>
          <span className="ms-pcard-id">
            <b className="ms-pcard-name">{project.name}</b>
            {site ? <span className="ms-pcard-site">{site}</span> : null}
          </span>
          <span className="ms-pcard-when">{relativeTime(locale, updated)}</span>
        </div>
        <div className="ms-pcard-stats">
          {data.creatives ? <span><b>{readable.length}</b> {p.creatives({ n: readable.length })}</span> : null}
          {data.assets !== null ? <span><b>{data.assets}</b> {p.assets({ n: data.assets })}</span> : null}
          {colors.length || fonts ? (
            <span><b>{colors.length}</b> {p.colors({ n: colors.length })} · <b>{fonts}</b> {p.fonts({ n: fonts })}</span>
          ) : null}
        </div>
      </div>
    </a>
  );
}

/** The brand's website (host only), else the project description. */
function siteOf(brand: BrandOverview | null, project: ProjectFile): string | null {
  const url = brand?.sources.find((s) => s.kind === 'website' && s.url)?.url;
  if (url) {
    try { return new URL(url).host.replace(/^www\./, ''); } catch { /* fall through */ }
  }
  return project.description.trim() || null;
}

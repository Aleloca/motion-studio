import { IntegrityNotice, useIntegrity } from '../components/IntegrityNotice.tsx';
import type { AssetEntry, AssetKind, AssetOrigin, JobSummary } from '@motion-studio/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api } from '../api.ts';
import type { EventsState } from '../eventsReducer.ts';
import { useT } from '../i18n.tsx';
import { brandJobFailedText, isActiveJob, isDescribeJob } from '../labels.ts';
import { D, enter, exit, useEnter } from '../motion/index.ts';
import { href } from '../routes.ts';
import { requestNewCreativeWithAssets } from '../shell/intents.ts';
import { go } from '../shell/ShellContext.tsx';
import { Button, Check, Chip, Empty, Icon, Input, NavItem, Pill, Popover, Select, Spinner, Tag, clockText, cx, toast, type IconName } from '../ui/index.ts';
import { Alert, UNDO_MS, message } from './common.tsx';
import { KEEPALIVE, deferRemoval, isPendingRemoval, removalKey, usePendingRemovals } from './deferred.ts';
import { AssetDetail } from './assets/AssetDetail.tsx';
import { GenerateDialog } from './assets/GenerateDialog.tsx';
import { KINDS, SORTS, baseName, mergeTags, sortAssets, splitTags, type AssetSort } from './assets/model.ts';
import { Thumb } from './assets/Thumb.tsx';
import './library.css';

export { baseName, mergeTags };

const ORIGINS: AssetOrigin[] = ['website', 'upload', 'generated', 'stock', 'google-fonts', 'codebase'];

type Listing = { assets: AssetEntry[]; error: string | null; unregistered: string[] };
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** The newest job of this project's brand key (analysis or description). Without the key, an active brand job of the slug. */
function brandJob(jobs: Record<string, JobSummary>, jobKey: string | null, slug: string): JobSummary | undefined {
  const all = Object.values(jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return jobKey ? all.find((j) => j.key === jobKey) : all.find((j) => isActiveJob(j) && j.key.startsWith('brand:') && j.key.endsWith(`:${slug}`));
}

/**
 * Project · Assets (spec §6.2 #10, visual test 16–19), ported from the prototype's AssetsPage / AssetCard / AssetDetail /
 * SelBar and the Assets boards: filters by type, origin and tag with search; cards with description and tags;
 * "Describing…" on the assets of a description job; multiple selection (Describe again, Add tags, Use in a creative,
 * Delete with Undo); the detail panel with description and tag chips; drop files anywhere on the page.
 */
export function Assets({ slug, live }: { slug: string; live: EventsState }) {
  const t = useT();
  const a = t.web.library.assets;
  const tick = live.projectTicks[slug] ?? 0;
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jobKey, setJobKey] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);

  useEffect(() => {
    let alive = true; // a slow answer for an older tick must not overwrite a newer one
    Promise.resolve().then(() => api.listAssets(slug))
      .then((l) => { if (alive) { setListing(l); setLoadError(null); } })
      .catch((e: unknown) => { if (alive) setLoadError(message(e)); });
    return () => { alive = false; };
  }, [slug, tick, nonce]);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getBrand(slug)).then((b) => { if (alive) setJobKey(b.jobKey); }).catch(() => { /* the slug finds the job */ });
    Promise.resolve().then(() => api.getProject(slug)).then((p) => { if (alive) setProjectName(p.project.name); }).catch(() => { /* the slug stands in */ });
    return () => { alive = false; };
  }, [slug]);

  if (!listing && loadError) {
    return (
      <div className="ms-lib-center">
        <Empty icon="warn" title={a.loadFailed({ detail: loadError })} action={<Button onClick={() => { setLoadError(null); reload(); }}>{a.retry}</Button>} />
      </div>
    );
  }
  if (!listing) return <div className="ms-lib-center"><Spinner size={20} /></div>;
  return (
    <AssetsBody slug={slug} live={live} listing={listing} setListing={setListing} reload={reload}
      job={brandJob(live.jobs, jobKey, slug)} projectName={projectName ?? slug} />
  );
}

interface BodyProps {
  slug: string; live: EventsState; listing: Listing; setListing(f: (l: Listing | null) => Listing | null): void; reload(): void;
  job: JobSummary | undefined; projectName: string;
}

function AssetsBody({ slug, live, listing, setListing, reload, job, projectName }: BodyProps) {
  const t = useT();
  const integrity = useIntegrity(slug, live);
  const a = t.web.library.assets;
  const root = useEnter<HTMLDivElement>([]);
  const [type, setType] = useState<AssetKind | 'all'>('all');
  const [origin, setOrigin] = useState<AssetOrigin | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<AssetSort>('date');
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<string | null>(null);
  // Deletes waiting for their Undo time: the cards are hidden until the delete goes out (or Undo brings them back).
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [uploading, setUploading] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [drag, setDrag] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const firstPaint = useRef(true);
  useEffect(() => { firstPaint.current = false; }, []);

  // Deletes started earlier (this screen was left and opened again within the Undo time) stay hidden too; when one goes
  // out, the item leaves this screen's (older) listing in the same render.
  const removals = usePendingRemovals((keys) => {
    setListing((l) => (l ? { ...l, assets: l.assets.filter((x) => !keys.includes(removalKey('asset', slug, x.file))) } : l));
  });
  const assets = useMemo(
    () => listing.assets.filter((x) => !hidden.has(x.file) && !isPendingRemoval(removalKey('asset', slug, x.file))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `removals` changes when a pending removal settles
    [listing.assets, hidden, slug, removals],
  );
  // The selection bar acts on what is selected: a filter change clears the selection, so it never acts on assets that
  // are no longer on screen.
  const filterKey = `${type}\n${origin ?? ''}\n${tag ?? ''}\n${query.trim()}`;
  const lastFilter = useRef(filterKey);
  useEffect(() => {
    if (lastFilter.current === filterKey) return;
    lastFilter.current = filterKey;
    setSel((s) => (s.size ? new Set() : s));
  }, [filterKey]);
  // A selection or an open detail of an asset that is gone (deleted elsewhere, hidden) lets go of it.
  useEffect(() => {
    const files = new Set(assets.map((x) => x.file));
    setSel((s) => ([...s].every((f) => files.has(f)) ? s : new Set([...s].filter((f) => files.has(f)))));
    setOpen((o) => (o && !files.has(o) ? null : o));
  }, [assets]);

  // Description: the assets this page asked to describe, until their job ends; otherwise, while a description job
  // started elsewhere runs, the assets without a description (what the core describes by default).
  const [requested, setRequested] = useState<{ jobId: string; files: string[] } | null>(null);
  const reqJob = requested ? live.jobs[requested.jobId] : undefined;
  const reqDone = Boolean(reqJob && !isActiveJob(reqJob));
  useEffect(() => {
    if (!requested || !reqJob || isActiveJob(reqJob)) return;
    if (reqJob.state === 'succeeded') toast.show(a.described, { tone: 'ok' });
    setRequested(null);
    reload();
  }, [requested, reqJob, a, reload]);
  const running = isActiveJob(job);
  const describing = useMemo(() => {
    if (requested && !reqDone) return new Set(requested.files);
    if (job && running && isDescribeJob(job)) return new Set(assets.filter((x) => !x.description.trim()).map((x) => x.file));
    return new Set<string>();
  }, [requested, reqDone, job, running, assets]);
  const busy = running || Boolean(requested && !reqDone);

  const describe = useCallback(async (files: string[]): Promise<boolean> => {
    if (files.length === 0) return false;
    try {
      const started = await api.describeAssets(slug, files);
      setRequested({ jobId: started.id, files });
      return true;
    } catch (e) {
      toast.show(a.describeFailed({ detail: message(e) }));
      return false;
    }
  }, [slug, a]);

  const upload = useCallback(async (files: File[]) => {
    if (files.length === 0 || listing.error) return;
    const names = files.map((f) => f.name);
    setUploading((u) => [...u, ...names]);
    try {
      const res = (await api.uploadFiles(slug, 'assets', files)) as { assets?: AssetEntry[] };
      const added = res.assets ?? [];
      setFresh((s) => new Set([...s, ...added.map((x) => x.file)]));
      setListing((l) => (l ? { ...l, assets: [...l.assets.filter((x) => !added.some((n) => n.file === x.file)), ...added] } : l));
      // No agent run without a click: the new files wait in "N without a description → Describe them".
      toast.show(a.uploaded({ count: added.length }), { tone: 'ok' });
      reload();
    } catch (e) {
      toast.show(a.uploadFailed({ detail: message(e) }));
    } finally {
      setUploading((u) => u.filter((n) => !names.includes(n)));
    }
  }, [slug, listing.error, a, setListing, reload]);

  const remove = useCallback(async (files: string[]) => {
    if (files.length === 0) return;
    setSel(new Set());
    setOpen((o) => (o && files.includes(o) ? null : o));
    const els = [...(root.current?.querySelectorAll<HTMLElement>('[data-file]') ?? [])].filter((el) => files.includes(el.dataset.file ?? ''));
    const finished = await Promise.all(els.map((el) => exit(el, { y: 6, ms: D.s })));
    if (finished.includes(false)) return; // an entrance revived a card meanwhile
    setHidden((h) => new Set([...h, ...files]));
    const unhide = (only: string[] = files) => setHidden((h) => new Set([...h].filter((f) => !only.includes(f))));
    // Set when some (not all) deletes failed: only those files come back.
    let failed: string[] | null = null;
    deferRemoval({
      text: a.deleted({ count: files.length, name: baseName(files[0]!) }),
      undoLabel: a.undo,
      ms: UNDO_MS,
      keys: files.map((f) => removalKey('asset', slug, f)),
      commit: async () => {
        // Every request starts synchronously: on pagehide only requests already issued leave before the page dies.
        const results = await Promise.allSettled(files.map((f) => api.deleteAsset(slug, f, KEEPALIVE)));
        const bad = files.filter((_, i) => results[i]!.status === 'rejected');
        if (bad.length) {
          failed = bad;
          const gone = files.filter((f) => !bad.includes(f));
          setListing((l) => (l ? { ...l, assets: l.assets.filter((x) => !gone.includes(x.file)) } : l));
          throw (results[files.indexOf(bad[0]!)] as PromiseRejectedResult).reason;
        }
        setListing((l) => (l ? { ...l, assets: l.assets.filter((x) => !files.includes(x.file)) } : l));
        unhide();
        reload();
      },
      restore: () => unhide(failed ?? files),
      onError: (e) => { toast.show(a.deleteFailed({ detail: message(e) })); reload(); },
    });
  }, [slug, a, root, setListing, reload]);

  const useInCreative = useCallback((files: string[]) => {
    requestNewCreativeWithAssets(slug, files.map((f) => `assets/${f}`));
    go(href.newCreative(slug));
  }, [slug]);

  const saved = useCallback((entry: AssetEntry) => {
    setListing((l) => (l ? { ...l, assets: l.assets.map((x) => (x.file === entry.file ? entry : x)) } : l));
  }, [setListing]);

  // A renamed file is a new key everywhere: the listing, the selection and the open detail follow it.
  const renamed = useCallback((from: string, entry: AssetEntry) => {
    setListing((l) => (l ? { ...l, assets: l.assets.map((x) => (x.file === from ? entry : x)) } : l));
    setSel((s) => (s.has(from) ? new Set([...s].map((f) => (f === from ? entry.file : f))) : s));
    setOpen((o) => (o === from ? entry.file : o));
    reload();
  }, [setListing, reload]);

  const addTags = useCallback(async (files: string[], text: string) => {
    const added = splitTags(text);
    if (!added.length) return;
    try {
      for (const f of files) {
        const cur = listing.assets.find((x) => x.file === f);
        if (!cur) continue;
        const next = mergeTags(cur.tags, added);
        if (next.length !== cur.tags.length) saved(await api.updateAsset(slug, f, { tags: next }));
      }
      toast.show(a.tagsAdded({ count: files.length }), { tone: 'ok' });
    } catch (e) {
      toast.show(a.tagsFailed({ detail: message(e) }));
    }
    reload();
  }, [listing.assets, slug, a, saved, reload]);

  const register = async () => {
    try { await api.registerAssets(slug, listing.unregistered); reload(); } catch (e) { toast.show(a.registerFailed({ detail: message(e) })); }
  };

  // Filters.
  const shown = sortAssets(assets, sort).filter((x) => (type === 'all' || x.kind === type) && (!origin || x.origin === origin) && (!tag || x.tags.includes(tag))
    && (!query.trim() || `${x.file} ${x.description} ${x.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())));
  const filtered = type !== 'all' || origin !== null || tag !== null || query.trim() !== '';
  const clear = () => { setType('all'); setOrigin(null); setTag(null); setQuery(''); };
  const tags = useMemo(() => {
    const count = new Map<string, number>();
    for (const x of assets) for (const g of x.tags) count.set(g, (count.get(g) ?? 0) + 1);
    return [...count.entries()].sort((p, q) => q[1] - p[1] || p[0].localeCompare(q[0])).slice(0, 12).map(([g]) => g);
  }, [assets]);
  const undescribed = assets.filter((x) => !x.description.trim()).map((x) => x.file);
  const detail = open ? assets.find((x) => x.file === open) : undefined;
  const toggle = (f: string) => setSel((s) => { const n = new Set(s); if (n.has(f)) n.delete(f); else n.add(f); return n; });

  // Drop anywhere on the page (dragenter/leave are counted: children fire their own).
  const canUpload = !listing.error;
  // An unreadable library takes no files: no drop target is offered then.
  const onDragEnter = (e: DragEvent) => { if (!canUpload || !hasFiles(e)) return; e.preventDefault(); dragDepth.current += 1; setDrag(true); };
  const onDragOver = (e: DragEvent) => { if (canUpload && hasFiles(e)) e.preventDefault(); };
  const onDragLeave = (e: DragEvent) => { if (!canUpload || !hasFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDrag(false); };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDrag(false);
    if (canUpload) void upload(Array.from(e.dataTransfer?.files ?? []));
  };
  const pick = () => fileInput.current?.click();
  const lastJobFailed = job && !running && isDescribeJob(job) && job.state === 'failed';

  return (
    <div ref={root} className={cx('ms-assets', detail && 'ms-with-detail')} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <input ref={fileInput} type="file" multiple hidden aria-label={a.uploadInput} onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      <aside className="ms-assets-side">
        <nav className="ms-assets-filters" aria-label={a.filters}>
          <div className="ms-lib-group">
            <span className="ms-lib-cap">{a.type}</span>
            <FilterItem on={type === 'all'} icon="grid" count={assets.length} onClick={() => setType('all')}>{a.kinds.all}</FilterItem>
            {KINDS.map((k) => {
              const n = assets.filter((x) => x.kind === k).length;
              return <FilterItem key={k} on={type === k} icon={KIND_ICON[k]} count={n} dim={n === 0} onClick={() => setType(k)}>{a.kinds[k]}</FilterItem>;
            })}
          </div>
          <div className="ms-lib-group">
            <span className="ms-lib-cap">{a.origin}</span>
            {ORIGINS.map((o) => {
              const n = assets.filter((x) => x.origin === o).length;
              return <FilterItem key={o} on={origin === o} count={n} dim={n === 0} onClick={() => setOrigin(origin === o ? null : o)}>{a.origins[o]}</FilterItem>;
            })}
          </div>
          {tags.length > 0 ? (
            <div className="ms-lib-group">
              <span className="ms-lib-cap">{a.tags}</span>
              <div className="ms-assets-tags">
                {tags.map((g) => <Chip key={g} on={tag === g} onClick={() => setTag(tag === g ? null : g)}>{g}</Chip>)}
              </div>
            </div>
          ) : null}
        </nav>
        <div className="ms-grow" />
        <DescribeCard count={undescribed.length} total={assets.length} describing={describing.size > 0} busy={busy}
          onDescribe={() => void describe(undescribed)} />
      </aside>

      <main className="ms-assets-main">
        <div className="ms-assets-head" data-enter>
          <h1>{a.title}</h1>
          <span className="ms-lib-muted">{a.count({ shown: shown.length, total: assets.length })}</span>
          {sel.size ? <span className="ms-lib-muted">· {a.selectedCount({ count: sel.size })}</span> : null}
          {filtered ? <Button size="sm" variant="ghost" onClick={clear}>{a.clearFilters}</Button> : null}
          <div className="ms-grow" />
          <Select className="ms-assets-sort" variant="pill" label={a.sort.label} value={sort} onChange={(v) => setSort(v as AssetSort)} options={SORTS.map((k) => ({ value: k, label: a.sort[k] }))} />
          <label className="ms-lib-search">
            <Icon name="search" size={14} />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={a.searchPlaceholder} aria-label={a.search} />
          </label>
          <Button variant="outline" disabled={!canUpload} onClick={() => setGenerating(true)}><Icon name="sparkle" size={13} strokeWidth={1.7} />{t.web.library.generate.open}</Button>
          <Button variant="ink" disabled={!canUpload} onClick={pick}><Icon name="upload" size={13} strokeWidth={1.7} />{a.upload}</Button>
        </div>
        <GenerateDialog open={generating} onClose={() => setGenerating(false)} slug={slug} live={live} />

        {listing.error ? <Alert>{a.listUnreadable({ detail: listing.error })}</Alert> : null}
        {listing.unregistered.length > 0 ? (
          <Alert action={<Button size="sm" variant="outline" onClick={() => void register()}>{a.register}</Button>}>{a.unregistered({ count: listing.unregistered.length })}</Alert>
        ) : null}
        {integrity.state ? <IntegrityNotice slug={slug} state={integrity.state} reload={integrity.reload} /> : null}
        {lastJobFailed ? <Alert>{brandJobFailedText(job, t)}</Alert> : null}
        {job && !running && isDescribeJob(job) ? (job.notes ?? []).map((n) => <Alert key={n}>{n}</Alert>) : null}

        {assets.length === 0 && uploading.length === 0 ? (
          <div className="ms-lib-empty">
            <Empty icon="image" title={a.emptyTitle} sub={a.emptyBody}
              action={<Button variant="ink" disabled={!canUpload} onClick={pick}><Icon name="upload" size={13} />{a.upload}</Button>} />
          </div>
        ) : shown.length === 0 && uploading.length === 0 ? (
          <div className="ms-lib-empty">
            <Empty icon="search" title={a.noMatchTitle} sub={a.noMatchBody} action={<Button size="sm" variant="outline" onClick={clear}>{a.clearFilters}</Button>} />
          </div>
        ) : (
          <div className="ms-assets-grid">
            {shown.map((x, i) => (
              <AssetCard key={x.file} slug={slug} asset={x} index={i} cascade={firstPaint.current} fresh={fresh.has(x.file)}
                selected={sel.has(x.file)} active={open === x.file} describing={describing.has(x.file)}
                onSelect={() => toggle(x.file)} onOpen={() => setOpen(x.file)} />
            ))}
            {uploading.map((name, i) => <UploadingCard key={`${name}-${i}`} name={name} />)}
            {canUpload ? (
              <button type="button" className="ms-assets-drop" onClick={pick}>
                <Icon name="upload" size={20} />
                <b>{a.dropTitle}</b>
                <span>{a.dropBody}</span>
              </button>
            ) : null}
          </div>
        )}
      </main>

      <div className="ms-assets-detail">
        {detail ? (
          <AssetDetail key={detail.file} slug={slug} asset={detail} describing={describing.has(detail.file)} busy={busy}
            onClose={() => setOpen(null)} onSaved={saved} onRenamed={renamed} onDescribe={() => void describe([detail.file])}
            onUse={() => useInCreative([detail.file])} onDelete={() => void remove([detail.file])} />
        ) : null}
      </div>
      {sel.size ? (
        <SelBar count={sel.size} busy={busy} onDescribe={() => { const files = [...sel]; setSel(new Set()); void describe(files); }}
          onAddTags={(text) => addTags([...sel], text)} onUse={() => useInCreative([...sel])}
          onDelete={() => void remove([...sel])} onClear={() => setSel(new Set())} />
      ) : null}
      {drag && canUpload ? <div className="ms-lib-dropzone" aria-hidden="true"><span>{a.dropOverlay({ project: projectName })}</span></div> : null}
    </div>
  );
}

const KIND_ICON: Record<AssetKind, IconName> = { image: 'image', svg: 'edit', video: 'video', font: 'text', audio: 'play', other: 'folder' };

/** A filter row of the side navigation: a toggle (aria-pressed), not a page. */
function FilterItem({ on, icon, count, dim, onClick, children }: { on: boolean; icon?: IconName; count: number; dim?: boolean; onClick(): void; children: string }) {
  return <NavItem icon={icon} count={count} aria-pressed={on} className={cx(on && 'ms-on', dim && 'ms-dim')} onClick={onClick}>{children}</NavItem>;
}

/** Side card (point 17): how many assets have no description, and a button that says it. */
function DescribeCard({ count, total, describing, busy, onDescribe }: { count: number; total: number; describing: boolean; busy: boolean; onDescribe(): void }) {
  const t = useT();
  const a = t.web.library.assets;
  if (total === 0) return null;
  return (
    <div className="ms-assets-describe">
      {describing ? (
        <span className="ms-lib-row"><Spinner decorative size={12} />{a.describing}</span>
      ) : count === 0 ? (
        <span className="ms-lib-row ms-lib-muted"><Icon name="check" size={12} />{a.allDescribed}</span>
      ) : (
        <>
          <span>{a.undescribed({ count })}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={onDescribe}><Icon name="sparkle" size={12} />{a.describeMissing({ count })}</Button>
          {busy ? <span className="ms-lib-note">{a.describeBusy}</span> : null}
        </>
      )}
    </div>
  );
}

interface CardProps {
  slug: string; asset: AssetEntry; index: number; cascade: boolean; fresh: boolean; selected: boolean; active: boolean; describing: boolean;
  onSelect(): void; onOpen(): void;
}

function AssetCard({ slug, asset: x, index, cascade, fresh, selected, active, describing, onSelect, onOpen }: CardProps) {
  const t = useT();
  const a = t.web.library.assets;
  const ref = useRef<HTMLDivElement>(null);
  const name = baseName(x.file);
  // T14: a cascade at the first appearance; a new card arrives with scale(.96).
  useLayoutEffect(() => {
    void enter(ref.current, fresh ? { y: 14, scale: 0.96 } : { y: 8, delay: cascade ? Math.min(index, 12) * 30 : 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} data-file={x.file} className={cx('ms-acard', selected && 'ms-sel', active && 'ms-active')}>
      <div className="ms-acard-media">
        <Thumb slug={slug} asset={x} />
        {x.width && x.height && (x.kind === 'image' || x.kind === 'video') ? <span className="ms-acard-dims">{x.width}×{x.height}</span> : null}
        {x.durationSec && (x.kind === 'video' || x.kind === 'audio') ? <span className="ms-acard-dur" title={a.durationBadge({ time: clockText(x.durationSec) })}>{clockText(x.durationSec)}</span> : null}
        {describing ? (
          <>
            <span className="ms-shimmer" aria-hidden="true" />
            <Pill spinner className="ms-acard-describing">{a.describing}</Pill>
          </>
        ) : null}
      </div>
      <div className="ms-acard-body">
        <b className="ms-acard-name" title={x.file}>{name}</b>
        {describing ? (
          <span className="ms-acard-skeleton" aria-hidden="true"><i /><i /></span>
        ) : x.description.trim() ? (
          <span className="ms-acard-desc">{x.description}</span>
        ) : (
          <span className="ms-acard-desc ms-lib-faint">{a.noDescription}</span>
        )}
        <span className="ms-acard-meta">
          {x.tags.slice(0, 2).map((g) => <Tag key={g}>{g}</Tag>)}
          {x.tags.length > 2 ? <span className="ms-lib-faint">{a.more({ count: x.tags.length - 2 })}</span> : null}
          <span className="ms-acard-origin">{a.originShort[x.origin]}</span>
        </span>
      </div>
      {/* The whole card opens the detail; the check sits above this layer. */}
      <button type="button" className="ms-acard-open" aria-label={a.open({ name })} aria-expanded={active} onClick={onOpen} />
      <span className="ms-acard-check"><Check on={selected} onChange={onSelect} label={a.select({ name })} /></span>
    </div>
  );
}

function UploadingCard({ name }: { name: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { void enter(ref.current, { y: 14, scale: 0.96 }); }, []);
  return (
    <div ref={ref} className="ms-acard ms-acard-uploading" aria-busy="true">
      <div className="ms-acard-media"><span className="ms-athumb ms-athumb-file"><Spinner decorative size={18} /></span><span className="ms-shimmer" aria-hidden="true" /></div>
      <div className="ms-acard-body">
        <b className="ms-acard-name">{name}</b>
        <span className="ms-acard-desc ms-lib-faint">{t.web.library.assets.uploading}</span>
      </div>
    </div>
  );
}

/** The selection bar (prototype SelBar): dark, centred 20 px above the bottom of the grid column; enters from +16 px. */
function SelBar({ count, busy, onDescribe, onAddTags, onUse, onDelete, onClear }: {
  count: number; busy: boolean; onDescribe(): void; onAddTags(text: string): Promise<void>; onUse(): void; onDelete(): void; onClear(): void;
}) {
  const t = useT();
  const a = t.web.library.assets;
  const ref = useRef<HTMLDivElement>(null);
  const tagsBtn = useRef<HTMLButtonElement>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  useLayoutEffect(() => { void enter(ref.current, { y: 16 }); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!splitTags(text).length || saving) return;
    setSaving(true);
    await onAddTags(text);
    setSaving(false);
    setText('');
    setTagsOpen(false);
  };
  return (
    <div className="ms-selbar-wrap">
      <div ref={ref} className="ms-selbar" role="toolbar" aria-label={a.selection}>
        <b>{a.selectedCount({ count })}</b>
        <button type="button" className="ms-selbar-btn" disabled={busy} title={busy ? a.describeBusy : undefined} onClick={onDescribe}>{a.describeAgain}</button>
        <button ref={tagsBtn} type="button" className="ms-selbar-btn" aria-expanded={tagsOpen} onClick={() => setTagsOpen((o) => !o)}>{a.addTags}</button>
        <button type="button" className="ms-selbar-btn" onClick={onUse}>{a.useInCreative}</button>
        <span className="ms-selbar-sep" aria-hidden="true" />
        <button type="button" className="ms-selbar-btn ms-selbar-danger" onClick={onDelete}>{a.delete}</button>
        <button type="button" className="ms-selbar-btn ms-selbar-x" aria-label={a.clearSelection} onClick={onClear}><Icon name="close" size={11} /></button>
      </div>
      <Popover open={tagsOpen} onClose={() => setTagsOpen(false)} anchor={tagsBtn} placement="top-start" width={280}>
        <form className="ms-lib-pop" onSubmit={(e) => void submit(e)}>
          <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label={a.addTagsLabel} placeholder={a.addTagsPlaceholder} />
          <Button type="submit" size="sm" variant="ink" loading={saving} disabled={!splitTags(text).length}>{a.addTagsApply}</Button>
        </form>
      </Popover>
    </div>
  );
}


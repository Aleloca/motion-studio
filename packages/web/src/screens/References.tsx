import type { ReferenceEntry } from '@motion-studio/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { api } from '../api.ts';
import type { EventsState } from '../eventsReducer.ts';
import { useT } from '../i18n.tsx';
import { collapse, enter, useEnter } from '../motion/index.ts';
import { href } from '../routes.ts';
import { go } from '../shell/ShellContext.tsx';
import { Button, Card, Empty, Icon, Spinner, Textarea, Toggle, cx, toast } from '../ui/index.ts';
import { Alert, UNDO_MS, message } from './Assets.tsx';
import { deferRemoval, flushDeferred } from './deferred.ts';
import './library.css';

type Listing = { references: ReferenceEntry[]; error: string | null };
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/**
 * Project · References (spec §6.2 #11), ported from the prototype's ReferencesPage / RefCard and the References boards:
 * a moodboard in columns with notes, the "Brand analysis" switch per card, "Analyze brand with these", removal with
 * Undo. Images are added through the upload; there is no link field because the API cannot add a link (R4).
 */
export function References({ slug, live }: { slug: string; live: EventsState }) {
  const t = useT();
  const r = t.web.library.references;
  const tick = live.projectTicks[slug] ?? 0;
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.listReferences(slug))
      .then((l) => { if (alive) { setListing(l); setLoadError(null); } })
      .catch((e: unknown) => { if (alive) setLoadError(message(e)); });
    return () => { alive = false; };
  }, [slug, tick, nonce]);

  if (!listing && loadError) {
    return (
      <div className="ms-lib-center">
        <Empty icon="warn" title={r.loadFailed({ detail: loadError })} action={<Button onClick={() => { setLoadError(null); reload(); }}>{r.retry}</Button>} />
      </div>
    );
  }
  if (!listing) return <div className="ms-lib-center"><Spinner size={20} /></div>;
  return <ReferencesBody slug={slug} listing={listing} setListing={setListing} reload={reload} />;
}

function ReferencesBody({ slug, listing, setListing, reload }: { slug: string; listing: Listing; setListing(f: (l: Listing | null) => Listing | null): void; reload(): void }) {
  const t = useT();
  const r = t.web.library.references;
  const root = useEnter<HTMLDivElement>([]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  // Switches flipped here, until the API answers (the switch moves at once; a failure puts it back).
  const [brandUse, setBrandUse] = useState<Record<string, boolean>>({});
  const [uploading, setUploading] = useState(0);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [analyzing, setAnalyzing] = useState(false);
  const [drag, setDrag] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const firstPaint = useRef(true);
  useEffect(() => { firstPaint.current = false; }, []);

  const refs = listing.references.filter((x) => !hidden.has(x.file));
  const on = (x: ReferenceEntry) => brandUse[x.file] ?? x.useForBrand;
  const feeding = refs.filter(on).length;
  const replace = useCallback((entry: ReferenceEntry) => {
    setListing((l) => (l ? { ...l, references: l.references.map((x) => (x.file === entry.file ? entry : x)) } : l));
  }, [setListing]);

  const toggle = async (x: ReferenceEntry, value: boolean) => {
    setBrandUse((m) => ({ ...m, [x.file]: value }));
    try {
      replace(await api.updateReference(slug, x.file, { useForBrand: value }));
    } catch (e) {
      toast.show(r.saveFailed({ detail: message(e) }));
    } finally {
      setBrandUse((m) => { const { [x.file]: _, ...rest } = m; return rest; });
    }
  };
  const saveNote = async (x: ReferenceEntry, note: string): Promise<boolean> => {
    try { replace(await api.updateReference(slug, x.file, { note })); return true; }
    catch (e) { toast.show(r.saveFailed({ detail: message(e) })); return false; }
  };

  const remove = async (x: ReferenceEntry, el: HTMLElement | null) => {
    // T15: height and opacity go to zero, then the toast with Undo.
    if (!(await collapse(el))) return;
    setHidden((h) => new Set(h).add(x.file));
    const unhide = () => setHidden((h) => { const n = new Set(h); n.delete(x.file); return n; });
    deferRemoval({
      text: r.removed,
      undoLabel: r.undo,
      ms: UNDO_MS,
      commit: async () => {
        await api.deleteReference(slug, x.file);
        setListing((l) => (l ? { ...l, references: l.references.filter((y) => y.file !== x.file) } : l));
        unhide();
        reload();
      },
      restore: unhide,
      onError: (e) => { toast.show(r.removeFailed({ detail: message(e) })); reload(); },
    });
  };

  const upload = async (files: File[]) => {
    if (files.length === 0 || listing.error) return;
    setUploading((n) => n + files.length);
    try {
      const res = (await api.uploadFiles(slug, 'references', files)) as { references?: ReferenceEntry[] };
      const added = res.references ?? [];
      setFresh((s) => new Set([...s, ...added.map((x) => x.file)]));
      setListing((l) => (l ? { ...l, references: [...l.references.filter((x) => !added.some((n) => n.file === x.file)), ...added] } : l));
      toast.show(r.uploaded({ count: added.length }), { tone: 'ok' });
      reload();
    } catch (e) {
      toast.show(r.uploadFailed({ detail: message(e) }));
    } finally {
      setUploading((n) => Math.max(0, n - files.length));
    }
  };

  // "Analyze brand with these": pending removals go out first (a removed image must not be analyzed), then the
  // analysis starts and Brand shows it live.
  const analyze = async () => {
    setAnalyzing(true);
    try {
      await flushDeferred();
      await api.analyzeBrand(slug);
      go(href.project(slug, 'brand'));
    } catch (e) {
      toast.show(r.analyzeFailed({ detail: message(e) }));
    } finally {
      setAnalyzing(false);
    }
  };

  const onDragEnter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current += 1; setDrag(true); };
  const onDragOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
  const onDragLeave = (e: DragEvent) => { if (!hasFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDrag(false); };
  const onDrop = (e: DragEvent) => { e.preventDefault(); dragDepth.current = 0; setDrag(false); void upload(Array.from(e.dataTransfer?.files ?? [])); };
  const pick = () => fileInput.current?.click();
  const canUpload = !listing.error;

  return (
    <div className="ms-refs" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <input ref={fileInput} type="file" accept="image/*" multiple hidden aria-label={r.addImages} onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      <div ref={root} className="ms-refs-inner">
        <div className="ms-refs-head" data-enter>
          <div className="ms-refs-title">
            <h1>{r.title}</h1>
            <span>{r.sub}</span>
          </div>
          {uploading > 0 ? <span className="ms-refs-uploading"><Spinner decorative size={12} />{r.uploading}</span> : null}
          <Button variant="ink" disabled={!canUpload} onClick={pick}><Icon name="upload" size={13} strokeWidth={1.7} />{r.addImages}</Button>
        </div>
        {listing.error ? <Alert>{r.listUnreadable({ detail: listing.error })}</Alert> : null}
        {refs.length > 0 ? (
          <Card className="ms-refs-brand" data-enter>
            <span className="ms-dot" aria-hidden="true" />
            <b>{r.feeding({ count: feeding })}</b>
            <span className="ms-lib-muted">· {r.feedingHint}</span>
            <Button size="sm" variant="ghost" loading={analyzing} disabled={feeding === 0 || analyzing} onClick={() => void analyze()}>{r.analyze}</Button>
          </Card>
        ) : null}
        {refs.length === 0 ? (
          <div className="ms-lib-empty">
            <Empty icon="image" title={r.emptyTitle} sub={r.emptyBody}
              action={<Button variant="ink" disabled={!canUpload} onClick={pick}><Icon name="upload" size={13} />{r.addImages}</Button>} />
          </div>
        ) : (
          <div className="ms-refs-board">
            {refs.map((x, i) => (
              <RefCard key={x.file} slug={slug} entry={x} on={on(x)} index={i} cascade={firstPaint.current} fresh={fresh.has(x.file)}
                onToggle={(v) => void toggle(x, v)} onNote={(note) => saveNote(x, note)} onRemove={(el) => void remove(x, el)} />
            ))}
          </div>
        )}
      </div>
      {drag ? <div className="ms-lib-dropzone" aria-hidden="true"><span>{r.dropOverlay}</span></div> : null}
    </div>
  );
}

interface RefCardProps {
  slug: string; entry: ReferenceEntry; on: boolean; index: number; cascade: boolean; fresh: boolean;
  onToggle(v: boolean): void; onNote(note: string): Promise<boolean>; onRemove(el: HTMLElement | null): void;
}

function RefCard({ slug, entry: x, on, index, cascade, fresh, onToggle, onNote, onRemove }: RefCardProps) {
  const t = useT();
  const r = t.web.library.references;
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  useLayoutEffect(() => {
    void enter(ref.current, fresh ? { y: 14, scale: 0.96 } : { y: 8, delay: cascade ? Math.min(index, 12) * 30 : 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const commit = async () => {
    if (draft === null) return;
    const next = draft.trim();
    if (next === x.note) { setDraft(null); return; }
    if (await onNote(next)) setDraft(null);
  };
  return (
    <div ref={ref} className={cx('ms-rcard', on && 'ms-on')}>
      <img src={api.projectFileUrl(slug, `references/${x.file}`)} alt={x.file} loading="lazy" />
      <div className="ms-rcard-body">
        {draft !== null ? (
          <Textarea autoFocus rows={3} value={draft} aria-label={r.noteFor({ name: x.file })} placeholder={r.notePlaceholder}
            onChange={(e) => setDraft(e.target.value)} onBlur={() => void commit()}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); } }} />
        ) : (
          <button type="button" className={cx('ms-rcard-note', !x.note && 'ms-empty-note')} aria-label={r.noteFor({ name: x.file })} onClick={() => setDraft(x.note)}>
            {x.note || r.notePlaceholder}
          </button>
        )}
        <div className="ms-rcard-foot">
          <span className="ms-rcard-file" title={x.file}>{x.file}</span>
          <span className="ms-rcard-switch">{r.brandAnalysis}<Toggle size="sm" on={on} onChange={onToggle} label={r.useForBrand({ name: x.file })} /></span>
        </div>
      </div>
      <Button size="sm" variant="ghost" icon className="ms-rcard-remove" aria-label={r.remove({ name: x.file })} onClick={() => onRemove(ref.current)}>
        <Icon name="trash" size={12} />
      </Button>
    </div>
  );
}

import type { Pin, QueuedRequest } from '@motion-studio/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useT } from '../i18n.tsx';
import { Button, Icon, Textarea, cx } from '../ui/index.ts';
import { liveErrorText, newClientId } from './liveErrors.ts';

/** How long "Run next" stays hidden after a turn ends, while the core decides whether to start the queue itself. */
export const SETTLE_MS = 1000;

export interface QueuedRequestsProps {
  slug: string;
  creative: string;
  /** `creative.json` `queued[]`, oldest first. */
  queued: QueuedRequest[];
  /** A turn is running or waiting for a slot: the queue starts by itself after it (when it saved a version). */
  working: boolean;
  /** After any change (the caller reloads the creative). */
  onChanged(): void;
}

/**
 * The requests waiting for after the current turn (Phase 13, spec §2), above the composer: edit, remove, reorder (drag, or
 * the move up/down buttons) and "Run next". The queue starts by itself only after a turn that saved a version; after a
 * failure, a stop or a restart nothing runs until the user presses "Run next".
 */
export function QueuedRequests({ slug, creative, queued, working, onChanged }: QueuedRequestsProps) {
  const t = useT();
  const u = t.web.liveUi;
  const heading = useId();
  // The order shown while a reorder is being saved (and until the creative is reloaded).
  const [local, setLocal] = useState<QueuedRequest[] | null>(null);
  useEffect(() => { setLocal(null); }, [queued]);
  useEffect(() => {
    if (!editing || queued.some((x) => x.clientId === editing)) return;
    const original = editingItem.current;
    const text = draft.trim();
    if (original && text && text !== original.text.trim()) setKept({ text, pins: original.pins as Pin[] });
    setEditing(null);
  }, [queued]); // eslint-disable-line react-hooks/exhaustive-deps -- only a change of the queue can overtake an edit
  const list = local ?? queued;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** The request being edited, as it was when the edit began. */
  const editingItem = useRef<QueuedRequest | null>(null);
  /**
   * Final wave P3: an edit the queue overtook (the request started, or was gone, before the edit was saved): never lost
   * silently, it stays here with the reason until the user queues it as a new request or discards it.
   */
  const [kept, setKept] = useState<{ text: string; pins: Pin[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const drag = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const edit = useRef<HTMLTextAreaElement>(null);
  const wasWorking = useRef(working);
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    const ended = wasWorking.current && !working;
    wasWorking.current = working;
    if (working) { setSettling(false); return; }
    if (!ended) return;
    setSettling(true);
    const id = setTimeout(() => setSettling(false), SETTLE_MS);
    return () => clearTimeout(id);
  }, [working]);
  useEffect(() => { setSettling(false); }, [queued]);
  useEffect(() => { if (editing) edit.current?.focus(); }, [editing]);

  // Right after a turn ends the core may start the queue by itself: "Run next" waits ~1 s (or the next queue change).
  if (queued.length === 0 && !local?.length && !kept) return null;

  const fail = (e: unknown) => { setLocal(null); setError(liveErrorText(e, t)); onChanged(); };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); onChanged(); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const moveTo = (from: number, to: number) => {
    if (busy || from === to || to < 0 || to >= list.length) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    setLocal(next);
    setSaid(u.moved({ n: from + 1, to: to + 1 }));
    void run(() => api.reorderQueue(slug, creative, next.map((x) => x.clientId))).catch(() => {});
  };
  const startEdit = (q: QueuedRequest) => { editingItem.current = q; setEditing(q.clientId); setDraft(q.text); setError(null); };
  const save = (q: QueuedRequest) => {
    const text = draft.trim();
    if (!text && q.pins.length === 0) return;
    setEditing(null);
    void run(async () => {
      try {
        await api.editQueued(slug, creative, q.clientId, { text, pins: q.pins as Pin[] });
      } catch (e) {
        // It started (or was removed) meanwhile: the edit is kept, with the reason, not dropped.
        if ((e as { code?: unknown } | null)?.code === 'not-queued' && text) { setKept({ text, pins: q.pins as Pin[] }); return; }
        throw e;
      }
    });
  };
  const queueKept = () => {
    if (!kept?.text.trim()) return;
    const body = { clientId: newClientId(), text: kept.text.trim(), pins: kept.pins, mode: 'queued' as const };
    void run(async () => { await api.postLiveMessage(slug, creative, body); setKept(null); });
  };

  const keptBlock = kept && (
    <div className="ms-queue-kept" role="group" aria-label={u.draftKeptLabel}>
      <p className="ms-queue-kept-why" role="status">{u.draftKept}</p>
      <Textarea rows={2} maxLength={4000} aria-label={u.draftField} value={kept.text} onChange={(e) => setKept({ ...kept, text: e.target.value })} />
      <div className="ms-queue-edit-actions">
        <Button size="sm" variant="ghost" onClick={() => setKept(null)}>{u.draftDiscard}</Button>
        <Button size="sm" variant="outline" disabled={busy || !kept.text.trim()} onClick={queueKept}>{u.draftQueue}</Button>
      </div>
    </div>
  );
  if (list.length === 0) {
    return (
      <section className="ms-queue" aria-label={u.draftKeptLabel}>
        {keptBlock}
        {error && <p role="alert" className="ms-composer-error">{error}</p>}
      </section>
    );
  }

  return (
    <section className="ms-queue" aria-labelledby={heading}>
      {keptBlock}
      <div className="ms-queue-head">
        <h3 id={heading} className="ms-queue-title">{u.queueTitle({ count: list.length })}</h3>
        {!working && !settling && (
          <>
            <span className="ms-queue-paused">{u.queuePaused}</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.runNext(slug, creative))}>
              <Icon name="play" size={12} />{u.runNext}
            </Button>
          </>
        )}
      </div>
      <ol className="ms-queue-list" aria-label={u.queueLabel}>
        {list.map((q, i) => {
          const n = i + 1;
          const isEditing = editing === q.clientId;
          return (
            <li key={q.clientId} className={cx('ms-queue-item', over === q.clientId && 'ms-over')} draggable={!isEditing} aria-label={u.item({ n })}
              onDragStart={(e) => { drag.current = q.clientId; if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', q.clientId); } catch { /* some engines refuse */ } } }}
              onDragOver={(e) => { if (drag.current && drag.current !== q.clientId) { e.preventDefault(); setOver(q.clientId); } }}
              onDragLeave={() => setOver((o) => (o === q.clientId ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                const from = list.findIndex((x) => x.clientId === drag.current);
                drag.current = null; setOver(null);
                if (from >= 0) moveTo(from, i);
              }}
              onDragEnd={() => { drag.current = null; setOver(null); }}>
              <span className="ms-queue-grip" aria-hidden="true" title={u.drag({ n })}><Icon name="menu" size={12} /></span>
              <div className="ms-queue-body">
                {isEditing ? (
                  <>
                    <Textarea ref={edit} rows={2} maxLength={4000} aria-label={u.editField} value={draft} onChange={(e) => setDraft(e.target.value)} />
                    <div className="ms-queue-edit-actions">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{u.cancelEdit}</Button>
                      <Button size="sm" variant="outline" disabled={!draft.trim() && q.pins.length === 0} onClick={() => save(q)}>{u.save}</Button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="ms-queue-text" data-text="">{q.text}</span>
                    <span className="ms-queue-meta">
                      <span className="ms-pill ms-neutral">{u.state.queued}</span>
                      {q.pins.length > 0 && <span className="ms-chip"><Icon name="comment" size={11} />{u.pins({ count: q.pins.length })}</span>}
                    </span>
                  </>
                )}
              </div>
              {!isEditing && (
                <div className="ms-queue-actions">
                  <Button size="sm" variant="ghost" icon aria-label={u.moveUp({ n })} disabled={busy || i === 0} onClick={() => moveTo(i, i - 1)}><Icon name="chevron" size={12} className="ms-queue-up" /></Button>
                  <Button size="sm" variant="ghost" icon aria-label={u.moveDown({ n })} disabled={busy || i === list.length - 1} onClick={() => moveTo(i, i + 1)}><Icon name="chevron" size={12} /></Button>
                  <Button size="sm" variant="ghost" icon aria-label={u.edit({ n })} disabled={busy} onClick={() => startEdit(q)}><Icon name="edit" size={12} /></Button>
                  <Button size="sm" variant="ghost" icon aria-label={u.remove({ n })} disabled={busy} onClick={() => void run(() => api.removeQueued(slug, creative, q.clientId))}><Icon name="trash" size={12} /></Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <span role="status" className="ms-queue-said">{said}</span>
      {error && <p role="alert" className="ms-composer-error">{error}</p>}
    </section>
  );
}

import type { AgentEvent, BriefContext, BriefField, BriefForm, BriefFormSave, BriefFormSaved, BriefMessageInput, BriefSendResult, BriefSessionView, ConversationEntry, JobSummary } from '@motion-studio/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api.ts';
import { message as errText } from '../../errors.ts';
import type { EventsState } from '../../eventsReducer.ts';

/** How long the form waits after the last change before it is saved (decision 1422: saved, debounced, when it changes). */
export const BRIEF_SAVE_MS = 400;

/** What the fills behind a refetch wrote (all of them since the last one shown); `seq` grows with every fill. */
export interface BriefFill { seq: number; written: BriefField[]; reclaimed: BriefField[] }

/** A refusal that says the session is not this form's any more (decision 1423): gone, or half moved into a creative. */
export interface BriefConflict { code: 'brief-session-gone' | 'brief-session-handed-off'; message: string; sessionId: string | null }

export interface BriefSession {
  /** The open session (null: none yet; it is created by the first message). */
  session: BriefSessionView | null;
  entries: ConversationEntry[];
  /** The session's latest brief job (running or finished), with its live events. */
  job: JobSummary | undefined;
  live: AgentEvent[];
  /**
   * `unreadable`: the session's files cannot be a session (422): only "Inizia da capo" (discard) helps. `failed`: the first
   * read failed (a real I/O error): nothing is known about the session until `refresh` reads it.
   */
  status: 'loading' | 'ready' | 'unreadable' | 'failed';
  /** The last failure of a load or a call, translated by the core. */
  error: string | null;
  /** A refusal of the session's moves (gone, handed off): said with what can be done. */
  conflict: BriefConflict | null;
  /** The fills behind the latest refetch: set together with `session`, so the form applies both at once. */
  lastFill: BriefFill | null;
  /** The open session, created with the form as the user has it when there is none. */
  ensure(init: { form: BriefForm; userEdited: BriefField[] }): Promise<BriefSessionView>;
  send(m: BriefMessageInput, id?: string): Promise<BriefSendResult>;
  /**
   * Saves the form BRIEF_SAVE_MS after the last call, one save at a time; `body` is read when the save goes out (the latest
   * form, on the latest revision the form adopted). `settle` says whether that save was taken. Nothing without a session. An
   * answer older than the view held is dropped and, once `settle` ran, that view is offered again (a new `session` object).
   */
  saveForm(body: () => BriefFormSave, settle?: (ok: boolean) => void): void;
  /** A save now, after any save in flight (its answer adopted like the others); null without a session or on a failure. */
  saveNow(body: () => BriefFormSave): Promise<BriefFormSaved | null>;
  /** Sends the pending debounced save at once (leaving the page). */
  flushSave(): void;
  setContext(c: BriefContext): Promise<void>;
  removeQueued(clientId: string): Promise<void>;
  /** Ends the session (Inizia da capo); also removes an unreadable one, or one half moved into a creative. */
  discard(): Promise<void>;
  refresh(): Promise<void>;
  /**
   * Reads a failure of a call made for the session elsewhere (Genera, Salva bozza): gone or handed off becomes `conflict` and
   * the session is read again; unreadable becomes the `unreadable` status. True when it was one of those.
   */
  report(e: unknown): boolean;
}

const ACTIVE = new Set<JobSummary['state']>(['queued', 'running']);
const NO_EVENTS: AgentEvent[] = [];
const union = (a: readonly BriefField[], b: readonly BriefField[]) => [...new Set([...a, ...b])];
const joinFills = (a: BriefFill | null, b: BriefFill | null): BriefFill | null =>
  (!a ? b : !b ? a : { seq: Math.max(a.seq, b.seq), written: union(a.written, b.written), reclaimed: union(a.reclaimed, b.reclaimed) });

type State = { session: BriefSessionView | null; entries: ConversationEntry[]; status: BriefSession['status']; lastFill: BriefFill | null };

/** Whether `view` is older than the one held (same session, lower revision): such an answer is dropped. */
const stale = (held: BriefSessionView | null, view: { revision: number }, id: string) => held !== null && held.id === id && view.revision < held.revision;

/**
 * Decisions 1421–1422: the project's brief session as the New creative page follows it: the view and its chat, refetched on
 * every `brief-session` message of the project, when its job changes state and after a reconnection; the calls of the session;
 * the debounced form save. An answer older than the view held (a lower revision of the same session) is ignored. The revision is
 * never adopted here on its own: the page adopts it with the form of the view it applies.
 */
/** `onFormatUnavailable` (report 59): a save refused a format no longer offered: the page reloads its catalog to drop it. */
export function useBriefSession(slug: string, live: EventsState | undefined, opts: { onFormatUnavailable?(): void } = {}): BriefSession {
  const onUnavailable = useRef(opts.onFormatUnavailable);
  onUnavailable.current = opts.onFormatUnavailable;
  const [state, setStateRaw] = useState<State>({ session: null, entries: [], status: 'loading', lastFill: null });
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<BriefConflict | null>(null);
  const sessionRef = useRef<BriefSessionView | null>(null);
  /** Every state change goes through here, so the session the calls use is always the one held. */
  const setState = useCallback((fn: (s: State) => State) => {
    setStateRaw((s) => { const next = fn(s); sessionRef.current = next.session; return next; });
  }, []);
  // Jobs this page started (a send answered `started`): theirs until the session's view names them.
  const started = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const loadRef = useRef<(fill: BriefFill | null) => Promise<void>>(async () => {});

  const report = useCallback((e: unknown): boolean => {
    if (!(e instanceof ApiError)) return false;
    if (e.code === 'format-unavailable' && onUnavailable.current) { onUnavailable.current(); return true; }
    if (e.code === 'brief-session-unreadable') {
      setState(() => ({ session: null, entries: [], status: 'unreadable', lastFill: null }));
      return true;
    }
    if (e.code === 'brief-session-gone' || e.code === 'brief-session-handed-off') {
      setConflict({ code: e.code, message: e.message, sessionId: sessionRef.current?.id ?? null });
      // Gone: once the session is read again there is nothing left to offer (the caller says what happened where it acts).
      const gone = e.code === 'brief-session-gone';
      void loadRef.current(null).then(() => { if (gone && alive.current) setConflict((c) => (c?.code === 'brief-session-gone' ? null : c)); });
      return true;
    }
    return false;
  }, [setState]);
  const fail = useCallback((e: unknown) => { if (alive.current && !report(e)) setError(errText(e)); }, [report]);

  // One load at a time; a load asked meanwhile runs once after it, with every fill asked meanwhile (none is lost).
  const loading = useRef<Promise<void> | null>(null);
  const again = useRef<{ fill: BriefFill | null } | null>(null);
  const load = useCallback(async (fill: BriefFill | null): Promise<void> => {
    if (loading.current) {
      again.current = { fill: joinFills(again.current?.fill ?? null, fill) };
      return loading.current;
    }
    const run = (async () => {
      try {
        const view = await api.getBriefSession(slug);
        const entries = view ? await api.getBriefConversation(slug, view.id) : [];
        if (!alive.current) return;
        setState((s) => {
          if (view && stale(s.session, view, view.id)) {
            // A newer view is held (a save answered meanwhile): keep it, but give the fills to the form again with it.
            return fill && s.session ? { ...s, session: { ...s.session }, lastFill: joinFills(s.lastFill, fill) } : s;
          }
          return { session: view, entries, status: 'ready', lastFill: fill ? joinFills(s.lastFill, fill) : s.lastFill };
        });
        setError(null);
      } catch (e) {
        if (!alive.current) return;
        if (e instanceof ApiError && e.code === 'brief-session-unreadable') setState(() => ({ session: null, entries: [], status: 'unreadable', lastFill: null }));
        else { setState((s) => ({ ...s, status: s.status === 'loading' || s.status === 'failed' ? 'failed' : s.status })); setError(errText(e)); }
      }
    })();
    loading.current = run;
    await run;
    loading.current = null;
    if (again.current) {
      const next = again.current.fill;
      again.current = null;
      await load(next);
    }
  }, [slug, setState]);
  loadRef.current = load;

  useEffect(() => { void load(null); }, [load]);

  // Every fill of this session since the last one taken, joined (two fills between renders, or during a load, are both kept).
  const tick = live?.briefTicks?.[slug] ?? 0;
  const lastTick = useRef(tick);
  const takenSeq = useRef(Math.max(0, ...(live?.briefFills?.[slug] ?? []).map((f) => f.seq)));
  useEffect(() => {
    if (tick === lastTick.current) return;
    lastTick.current = tick;
    const id = sessionRef.current?.id;
    const fresh = (live?.briefFills?.[slug] ?? []).filter((f) => f.seq > takenSeq.current);
    takenSeq.current = Math.max(takenSeq.current, ...fresh.map((f) => f.seq));
    const fill = fresh.filter((f) => !id || f.sessionId === id)
      .reduce<BriefFill | null>((acc, f) => joinFills(acc, { seq: f.seq, written: f.written, reclaimed: f.reclaimed }), null);
    void load(fill);
  }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps -- a tick (each brief-session message) is the trigger

  // A reconnection (a new snapshot) may have missed brief-session messages: the session is read again.
  const snapshots = live?.snapshots ?? 0;
  const lastSnapshots = useRef(snapshots);
  useEffect(() => {
    if (snapshots === lastSnapshots.current) return;
    lastSnapshots.current = snapshots;
    void load(null);
  }, [snapshots, load]);

  // The latest brief job of this project that belongs to the session (its own job, one of its turns, or one this page started).
  const job = useMemo(() => {
    const s = state.session;
    const turns = new Set(state.entries.flatMap((e) => (e.type === 'agent' ? [e.jobId] : e.type === 'user' && e.jobId ? [e.jobId] : [])));
    return Object.values(live?.jobs ?? {})
      .filter((j) => j.kind === 'brief' && j.key.startsWith('brief:') && j.key.endsWith(`:${slug}`))
      .filter((j) => j.id === s?.jobId || turns.has(j.id) || started.current.has(j.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1);
  }, [live?.jobs, state.session, state.entries, slug]);
  // The job's state changes (a turn starts or ends): the view says the job and the queue, the chat the turn's entries.
  const jobState = job ? `${job.id}:${job.state}` : '';
  const lastJobState = useRef(jobState);
  useEffect(() => {
    if (jobState === lastJobState.current) return;
    const ended = lastJobState.current !== '' && job && !ACTIVE.has(job.state);
    lastJobState.current = jobState;
    if (ended || (job && ACTIVE.has(job.state) && state.session?.jobId !== job.id)) void load(null);
  }, [jobState]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A view answered by a call (start, context, queue): taken unless it is older than the one held. */
  const adopt = useCallback((view: BriefSessionView) => {
    if (alive.current) setState((st) => (stale(st.session, view, view.id) ? st : { ...st, session: view, status: 'ready' }));
  }, [setState]);

  const ensure = useCallback(async (init: { form: BriefForm; userEdited: BriefField[] }) => {
    if (sessionRef.current) return sessionRef.current;
    try {
      const view = await api.startBriefSession(slug, init);
      sessionRef.current = view;
      adopt(view);
      setConflict(null);
      return view;
    } catch (e) { fail(e); throw e; }
  }, [slug, adopt, fail]);

  const send = useCallback(async (m: BriefMessageInput, id?: string) => {
    const sid = id ?? sessionRef.current?.id;
    if (!sid) throw new Error('no brief session');
    try {
      const r = await api.sendBriefMessage(slug, sid, m);
      if (r.outcome === 'started') started.current.add(r.job.id);
      setConflict(null);
      void load(null);
      return r;
    } catch (e) { if (alive.current) report(e); throw e; }
  }, [slug, load, report]);

  // The saves: one at a time, in order. The debounced one reads its body when it goes out.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const doSave = useCallback(async (getBody: () => BriefFormSave): Promise<BriefFormSaved | null> => {
    const s = sessionRef.current;
    if (!s) return null;
    try {
      const saved = await api.saveBriefForm(slug, s.id, getBody());
      if (alive.current) {
        setState((st) => (st.session && st.session.id === s.id && !stale(st.session, saved, s.id)
          ? { ...st, session: { ...st.session, form: saved.form, userEdited: saved.userEdited, agentFields: saved.agentFields, revision: saved.revision } }
          : st));
        setError(null);
      }
      return saved;
    } catch (e) {
      fail(e);
      return null;
    }
  }, [slug, setState, fail]);
  const enqueue = useCallback((getBody: () => BriefFormSave) => {
    const next = chain.current.then(() => doSave(getBody));
    chain.current = next.catch(() => {});
    return next;
  }, [doSave]);

  const pending = useRef<{ body: () => BriefFormSave; settle?: (ok: boolean) => void } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSave = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    const sid = sessionRef.current?.id;
    void enqueue(p.body).then((r) => {
      p.settle?.(r !== null);
      // An answer older than the view held was dropped, and that view was merged while this save was out (its fields kept the
      // user's text): once the save is settled, the view is offered again, so a rewrite it holds is not lost.
      if (r && sid && alive.current) setState((st) => (st.session && stale(st.session, r, sid) ? { ...st, session: { ...st.session } } : st));
    });
  }, [enqueue, setState]);
  const saveForm = useCallback((body: () => BriefFormSave, settle?: (ok: boolean) => void) => {
    pending.current = { body, ...(settle ? { settle } : {}) };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flushSave, BRIEF_SAVE_MS);
  }, [flushSave]);
  const saveNow = useCallback((body: () => BriefFormSave) => enqueue(body), [enqueue]);
  // Leaving the page: an edit waiting for its save is sent, not lost.
  const flushRef = useRef(flushSave);
  flushRef.current = flushSave;
  useEffect(() => () => { flushRef.current(); }, []);

  const setContext = useCallback(async (c: BriefContext) => {
    const s = sessionRef.current;
    if (!s) return;
    try { adopt(await api.setBriefContext(slug, s.id, c)); } catch (e) { fail(e); throw e; }
  }, [slug, adopt, fail]);
  const removeQueued = useCallback(async (clientId: string) => {
    const s = sessionRef.current;
    if (!s) return;
    try { adopt(await api.removeBriefQueued(slug, s.id, clientId)); } catch (e) { fail(e); throw e; }
  }, [slug, adopt, fail]);
  const discard = useCallback(async () => {
    const s = sessionRef.current;
    // Any id removes a session that cannot be read (contract): there is no id to give.
    await api.discardBriefSession(slug, s?.id ?? conflict?.sessionId ?? 'unreadable');
    pending.current = null;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    started.current.clear();
    setConflict(null);
    if (alive.current) setState(() => ({ session: null, entries: [], status: 'ready', lastFill: null }));
  }, [slug, conflict, setState]);
  const refresh = useCallback(() => load(null), [load]);

  return {
    session: state.session, entries: state.entries, job, live: (job && live?.events[job.id]) || NO_EVENTS, status: state.status, error, conflict, lastFill: state.lastFill,
    ensure, send, saveForm, saveNow, flushSave, setContext, removeQueued, discard, refresh, report,
  };
}

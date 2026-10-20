import type { AgentEvent, BriefContext, BriefField, BriefForm, BriefFormSave, BriefMessageInput, BriefSendResult, BriefSessionView, ConversationEntry, JobSummary } from '@motion-studio/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api.ts';
import { message as errText } from '../../errors.ts';
import type { EventsState } from '../../eventsReducer.ts';

/** How long the form waits after the last change before it is saved (decision 1422: saved, debounced, when it changes). */
export const BRIEF_SAVE_MS = 400;

/** What the fill that refetched the session wrote; `seq` grows with every fill (the form plays its marks once). */
export interface BriefFill { seq: number; written: BriefField[]; reclaimed: BriefField[] }

export interface BriefSession {
  /** The open session (null: none yet; it is created by the first message). */
  session: BriefSessionView | null;
  entries: ConversationEntry[];
  /** The session's latest brief job (running or finished), with its live events. */
  job: JobSummary | undefined;
  live: AgentEvent[];
  /** `unreadable`: the session's files cannot be a session (422): only "Inizia da capo" (discard) helps. */
  status: 'loading' | 'ready' | 'unreadable';
  /** The last failure of a load or a call, translated by the core. */
  error: string | null;
  /** The fill behind the latest refetch: set together with `session`, so the form applies both at once. */
  lastFill: BriefFill | null;
  /** The open session, created with the form as the user has it when there is none. */
  ensure(init: { form: BriefForm; userEdited: BriefField[] }): Promise<BriefSessionView>;
  send(m: BriefMessageInput, id?: string): Promise<BriefSendResult>;
  /**
   * Saves the form BRIEF_SAVE_MS after the last call, one save at a time; `body` is read when the save goes out (the latest
   * form, on the latest revision the form adopted). Nothing without a session.
   */
  saveForm(body: () => BriefFormSave): void;
  setContext(c: BriefContext): Promise<void>;
  removeQueued(clientId: string): Promise<void>;
  /** Ends the session (Inizia da capo); also removes an unreadable one. */
  discard(): Promise<void>;
  refresh(): Promise<void>;
}

const ACTIVE = new Set<JobSummary['state']>(['queued', 'running']);
const NO_EVENTS: AgentEvent[] = [];

/**
 * Decisions 1421–1422: the project's brief session as the New creative page follows it: the view and its chat, refetched on
 * every `brief-session` message of the project and when its job changes state; the calls of the session; the debounced form
 * save. The revision is never adopted here on its own: the page adopts it with the form of the view it applies.
 */
export function useBriefSession(slug: string, live: EventsState | undefined): BriefSession {
  const [state, setState] = useState<{ session: BriefSessionView | null; entries: ConversationEntry[]; status: BriefSession['status']; lastFill: BriefFill | null }>(
    { session: null, entries: [], status: 'loading', lastFill: null });
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<BriefSessionView | null>(null);
  sessionRef.current = state.session;
  // Jobs this page started (a send answered `started`): theirs until the session's view names them.
  const started = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // One load at a time; a load asked meanwhile runs once after it (a burst of fills is one refetch, then the latest).
  const loading = useRef<Promise<void> | null>(null);
  const again = useRef<BriefFill | null | undefined>(undefined);
  const load = useCallback(async (fill: BriefFill | null): Promise<void> => {
    if (loading.current) {
      again.current = fill ?? again.current ?? null;
      return loading.current;
    }
    const run = (async () => {
      try {
        const view = await api.getBriefSession(slug);
        const entries = view ? await api.getBriefConversation(slug, view.id) : [];
        if (!alive.current) return;
        setState((s) => ({ session: view, entries, status: 'ready', lastFill: fill ?? s.lastFill }));
        setError(null);
      } catch (e) {
        if (!alive.current) return;
        if (e instanceof ApiError && e.code === 'brief-session-unreadable') setState({ session: null, entries: [], status: 'unreadable', lastFill: null });
        else { setState((s) => ({ ...s, status: s.status === 'loading' ? 'ready' : s.status })); setError(errText(e)); }
      }
    })();
    loading.current = run;
    await run;
    loading.current = null;
    if (again.current !== undefined) {
      const next = again.current;
      again.current = undefined;
      await load(next);
    }
  }, [slug]);

  useEffect(() => { void load(null); }, [load]);

  const tick = live?.briefTicks?.[slug] ?? 0;
  const fill = live?.briefFills?.[slug];
  const fillSeq = fill?.seq ?? 0;
  const lastTick = useRef(tick);
  useEffect(() => {
    if (tick === lastTick.current) return;
    lastTick.current = tick;
    void load(fill && fill.seq !== state.lastFill?.seq ? { seq: fill.seq, written: fill.written, reclaimed: fill.reclaimed } : null);
  }, [tick, fillSeq]); // eslint-disable-line react-hooks/exhaustive-deps -- a tick (each brief-session message) is the trigger

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

  const ensure = useCallback(async (init: { form: BriefForm; userEdited: BriefField[] }) => {
    if (sessionRef.current) return sessionRef.current;
    const view = await api.startBriefSession(slug, init);
    sessionRef.current = view;
    if (alive.current) setState((s) => ({ ...s, session: view, status: 'ready' }));
    return view;
  }, [slug]);

  const send = useCallback(async (m: BriefMessageInput, id?: string) => {
    const sid = id ?? sessionRef.current?.id;
    if (!sid) throw new Error('no brief session');
    const r = await api.sendBriefMessage(slug, sid, m);
    if (r.outcome === 'started') started.current.add(r.job.id);
    void load(null);
    return r;
  }, [slug, load]);

  // The debounced save: the latest body getter waits BRIEF_SAVE_MS; a save in flight delays the next until it answers.
  const pending = useRef<(() => BriefFormSave) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const flush = useCallback(async () => {
    timer.current = null;
    if (saving.current) return;
    const getBody = pending.current;
    const s = sessionRef.current;
    pending.current = null;
    if (!getBody || !s) return;
    saving.current = true;
    try {
      const saved = await api.saveBriefForm(slug, s.id, getBody());
      if (alive.current) {
        setState((st) => (st.session && st.session.id === s.id
          ? { ...st, session: { ...st.session, form: saved.form, userEdited: saved.userEdited, agentFields: saved.agentFields, revision: saved.revision } }
          : st));
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(errText(e));
    } finally {
      saving.current = false;
      if (pending.current && !timer.current) timer.current = setTimeout(() => void flush(), 0);
    }
  }, [slug]);
  const saveForm = useCallback((body: () => BriefFormSave) => {
    pending.current = body;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), BRIEF_SAVE_MS);
  }, [flush]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const setContext = useCallback(async (c: BriefContext) => {
    const s = sessionRef.current;
    if (!s) return;
    const view = await api.setBriefContext(slug, s.id, c);
    if (alive.current) setState((st) => ({ ...st, session: view }));
  }, [slug]);
  const removeQueued = useCallback(async (clientId: string) => {
    const s = sessionRef.current;
    if (!s) return;
    const view = await api.removeBriefQueued(slug, s.id, clientId);
    if (alive.current) setState((st) => ({ ...st, session: view }));
  }, [slug]);
  const discard = useCallback(async () => {
    const s = sessionRef.current;
    // Any id removes a session that cannot be read (contract): there is no id to give.
    await api.discardBriefSession(slug, s?.id ?? 'unreadable');
    pending.current = null;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    sessionRef.current = null;
    started.current.clear();
    if (alive.current) setState({ session: null, entries: [], status: 'ready', lastFill: null });
  }, [slug]);
  const refresh = useCallback(() => load(null), [load]);

  return {
    session: state.session, entries: state.entries, job, live: (job && live?.events[job.id]) || NO_EVENTS, status: state.status, error, lastFill: state.lastFill,
    ensure, send, saveForm, setContext, removeQueued, discard, refresh,
  };
}

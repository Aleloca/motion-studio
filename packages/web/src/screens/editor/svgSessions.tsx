// The SVG content of the editor's svg clips, shared by the layers tree and the inspector (user test item 12: an svg layer's
// elements are children of the layer in the Layers panel; the inspector shows the layer, or one element of it). One session
// per svg clip that is selected or open in the tree runs here, above both panels, so an edit made in either goes through the
// same staging (SVG inner editor, Task 3):
// - The clip's text comes from the core, which answers only text its SVG check accepts (a base file) or that it staged itself
//   (an edit), and is parsed into an XML document that never enters the page; it is read once per file and kept in the draft.
// - Every change is made on a copy of the latest text and, 300 ms after the last one, staged through the core (`stageSvg`):
//   on success the clip's `src` moves to the staged file and an `svgContent` op feeds the summary, both as one undo step; a
//   refusal is kept for the panels to show and the `src` stays. The texts the core checked are kept in the draft by path, so
//   an undo finds the earlier text again.
// - A session that ends (the clip deselected and closed in the tree) stages what is pending at once.
import {
  editProblemText, listColors, listElements, listTexts, parseSvg, serializeSvg,
  type Clip, type SvgDoc, type SvgElement, type SvgText,
} from '@motion-studio/shared';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api } from '../../api.ts';
import { message } from '../../errors.ts';
import { useLocale } from '../../i18n.tsx';
import { peekDraft } from './draftStore.ts';
import { useEditor } from './editorContext.ts';
import { findClip } from './Stage.tsx';

/** A burst of changes (several swatches clicked) is staged once, this long after the last. */
export const SVG_STAGE_DELAY_MS = 300;

export type SvgEditKind = 'colors' | 'texts' | 'hidden';
type Counts = Record<SvgEditKind, number>;
/** Changes not staged yet: the text they made from the file `src`, how many of each kind, and the draft (`Draft.gen`) they belong to. */
type Working = { src: string; text: string; counts: Counts; gen: number };
export type SvgFailure = { text: string; reasons: string[] };
type SvgColor = ReturnType<typeof listColors>[number];

/** What the panels read of an svg clip's content. */
export interface SvgSession {
  clipId: string;
  /** `loading` until the text is known; `failed` when the core refused it or it does not parse (`failure` says why). */
  status: 'loading' | 'failed' | 'ready';
  failure: SvgFailure | null;
  doc: SvgDoc | null;
  colors: SvgColor[];
  texts: SvgText[];
  elements: SvgElement[];
  /** The last change the core refused, until the next change. */
  editFailure: SvgFailure | null;
  /** Locked clip, or nothing may be written from this editor. */
  disabled: boolean;
  /** One change, applied to a copy of the latest text and staged after the delay. */
  edit(kind: SvgEditKind, change: (doc: SvgDoc) => void): void;
}

const ZERO: Counts = { colors: 0, texts: 0, hidden: 0 };
export const failureOf = (err: unknown): SvgFailure => {
  const problems = (err as { problems?: unknown }).problems;
  return { text: message(err), reasons: Array.isArray(problems) ? problems.filter((x): x is string => typeof x === 'string') : [] };
};
const less = (a: Counts, b: Counts): Counts => ({ colors: Math.max(0, a.colors - b.colors), texts: Math.max(0, a.texts - b.texts), hidden: Math.max(0, a.hidden - b.hidden) });

/** The sessions by clip id, read with `useSyncExternalStore`. */
class SessionStore {
  private map = new Map<string, SvgSession>();
  private listeners = new Set<() => void>();
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  get = (id: string): SvgSession | undefined => this.map.get(id);
  set(id: string, s: SvgSession | undefined): void {
    if (this.map.get(id) === s) return;
    if (s) this.map.set(id, s); else this.map.delete(id);
    for (const l of this.listeners) l();
  }
}

interface SessionsValue {
  store: SessionStore;
  /** The svg layers open in the layers tree. */
  expanded: ReadonlySet<string>;
  setExpanded(clipId: string, open: boolean): void;
}
const SessionsContext = createContext<SessionsValue | null>(null);

const svgClipIds = (tracks: Array<{ clips: Clip[] }>): string[] => tracks.flatMap((t) => t.clips).filter((c) => c.type === 'svg').map((c) => c.id);

/** Runs the sessions of the svg clips that are selected or open in the tree, for the panels inside it. */
export function SvgSessions({ children }: { children: ReactNode }) {
  const { draft, selection, svgElement } = useEditor();
  const [store] = useState(() => new SessionStore());
  const [expanded, setExpandedState] = useState<ReadonlySet<string>>(() => new Set());
  const setExpanded = useCallback((clipId: string, open: boolean) => setExpandedState((s) => {
    if (s.has(clipId) === open) return s;
    const next = new Set(s);
    if (open) next.add(clipId); else next.delete(clipId);
    return next;
  }), []);
  // An element picked (on the stage, or in the inspector of a video) shows in the tree: its layer opens.
  useEffect(() => { if (selection !== null && svgElement !== null) setExpanded(selection, true); }, [selection, svgElement, setExpanded]);
  const ids = svgClipIds(draft.composition.tracks);
  const wanted = ids.filter((id) => id === selection || expanded.has(id));
  const value = useMemo(() => ({ store, expanded, setExpanded }), [store, expanded, setExpanded]);
  return (
    <SessionsContext.Provider value={value}>
      {wanted.map((id) => <SessionRunner key={id} clipId={id} store={store} />)}
      {children}
    </SessionsContext.Provider>
  );
}

/** The session of an svg clip, or null while none runs for it (or outside `SvgSessions`). */
export function useSvgSession(clipId: string | null): SvgSession | null {
  const ctx = useContext(SessionsContext);
  const subscribe = ctx ? ctx.store.subscribe : NO_SUBSCRIBE;
  const get = () => (ctx && clipId !== null ? ctx.store.get(clipId) ?? null : null);
  return useSyncExternalStore(subscribe, get, get);
}
const NO_SUBSCRIBE = () => () => {};

/** The layers tree's open svg layers. */
export function useSvgTree(): { expanded: ReadonlySet<string>; setExpanded(clipId: string, open: boolean): void } {
  const ctx = useContext(SessionsContext);
  return ctx ?? NO_TREE;
}
const NO_TREE = { expanded: new Set<string>() as ReadonlySet<string>, setExpanded: () => {} };

function SessionRunner({ clipId, store }: { clipId: string; store: SessionStore }) {
  const { draft } = useEditor();
  const found = findClip(draft.composition.tracks, clipId);
  if (!found || found.clip.type !== 'svg') return null;
  return <Session clip={found.clip} locked={found.locked} store={store} />;
}

function Session({ clip, locked, store }: { clip: Extract<Clip, { type: 'svg' }>; locked: boolean; store: SessionStore }) {
  const locale = useLocale();
  const { slug, creative, draft, actions, token, stageSvg, readOnly } = useEditor();
  const known = draft.svgTexts.get(clip.src);
  const disabled = locked || readOnly !== null;

  // The clip's text: read once per file (the core checks it), then kept in the draft.
  const [readFailure, setReadFailure] = useState<{ src: string; failure: SvgFailure } | null>(null);
  const failedHere = readFailure?.src === clip.src ? readFailure.failure : null;
  useEffect(() => {
    if (known !== undefined || !token || failedHere) return;
    let alive = true;
    const src = clip.src;
    api.getEditorSvg(slug, creative, token, src).then(
      (r) => { if (alive) actions.svgText(src, r.content); },
      (err: unknown) => { if (alive) setReadFailure({ src, failure: failureOf(err) }); },
    );
    return () => { alive = false; };
  }, [known, token, clip.src, slug, creative, actions, failedHere]);

  // Changes not staged yet, and the staging (one at a time: a burst during one is staged when it is done). While there are
  // any, the draft says so (`svgPending`): Save waits and leaving asks.
  const [working, setWorkingState] = useState<Working | null>(null);
  const workingRef = useRef<Working | null>(null);
  const [editFailure, setEditFailure] = useState<SvgFailure | null>(null);
  const timer = useRef(0);
  const busy = useRef(false);
  const again = useRef(false);
  const latest = useRef({ clipId: clip.id, src: clip.src, known, stageSvg, actions, locale, key: draft.key, gen: draft.gen });
  latest.current = { clipId: clip.id, src: clip.src, known, stageSvg, actions, locale, key: draft.key, gen: draft.gen };
  /** Whether `gen` is still the draft open under this key (a save or a discard opens another one). */
  const sameDraft = (gen: number) => peekDraft(latest.current.key)?.gen === gen;
  const syncPending = (gen: number) => {
    if (sameDraft(gen)) latest.current.actions.svgPending(latest.current.clipId, workingRef.current !== null || busy.current);
  };
  const setWorking = (w: Working | null) => {
    const gen = workingRef.current?.gen ?? w?.gen ?? latest.current.gen;
    workingRef.current = w;
    setWorkingState(w);
    syncPending(w?.gen ?? gen);
  };

  const flush = async (): Promise<void> => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    const w = workingRef.current;
    if (!w) return;
    if (busy.current) { again.current = true; return; }
    busy.current = true;
    const L = latest.current;
    try {
      const staged = await L.stageSvg({ kind: 'svgEdit', clipId: L.clipId, baseSrc: w.src, content: w.text });
      // A draft saved, discarded or reopened meanwhile is not this one: the answer is dropped, nothing of it touched.
      if (!sameDraft(w.gen)) { busy.current = false; workingRef.current = null; again.current = false; return; }
      L.actions.svgText(staged.path, w.text);
      const now = workingRef.current;
      // An undo (or a replaced file) moved the clip off the file the change started from: the result is dropped.
      const clipNow = peekDraft(L.key)!.composition.tracks.flatMap((tr) => tr.clips).find((k) => k.id === L.clipId);
      if (!clipNow || !('src' in clipNow) || clipNow.src !== w.src) {
        busy.current = false;
        setWorking(null);
        return;
      }
      const r = L.actions.applyAll([{ kind: 'clipMedia', clipId: L.clipId, src: staged.path }, { kind: 'svgContent', clipId: L.clipId, ...w.counts }]);
      if (!r.ok) setEditFailure({ text: editProblemText(r.problem, L.locale), reasons: [] });
      busy.current = false;
      // Changes made while this one was on its way go on from the staged file.
      if (now === w || !r.ok || !now) setWorking(null);
      else setWorking({ ...now, src: staged.path, counts: less(now.counts, w.counts) });
    } catch (err) {
      busy.current = false;
      if (!sameDraft(w.gen)) { workingRef.current = null; again.current = false; return; }
      setEditFailure(failureOf(err));
      // Changes made after the refused one stay (they start from the same file) and are staged next.
      const now = workingRef.current;
      if (now && now !== w) { setWorking(now); again.current = true; } else setWorking(null);
    }
    if (again.current) { again.current = false; await flush(); }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  // The session ends (the clip is no longer selected nor open in the tree): what is pending is staged at once.
  useEffect(() => () => { if (timer.current) void flushRef.current(); }, []);
  // An undo or a replaced file moved the clip off the file the pending changes started from: they are dropped.
  useEffect(() => {
    const w = workingRef.current;
    if (w && w.src !== clip.src && !busy.current) { window.clearTimeout(timer.current); timer.current = 0; setWorking(null); }
  }, [clip.src]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (kind: SvgEditKind, change: (doc: SvgDoc) => void) => {
    if (disabled) return;
    const w = workingRef.current;
    const from = w ? w.text : latest.current.known;
    if (from === undefined) return;
    const parsed = parseSvg(from);
    if (!parsed.ok) return;
    try { change(parsed.doc); } catch { return; }
    const text = serializeSvg(parsed.doc);
    if (text === from) return;
    const counts = { ...(w?.counts ?? ZERO) };
    counts[kind] += 1;
    setWorking({ src: w?.src ?? clip.src, text, counts, gen: w?.gen ?? draft.gen });
    setEditFailure(null);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flushRef.current(); }, SVG_STAGE_DELAY_MS);
  };
  const editRef = useRef(edit);
  editRef.current = edit;
  const stableEdit = useCallback((kind: SvgEditKind, change: (doc: SvgDoc) => void) => editRef.current(kind, change), []);

  const shown = working && working.src === clip.src ? working.text : known;
  const parsed = useMemo(() => (shown !== undefined ? parseSvg(shown) : null), [shown]);
  const doc = parsed?.ok ? parsed.doc : null;
  const parseFailure = parsed && !parsed.ok ? parsed.reason : null;
  const session = useMemo<SvgSession>(() => ({
    clipId: clip.id,
    status: failedHere || parseFailure ? 'failed' : doc ? 'ready' : 'loading',
    failure: failedHere ?? (parseFailure ? { text: parseFailure, reasons: [] } : null),
    doc,
    colors: doc ? listColors(doc) : [],
    texts: doc ? listTexts(doc) : [],
    elements: doc ? listElements(doc) : [],
    editFailure,
    disabled,
    edit: stableEdit,
  }), [clip.id, failedHere, parseFailure, doc, editFailure, disabled, stableEdit]);
  useLayoutEffect(() => { store.set(clip.id, session); }, [store, clip.id, session]);
  useLayoutEffect(() => () => { store.set(clip.id, undefined); }, [store, clip.id]);
  return null;
}

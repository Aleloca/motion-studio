// Autosave of the subtitle editor (decisions 1654-1659): the cues go out SAVE_DEBOUNCE_MS after the last edit, over the hash
// of the set the editor holds. One save at a time. A 409 means the set changed elsewhere (a job, another window): it is
// reloaded, the user's unsaved changes are put back on it (`mergeAfterConflict`; anti-goal 1: nothing silently drops text the
// user corrected) and saved over the new hash. A waiting edit is sent when the screen goes away or the page closes.
import { relocateCues, type LocaleTag, type SubtitleCue } from '@motion-studio/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api.ts';
import { byStart, type EditorOp, type EditorState } from './subtitlesModel.ts';

export const SAVE_DEBOUNCE_MS = 800;
/** A body over this many bytes is sent without keepalive when the page closes (browsers refuse larger keepalive bodies). */
export const KEEPALIVE_MAX_BYTES = 60_000;

/**
 * `conflict`: the set changed elsewhere and was reloaded, the user's changes put back on it; it stays until the merge is saved
 * (then `saved`, with `notice`). `saving` also covers an edit waiting for its debounce, or one that cannot go out yet (no set
 * loaded).
 */
export type SubtitleSaveStatus = 'saved' | 'saving' | 'error' | 'conflict';

export interface SubtitleSave {
  status: SubtitleSaveStatus;
  /** The set was changed elsewhere and reloaded under the user's changes (the screen says so): true until the next edit. */
  notice: boolean;
  /**
   * True when `cues` are what the server has (the last loaded or saved), with no save, reload or debounce pending: a load
   * from a broadcast then replaces nothing of the user's (final review, M1).
   */
  isSaved(cues: readonly SubtitleCue[]): boolean;
  /**
   * "Tempi controllati" (final review, M3): once everything is saved, the set's timing is marked as checked on the latest
   * audio, over the hash the hook holds (the cues are not touched). Throws the server's error (409 when the set changed).
   */
  timingChecked(): Promise<void>;
  /**
   * Sends a waiting edit now (or retries a failed one) and waits for the saves in flight, a conflict's merged save included.
   * True when the server then has everything the editor shows (a download may go); false when a save failed or is still
   * owed.
   */
  flush(): Promise<boolean>;
}

/**
 * A cue as a string that does not depend on its keys' order (Task 23): the server answers its cues in the schema's order
 * (id, start, end, text, words, edited, source), the editor builds them in its own (a corrected translated line ends with
 * `edited`), and both must read as the same line.
 */
const cueKey = (c: SubtitleCue): string => JSON.stringify([
  c.id, c.start, c.end, c.text, c.edited ?? null, c.source?.text ?? null, c.words?.map((w) => [w.start, w.end, w.text]) ?? null,
]);
const textOf = (cues: readonly SubtitleCue[]): string => JSON.stringify(cues.map(cueKey));
const same = (a: SubtitleCue, b: SubtitleCue | undefined): boolean => b !== undefined && cueKey(a) === cueKey(b);

/**
 * After a 409 (final review, C1): the server's set `fresh` with the user's changes since `base` (what the server had when the
 * editor last loaded or saved) put back on it. The user's changes are the lines that differ from `base` (new ones, corrected
 * ones, moved ones, and one undone back to its first text) and the lines deleted here:
 * - a changed line replaces the server's line of the same id when that is still the saved one or a corrected one (the same
 *   line); a server line under the same id that is neither (a new transcription reusing the id) stays, and the user's takes
 *   a free id;
 * - a deleted line goes when the server still has it as it was saved;
 * - a server line the user never had (not as it is now) and not corrected goes when it overlaps a line of the user's, as the
 *   job's merge does; a corrected one (`edited`) never goes: overlaps stay visible, with their warning;
 * - `retimed` (the set's audio fingerprint is not the one loaded): the user's lines move with their words
 *   (`relocateCues`); otherwise their times are kept exactly.
 */
export function mergeAfterConflict(base: readonly SubtitleCue[], local: readonly SubtitleCue[], fresh: readonly SubtitleCue[], retimed: boolean): SubtitleCue[] {
  const saved = new Map(base.map((c) => [c.id, c]));
  const here = new Set(local.map((c) => c.id));
  let mine = local.filter((c) => !same(c, saved.get(c.id)));
  if (retimed && mine.length > 0) mine = relocateCues(mine, [...fresh]);
  const mineIds = new Set(mine.map((c) => c.id));
  const theirs: SubtitleCue[] = [];
  const clash = new Set<string>();
  for (const f of fresh) {
    const was = saved.get(f.id);
    const untouched = same(f, was);
    if (untouched && !here.has(f.id)) continue;
    if (mineIds.has(f.id)) {
      if (was && (untouched || f.edited)) continue;
      clash.add(f.id);
    }
    theirs.push(f);
  }
  const used = new Set([...theirs, ...mine].map((c) => c.id));
  let n = 0;
  const renamed = mine.map((c) => {
    if (!clash.has(c.id)) return c;
    do n++; while (used.has(`u${n}`));
    used.add(`u${n}`);
    return { ...c, id: `u${n}` };
  });
  const kept = theirs.filter((f) => f.edited || same(f, saved.get(f.id)) || !renamed.some((m) => f.start < m.end && f.end > m.start));
  return [...renamed, ...kept];
}

/**
 * Contract (decision 1657): the hook takes `o.hash` (and `o.fingerprint`, the set's audio fingerprint) only together with a
 * `load`, never alone. At mount, they go with the cues of `state` when it is not dirty; afterwards with each `load` the
 * screen dispatches (pass them in the same render as that load). A hash that changes without a load is ignored.
 * `o.dispatch` is the editor's: the hook dispatches its own `load` after a conflict. Mount one per set (key it by creative
 * and language). The screen dispatches its own `load` only when `isSaved` says the editor's cues are what the server has
 * (decision 1720): otherwise a screen load would drop unsaved edits, or win over the hook's merge.
 */
export function useSubtitleSave(
  slug: string, creative: string, lang: LocaleTag, state: EditorState,
  o: { hash: string | null; fingerprint?: string | null; dispatch: (op: EditorOp) => void },
): SubtitleSave {
  const [status, setStatus] = useState<SubtitleSaveStatus>('saved');
  const [notice, setNotice] = useState(false);
  /** Bumped when the last queued save or reload ends: the screen's `isSaved` may have turned true. */
  const [, setIdle] = useState(0);
  const target = useRef({ slug, creative, lang });
  target.current = { slug, creative, lang };
  const latest = useRef(state);
  latest.current = state;
  const dispatch = useRef(o.dispatch);
  dispatch.current = o.dispatch;
  const propHash = useRef(o.hash);
  propHash.current = o.hash;
  const propFingerprint = useRef(o.fingerprint ?? null);
  propFingerprint.current = o.fingerprint ?? null;
  /** The hash and cues the server has (the last loaded or saved), and the audio fingerprint the set was timed on. */
  const hash = useRef(state.dirty ? null : o.hash);
  const fingerprint = useRef(o.fingerprint ?? null);
  const base = useRef({ cues: state.cues, text: textOf(state.cues) });
  /** The cues array last looked at (a `select` keeps it; every load or edit makes a new one). */
  const seen = useRef(state.cues);
  /** The text of the `load` the hook dispatched after a conflict, until the editor shows it. */
  const ownLoad = useRef<string | null>(null);
  /** Saves and reloads queued and not finished. */
  const pending = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * False once the screen is gone; `closing`: the page began closing (a cancelled close leaves it set: harmless, the reload
   * then saves its merge itself and the editor's load that follows has nothing more to save). A reload ending then saves
   * its result itself.
   */
  const mounted = useRef(true);
  const closing = useRef(false);
  const chain = useRef<Promise<void>>(Promise.resolve());
  /** `flush` calls waiting for the reload's `load` to be on screen (its merged save follows it). */
  const loadShown = useRef<Array<() => void>>([]);
  const wake = () => { const w = loadShown.current; loadShown.current = []; for (const f of w) f(); };

  const changed = () => textOf(latest.current.cues) !== base.current.text;

  // A 409: the server's set with the user's changes not saved yet put back on it (`mergeAfterConflict`), edits typed while
  // it loads included. Saved when the editor shows it.
  const reload = async () => {
    const { slug: s, creative: c, lang: l } = target.current;
    let fresh: { set: { cues: SubtitleCue[]; timing?: { fingerprint: string } }; hash: string };
    try { fresh = await api.subtitleSet(s, c, l); } catch { setStatus('error'); return; }
    const now = fresh.set.timing?.fingerprint ?? null;
    // In the editor's order, so the `load` on screen is recognised by its text.
    const cues = mergeAfterConflict(base.current.cues, latest.current.cues, fresh.set.cues, now !== fingerprint.current).sort(byStart);
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    hash.current = fresh.hash;
    fingerprint.current = now;
    // The server's cues in the editor's order: the same set, so a reload with nothing to put back saves nothing.
    const server = [...fresh.set.cues].sort(byStart);
    base.current = { cues: server, text: textOf(server) };
    const unsaved = textOf(cues) !== base.current.text;
    // The screen left (or the page is closing) while it loaded: no effect will save the merge, so it goes out now.
    if ((!mounted.current || closing.current) && unsaved) {
      const body = { baseHash: fresh.hash, cues };
      const small = new TextEncoder().encode(JSON.stringify(body)).length <= KEEPALIVE_MAX_BYTES;
      try {
        const r = await (small ? api.saveSubtitleSet(s, c, l, body, { keepalive: true }) : api.saveSubtitleSet(s, c, l, body));
        hash.current = r.hash;
        base.current = { cues, text: textOf(cues) };
      } catch { /* the editor, if still there, saves it after its load */ }
    }
    ownLoad.current = textOf(cues);
    // Gone: the editor is gone too, never dispatched into (`ownLoad` stays set, so the queued unmount flush sends nothing more).
    if (!mounted.current) return;
    setNotice(true);
    setStatus(unsaved ? 'conflict' : 'saved');
    dispatch.current({ type: 'load', cues, durationMs: latest.current.durationMs, lang: latest.current.lang });
  };

  const send = async (keepalive: boolean) => {
    // The reload's `load` is not on screen yet: its own save follows it.
    if (ownLoad.current !== null) return;
    if (!changed()) { setStatus((st) => (st === 'saving' ? 'saved' : st)); return; }
    // Nothing loaded with a hash: nothing to save over (the status stays `saving`).
    if (hash.current === null) return;
    const { slug: s, creative: c, lang: l } = target.current;
    const cues = latest.current.cues;
    const body = { baseHash: hash.current, cues };
    const small = keepalive && new TextEncoder().encode(JSON.stringify(body)).length <= KEEPALIVE_MAX_BYTES;
    try {
      const r = await (small ? api.saveSubtitleSet(s, c, l, body, { keepalive: true }) : api.saveSubtitleSet(s, c, l, body));
      hash.current = r.hash;
      base.current = { cues, text: textOf(cues) };
      // Edits made while it was in flight have their own timer running. A conflict's merge saved: `saved` again (I2), so the
      // screen applies the next broadcast; `notice` still says what happened.
      setStatus(changed() ? 'saving' : 'saved');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) await reload();
      else setStatus('error');
    }
  };

  /** Queues a save after the ones in flight (each sends only what is still unsaved). */
  const save = useCallback((keepalive: boolean): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    pending.current++;
    const run = chain.current.then(() => send(keepalive)).finally(() => { if (--pending.current === 0) setIdle((n) => n + 1); });
    chain.current = run;
    return run;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state.cues === seen.current) return;
    seen.current = state.cues;
    const text = textOf(state.cues);
    if (ownLoad.current !== null) {
      // Our load is on screen (alone, or under edits made right after it: then it is the first undo step).
      const shown = state.dirty ? state.past.length > 0 && textOf(state.past[0]!) === ownLoad.current : text === ownLoad.current;
      if (shown) {
        ownLoad.current = null;
        wake();
        if (!state.dirty) {
          if (text !== base.current.text) void save(false);
          else setStatus((st) => (st === 'conflict' ? 'saved' : st));
          return;
        }
      } else if (state.dirty) {
        // A render from before our load: the load's own render follows.
        return;
      } else {
        // A screen load in the same batch as ours (outside the contract): it wins, with its hash.
        ownLoad.current = null;
        wake();
        base.current = { cues: state.cues, text };
        hash.current = propHash.current;
        fingerprint.current = propFingerprint.current;
        return;
      }
    } else if (!state.dirty) {
      // The screen's load: its cues with its hash and fingerprint.
      base.current = { cues: state.cues, text };
      hash.current = propHash.current;
      fingerprint.current = propFingerprint.current;
      return;
    }
    setNotice(false);
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (text === base.current.text) { setStatus((st) => (st === 'saving' ? 'saved' : st)); return; }
    setStatus('saving');
    timer.current = setTimeout(() => { timer.current = null; void save(false); }, SAVE_DEBOUNCE_MS);
  }, [state.cues, state.dirty, state.past, save]);

  // Leaving the screen sends a waiting edit (the page lives on); closing the page too, with keepalive when it fits.
  useEffect(() => {
    const onClose = () => { closing.current = true; void save(true); };
    window.addEventListener('beforeunload', onClose);
    window.addEventListener('pagehide', onClose);
    mounted.current = true;
    return () => {
      window.removeEventListener('beforeunload', onClose);
      window.removeEventListener('pagehide', onClose);
      mounted.current = false;
      void save(false);
      wake();
    };
  }, [save]);

  const flush = useCallback(async (): Promise<boolean> => {
    // A 409 reloads and loads the merge; its save goes out once the editor shows it: wait for that, then send it now.
    for (let round = 0; round < 5; round++) {
      await save(false);
      if (ownLoad.current === null || !mounted.current) break;
      await new Promise<void>((r) => { loadShown.current.push(r); });
    }
    // The merge's own save may already be queued (the editor showed the load before we looked): wait for every queued save.
    for (let last = null as Promise<void> | null; last !== chain.current;) { last = chain.current; await last; }
    return mounted.current && ownLoad.current === null && !changed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save]);

  const isSaved = useCallback((cues: readonly SubtitleCue[]): boolean =>
    pending.current === 0 && timer.current === null && ownLoad.current === null && hash.current !== null && textOf(cues) === base.current.text, []);

  const timingChecked = useCallback(async (): Promise<void> => {
    if (!(await flush())) throw new Error('not saved');
    const { slug: s, creative: c, lang: l } = target.current;
    let failure: unknown = null;
    pending.current++;
    // In the save queue, so no save goes out over the hash this replaces.
    const run = chain.current.then(async () => {
      if (hash.current === null) return;
      try {
        const r = await api.subtitleTimingChecked(s, c, l, { baseHash: hash.current });
        hash.current = r.hash;
        fingerprint.current = r.timing.fingerprint;
      } catch (e) { failure = e; }
    }).finally(() => { if (--pending.current === 0) setIdle((n) => n + 1); });
    chain.current = run;
    await run;
    if (failure) throw failure;
  }, [flush]);
  return { status, notice, flush, isSaved, timingChecked };
}

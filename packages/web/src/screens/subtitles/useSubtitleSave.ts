// Autosave of the subtitle editor (decisions 1654-1659): the cues go out SAVE_DEBOUNCE_MS after the last edit, over the hash
// of the set the editor holds. One save at a time. A 409 means the set changed elsewhere (a job, another window): it is
// reloaded, the user's unsaved corrections are put back on it (anti-goal 1: nothing silently drops text the user corrected)
// and saved over the new hash. A waiting edit is sent when the screen goes away or the page closes.
import { mergeKeepingEdited, type LocaleTag, type SubtitleCue } from '@motion-studio/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api.ts';
import { byStart, type EditorOp, type EditorState } from './subtitlesModel.ts';

export const SAVE_DEBOUNCE_MS = 800;
/** A body over this many bytes is sent without keepalive when the page closes (browsers refuse larger keepalive bodies). */
export const KEEPALIVE_MAX_BYTES = 60_000;

/**
 * `conflict`: the set changed elsewhere and was reloaded, the user's corrections kept (the screen says so); it stays until
 * the next edit. `saving` also covers an edit waiting for its debounce, or one that cannot go out yet (no set loaded).
 */
export type SubtitleSaveStatus = 'saved' | 'saving' | 'error' | 'conflict';

export interface SubtitleSave {
  status: SubtitleSaveStatus;
  /** Sends a waiting edit now (or retries a failed one) and waits for the saves in flight. */
  flush(): Promise<void>;
}

const textOf = (cues: readonly SubtitleCue[]): string => JSON.stringify(cues);

/**
 * Contract (decision 1657): the hook takes `o.hash` only together with a `load`, never alone. At mount, the hash goes with
 * the cues of `state` when it is not dirty; afterwards with each `load` the screen dispatches (pass the new hash in the same
 * render as that load, e.g. both from one state). A hash that changes without a load is ignored. `o.dispatch` is the
 * editor's: the hook dispatches its own `load` after a conflict. Mount one per set (key it by creative and language).
 * The screen must not dispatch its own `load` while the editor is dirty or while a conflict is being resolved (status
 * `conflict` with a save in flight): a screen load then wins over the hook's and the merged corrections are not saved.
 */
export function useSubtitleSave(
  slug: string, creative: string, lang: LocaleTag, state: EditorState,
  o: { hash: string | null; dispatch: (op: EditorOp) => void },
): SubtitleSave {
  const [status, setStatus] = useState<SubtitleSaveStatus>('saved');
  const target = useRef({ slug, creative, lang });
  target.current = { slug, creative, lang };
  const latest = useRef(state);
  latest.current = state;
  const dispatch = useRef(o.dispatch);
  dispatch.current = o.dispatch;
  const propHash = useRef(o.hash);
  propHash.current = o.hash;
  /** The hash and cues the server has (the last loaded or saved). */
  const hash = useRef(state.dirty ? null : o.hash);
  const base = useRef({ cues: state.cues, text: textOf(state.cues) });
  /** The cues array last looked at (a `select` keeps it; every load or edit makes a new one). */
  const seen = useRef(state.cues);
  /** The text of the `load` the hook dispatched after a conflict, until the editor shows it. */
  const ownLoad = useRef<string | null>(null);
  /** No edit since the last conflict: a save then keeps saying `conflict`. */
  const afterConflict = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * False once the screen is gone; `closing`: the page began closing (a cancelled close leaves it set: harmless, the reload
   * then saves its merge itself and the editor's load that follows has nothing more to save). A reload ending then saves
   * its result itself.
   */
  const mounted = useRef(true);
  const closing = useRef(false);
  const chain = useRef<Promise<void>>(Promise.resolve());

  const changed = () => textOf(latest.current.cues) !== base.current.text;

  // A 409: the server's set with the user's corrections not saved yet put back on it (their text wins; their times move with
  // the words when the set's words have them), edits typed while it loads included. Saved when the editor shows it.
  const reload = async () => {
    const { slug: s, creative: c, lang: l } = target.current;
    let fresh: { set: { cues: SubtitleCue[] }; hash: string };
    try { fresh = await api.subtitleSet(s, c, l); } catch { setStatus('error'); return; }
    const saved = new Set(base.current.cues.map((cue) => JSON.stringify(cue)));
    const unsaved = latest.current.cues.filter((cue) => cue.edited && !saved.has(JSON.stringify(cue)));
    // In the editor's order, so the `load` on screen is recognised by its text.
    const cues = [...(unsaved.length > 0 ? mergeKeepingEdited(unsaved, fresh.set.cues) : fresh.set.cues)].sort(byStart);
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    hash.current = fresh.hash;
    // The server's cues in the editor's order: the same set, so a reload with nothing to put back saves nothing.
    const server = [...fresh.set.cues].sort(byStart);
    base.current = { cues: server, text: textOf(server) };
    // The screen left (or the page is closing) while it loaded: no effect will save the merge, so it goes out now.
    if ((!mounted.current || closing.current) && unsaved.length > 0) {
      const body = { baseHash: fresh.hash, cues };
      const small = new TextEncoder().encode(JSON.stringify(body)).length <= KEEPALIVE_MAX_BYTES;
      try {
        const r = await (small ? api.saveSubtitleSet(s, c, l, body, { keepalive: true }) : api.saveSubtitleSet(s, c, l, body));
        hash.current = r.hash;
        base.current = { cues, text: textOf(cues) };
      } catch { /* the editor, if still there, saves it after its load */ }
    }
    ownLoad.current = textOf(cues);
    afterConflict.current = true;
    setStatus('conflict');
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
      // Edits made while it was in flight have their own timer running.
      setStatus(changed() ? 'saving' : afterConflict.current ? 'conflict' : 'saved');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) await reload();
      else setStatus('error');
    }
  };

  /** Queues a save after the ones in flight (each sends only what is still unsaved). */
  const save = useCallback((keepalive: boolean): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const run = chain.current.then(() => send(keepalive));
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
        if (!state.dirty) {
          if (text !== base.current.text) void save(false);
          return;
        }
      } else if (state.dirty) {
        // A render from before our load: the load's own render follows.
        return;
      } else {
        // A screen load in the same batch as ours (outside the contract): it wins, with its hash.
        ownLoad.current = null;
        base.current = { cues: state.cues, text };
        hash.current = propHash.current;
        return;
      }
    } else if (!state.dirty) {
      // The screen's load: its cues with its hash.
      base.current = { cues: state.cues, text };
      hash.current = propHash.current;
      return;
    }
    afterConflict.current = false;
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
    };
  }, [save]);

  const flush = useCallback(() => save(false), [save]);
  return { status, flush };
}

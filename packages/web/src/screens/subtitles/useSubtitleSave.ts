// Autosave of the subtitle editor (decisions 1654-1656): the cues go out SAVE_DEBOUNCE_MS after the last edit, over the hash
// of the set the editor holds. One save at a time; a 409 means the set changed elsewhere (a job, another window): it is
// reloaded and the local edits and their undo stack are left out. A waiting edit is sent when the screen goes away or the
// page closes.
import type { LocaleTag } from '@motion-studio/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api.ts';
import type { EditorOp, EditorState } from './subtitlesModel.ts';

export const SAVE_DEBOUNCE_MS = 800;

/** `conflict`: the set was reloaded because it changed elsewhere (the screen says so); it stays until the next edit. */
export type SubtitleSaveStatus = 'saved' | 'saving' | 'error' | 'conflict';

export interface SubtitleSave {
  status: SubtitleSaveStatus;
  /** Sends a waiting edit now (or retries a failed one) and waits for the saves in flight. */
  flush(): Promise<void>;
}

/**
 * `o.hash`: the hash of the set the screen loaded into `state` (null before it is loaded); a new value is the new base.
 * `o.dispatch`: the editor's, for the reload after a conflict. Mount one per set (key it by creative and language).
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
  const hash = useRef(o.hash);
  /** The cues the server has (the last loaded or saved). */
  const baseline = useRef(state.cues);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => { hash.current = o.hash; }, [o.hash]);

  const changed = () => latest.current.dirty && latest.current.cues !== baseline.current;

  const reload = async () => {
    const { slug: s, creative: c, lang: l } = target.current;
    try {
      const r = await api.subtitleSet(s, c, l);
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      hash.current = r.hash;
      baseline.current = r.set.cues;
      dispatch.current({ type: 'load', cues: r.set.cues, durationMs: latest.current.durationMs, lang: latest.current.lang });
      setStatus('conflict');
    } catch {
      setStatus('error');
    }
  };

  const send = async (keepalive: boolean) => {
    if (!changed() || hash.current === null) {
      setStatus((st) => (st === 'saving' ? 'saved' : st));
      return;
    }
    const { slug: s, creative: c, lang: l } = target.current;
    const cues = latest.current.cues;
    const body = { baseHash: hash.current, cues };
    try {
      const r = await (keepalive ? api.saveSubtitleSet(s, c, l, body, { keepalive: true }) : api.saveSubtitleSet(s, c, l, body));
      hash.current = r.hash;
      baseline.current = cues;
      // Edits made while it was in flight have their own timer running.
      setStatus(changed() ? 'saving' : 'saved');
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

  // A load (not dirty) is what the server has; an edit waits SAVE_DEBOUNCE_MS of quiet.
  useEffect(() => {
    if (!state.dirty) { baseline.current = state.cues; return; }
    if (state.cues === baseline.current) return;
    setStatus('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void save(false); }, SAVE_DEBOUNCE_MS);
  }, [state.cues, state.dirty, save]);

  // Leaving the screen sends a waiting edit (the page lives on); closing the page too, with keepalive.
  useEffect(() => {
    const closing = () => { void save(true); };
    window.addEventListener('beforeunload', closing);
    window.addEventListener('pagehide', closing);
    return () => {
      window.removeEventListener('beforeunload', closing);
      window.removeEventListener('pagehide', closing);
      void save(false);
    };
  }, [save]);

  const flush = useCallback(() => save(false), [save]);
  return { status, flush };
}

// Autosave of the subtitle editor (decisions 1654-1657): debounced PUTs with the set's hash; a conflict reloads the set and
// keeps the user's unsaved corrections.
import { act, renderHook } from '@testing-library/react';
import type { SubtitleCue } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorReducer, initialEditorState, type EditorOp, type EditorState } from '../src/screens/subtitles/subtitlesModel.ts';

class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) { super(message); }
}
const api = { saveSubtitleSet: vi.fn(), subtitleSet: vi.fn() };
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { useSubtitleSave, SAVE_DEBOUNCE_MS, KEEPALIVE_MAX_BYTES } = await import('../src/screens/subtitles/useSubtitleSave.ts');

const CUES: SubtitleCue[] = [
  { id: 'c1', start: 0, end: 1500, text: 'Ciao a tutti' },
  { id: 'c2', start: 2000, end: 3500, text: 'Prenota in tre tocchi' },
];
const loaded = (cues = CUES, durationMs = 6000): EditorState => editorReducer(initialEditorState(), { type: 'load', cues, durationMs, lang: 'it' });
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);

/** The hook over an editor state; the hook's own dispatch goes to the same reducer, as in the screen. */
const FP1 = '1'.repeat(64);
const FP2 = '2'.repeat(64);
/** The set as the server answers it: its timing's fingerprint with the cues. */
const setWith = (cues: SubtitleCue[], fingerprint = FP1) => ({ lang: 'it', timing: { version: 1, format: 'f', fingerprint }, cues });

function setup(start: EditorState = loaded(), firstHash: string | null = H1, o: { deferDispatch?: boolean; fingerprint?: string } = {}) {
  let state = start;
  let hash = firstHash;
  // eslint-disable-next-line prefer-const
  let hook: ReturnType<typeof render>;
  const edit = (op: EditorOp) => { state = editorReducer(state, op); hook.rerender({ state, hash }); };
  // `deferDispatch`: the hook's op is applied but shown only with the next render (one React batch with what follows).
  const dispatch = vi.fn<(op: EditorOp) => void>((op) => { if (o.deferDispatch) state = editorReducer(state, op); else edit(op); });
  const render = () => renderHook(({ state: st, hash: h }) => useSubtitleSave('acme', 'promo', 'it', st, { hash: h, fingerprint: o.fingerprint ?? FP1, dispatch }), { initialProps: { state, hash } });
  hook = render();
  /** The screen passing another hash, with or without a load in the same render. */
  const screen = (h: string | null, load?: SubtitleCue[]) => {
    hash = h;
    if (load) state = editorReducer(state, { type: 'load', cues: load, durationMs: 6000, lang: 'it' });
    hook.rerender({ state, hash });
  };
  return { ...hook, dispatch, edit, screen, now: () => state };
}
/** Lets the chained promises (save, reload, the save after it) run. */
const settle = () => act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe('useSubtitleSave', () => {
  it('three edits within 800 ms make one PUT with the latest cues and the loaded hash; the answer\'s hash is the next base', async () => {
    api.saveSubtitleSet.mockResolvedValueOnce({ hash: H2 }).mockResolvedValueOnce({ hash: H3 });
    const { result, edit, now } = setup();
    expect(result.current.status).toBe('saved');
    act(() => { edit({ type: 'text', id: 'c1', text: 'Ciao' }); });
    expect(result.current.status).toBe('saving');
    act(() => { vi.advanceTimersByTime(300); edit({ type: 'text', id: 'c1', text: 'Ciao a' }); });
    act(() => { vi.advanceTimersByTime(300); edit({ type: 'text', id: 'c1', text: 'Ciao a voi' }); });
    act(() => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1); });
    expect(api.saveSubtitleSet).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(1);
    expect(api.saveSubtitleSet).toHaveBeenCalledWith('acme', 'promo', 'it', { baseHash: H1, cues: now().cues });
    expect(now().cues[0]).toMatchObject({ text: 'Ciao a voi', edited: true });
    expect(result.current.status).toBe('saved');

    act(() => { edit({ type: 'delete', id: 'c2' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(2);
    expect(api.saveSubtitleSet.mock.calls[1]![3]).toEqual({ baseHash: H2, cues: now().cues });
  });

  it('a 409 while the user has an unsaved correction: the set is reloaded, the correction kept and saved over the new hash', async () => {
    api.saveSubtitleSet.mockRejectedValueOnce(new ApiError(409, 'changed', 'subtitles-conflict')).mockResolvedValueOnce({ hash: H2 });
    const theirs: SubtitleCue[] = [CUES[0]!, { id: 'c2', start: 2000, end: 3500, text: 'Prenota ora', edited: true }];
    api.subtitleSet.mockResolvedValueOnce({ set: setWith(theirs), hash: H3 });
    const { result, edit, dispatch, now } = setup();
    act(() => { edit({ type: 'text', id: 'c1', text: 'Ciao mio' }); });
    const mine = now().cues[0]!;
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    await settle();
    expect(api.subtitleSet).toHaveBeenCalledWith('acme', 'promo', 'it');
    // Their edited line keeps its id; the user's line replaces the same line of theirs.
    expect(dispatch).toHaveBeenCalledWith({ type: 'load', cues: [mine, theirs[1]!], durationMs: 6000, lang: 'it' });
    expect(now().cues.map((c) => c.text)).toEqual(['Ciao mio', 'Prenota ora']);
    expect(now().past).toEqual([]);
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(2);
    expect(api.saveSubtitleSet.mock.calls[1]![3]).toEqual({ baseHash: H3, cues: now().cues });
    // The merged save landed: saved again (the notice stays until the next edit).
    expect(result.current.status).toBe('saved');
    expect(result.current.notice).toBe(true);

    // The next edit saves over the hash that save answered.
    api.saveSubtitleSet.mockResolvedValueOnce({ hash: H1 });
    act(() => { edit({ type: 'text', id: now().cues[1]!.id, text: 'Prenota adesso' }); });
    expect(result.current.status).toBe('saving');
    expect(result.current.notice).toBe(false);
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    expect(api.saveSubtitleSet.mock.calls[2]![3]).toMatchObject({ baseHash: H2 });
    expect(result.current.status).toBe('saved');
  });

  it('a 409 with nothing unsaved of the user\'s just reloads; an edit typed while the reload is pending survives it', async () => {
    api.saveSubtitleSet.mockRejectedValueOnce(new ApiError(409, 'changed', 'subtitles-conflict')).mockResolvedValueOnce({ hash: H2 });
    let answer!: (v: unknown) => void;
    api.subtitleSet.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const theirs: SubtitleCue[] = [...CUES, { id: 'c3', start: 4000, end: 5500, text: 'Scarica l\'app', edited: true }];
    const { result, edit, now } = setup();
    act(() => { edit({ type: 'text', id: 'c1', text: 'Ciao mio' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    expect(api.subtitleSet).toHaveBeenCalledTimes(1);
    // Typed while the set is being fetched again; its own timer runs out too.
    act(() => { edit({ type: 'text', id: 'c2', text: 'Prenota subito' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    await act(async () => { answer({ set: setWith(theirs), hash: H3 }); });
    await settle();
    expect(now().cues.map((c) => c.text)).toEqual(['Ciao mio', 'Prenota subito', 'Scarica l\'app']);
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(2);
    expect(api.saveSubtitleSet.mock.calls[1]![3]).toEqual({ baseHash: H3, cues: now().cues });
    expect(result.current.status).toBe('saved');

    // A deletion of a line the server still has as it was is put back too (final review, C1), and saved.
    api.saveSubtitleSet.mockRejectedValueOnce(new ApiError(409, 'changed', 'subtitles-conflict')).mockResolvedValueOnce({ hash: H1 });
    const again = setup();
    api.subtitleSet.mockResolvedValueOnce({ set: setWith(theirs), hash: H3 });
    act(() => { again.edit({ type: 'delete', id: 'c2' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    await settle();
    expect(again.now().cues).toEqual([theirs[0]!, theirs[2]!]);
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(4);
    expect(api.saveSubtitleSet.mock.calls[3]![3]).toEqual({ baseHash: H3, cues: again.now().cues });
    expect(again.result.current.status).toBe('saved');
    again.unmount();
  });

  it('a reloaded set with equal starts in another order than the editor\'s keeps autosave working', async () => {
    api.saveSubtitleSet.mockRejectedValueOnce(new ApiError(409, 'changed', 'subtitles-conflict')).mockResolvedValue({ hash: H2 });
    // Sorted by start only (the schema's rule); the editor sorts equal starts by end.
    const theirs: SubtitleCue[] = [{ id: 'c1', start: 0, end: 1500, text: 'Ciao' }, { id: 'c2', start: 0, end: 1000, text: 'Sopra' }];
    api.subtitleSet.mockResolvedValueOnce({ set: setWith(theirs), hash: H3 });
    const { result, edit, now } = setup();
    act(() => { edit({ type: 'delete', id: 'c2' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    await settle();
    expect(now().cues.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(1);
    act(() => { edit({ type: 'text', id: 'c1', text: 'Ciao ciao' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(2);
    expect(api.saveSubtitleSet.mock.calls[1]![3]).toEqual({ baseHash: H3, cues: now().cues });
    expect(result.current.status).toBe('saved');
  });

  it('a screen load in the same render as the reload\'s load wins, and autosave goes on over its hash', async () => {
    api.saveSubtitleSet.mockRejectedValueOnce(new ApiError(409, 'changed', 'subtitles-conflict')).mockResolvedValue({ hash: H2 });
    api.subtitleSet.mockResolvedValueOnce({ set: setWith(CUES), hash: H3 });
    const { edit, screen, now } = setup(loaded(), H1, { deferDispatch: true });
    act(() => { edit({ type: 'text', id: 'c1', text: 'Ciao mio' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    await settle();
    const other: SubtitleCue[] = [{ id: 'c9', start: 100, end: 1600, text: 'Dalla schermata' }];
    act(() => { screen(H1.replace(/a/g, 'd'), other); });
    await settle();
    expect(now().cues).toEqual(other);
    act(() => { edit({ type: 'text', id: 'c9', text: 'Dalla schermata, corretto' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    expect(api.saveSubtitleSet.mock.calls.at(-1)![3]).toEqual({ baseHash: 'd'.repeat(64), cues: now().cues });
  });

  it('leaving the screen while a conflict reload is pending still saves the merged corrections', async () => {
    api.saveSubtitleSet.mockRejectedValueOnce(new ApiError(409, 'changed', 'subtitles-conflict')).mockResolvedValue({ hash: H2 });
    let answer!: (v: unknown) => void;
    api.subtitleSet.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const theirs: SubtitleCue[] = [CUES[0]!, { id: 'c2', start: 2000, end: 3500, text: 'Prenota ora', edited: true }];
    const { edit, now, unmount, dispatch } = setup();
    act(() => { edit({ type: 'text', id: 'c1', text: 'Ciao mio' }); });
    const mine = now().cues[0]!;
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    unmount();
    await act(async () => { answer({ set: setWith(theirs), hash: H3 }); });
    await settle();
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(2);
    expect(api.saveSubtitleSet.mock.calls[1]).toEqual(['acme', 'promo', 'it', { baseHash: H3, cues: [mine, theirs[1]!] }, { keepalive: true }]);
    // The editor is gone: nothing is dispatched into it.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('a hash given without a load is ignored; one given with a load is the next base', async () => {
    api.saveSubtitleSet.mockResolvedValue({ hash: H2 });
    const { edit, screen } = setup();
    act(() => { screen(H3); });
    act(() => { edit({ type: 'text', id: 'c1', text: 'Ciao' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    expect(api.saveSubtitleSet.mock.calls[0]![3]).toMatchObject({ baseHash: H1 });
    // The screen loads the set again (another tab's change came in) with its hash.
    act(() => { screen(H3, CUES); });
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(1);
    act(() => { edit({ type: 'text', id: 'c2', text: 'Prenota' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    expect(api.saveSubtitleSet.mock.calls[1]![3]).toMatchObject({ baseHash: H3 });
  });

  it('with no hash yet an edit is not saved and the status never says saved', async () => {
    const { result, edit } = setup(loaded(), null);
    act(() => { edit({ type: 'text', id: 'c1', text: 'Ciao' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    await act(async () => { await result.current.flush(); });
    expect(api.saveSubtitleSet).not.toHaveBeenCalled();
    expect(result.current.status).toBe('saving');
  });

  it('closing the page with a body too large for keepalive sends it as a normal request', async () => {
    api.saveSubtitleSet.mockResolvedValue({ hash: H2 });
    const many: SubtitleCue[] = Array.from({ length: 400 }, (_, i) => ({ id: `c${i}`, start: i * 2000, end: i * 2000 + 1500, text: 'x'.repeat(190) }));
    const { edit, now, unmount } = setup(loaded(many));
    act(() => { edit({ type: 'text', id: 'c0', text: 'Ciao' }); });
    expect(JSON.stringify(now().cues).length).toBeGreaterThan(KEEPALIVE_MAX_BYTES);
    await act(async () => { window.dispatchEvent(new Event('beforeunload')); });
    expect(api.saveSubtitleSet.mock.calls).toEqual([['acme', 'promo', 'it', { baseHash: H1, cues: now().cues }]]);
    unmount();
  });

  it('another failure is status error; flush saves again at once', async () => {
    api.saveSubtitleSet.mockRejectedValueOnce(new ApiError(500, 'boom')).mockResolvedValueOnce({ hash: H2 });
    const { result, edit } = setup();
    act(() => { edit({ type: 'text', id: 'c1', text: 'Ciao' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    expect(result.current.status).toBe('error');
    await act(async () => { await result.current.flush(); });
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('saved');
  });

  it('flush sends a waiting edit now; leaving the screen and closing the page flush too (the page with keepalive)', async () => {
    api.saveSubtitleSet.mockResolvedValue({ hash: H2 });
    const first = setup();
    act(() => { first.edit({ type: 'text', id: 'c1', text: 'Ciao' }); });
    await act(async () => { await first.result.current.flush(); });
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(1);
    // Nothing waiting: flush sends nothing.
    await act(async () => { await first.result.current.flush(); });
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(1);

    act(() => { first.edit({ type: 'text', id: 'c2', text: 'Prenota' }); });
    await act(async () => { first.unmount(); });
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(2);
    expect(api.saveSubtitleSet.mock.calls[1]![3]).toEqual({ baseHash: H2, cues: first.now().cues });

    const second = setup();
    act(() => { second.edit({ type: 'text', id: 'c1', text: 'Ciao ciao' }); });
    await act(async () => { window.dispatchEvent(new Event('beforeunload')); });
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(3);
    expect(api.saveSubtitleSet.mock.calls[2]).toEqual(['acme', 'promo', 'it', { baseHash: H1, cues: second.now().cues }, { keepalive: true }]);
    second.unmount();
  });

  it('a load (no edit) never saves', async () => {
    const { edit } = setup();
    act(() => { edit({ type: 'load', cues: [CUES[0]!], durationMs: 6000, lang: 'it' }); });
    act(() => { edit({ type: 'select', id: 'c1' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 2); });
    expect(api.saveSubtitleSet).not.toHaveBeenCalled();
  });
});

describe('useSubtitleSave after a conflict (final review)', () => {
  const conflictThen = (fresh: SubtitleCue[], fingerprint = FP1) => {
    api.saveSubtitleSet.mockRejectedValueOnce(new ApiError(409, 'changed', 'subtitles-conflict')).mockResolvedValue({ hash: H2 });
    api.subtitleSet.mockResolvedValueOnce({ set: setWith(fresh, fingerprint), hash: H3 });
  };
  const run = async () => { await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); }); await settle(); };
  const lastSaved = () => (api.saveSubtitleSet.mock.calls.at(-1)![3] as { cues: SubtitleCue[] }).cues;

  it('C1: a corrected line the server has (edited) stays even under an unsaved line of the user\'s; a new fresh line under it goes', async () => {
    const base: SubtitleCue[] = [{ id: 'f1', start: 0, end: 2000, text: 'Ciao a tutti' }, { id: 'c1', start: 6000, end: 8000, text: 'Buongiorno' }];
    const u7: SubtitleCue = { id: 'u7', start: 3000, end: 5000, text: 'benvenuti nel corso di oggi', edited: true };
    const f9: SubtitleCue = { id: 'f9', start: 4500, end: 5500, text: 'una riga nuova' };
    conflictThen([base[0]!, u7, f9, base[1]!]);
    const { edit, now, result } = setup(loaded(base, 10_000));
    act(() => { edit({ type: 'text', id: 'c1', text: 'Buongiorno e grazie' }); });
    act(() => { edit({ type: 'times', id: 'c1', start: 4000, end: 6000 }); });
    const mine = now().cues.find((c) => c.id === 'c1')!;
    await run();
    expect(now().cues).toEqual([base[0]!, u7, mine]);
    expect(lastSaved()).toEqual(now().cues);
    expect(result.current.status).toBe('saved');
  });

  it('C1: with the same audio the user\'s own times are kept exactly; with new audio the line follows its words', async () => {
    const fresh: SubtitleCue[] = [CUES[0]!, { ...CUES[1]!, words: [{ start: 2000, end: 2400, text: 'Prenota' }, { start: 2400, end: 2600, text: 'in' }, { start: 2600, end: 3000, text: 'tre' }, { start: 3000, end: 3500, text: 'tocchi' }] }];
    conflictThen(fresh);
    const same = setup();
    act(() => { same.edit({ type: 'times', id: 'c2', start: 2500, end: 3800 }); });
    await run();
    // The server's c2 is not the saved one any more (it has words now): the user's line keeps its text under a free id.
    const mineOf = (cues: SubtitleCue[]) => cues.filter((c) => c.text === CUES[1]!.text);
    expect(mineOf(same.now().cues)).toEqual([expect.objectContaining({ start: 2500, end: 3800, edited: true })]);
    same.unmount();

    vi.resetAllMocks();
    conflictThen(fresh, FP2);
    const moved = setup();
    act(() => { moved.edit({ type: 'times', id: 'c2', start: 2500, end: 3800 }); });
    await run();
    expect(mineOf(moved.now().cues)).toEqual([expect.objectContaining({ start: 2000, end: 3500, edited: true })]);
    moved.unmount();
  });

  it('C1: an undo back to the original text (not edited, but not what was saved) is put back on the reloaded set', async () => {
    api.saveSubtitleSet.mockResolvedValueOnce({ hash: H2 });
    const { edit, now } = setup();
    act(() => { edit({ type: 'text', id: 'c1', text: 'Ciao mio' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    const saved = now().cues;
    const c3: SubtitleCue = { id: 'c3', start: 4000, end: 5000, text: 'Da un\'altra finestra' };
    conflictThen([...saved, c3]);
    act(() => { edit({ type: 'undo' }); });
    expect(now().cues[0]).toEqual(CUES[0]);
    await run();
    expect(now().cues).toEqual([CUES[0]!, CUES[1]!, c3]);
    expect(lastSaved()).toEqual(now().cues);
  });

  it('C1: a line deleted here that the server changed meanwhile stays; a new line of the user\'s under an id the server also took is renamed', async () => {
    const theirs: SubtitleCue[] = [
      CUES[0]!, { id: 'c2', start: 2000, end: 3500, text: 'Prenota ora', edited: true },
      { id: 'u1', start: 4000, end: 4800, text: 'Aggiunta altrove', edited: true },
    ];
    conflictThen(theirs);
    const { edit, now } = setup();
    act(() => { edit({ type: 'delete', id: 'c2' }); });
    act(() => { edit({ type: 'add', at: 5000 }); });
    const added = now().cues.find((c) => c.id === 'u1')!;
    await run();
    expect(now().cues.map((c) => [c.id, c.text])).toEqual([['c1', 'Ciao a tutti'], ['c2', 'Prenota ora'], ['u1', 'Aggiunta altrove'], ['u2', added.text]]);
    expect(now().cues.at(-1)).toMatchObject({ start: added.start, end: added.end, edited: true });
  });

  it('Task 23: a translated line comes back with its keys in the schema\'s order: still the saved line (a delete stays, isSaved holds)', async () => {
    const translated: SubtitleCue[] = [
      { id: 'c1', start: 0, end: 1500, text: 'Hi everyone', source: { text: 'Ciao a tutti' } },
      { id: 'c2', start: 2000, end: 3500, text: 'Book in three taps', source: { text: 'Prenota in tre tocchi' } },
    ];
    api.saveSubtitleSet.mockResolvedValueOnce({ hash: H2 });
    const { edit, now, result } = setup(loaded(translated));
    act(() => { edit({ type: 'text', id: 'c1', text: 'Hello everyone' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    const mine = now().cues[0]!;
    // The server's file has the cue in the schema's key order (id, start, end, text, words, edited, source).
    const schemaOrder: SubtitleCue = { id: mine.id, start: mine.start, end: mine.end, text: mine.text, edited: true, source: { text: 'Ciao a tutti' } };
    expect(JSON.stringify(schemaOrder)).not.toBe(JSON.stringify(mine));
    expect(result.current.isSaved([schemaOrder, translated[1]!])).toBe(true);
    const c3: SubtitleCue = { id: 'c3', start: 4000, end: 5000, text: 'From another window' };
    conflictThen([schemaOrder, translated[1]!, c3]);
    act(() => { edit({ type: 'delete', id: 'c1' }); });
    await run();
    expect(now().cues).toEqual([translated[1]!, c3]);
    expect(lastSaved()).toEqual(now().cues);
  });

  it('M1: isSaved says whether the cues are what the server has, nothing in flight', async () => {
    let answer!: (v: unknown) => void;
    api.saveSubtitleSet.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const { edit, now, result } = setup();
    expect(result.current.isSaved(now().cues)).toBe(true);
    act(() => { edit({ type: 'text', id: 'c1', text: 'Ciao' }); });
    expect(result.current.isSaved(now().cues)).toBe(false);
    expect(result.current.isSaved(CUES)).toBe(false);
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    expect(result.current.isSaved(now().cues)).toBe(false);
    await act(async () => { answer({ hash: H2 }); });
    await settle();
    expect(result.current.isSaved(now().cues)).toBe(true);
  });
});

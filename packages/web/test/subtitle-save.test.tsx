// Autosave of the subtitle editor (decisions 1654-1657): debounced PUTs with the set's hash; a conflict reloads the set and
// keeps the user's unsaved corrections.
import { act, renderHook } from '@testing-library/react';
import { mergeKeepingEdited, type SubtitleCue } from '@motion-studio/shared';
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
const loaded = (cues = CUES): EditorState => editorReducer(initialEditorState(), { type: 'load', cues, durationMs: 6000, lang: 'it' });
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);

/** The hook over an editor state; the hook's own dispatch goes to the same reducer, as in the screen. */
function setup(start: EditorState = loaded(), firstHash: string | null = H1) {
  let state = start;
  let hash = firstHash;
  // eslint-disable-next-line prefer-const
  let hook: ReturnType<typeof render>;
  const edit = (op: EditorOp) => { state = editorReducer(state, op); hook.rerender({ state, hash }); };
  const dispatch = vi.fn<(op: EditorOp) => void>((op) => { edit(op); });
  const render = () => renderHook(({ state: st, hash: h }) => useSubtitleSave('acme', 'promo', 'it', st, { hash: h, dispatch }), { initialProps: { state, hash } });
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
    api.subtitleSet.mockResolvedValueOnce({ set: { lang: 'it', cues: theirs }, hash: H3 });
    const { result, edit, dispatch, now } = setup();
    act(() => { edit({ type: 'text', id: 'c1', text: 'Ciao mio' }); });
    const mine = now().cues[0]!;
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    await settle();
    expect(api.subtitleSet).toHaveBeenCalledWith('acme', 'promo', 'it');
    expect(dispatch).toHaveBeenCalledWith({ type: 'load', cues: mergeKeepingEdited([mine], theirs), durationMs: 6000, lang: 'it' });
    expect(now().cues.map((c) => c.text)).toEqual(['Ciao mio', 'Prenota ora']);
    expect(now().past).toEqual([]);
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(2);
    expect(api.saveSubtitleSet.mock.calls[1]![3]).toEqual({ baseHash: H3, cues: now().cues });
    expect(result.current.status).toBe('conflict');

    // The next edit saves over the hash that save answered.
    api.saveSubtitleSet.mockResolvedValueOnce({ hash: H1 });
    act(() => { edit({ type: 'text', id: now().cues[1]!.id, text: 'Prenota adesso' }); });
    expect(result.current.status).toBe('saving');
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
    await act(async () => { answer({ set: { lang: 'it', cues: theirs }, hash: H3 }); });
    await settle();
    expect(now().cues.map((c) => c.text)).toEqual(['Ciao mio', 'Prenota subito', 'Scarica l\'app']);
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(2);
    expect(api.saveSubtitleSet.mock.calls[1]![3]).toEqual({ baseHash: H3, cues: now().cues });
    expect(result.current.status).toBe('conflict');

    // Nothing of the user's unsaved: the reload is the server's set, nothing saved.
    api.saveSubtitleSet.mockRejectedValueOnce(new ApiError(409, 'changed', 'subtitles-conflict'));
    const again = setup();
    api.subtitleSet.mockResolvedValueOnce({ set: { lang: 'it', cues: theirs }, hash: H3 });
    // A deletion is not a correction of text: it is not put back.
    act(() => { again.edit({ type: 'delete', id: 'c2' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    await settle();
    expect(again.now().cues).toEqual(theirs);
    expect(api.saveSubtitleSet).toHaveBeenCalledTimes(3);
    expect(again.result.current.status).toBe('conflict');
    again.unmount();
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

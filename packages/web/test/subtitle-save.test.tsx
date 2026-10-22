// Autosave of the subtitle editor (decisions 1654-1656): debounced PUTs with the set's hash, a conflict reloads the set.
import { act, renderHook } from '@testing-library/react';
import type { SubtitleCue } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorReducer, initialEditorState, type EditorOp, type EditorState } from '../src/screens/subtitles/subtitlesModel.ts';

class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) { super(message); }
}
const api = { saveSubtitleSet: vi.fn(), subtitleSet: vi.fn() };
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { useSubtitleSave, SAVE_DEBOUNCE_MS } = await import('../src/screens/subtitles/useSubtitleSave.ts');

const CUES: SubtitleCue[] = [
  { id: 'c1', start: 0, end: 1500, text: 'Ciao a tutti' },
  { id: 'c2', start: 2000, end: 3500, text: 'Prenota in tre tocchi' },
];
const loaded = (cues = CUES): EditorState => editorReducer(initialEditorState(), { type: 'load', cues, durationMs: 6000, lang: 'it' });
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);

function setup(start: EditorState = loaded()) {
  const dispatch = vi.fn<(op: EditorOp) => void>();
  const hook = renderHook(({ state, hash }) => useSubtitleSave('acme', 'promo', 'it', state, { hash, dispatch }), { initialProps: { state: start, hash: H1 as string | null } });
  let state = start;
  const edit = (op: EditorOp) => { state = editorReducer(state, op); hook.rerender({ state, hash: H1 }); };
  return { ...hook, dispatch, edit, now: () => state };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

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

  it('a 409 reloads the set (status conflict, the undo stack left out)', async () => {
    api.saveSubtitleSet.mockRejectedValueOnce(new ApiError(409, 'changed', 'subtitles-conflict'));
    const theirs: SubtitleCue[] = [{ id: 'c1', start: 0, end: 1500, text: 'Ciao da loro', edited: true }];
    api.subtitleSet.mockResolvedValueOnce({ set: { lang: 'it', cues: theirs }, hash: H3 });
    const { result, edit, dispatch } = setup();
    act(() => { edit({ type: 'text', id: 'c1', text: 'Ciao mio' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    expect(api.subtitleSet).toHaveBeenCalledWith('acme', 'promo', 'it');
    expect(dispatch).toHaveBeenCalledWith({ type: 'load', cues: theirs, durationMs: 6000, lang: 'it' });
    expect(result.current.status).toBe('conflict');

    // The next save starts from the reloaded set's hash.
    api.saveSubtitleSet.mockResolvedValueOnce({ hash: H2 });
    act(() => { edit({ type: 'load', cues: theirs, durationMs: 6000, lang: 'it' }); });
    expect(result.current.status).toBe('conflict');
    act(() => { edit({ type: 'text', id: 'c1', text: 'Ciao di nuovo' }); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS); });
    expect(api.saveSubtitleSet.mock.calls.at(-1)![3]).toMatchObject({ baseHash: H3 });
    expect(result.current.status).toBe('saved');
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

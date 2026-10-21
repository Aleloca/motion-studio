import type { VideoAnalysisView } from '@motion-studio/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventsReducer, initialEventsState, type EventsState } from '../src/eventsReducer.ts';

const view = (file: string, over: Partial<VideoAnalysisView> = {}): VideoAnalysisView =>
  ({ file, state: 'none', jobId: null, error: null, pending: null, header: null, body: null, ...over });
const api = {
  listVideoAnalyses: vi.fn(async (_slug: string): Promise<VideoAnalysisView[]> => [view('assets/a.mp4'), view('assets/b.mp4')]),
  analysisWait: vi.fn(async (_slug: string, _c: string) => ({ files: ['assets/a.mp4'] })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { useAnalysisWait, useVideoAnalyses } = await import('../src/useVideoAnalyses.ts');
afterEach(() => vi.clearAllMocks());

describe('video analyses in the events state (Task 18)', () => {
  it('a video-analysis message keeps the view per project and file; analysis-wait keeps the files and refetches the chat', () => {
    let s = eventsReducer(initialEventsState, { type: 'video-analysis', project: 'acme', file: 'assets/a.mp4', view: view('assets/a.mp4', { state: 'running', jobId: 'j1' }) });
    expect(s.analyses?.acme?.['assets/a.mp4']?.view.state).toBe('running');
    s = eventsReducer(s, { type: 'analysis-wait', project: 'acme', creative: 'lancio', files: ['assets/a.mp4'] });
    expect(s.analysisWaits?.['acme/lancio']?.files).toEqual(['assets/a.mp4']);
    expect(s.creativeTicks['acme/lancio']).toBe(1);
    s = eventsReducer(s, { type: 'analysis-wait', project: 'acme', creative: 'lancio', files: [] });
    expect(s.analysisWaits?.['acme/lancio']?.files).toEqual([]);
  });
});

describe('useVideoAnalyses / useAnalysisWait', () => {
  it('lists the analyses and applies a later live view over the listed one; pending lists the held ones', async () => {
    let live: EventsState = initialEventsState;
    const { result, rerender } = renderHook(({ l }) => useVideoAnalyses('acme', l), { initialProps: { l: live } });
    await waitFor(() => expect(Object.keys(result.current.byFile)).toEqual(['assets/a.mp4', 'assets/b.mp4']));
    const pending = { kind: 'long' as const, frames: 130, reducedFrames: 44, tokens: 104000, reducedTokens: 35200 };
    live = eventsReducer(live, { type: 'video-analysis', project: 'acme', file: 'assets/b.mp4', view: view('assets/b.mp4', { state: 'waiting', pending }) });
    act(() => rerender({ l: live }));
    expect(result.current.byFile['assets/b.mp4']?.state).toBe('waiting');
    expect(result.current.pending.map((v) => v.file)).toEqual(['assets/b.mp4']);
    // A message of another project changes nothing here.
    live = eventsReducer(live, { type: 'video-analysis', project: 'other', file: 'assets/a.mp4', view: view('assets/a.mp4', { state: 'ready' }) });
    act(() => rerender({ l: live }));
    expect(result.current.byFile['assets/a.mp4']?.state).toBe('none');
  });

  it('a live view received before the listing answered does not hide the listing\'s newer state', async () => {
    let resolve!: (v: VideoAnalysisView[]) => void;
    api.listVideoAnalyses.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const before = eventsReducer(initialEventsState, { type: 'video-analysis', project: 'acme', file: 'assets/a.mp4', view: view('assets/a.mp4', { state: 'running' }) });
    const { result } = renderHook(() => useVideoAnalyses('acme', before));
    await waitFor(() => expect(api.listVideoAnalyses).toHaveBeenCalled());
    expect(result.current.byFile['assets/a.mp4']?.state, 'the live view shows until the listing answers').toBe('running');
    await act(async () => resolve([view('assets/a.mp4', { state: 'ready' })]));
    expect(result.current.byFile['assets/a.mp4']?.state).toBe('ready');
  });

  it('the wait: fetched first, then the live message; an empty list ends it', async () => {
    let live: EventsState = initialEventsState;
    const { result, rerender } = renderHook(({ l }) => useAnalysisWait('acme', 'lancio', l), { initialProps: { l: live } });
    await waitFor(() => expect(result.current).toEqual(['assets/a.mp4']));
    live = eventsReducer(live, { type: 'analysis-wait', project: 'acme', creative: 'lancio', files: [] });
    act(() => rerender({ l: live }));
    expect(result.current).toEqual([]);
  });
});

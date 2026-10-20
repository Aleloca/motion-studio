import { EMPTY_BRIEF_FORM, type BriefSessionView, type ConversationEntry, type JobSummary } from '@motion-studio/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialEventsState, type EventsState } from '../src/eventsReducer.ts';

const at = '2026-10-20T10:00:00.000Z';
const view = (over: Partial<BriefSessionView> = {}): BriefSessionView => ({
  id: 's1', createdAt: at, updatedAt: at, context: { codebases: [], assets: [] }, form: EMPTY_BRIEF_FORM, userEdited: [], agentFields: [], queued: [], jobId: null, revision: 3, ...over,
});
class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
const api = {
  getBriefSession: vi.fn(async (_slug: string): Promise<BriefSessionView | null> => view()),
  getBriefConversation: vi.fn(async (_slug: string, _id: string): Promise<ConversationEntry[]> => [{ type: 'user', at, text: 'Ciao', pins: [], attachments: [] } as unknown as ConversationEntry]),
  saveBriefForm: vi.fn(async (_slug: string, _id: string, body: { form: typeof EMPTY_BRIEF_FORM; userEdited: string[]; baseRevision: number }) => ({ ok: true, form: body.form, userEdited: body.userEdited, agentFields: [], revision: body.baseRevision + 1 })),
  discardBriefSession: vi.fn(async (_slug: string, _id: string) => undefined),
  startBriefSession: vi.fn(async () => view()),
};
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { useBriefSession } = await import('../src/screens/new-creative/useBriefSession.ts');

const live = (over: Partial<EventsState> = {}): EventsState => ({ ...initialEventsState, ...over });
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('useBriefSession (decision 1422)', () => {
  it('loads the open session and its chat, and refetches both on a brief-session tick', async () => {
    const { result, rerender } = renderHook(({ l }) => useBriefSession('acme', l), { initialProps: { l: live() } });
    await waitFor(() => expect(result.current.session?.id).toBe('s1'));
    expect(result.current.entries).toHaveLength(1);
    expect(api.getBriefSession).toHaveBeenCalledTimes(1);
    rerender({ l: live({ briefTicks: { acme: 1 } }) });
    await waitFor(() => expect(api.getBriefSession).toHaveBeenCalledTimes(2));
    expect(api.getBriefConversation).toHaveBeenCalledTimes(2);
    // Another project's tick changes nothing here.
    rerender({ l: live({ briefTicks: { acme: 1, other: 4 } }) });
    await act(async () => { await Promise.resolve(); });
    expect(api.getBriefSession).toHaveBeenCalledTimes(2);
  });

  it('a reconnection (new snapshot) reads the session again', async () => {
    const { result, rerender } = renderHook(({ l }) => useBriefSession('acme', l), { initialProps: { l: live({ snapshots: 1 }) } });
    await waitFor(() => expect(result.current.session?.id).toBe('s1'));
    rerender({ l: live({ snapshots: 2 }) });
    await waitFor(() => expect(api.getBriefSession).toHaveBeenCalledTimes(2));
  });

  it('a fill tick refetches and then says which fields the agent wrote', async () => {
    const { result, rerender } = renderHook(({ l }) => useBriefSession('acme', l), { initialProps: { l: live() } });
    await waitFor(() => expect(result.current.session?.id).toBe('s1'));
    api.getBriefSession.mockResolvedValueOnce(view({ revision: 5, form: { ...EMPTY_BRIEF_FORM, goal: 'Lancio' }, agentFields: ['goal'] }));
    rerender({ l: live({ briefTicks: { acme: 1 }, briefFills: { acme: { sessionId: 's1', seq: 1, written: ['goal'], reclaimed: [] } } }) });
    await waitFor(() => expect(result.current.lastFill?.seq).toBe(1));
    expect(result.current.lastFill?.written).toEqual(['goal']);
    expect(result.current.session?.form.goal).toBe('Lancio');
  });

  it('saveForm three times within 400 ms sends one PUT with the last value, then takes the merged form', async () => {
    const { result } = renderHook(() => useBriefSession('acme', live()));
    await waitFor(() => expect(result.current.session?.id).toBe('s1'));
    vi.useFakeTimers();
    const body = (goal: string) => () => ({ form: { ...EMPTY_BRIEF_FORM, goal }, userEdited: ['goal' as const], baseRevision: 3 });
    act(() => { result.current.saveForm(body('a')); });
    act(() => { vi.advanceTimersByTime(150); result.current.saveForm(body('ab')); });
    act(() => { vi.advanceTimersByTime(150); result.current.saveForm(body('abc')); });
    expect(api.saveBriefForm).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(api.saveBriefForm).toHaveBeenCalledTimes(1);
    expect(api.saveBriefForm.mock.calls[0]![2]).toEqual({ form: { ...EMPTY_BRIEF_FORM, goal: 'abc' }, userEdited: ['goal'], baseRevision: 3 });
    vi.useRealTimers();
    await waitFor(() => expect(result.current.session?.revision).toBe(4));
    expect(result.current.session?.form.goal).toBe('abc');
  });

  it('discard removes the session', async () => {
    const { result } = renderHook(() => useBriefSession('acme', live()));
    await waitFor(() => expect(result.current.session?.id).toBe('s1'));
    await act(async () => { await result.current.discard(); });
    expect(api.discardBriefSession).toHaveBeenCalledWith('acme', 's1');
    expect(result.current.session).toBeNull();
    expect(result.current.entries).toEqual([]);
  });

  it('an unreadable session is said, and discard removes it whatever the id', async () => {
    api.getBriefSession.mockRejectedValueOnce(new ApiError(422, 'illeggibile', 'brief-session-unreadable'));
    const { result } = renderHook(() => useBriefSession('acme', live()));
    await waitFor(() => expect(result.current.status).toBe('unreadable'));
    await act(async () => { await result.current.discard(); });
    expect(api.discardBriefSession).toHaveBeenCalledWith('acme', 'unreadable');
    expect(result.current.status).toBe('ready');
  });

  it('the job is the latest brief job of this project that belongs to the session', async () => {
    const j = (id: string, key: string, createdAt: string): JobSummary => ({ id, key, kind: 'brief', label: 'l', state: 'running', createdAt });
    api.getBriefSession.mockResolvedValue(view({ jobId: 'b2' }));
    const jobs = { b1: j('b1', 'brief:/w:acme', '2026-10-20T09:00:00.000Z'), b2: j('b2', 'brief:/w:acme', '2026-10-20T09:30:00.000Z'), x: j('x', 'brief:/w:other', '2026-10-20T11:00:00.000Z') };
    const { result } = renderHook(() => useBriefSession('acme', live({ jobs })));
    await waitFor(() => expect(result.current.job?.id).toBe('b2'));
    api.getBriefSession.mockResolvedValue(view());
  });
});

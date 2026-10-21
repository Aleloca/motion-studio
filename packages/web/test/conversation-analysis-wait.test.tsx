import type { ConversationEntry, JobSummary } from '@motion-studio/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventsReducer, initialEventsState, type EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

const at = '2026-10-21T10:00:00.000Z';
const api = {
  analysisWait: vi.fn(async (_s: string, _c: string) => ({ files: ['assets/clip.mp4'] })),
  skipAnalysisWait: vi.fn(async () => undefined),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: at })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { Conversation } = await import('../src/components/Conversation.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { analysisJobTarget, jobHref, jobPlace } = await import('../src/shell/ActivityCenter.tsx');
afterEach(() => vi.clearAllMocks());

const entries: ConversationEntry[] = [
  { type: 'system', at, level: 'info', text: 'Analisi del video in corso (clip.mp4)…', analysisWait: { files: ['clip.mp4'] } },
];
function page(live: EventsState) {
  const shell = { live, route: { name: 'creative', slug: 'acme', creative: 'lancio' }, catalog: { projects: [], creatives: {}, refresh: () => {} } } as never;
  return (
    <I18nProvider locale="it"><ShellContext.Provider value={shell}>
      <Conversation slug="acme" creative="lancio" entries={entries} approvals={[]} job={undefined} />
    </ShellContext.Provider></I18nProvider>
  );
}

describe('the first turn waits for its videos, with Salta (Task 21, decision 1478)', () => {
  it('while it waits: the line with Salta, which skips; when the wait ends the line stays as plain text', async () => {
    const { rerender } = render(page(initialEventsState));
    const skip = await screen.findByRole('button', { name: 'Salta' });
    expect(screen.getByText(/Analisi del video in corso \(clip\.mp4\)…/)).toBeTruthy();
    await userEvent.click(skip);
    expect(api.skipAnalysisWait).toHaveBeenCalledWith('acme', 'lancio');
    const ended = eventsReducer(initialEventsState, { type: 'analysis-wait', project: 'acme', creative: 'lancio', files: [] });
    act(() => rerender(page(ended)));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Salta' })).toBeNull());
    expect(screen.getByText(/Analisi del video in corso \(clip\.mp4\)…/)).toBeTruthy();
  });

  it('no wait known to the core: no Salta', async () => {
    api.analysisWait.mockResolvedValueOnce({ files: [] });
    render(page(initialEventsState));
    await waitFor(() => expect(api.analysisWait).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Salta' })).toBeNull();
  });
});

describe('the activity centre: video analyses', () => {
  it('a video-analysis job belongs to its project; its row opens the library and selects its video', () => {
    const job: JobSummary = { id: 'v1', key: 'video-analysis:/Users/me/Motion Studio:acme:' + 'a'.repeat(64), kind: 'video-analysis', label: 'Analisi video · clip #1.mp4', state: 'running', createdAt: at };
    expect(jobPlace(job)).toEqual({ project: 'acme', creative: null });
    expect(jobHref(job)).toBe('#/p/acme/assets');
    expect(analysisJobTarget(job)).toEqual({ jobId: 'v1', name: 'clip #1.mp4' });
  });
});

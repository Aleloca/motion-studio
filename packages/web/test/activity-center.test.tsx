import type { ConversationEntry, JobSummary } from '@motion-studio/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

const api = { getConversation: vi.fn(async (): Promise<ConversationEntry[]> => []) };
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ActivityCenter, jobHref } = await import('../src/shell/ActivityCenter.tsx');

const at = '2026-10-08T10:00:00.000Z';
const job = (over: Partial<JobSummary> & { id: string }): JobSummary =>
  ({ key: 'creative:/Users/me/Motion Studio:acme:lancio', kind: 'creative', label: 'Creative · Lancio estivo', state: 'succeeded', createdAt: at, finishedAt: at, ...over });
const live = (jobs: JobSummary[], events: EventsState['events'] = {}): EventsState =>
  ({ approvals: {}, jobs: Object.fromEntries(jobs.map((j) => [j.id, j])), events, creativeTicks: {}, projectTicks: {} });
const where = (p: string, c: string | null) => (c ? `${p} · ${c}` : p);
const en = (l: EventsState, tab: 'done' | 'running' = 'done') =>
  render(<I18nProvider locale="en"><ActivityCenter live={l} initialTab={tab} where={where} /></I18nProvider>);
afterEach(() => vi.clearAllMocks());

describe('Activity center · what happened (AC2)', () => {
  it('derives the target of every job from its key (a Windows root with ":" too)', () => {
    expect(jobHref(job({ id: 'a' }))).toBe('#/p/acme/c/lancio');
    expect(jobHref(job({ id: 'b', key: 'creative:C:\\Users\\me\\ws:acme:lancio' }))).toBe('#/p/acme/c/lancio');
    expect(jobHref(job({ id: 'c', key: 'brand:/w:acme', kind: 'brand-analysis' }))).toBe('#/p/acme/brand');
    expect(jobHref(job({ id: 'd', key: 'brand:/w:acme', kind: 'asset-description' }))).toBe('#/p/acme/assets');
    expect(jobHref(job({ id: 'e', key: 'project:/w:acme', kind: 'console' }))).toBe('#/p/acme');
    expect(jobHref(job({ id: 'f', key: 'something-else' }))).toBeNull();
  });

  it('a finished generation says which version it made, from the conversation, and links to the creative', async () => {
    api.getConversation.mockResolvedValue([
      { type: 'user', at, text: 'Make it warmer', pins: [], attachments: [] },
      { type: 'agent', at, jobId: 'j1', event: { kind: 'text', text: 'ok' } },
      { type: 'version', at, n: 1, status: 'complete' },
      { type: 'agent', at, jobId: 'j2', event: { kind: 'text', text: 'ok' } },
      { type: 'version', at, n: 2, status: 'incomplete' },
    ]);
    en(live([job({ id: 'j1', finishedAt: '2026-10-08T10:01:00.000Z' }), job({ id: 'j2', finishedAt: '2026-10-08T10:02:00.000Z' })]));
    expect(await screen.findByText('v1 ready')).toBeTruthy();
    expect(screen.getByText('v2 saved, incomplete')).toBeTruthy();
    expect(api.getConversation).toHaveBeenCalledTimes(1); // one read per creative
    expect(api.getConversation).toHaveBeenCalledWith('acme', 'lancio');
    const rows = within(screen.getByRole('list')).getAllByRole('link');
    expect(rows).toHaveLength(2);
    expect(rows.every((a) => a.getAttribute('href') === '#/p/acme/c/lancio')).toBe(true);
  });

  it('a failure says why (job error, else the result event), and nothing is invented when the outcome is unknown', async () => {
    en(live([
      job({ id: 'f1', state: 'failed', error: 'Render timed out', finishedAt: '2026-10-08T10:03:00.000Z' }),
      job({ id: 'f2', state: 'failed', finishedAt: '2026-10-08T10:02:00.000Z' }),
      job({ id: 's1', key: 'brand:/w:acme', kind: 'brand-analysis', label: 'Brand analysis', finishedAt: '2026-10-08T10:01:00.000Z' }),
    ], { f2: [{ kind: 'result', ok: false, error: 'No outputs were written' }] }));
    const list = screen.getByRole('list');
    expect(within(list).getByText('Failed · Render timed out')).toBeTruthy();
    expect(within(list).getByText('Failed · No outputs were written')).toBeTruthy();
    const brand = within(list).getByText('Brand analysis').closest('a')!;
    expect(brand.getAttribute('href')).toBe('#/p/acme/brand');
    expect(brand.textContent).toContain('Done');
    await waitFor(() => expect(api.getConversation).not.toHaveBeenCalled());
  });

  it('running rows link to where the job runs', () => {
    en(live([job({ id: 'r1', state: 'running', finishedAt: undefined })]), 'running');
    expect(within(screen.getByRole('list')).getByRole('link').getAttribute('href')).toBe('#/p/acme/c/lancio');
  });
});

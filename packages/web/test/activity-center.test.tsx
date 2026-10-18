import type { ConversationEntry, JobSummary } from '@motion-studio/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

const api = { getConversation: vi.fn(async (): Promise<ConversationEntry[]> => []), cancelJob: vi.fn(async (_id: string) => ({ cancelled: true })) };
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ActivityCenter, jobHref, jobPlace } = await import('../src/shell/ActivityCenter.tsx');
const { jobVariantLetter } = await import('../src/screens/variants/variantModel.ts');

const at = '2026-10-08T10:00:00.000Z';
const job = (over: Partial<JobSummary> & { id: string }): JobSummary =>
  ({ key: 'creative:/Users/me/Motion Studio:acme:lancio', kind: 'creative', label: 'Creative · Lancio estivo', state: 'succeeded', createdAt: at, finishedAt: at, ...over });
const live = (jobs: JobSummary[], events: EventsState['events'] = {}): EventsState =>
  ({ approvals: {}, jobs: Object.fromEntries(jobs.map((j) => [j.id, j])), events, creativeTicks: {}, projectTicks: {} });
const where = (p: string, c: string | null) => (c ? `${p} · ${c}` : p);
const en = (l: EventsState, tab: 'done' | 'running' = 'done') =>
  render(<I18nProvider locale="en"><ActivityCenter live={l} initialTab={tab} where={where} /></I18nProvider>);
afterEach(() => vi.clearAllMocks());

describe('Activity center · exports in the background (decision 974, user report 20)', () => {
  const exp = (over: Partial<JobSummary> = {}) => job({ id: 'e1', key: 'export:C:\\Users\\me\\ws:acme:lancio:0a1b2c3d', kind: 'export', label: 'Export · Lancio estivo', state: 'running', ...over });

  it('an export and a render made for one export belong to their creative', () => {
    expect(jobPlace(exp())).toEqual({ project: 'acme', creative: 'lancio' });
    expect(jobHref(job({ id: 'r', key: 'render-export:/w:acme:lancio:v3:0a1b2c3d', kind: 'render' }))).toBe('#/p/acme/c/lancio');
  });

  it('running: its renders\' progress with a bar, then the copy; Cancel cancels the export', async () => {
    const view = en(live([exp({ export: { stage: 'rendering', pct: 40, destination: '/d', renders: ['r1'] } })]), 'running');
    const row = screen.getByText('Export · Lancio estivo').closest('li') as HTMLElement;
    expect(within(row).getByText('Rendering · 40%')).toBeTruthy();
    expect(within(row).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');
    await userEvent.click(within(row).getByRole('button', { name: 'Cancel Export · Lancio estivo' }));
    expect(api.cancelJob).toHaveBeenCalledWith('e1');
    view.unmount();
    en(live([exp({ export: { stage: 'copying', pct: null, destination: '/d', renders: ['r1'] } })]), 'running');
    expect(screen.getByText('Copying the files…')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('done: how many files, and where (the bell keeps it)', () => {
    en(live([exp({ state: 'succeeded', finishedAt: at, export: { stage: 'done', pct: 100, destination: '/Users/me/Desktop', files: ['/Users/me/Desktop/a.mp4', '/Users/me/Desktop/b.mp4'] } })]));
    expect(screen.getByText('2 files in /Users/me/Desktop')).toBeTruthy();
  });
});

describe('Activity center · what happened (AC2)', () => {
  it('derives the target of every job from its key (a Windows root with ":" too)', () => {
    expect(jobHref(job({ id: 'a' }))).toBe('#/p/acme/c/lancio');
    expect(jobHref(job({ id: 'b', key: 'creative:C:\\Users\\me\\ws:acme:lancio' }))).toBe('#/p/acme/c/lancio');
    expect(jobHref(job({ id: 'c', key: 'brand:/w:acme', kind: 'brand-analysis' }))).toBe('#/p/acme/brand');
    expect(jobHref(job({ id: 'd', key: 'brand:/w:acme', kind: 'asset-description' }))).toBe('#/p/acme/assets');
    expect(jobHref(job({ id: 'e', key: 'project:/w:acme', kind: 'console' }))).toBe('#/p/acme');
    expect(jobHref(job({ id: 'g', key: 'render:C:\\Users\\me\\ws:acme:lancio:v3', kind: 'render' }))).toBe('#/p/acme/c/lancio');
    // A follow-up render job of the same version (core I3) belongs to the same creative.
    expect(jobHref(job({ id: 'h', key: 'render:C:\\Users\\me\\ws:acme:lancio:v3:2', kind: 'render' }))).toBe('#/p/acme/c/lancio');
    expect(jobHref(job({ id: 'f', key: 'something-else' }))).toBeNull();
    // Phase 15 (final wave M1): the variant directions turn of a group links to its host.
    expect(jobHref(job({ id: 'i', key: 'variant-directions:creative:/w:acme:lancio', kind: 'variant-directions' as never }))).toBe('#/p/acme/c/lancio');
    expect(jobPlace(job({ id: 'j', key: 'variant-directions:creative:C:\\Users\\me\\ws:acme:lancio' }))).toEqual({ project: 'acme', creative: 'lancio' });
    // …and carries the host's variant tag (A) when the project lists the creative as a group.
    const summaries = [{ slug: 'lancio', variants: { count: 3, active: 3, missing: [] } }] as unknown as Parameters<typeof jobVariantLetter>[1];
    expect(jobVariantLetter(jobPlace(job({ id: 'k', key: 'variant-directions:creative:/w:acme:lancio' }))!.creative, summaries)).toBe('a');
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


describe('Activity center · render lane (Task 8)', () => {
  const render1 = (over: Partial<JobSummary> & { id: string }) => job({ key: 'render:/w:acme:lancio:v3', kind: 'render', label: 'Render · Lancio estivo v3', state: 'running', finishedAt: undefined, ...over });

  it('queued renders say how many renders are ahead; the running one its frames done out of the total, with a bar', () => {
    en(live([
      render1({ id: 'r1', createdAt: '2026-10-08T10:00:00.000Z', formats: ['tiktok-9x16'], progress: { format: 'tiktok-9x16', phase: 'frames', done: 1200, total: 2400 } }),
      render1({ id: 'r2', state: 'queued', createdAt: '2026-10-08T10:01:00.000Z', queuePosition: 1 }),
      render1({ id: 'r3', state: 'queued', createdAt: '2026-10-08T10:02:00.000Z', queuePosition: 2 }),
    ]), 'running');
    const list = screen.getByRole('list');
    expect(within(list).getByText('Video 9:16 · 1,200 / 2,400 frames')).toBeTruthy();
    expect(within(list).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    expect(within(list).getByText('Queued · 1 render ahead')).toBeTruthy();
    expect(within(list).getByText('Queued · 2 renders ahead')).toBeTruthy();
  });

  it('a localized render shows its progress with the format and the language named (Q6)', () => {
    en(live([render1({ id: 'r1', formats: ['tiktok-9x16.de'], progress: { format: 'tiktok-9x16.de', phase: 'frames', done: 1200, total: 2400 } })]), 'running');
    const list = screen.getByRole('list');
    expect(within(list).getByText('Video 9:16 (German) · 1,200 / 2,400 frames')).toBeTruthy();
    expect(within(list).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
  });

  it('preparing media and finishing are said as such', () => {
    en(live([
      render1({ id: 'r1', progress: { format: 'tiktok-9x16', phase: 'media', done: 1, total: 3 } }),
      render1({ id: 'r2', createdAt: '2026-10-08T10:05:00.000Z', progress: { format: 'instagram-post-1x1', phase: 'finishing', done: 0, total: 0 } }),
    ]), 'running');
    expect(screen.getByText('Video 9:16 · preparing media 1/3')).toBeTruthy();
    expect(screen.getByText('Post 1:1 · finishing')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('Cancel cancels that render (queued or running); the row still links to the creative', async () => {
    en(live([render1({ id: 'r1' }), render1({ id: 'r2', state: 'queued', createdAt: '2026-10-08T10:01:00.000Z', queuePosition: 1 })]), 'running');
    const rows = within(screen.getByRole('list')).getAllByRole('link');
    expect(rows.every((a) => a.getAttribute('href') === '#/p/acme/c/lancio')).toBe(true);
    const cancels = screen.getAllByRole('button', { name: 'Cancel Render · Lancio estivo v3' });
    expect(cancels).toHaveLength(2);
    // Not inside the link (a button in a link is not a valid control).
    expect(cancels[0]!.closest('a')).toBeNull();
    await userEvent.click(cancels[1]!);
    expect(api.cancelJob).toHaveBeenCalledWith('r2');
  });
});

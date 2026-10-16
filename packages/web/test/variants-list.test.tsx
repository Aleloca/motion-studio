/**
 * Phase 15, Task 5: the creatives list shows one row per group with "N varianti" (the sisters are not listed on their own), says
 * "mancante" for a member whose folder is gone (Review Focus 5), speaks for all the variants' work, and starts a draft group as
 * a group. The Activity center names the variant of a job.
 */
import { DEFAULT_FORMATS, type ApprovalRequest, type CreativeListItem, type JobSummary } from '@motion-studio/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

const api = {
  listCreatives: vi.fn(),
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(),
  getConversation: vi.fn(async () => []),
  sendCreativeTurn: vi.fn(async (..._a: unknown[]) => ({ id: 'j' })),
  runVariants: vi.fn(async (..._a: unknown[]) => ({ jobs: {}, queued: [], skipped: [], failed: {} })),
  fileUrl: (s: string, c: string, rel: string) => `/files/${s}/${c}/${rel}`,
  cancelJob: vi.fn(),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ProjectCreatives } = await import('../src/screens/ProjectCreatives.tsx');
const { ActivityCenter } = await import('../src/shell/ActivityCenter.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');

const at = '2026-10-08T10:00:00.000Z';
const item = (slug: string, title: string, status: string, over: Record<string, unknown> = {}): CreativeListItem =>
  ({ ok: true, slug, title, status, formats: ['instagram-reel-9x16'], versions: 1, updatedAt: at, cover: `outputs/v1/${slug}.png`, ...over }) as CreativeListItem;
const live = (over: Partial<EventsState> = {}): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {}, ...over });
const en = (node: React.ReactNode, locale: 'en' | 'it' = 'en') => render(<I18nProvider locale={locale}>{node}</I18nProvider>);
const cards = () => screen.getAllByRole('article');
const card = (title: string) => cards().find((c) => within(c).queryByText(title))!;

beforeEach(() => { history.replaceState(null, '', '/#/p/acme'); });
afterEach(() => { vi.clearAllMocks(); history.replaceState(null, '', '/'); });

describe('the list of a project with a variant group', () => {
  it('one card per group, with the number of variants; an ordinary creative has none', async () => {
    api.listCreatives.mockResolvedValue([
      item('lancio', 'Lancio estivo', 'ready', { variants: { count: 3, active: 3, missing: [] } }),
      item('single', 'Una sola', 'ready'),
    ]);
    en(<ProjectCreatives slug="acme" live={live()} />);
    await screen.findByText('Lancio estivo');
    expect(cards()).toHaveLength(2);
    expect(within(card('Lancio estivo')).getByText('3 variants')).toBeTruthy();
    expect(within(card('Una sola')).queryByText(/variant/)).toBeNull();
  });

  it('in Italian it says "3 varianti"', async () => {
    api.listCreatives.mockResolvedValue([item('lancio', 'Lancio estivo', 'ready', { variants: { count: 3, active: 2, missing: [] } })]);
    en(<ProjectCreatives slug="acme" live={live()} />, 'it');
    await screen.findByText('Lancio estivo');
    expect(within(card('Lancio estivo')).getByText('3 varianti')).toBeTruthy();
  });

  it('Review Focus 5: a member whose folder is missing is listed as "mancante", and the row still renders', async () => {
    api.listCreatives.mockResolvedValue([item('lancio', 'Lancio estivo', 'ready', { variants: { count: 3, active: 3, missing: ['c', 'e'] } })]);
    en(<ProjectCreatives slug="acme" live={live()} />, 'it');
    await screen.findByText('Lancio estivo');
    expect(within(card('Lancio estivo')).getByText('mancante: C, E')).toBeTruthy();
  });

  it('a group speaks for the work of its variants: a job on a sister is "In progress", an approval of one "Needs you"', async () => {
    api.listCreatives.mockResolvedValue([
      item('lancio', 'Lancio estivo', 'ready', { variants: { count: 3, active: 3, missing: [] } }),
      item('altro', 'Altro gruppo', 'ready', { variants: { count: 2, active: 2, missing: [] } }),
    ]);
    const sisterJob: JobSummary = { id: 'j1', key: 'creative:/w:acme:lancio~c', kind: 'creative', label: 'Lancio', state: 'running', createdAt: at };
    const sisterApproval = { id: 'a1', jobId: 'j2', projectSlug: 'acme', creativeSlug: 'altro~b', kind: 'tool', title: 'Run it?', detail: '', toolName: 'Bash', alwaysRule: null, explanation: null, agentReason: null, createdAt: at, expiresAt: '2026-10-08T10:05:00.000Z' } as ApprovalRequest;
    en(<ProjectCreatives slug="acme" live={live({ jobs: { j1: sisterJob }, approvals: { a1: sisterApproval } })} />);
    await screen.findByText('Lancio estivo');
    const group = screen.getByRole('radiogroup', { name: 'Filter creatives' });
    const count = (name: RegExp) => within(group).getByRole('radio', { name }).querySelector('.ms-n')?.textContent;
    expect(count(/^In progress/)).toBe('1');
    expect(count(/^Needs you/)).toBe('1');
    expect(count(/^Ready/)).toBe('0');
  });

  it('a group that never started "Generate" starts every variant, not the host alone', async () => {
    api.listCreatives.mockResolvedValue([item('lancio', 'Lancio estivo', 'draft', { versions: 0, cover: null, variants: { count: 3, active: 3, missing: [] } })]);
    en(<ProjectCreatives slug="acme" live={live()} />);
    await screen.findByText('Lancio estivo');
    await userEvent.click(within(card('Lancio estivo')).getByRole('button', { name: /Generate/ }));
    await waitFor(() => expect(api.runVariants).toHaveBeenCalledWith('acme', 'lancio', { targets: 'all-active', request: null }));
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
  });
});

describe('Activity center · the variant of a job', () => {
  const job = (id: string, creative: string, over: Partial<JobSummary> = {}): JobSummary =>
    ({ id, key: `creative:/w:acme:${creative}`, kind: 'creative', label: 'Creative · Lancio estivo', state: 'running', createdAt: at, ...over });
  const summaries = { acme: [{ slug: 'lancio', title: 'Lancio estivo', status: 'ready', formats: [], versions: 1, updatedAt: at, cover: null, variants: { count: 2, active: 2, missing: [] } }] };
  const shell = { catalog: { projects: [], creatives: summaries, refresh: () => {} } } as never;
  const mount = (jobs: JobSummary[], locale: 'en' | 'it' = 'en') => render(
    <I18nProvider locale={locale}><ShellContext.Provider value={shell}>
      <ActivityCenter live={live({ jobs: Object.fromEntries(jobs.map((j) => [j.id, j])) })} initialTab="running" where={(p, c) => (c ? `${p} · ${c}` : p)} />
    </ShellContext.Provider></I18nProvider>,
  );

  it('shows the letter of each variant\'s work, and why a queued one waits', () => {
    mount([job('a', 'lancio'), job('b', 'lancio~b'), job('c', 'lancio~c', { state: 'queued', waitReason: 'variant-slot' })]);
    expect(screen.getByText('Creative · Lancio estivo · A')).toBeTruthy();
    expect(screen.getByText('Creative · Lancio estivo · B')).toBeTruthy();
    expect(screen.getByText('Creative · Lancio estivo · C')).toBeTruthy();
    expect(screen.getByText('queued: two variants already working')).toBeTruthy();
  });

  it('a creative outside any group has no letter', () => {
    mount([job('x', 'other')]);
    expect(screen.getByText('Creative · Lancio estivo')).toBeTruthy();
    expect(screen.queryByText(/ · [A-E]$/)).toBeNull();
  });
});

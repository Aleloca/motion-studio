import { DEFAULT_FORMATS, type ApprovalRequest, type CreativeListItem, type JobSummary } from '@motion-studio/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

const api = {
  listCreatives: vi.fn(),
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(),
  sendCreativeTurn: vi.fn(),
  fileUrl: (s: string, c: string, rel: string) => `/files/${s}/${c}/${rel}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ProjectCreatives } = await import('../src/screens/ProjectCreatives.tsx');

const at = '2026-10-08T10:00:00.000Z';
const item = (slug: string, title: string, status: string, over: Record<string, unknown> = {}): CreativeListItem =>
  ({ ok: true, slug, title, status, formats: ['instagram-reel-9x16'], versions: 1, updatedAt: at, cover: `outputs/v1/${slug}.png`, ...over }) as CreativeListItem;

const LIST: CreativeListItem[] = [
  item('crime', 'A crime a week', 'ready', { formats: ['instagram-reel-9x16', 'instagram-post-1x1'], versions: 5 }),
  item('teaser', 'Case 092 teaser', 'working'),
  item('weekly', 'Weekly case post', 'ready', { formats: ['instagram-image-1x1'] }),
  item('partial', 'Partial post', 'incomplete'),
  item('loop', 'Calder at night loop', 'error', { formats: ['tiktok-9x16'] }),
  item('shots', 'App Store screenshots', 'draft', { versions: 0, cover: null, formats: ['instagram-reel-9x16', 'instagram-post-1x1'] }),
];

const approval: ApprovalRequest = {
  id: 'a1', jobId: 'j1', projectSlug: 'acme', creativeSlug: 'crime', kind: 'tool', title: 'Render the reel again?', detail: 'ffmpeg …',
  toolName: 'Bash', alwaysRule: null, createdAt: at, expiresAt: '2026-10-08T10:05:00.000Z',
};
const runningJob: JobSummary = { id: 'j2', key: 'creative:/w:acme:teaser', kind: 'creative', label: 'Teaser', state: 'running', createdAt: at };
const live = (over: Partial<EventsState> = {}): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {}, ...over });
const busyLive = () => live({
  approvals: { a1: approval },
  jobs: { j2: runningJob },
  events: { j2: [{ kind: 'progress', text: 'Rendering 210 frames' }, { kind: 'text', text: 'ok' }] },
});

const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);
const radio = (name: RegExp) => screen.getByRole('radio', { name });
const cards = () => screen.getAllByRole('article');
const card = (title: string) => cards().find((c) => within(c).queryByText(title))!;

beforeEach(() => { history.replaceState(null, '', '/#/p/acme'); });
afterEach(() => { vi.clearAllMocks(); history.replaceState(null, '', '/'); });

describe('ProjectCreatives filters', () => {
  it('counts every state and filters by segment and search', async () => {
    api.listCreatives.mockResolvedValue(LIST);
    en(<ProjectCreatives slug="acme" live={busyLive()} />);
    await screen.findByText('A crime a week');
    const group = screen.getByRole('radiogroup', { name: 'Filter creatives' });
    const count = (name: RegExp) => within(group).getByRole('radio', { name }).querySelector('.ms-n')?.textContent;
    expect(count(/^All/)).toBe('6');
    expect(count(/^Needs you/)).toBe('1');
    expect(count(/^In progress/)).toBe('1');
    // Ready includes the incomplete one (it has a version); the ready one waiting for an approval is under Needs you.
    expect(count(/^Ready/)).toBe('2');
    expect(count(/^Drafts/)).toBe('1');
    // The pending approval count is the accent badge.
    expect(within(group).getByRole('radio', { name: /^Needs you/ }).querySelector('.ms-n.ms-accent')).toBeTruthy();

    await userEvent.click(radio(/^Drafts/));
    expect(cards().map((c) => c.querySelector('h3')?.textContent)).toEqual(['App Store screenshots']);
    await userEvent.click(radio(/^In progress/));
    expect(cards().map((c) => c.querySelector('h3')?.textContent)).toEqual(['Case 092 teaser']);
    await userEvent.click(radio(/^Needs you/));
    expect(cards().map((c) => c.querySelector('h3')?.textContent)).toEqual(['A crime a week']);

    await userEvent.click(radio(/^All/));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search creatives' }), 'case');
    expect(cards().map((c) => c.querySelector('h3')?.textContent)).toEqual(['Case 092 teaser', 'Weekly case post']);
  });

  it('explains an empty filter and shows everything again', async () => {
    api.listCreatives.mockResolvedValue([item('weekly', 'Weekly case post', 'ready')]);
    en(<ProjectCreatives slug="acme" live={live()} />);
    await screen.findByText('Weekly case post');
    await userEvent.click(radio(/^Drafts/));
    expect(screen.getByText('Nothing here')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByText('Weekly case post')).toBeTruthy();
    expect(radio(/^All/).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps an unreadable creative visible under every filter', async () => {
    api.listCreatives.mockResolvedValue([...LIST, { ok: false, slug: 'broken', error: 'creative.json: invalid JSON' }]);
    en(<ProjectCreatives slug="acme" live={live()} />);
    await screen.findByText('A crime a week');
    await userEvent.click(radio(/^Drafts/));
    expect(screen.getByText(/invalid JSON/)).toBeTruthy();
  });
});

describe('ProjectCreatives cards', () => {
  it('outlines a card waiting for an approval and offers Review', async () => {
    api.listCreatives.mockResolvedValue(LIST);
    en(<ProjectCreatives slug="acme" live={busyLive()} />);
    await screen.findByText('A crime a week');
    const crime = card('A crime a week');
    expect(crime.className).toContain('ms-needs');
    expect(within(crime).getByText('Render the reel again?')).toBeTruthy();
    expect(card('Weekly case post').className).not.toContain('ms-needs');
    await userEvent.click(within(crime).getByRole('button', { name: 'Review' }));
    expect(location.hash).toBe('#/p/acme/c/crime');
  });

  it('shows the running step without an invented percentage', async () => {
    api.listCreatives.mockResolvedValue(LIST);
    en(<ProjectCreatives slug="acme" live={busyLive()} />);
    await screen.findByText('Case 092 teaser');
    const teaser = card('Case 092 teaser');
    expect(within(teaser).getByText('Rendering 210 frames')).toBeTruthy();
    expect(teaser.textContent).not.toMatch(/\d+\s*%/);
    // An indeterminate bar: no value is claimed.
    expect(within(teaser).getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
  });

  it('explains a failed creative and tries again with the core retry turn', async () => {
    api.listCreatives.mockResolvedValue(LIST);
    api.getCreative.mockResolvedValue({ slug: 'loop', jobKey: 'k', versions: [], creative: { title: 'Calder at night loop', status: 'error', error: 'The video came out 9 s long; TikTok expects 7 s' } });
    api.sendCreativeTurn.mockResolvedValue({ ...runningJob, id: 'j9', key: 'creative:/w:acme:loop' });
    en(<ProjectCreatives slug="acme" live={live()} />);
    const loop = await waitFor(() => {
      const c = card('Calder at night loop');
      within(c).getByText('The video came out 9 s long; TikTok expects 7 s');
      return c;
    });
    expect(api.getCreative).toHaveBeenCalledWith('acme', 'loop');
    await userEvent.click(within(loop).getByRole('button', { name: 'Try again' }));
    // An empty turn: the core resumes with its own retry wording (the brief, or "Regenerate all formats…").
    expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'loop', {});
  });

  it('generates a draft with the accent Generate and opens it', async () => {
    api.listCreatives.mockResolvedValue(LIST);
    api.sendCreativeTurn.mockResolvedValue({ ...runningJob, id: 'j9', key: 'creative:/w:acme:shots' });
    en(<ProjectCreatives slug="acme" live={live()} />);
    await screen.findByText('App Store screenshots');
    const shots = card('App Store screenshots');
    expect(within(shots).getByText('Brief saved · nothing generated yet')).toBeTruthy();
    const generate = within(shots).getByRole('button', { name: /Generate/ });
    expect(generate.className).toContain('ms-accent');
    await userEvent.click(generate);
    expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'shots', {});
    await waitFor(() => expect(location.hash).toBe('#/p/acme/c/shots'));
  });

  it('draws the format previews in proportion from the catalog', async () => {
    api.listCreatives.mockResolvedValue(LIST);
    en(<ProjectCreatives slug="acme" live={live()} />);
    await screen.findByText('App Store screenshots');
    // The catalog arrives after the list: wait for the proportions.
    const frames = await waitFor(() => {
      const f = [...card('App Store screenshots').querySelectorAll<HTMLElement>('.ms-frame')];
      expect(f).toHaveLength(2);
      expect(f[1]!.style.width).toBe(f[1]!.style.height);
      return f;
    });
    const ratio = (el: HTMLElement) => parseFloat(el.style.width) / parseFloat(el.style.height);
    expect(ratio(frames[0]!)).toBeCloseTo(1080 / 1920, 2);
    expect(ratio(frames[1]!)).toBeCloseTo(1, 2);
    // Formats as tags with the channel mark.
    expect(within(card('App Store screenshots')).getByText('Story/Reel 9:16')).toBeTruthy();
  });

  it('links each card to its creative', async () => {
    api.listCreatives.mockResolvedValue(LIST);
    en(<ProjectCreatives slug="acme" live={live()} />);
    await screen.findByText('Weekly case post');
    expect(screen.getByRole('link', { name: 'Weekly case post' }).getAttribute('href')).toBe('#/p/acme/c/weekly');
  });
});

describe('ProjectCreatives empty project', () => {
  it('shows the designed empty state with the brand and new creative actions', async () => {
    api.listCreatives.mockResolvedValue([]);
    en(<ProjectCreatives slug="acme" live={live()} />);
    expect(await screen.findByText('No creatives yet')).toBeTruthy();
    // No filters over nothing.
    expect(screen.queryByRole('radiogroup')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Set up the brand' }));
    expect(location.hash).toBe('#/p/acme/brand');
    await userEvent.click(screen.getByRole('button', { name: 'New creative' }));
    expect(location.hash).toBe('#/p/acme/new');
  });

  it('explains a load failure with a way to retry', async () => {
    api.listCreatives.mockRejectedValueOnce(new Error('server down')).mockResolvedValue([]);
    en(<ProjectCreatives slug="acme" live={live()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('server down');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No creatives yet')).toBeTruthy();
  });

  it('reloads when a creative of the project changes', async () => {
    api.listCreatives.mockResolvedValue([]);
    const { rerender } = en(<ProjectCreatives slug="acme" live={live()} />);
    await screen.findByText('No creatives yet');
    api.listCreatives.mockResolvedValue([item('new', 'Fresh one', 'draft', { versions: 0, cover: null })]);
    await act(async () => {
      rerender(<I18nProvider locale="en"><ProjectCreatives slug="acme" live={live({ creativeTicks: { 'acme/new': 1 } })} /></I18nProvider>);
    });
    expect(await screen.findByText('Fresh one')).toBeTruthy();
  });
});

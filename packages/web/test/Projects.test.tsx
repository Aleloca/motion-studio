import { DEFAULT_FORMATS, EMPTY_BRAND_KIT, type ApprovalRequest, type JobSummary, type ProjectListItem, type RecentCreative } from '@motion-studio/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { requestNewProject } from '../src/shell/intents.ts';

const api = {
  listProjects: vi.fn(),
  createProject: vi.fn(),
  recentCreatives: vi.fn(),
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  listCreatives: vi.fn(async () => []),
  getBrand: vi.fn(),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })),
  fileUrl: (s: string, c: string, rel: string) => `/files/${s}/${c}/${rel}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { Projects, hex6, luminance } = await import('../src/screens/Projects.tsx');

const at = '2026-10-08T10:00:00.000Z';
const project = (slug: string, name: string, updatedAt = at): ProjectListItem =>
  ({ slug, ok: true, project: { schemaVersion: 1, name, description: '', createdAt: at, updatedAt, linkedCodebases: [] } });
const recent = (slug: string, title: string, status: string, over: Partial<RecentCreative> = {}): RecentCreative =>
  ({ slug, title, status, formats: ['instagram-reel-9x16'], versions: 1, updatedAt: at, cover: `outputs/v1/${slug}.png`, project: { slug: 'hs', name: 'Half Story' }, ...over }) as RecentCreative;
const brand = (colors: string[]) => ({
  kit: { ...EMPTY_BRAND_KIT, colors: colors.map((hex, i) => ({ id: `c${i}`, name: `C${i}`, hex, role: 'other', source: { kind: 'manual' } })) },
  kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'brand:k',
});
const live = (over: Partial<EventsState> = {}): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {}, ...over });
const approval: ApprovalRequest = {
  id: 'a1', jobId: 'j1', projectSlug: 'hs', creativeSlug: 'crime', kind: 'tool', title: 'Render?', detail: 'x', toolName: 'Bash',
  alwaysRule: null, createdAt: at, expiresAt: '2026-10-08T10:05:00.000Z',
};
const job: JobSummary = { id: 'j2', key: 'creative:/w:hs:teaser', kind: 'creative', label: 'Teaser', state: 'running', createdAt: at };

const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);

beforeEach(() => {
  api.listCreatives.mockResolvedValue([]);
  api.getBrand.mockResolvedValue(brand([]));
  api.recentCreatives.mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

describe('Projects · Jump back in', () => {
  it('a video cover plays on hover in Jump back in, from the video behind the poster (point 31)', async () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(async () => {}) });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() });
    api.listProjects.mockResolvedValue([project('hs', 'Half Story')]);
    api.recentCreatives.mockResolvedValue([recent('reel', 'Autumn reel', 'ready', { cover: 'outputs/v2/.previews/reel.mp4.jpg' })]);
    en(<Projects live={live()} />);
    const section = await screen.findByRole('region', { name: 'Jump back in' });
    const tile = (await within(section).findByText('Autumn reel')).closest('a')!;
    expect(tile.querySelector('video')).toBeNull();
    fireEvent.pointerEnter(tile);
    expect(tile.querySelector('video')!.getAttribute('src')).toBe('/files/hs/reel/outputs/v2/reel.mp4');
    fireEvent.pointerLeave(tile);
    expect(tile.querySelector('video')).toBeNull();
  });

  it('shows the three latest creatives with their state', async () => {
    api.listProjects.mockResolvedValue([project('hs', 'Half Story')]);
    api.recentCreatives.mockResolvedValue([
      recent('crime', 'A crime a week', 'ready'),
      recent('teaser', 'Case 092 teaser', 'working'),
      recent('weekly', 'Weekly case post', 'ready', { formats: ['instagram-image-1x1', 'linkedin-post-1x1'] }),
    ]);
    en(<Projects live={live({ approvals: { a1: approval }, jobs: { j2: job }, events: { j2: [{ kind: 'progress', text: 'Rendering 210 frames' }] } })} />);
    const section = await screen.findByRole('region', { name: 'Jump back in' });
    await within(section).findByText('A crime a week');
    expect(api.recentCreatives).toHaveBeenCalledWith(3);
    const tile = (title: string) => within(section).getByText(title).closest('a')!;
    expect(tile('A crime a week').textContent).toContain('Waiting for your OK');
    expect(tile('Case 092 teaser').textContent).toContain('Rendering 210 frames');
    expect(tile('Case 092 teaser').textContent).not.toMatch(/\d+\s*%/);
    expect(tile('Weekly case post').textContent).toContain('Ready');
    expect(tile('Weekly case post').textContent).toContain('Half Story · 2 formats');
    expect(tile('A crime a week').getAttribute('href')).toBe('#/p/hs/c/crime');
    // The quick way to a new brief in the latest project.
    expect(within(section).getByRole('link', { name: 'New creative in Half Story' }).getAttribute('href')).toBe('#/p/hs/new');
  });

  it('hides the section when there is nothing recent', async () => {
    api.listProjects.mockResolvedValue([project('hs', 'Half Story')]);
    en(<Projects live={live()} />);
    await screen.findByText('Half Story', { selector: '.ms-pcard-name' });
    await waitFor(() => expect(api.recentCreatives).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Jump back in' })).toBeNull();
  });
});

describe('Projects · cards', () => {
  it('covers a project with its latest creatives and the brand palette strip', async () => {
    api.listProjects.mockResolvedValue([project('hs', 'Half Story')]);
    api.listCreatives.mockResolvedValue([
      { ok: true, slug: 'old', title: 'Old', status: 'ready', formats: [], versions: 1, updatedAt: '2026-10-01T10:00:00.000Z', cover: 'outputs/v1/old.png' },
      { ok: true, slug: 'new', title: 'New', status: 'ready', formats: [], versions: 2, updatedAt: '2026-10-08T09:00:00.000Z', cover: 'outputs/v2/new.png' },
      { ok: true, slug: 'draft', title: 'Draft', status: 'draft', formats: [], versions: 0, updatedAt: '2026-10-08T09:30:00.000Z', cover: null },
    ] as never);
    api.getBrand.mockResolvedValue(brand(['#1B1913', '#856E51', '#FBE8C3']));
    en(<Projects live={live({ approvals: { a1: approval } })} />);
    const card = (await screen.findByText('Half Story', { selector: '.ms-pcard-name' })).closest('a')!;
    await waitFor(() => expect(card.querySelectorAll('.ms-pcover img')).toHaveLength(2));
    // Latest first.
    expect([...card.querySelectorAll<HTMLImageElement>('.ms-pcover img')].map((i) => i.getAttribute('src'))).toEqual([
      '/files/hs/new/outputs/v2/new.png', '/files/hs/old/outputs/v1/old.png',
    ]);
    await waitFor(() => expect(card.querySelectorAll('.ms-pstrip span')).toHaveLength(3));
    expect((card.querySelector('.ms-pstrip span') as HTMLElement).style.background).toBe('rgb(27, 25, 19)');
    expect(card.getAttribute('href')).toBe('#/p/hs');
    expect(within(card).getByText('1 approval waiting')).toBeTruthy();
    await waitFor(() => expect(card.textContent).toContain('3 creatives'));
  });

  it('falls back to the project name without covers or palette', async () => {
    api.listProjects.mockResolvedValue([project('nw', 'Northwind Coffee')]);
    en(<Projects live={live()} />);
    const card = (await screen.findByText('Northwind Coffee', { selector: '.ms-pcard-name' })).closest('a')!;
    await waitFor(() => expect(card.querySelector('.ms-pcover-word')?.textContent).toBe('Northwind Coffee'));
    expect(card.querySelector('.ms-pcover img')).toBeNull();
    expect(card.querySelector('.ms-pstrip')).toBeNull();
  });

  it('shows an unreadable project with its error', async () => {
    api.listProjects.mockResolvedValue([{ slug: 'broken', ok: false, error: 'project.json: invalid JSON' }]);
    en(<Projects live={live()} />);
    expect(await screen.findByText(/invalid JSON/)).toBeTruthy();
    expect(screen.getByText('Unreadable')).toBeTruthy();
  });

  it('explains a load failure with a way to retry', async () => {
    api.listProjects.mockRejectedValueOnce(new Error('server down')).mockResolvedValue([project('hs', 'Half Story')]);
    en(<Projects live={live()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('server down');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Half Story', { selector: '.ms-pcard-name' })).toBeTruthy();
  });
});

describe('Projects · card data', () => {
  const covered = (slug: string) => [{ ok: true, slug, title: slug, status: 'ready', formats: [], versions: 1, updatedAt: at, cover: `outputs/v1/${slug}.png` }];

  it('drops a stale creatives response that arrives after a newer one', async () => {
    api.listProjects.mockResolvedValue([project('hs', 'Half Story')]);
    let resolveOld!: (v: unknown) => void;
    api.listCreatives
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }) as never)
      .mockImplementationOnce(async () => covered('newer') as never);
    const { rerender } = en(<Projects live={live()} />);
    const card = (await screen.findByText('Half Story', { selector: '.ms-pcard-name' })).closest('a')!;
    rerender(<I18nProvider locale="en"><Projects live={live({ creativeTicks: { 'hs/newer': 1 } })} /></I18nProvider>);
    await waitFor(() => expect(card.querySelector('.ms-pcover img')?.getAttribute('src')).toBe('/files/hs/newer/outputs/v1/newer.png'));
    await act(async () => { resolveOld(covered('older')); });
    expect([...card.querySelectorAll('.ms-pcover img')].map((i) => i.getAttribute('src'))).toEqual(['/files/hs/newer/outputs/v1/newer.png']);
  });

  it('reloads the brand on project ticks only, and keeps the name fallback while a reload is pending', async () => {
    api.listProjects.mockResolvedValue([project('nw', 'Northwind Coffee')]);
    const { rerender } = en(<Projects live={live()} />);
    const card = (await screen.findByText('Northwind Coffee', { selector: '.ms-pcard-name' })).closest('a')!;
    await waitFor(() => expect(card.querySelector('.ms-pcover-word')).toBeTruthy());
    expect(api.getBrand).toHaveBeenCalledTimes(1);
    // A creative change reloads the creatives only (and that round never answers).
    api.listCreatives.mockImplementation(() => new Promise(() => {}) as never);
    rerender(<I18nProvider locale="en"><Projects live={live({ creativeTicks: { 'nw/x': 1 } })} /></I18nProvider>);
    await waitFor(() => expect(api.listCreatives).toHaveBeenCalledTimes(2));
    expect(api.getBrand).toHaveBeenCalledTimes(1);
    expect(api.listAssets).toHaveBeenCalledTimes(1);
    expect(card.querySelector('.ms-pcover-word')?.textContent).toBe('Northwind Coffee');
    rerender(<I18nProvider locale="en"><Projects live={live({ creativeTicks: { 'nw/x': 1 }, projectTicks: { nw: 1 } })} /></I18nProvider>);
    await waitFor(() => expect(api.getBrand).toHaveBeenCalledTimes(2));
    expect(api.listAssets).toHaveBeenCalledTimes(2);
    expect(api.listCreatives).toHaveBeenCalledTimes(2);
  });

  it('sorts Last edited by the latest activity the card shows (project or creatives)', async () => {
    api.listProjects.mockResolvedValue([project('new', 'Newer project', '2026-10-08T09:00:00.000Z'), project('old', 'Older project', '2026-10-01T09:00:00.000Z')]);
    api.listCreatives.mockImplementation((async (slug: string) => (slug === 'old'
      ? [{ ok: true, slug: 'c', title: 'C', status: 'ready', formats: [], versions: 1, updatedAt: '2026-10-08T11:00:00.000Z', cover: null }]
      : [])) as never);
    en(<Projects live={live()} />);
    const names = () => [...document.querySelectorAll('.ms-pcard-name')].map((n) => n.textContent);
    await waitFor(() => expect(names()).toEqual(['Older project', 'Newer project']));
  });

  it('the order never jumps while cards load: it changes once, when every card has settled (D6)', async () => {
    api.listProjects.mockResolvedValue([
      project('a', 'Alpha', '2026-10-08T09:00:00.000Z'), project('b', 'Bravo', '2026-10-01T09:00:00.000Z'), project('c', 'Charlie', '2026-10-02T09:00:00.000Z'),
    ]);
    const gates: Record<string, () => void> = {};
    const made = (updatedAt: string) => [{ ok: true, slug: 'x', title: 'X', status: 'ready', formats: [], versions: 1, updatedAt, cover: null }];
    const latest: Record<string, string | null> = { a: null, b: '2026-10-08T11:00:00.000Z', c: '2026-10-08T10:00:00.000Z' };
    api.listCreatives.mockImplementation(((slug: string) => new Promise((r) => { gates[slug] = () => r(latest[slug] ? made(latest[slug]!) : []); })) as never);
    en(<Projects live={live()} />);
    const names = () => [...document.querySelectorAll('.ms-pcard-name')].map((n) => n.textContent).join(',');
    await waitFor(() => expect(names()).toBe('Alpha,Charlie,Bravo'));
    await waitFor(() => expect(Object.keys(gates)).toHaveLength(3));
    // Charlie settles first with a creative edited at 10:00: it must not jump ahead while the others load.
    await act(async () => { gates.c!(); });
    await act(async () => { gates.a!(); });
    expect(names()).toBe('Alpha,Charlie,Bravo');
    await act(async () => { gates.b!(); });
    await waitFor(() => expect(names()).toBe('Bravo,Charlie,Alpha'));
  });

  it('uses Jump back in to place recently edited projects first before the cards load (D6)', async () => {
    api.listProjects.mockResolvedValue([project('new', 'Newer project', '2026-10-08T09:00:00.000Z'), project('old', 'Older project', '2026-10-01T09:00:00.000Z')]);
    api.recentCreatives.mockResolvedValue([recent('c', 'C', 'ready', { updatedAt: '2026-10-08T11:00:00.000Z', project: { slug: 'old', name: 'Older project' } })]);
    api.listCreatives.mockImplementation((() => new Promise(() => {})) as never); // cards never settle
    en(<Projects live={live()} />);
    const names = () => [...document.querySelectorAll('.ms-pcard-name')].map((n) => n.textContent);
    await waitFor(() => expect(names()).toEqual(['Older project', 'Newer project']));
  });

  it('reads 3-, 6- and 8-digit hex colours and rejects the rest', () => {
    expect(hex6('#abc')).toBe('#aabbcc');
    expect(hex6('#1B1913')).toBe('#1B1913');
    expect(hex6('#1B1913FF')).toBe('#1B1913');
    expect(hex6('red')).toBeNull();
    expect(luminance('#fff')).toBeCloseTo(1, 5);
    expect(luminance('#FFFFFF80')).toBeCloseTo(1, 5);
    expect(luminance('nope')).toBe(0);
  });
});

describe('Projects · new project inline', () => {
  it('shows the created project with the T14 entrance (scale .96)', async () => {
    api.listProjects.mockResolvedValue([project('hs', 'Half Story')]);
    api.createProject.mockResolvedValue({ slug: 'acme', project: (project('acme', 'Acme') as { project: unknown }).project });
    const entries: Array<{ el: Element; frames: Keyframe[] }> = [];
    const orig = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, frames: Keyframe[]) {
      entries.push({ el: this, frames });
      return { finished: Promise.resolve(), cancel() {} } as unknown as Animation;
    } as never;
    try {
      en(<Projects live={live()} />);
      await screen.findByText('Half Story', { selector: '.ms-pcard-name' });
      await userEvent.type(screen.getByLabelText('Project name'), 'Acme');
      await userEvent.click(screen.getByRole('button', { name: 'Create' }));
      expect(api.createProject).toHaveBeenCalledWith('Acme');
      const card = (await screen.findByText('Acme', { selector: '.ms-pcard-name' })).closest('a')!;
      expect(card.getAttribute('href')).toBe('#/p/acme');
      const scaled = entries.filter((e) => e.el === card && String(e.frames[0]?.transform).includes('scale(0.96)'));
      expect(scaled).toHaveLength(1);
      expect((screen.getByLabelText('Project name') as HTMLInputElement).value).toBe('');
    } finally { Element.prototype.animate = orig; }
  });

  it('explains a refused name and keeps it', async () => {
    api.listProjects.mockResolvedValue([]);
    api.createProject.mockRejectedValue(new Error('A project with this name exists'));
    en(<Projects live={live()} />);
    await userEvent.type(await screen.findByLabelText('Project name'), 'Acme');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect((await screen.findByRole('alert')).textContent).toContain('A project with this name exists');
    expect((screen.getByLabelText('Project name') as HTMLInputElement).value).toBe('Acme');
  });

  it('does not call the API for an empty name', async () => {
    api.listProjects.mockResolvedValue([]);
    en(<Projects live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Create' }));
    expect(api.createProject).not.toHaveBeenCalled();
  });

  it('focuses the name field for New project (header button and the switcher intent)', async () => {
    api.listProjects.mockResolvedValue([project('hs', 'Half Story')]);
    en(<Projects live={live()} />);
    await screen.findByText('Half Story', { selector: '.ms-pcard-name' });
    await userEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(document.activeElement?.id).toBe('new-project');
    (document.activeElement as HTMLElement).blur();
    act(() => requestNewProject());
    expect(document.activeElement?.id).toBe('new-project');
  });

  it('greets an empty workspace with the new project card', async () => {
    api.listProjects.mockResolvedValue([]);
    en(<Projects live={live()} />);
    expect(await screen.findByText('No projects yet')).toBeTruthy();
    expect(screen.getByText('Start a new project')).toBeTruthy();
  });
});

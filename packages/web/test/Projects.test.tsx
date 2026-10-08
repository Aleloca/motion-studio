import { DEFAULT_FORMATS, EMPTY_BRAND_KIT, type ApprovalRequest, type JobSummary, type ProjectListItem, type RecentCreative } from '@motion-studio/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
const { Projects } = await import('../src/screens/Projects.tsx');

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

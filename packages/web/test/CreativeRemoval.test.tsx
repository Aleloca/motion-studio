// Decision 915: archive and delete from the card menu of the project's creatives, the "Archived" section with Restore,
// the reasons while the core refuses, the confirmations (delete names the creative and the Trash; a whole group is asked).
import { DEFAULT_FORMATS, type CreativeListItem, type CreativeRemovalInfo } from '@motion-studio/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

const info = (over: Partial<CreativeRemovalInfo> = {}): CreativeRemovalInfo => ({ role: 'single', members: 1, letter: null, title: 'Spring launch', archived: false, blocked: null, ...over });
const api = {
  listCreatives: vi.fn(),
  listArchivedCreatives: vi.fn(async (): Promise<CreativeListItem[]> => []),
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(),
  getConversation: vi.fn(async () => []),
  sendCreativeTurn: vi.fn(),
  creativeRemoval: vi.fn(async () => info()),
  archiveCreative: vi.fn(async (_s: string, c: string) => ({ archived: [c] })),
  unarchiveCreative: vi.fn(async (_s: string, c: string) => ({ restored: [c] })),
  deleteCreative: vi.fn(async (_s: string, c: string) => ({ deleted: [c] })),
  fileUrl: (s: string, c: string, rel: string) => `/files/${s}/${c}/${rel}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ProjectCreatives } = await import('../src/screens/ProjectCreatives.tsx');
const { __resetToasts, getToasts } = await import('../src/ui/toast.tsx');

const at = '2026-10-08T10:00:00.000Z';
const item = (slug: string, title: string, over: Record<string, unknown> = {}): CreativeListItem =>
  ({ ok: true, slug, title, status: 'ready', formats: ['instagram-reel-9x16'], versions: 1, updatedAt: at, cover: null, ...over }) as CreativeListItem;
const live: EventsState = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as EventsState;
const en = () => render(<I18nProvider locale="en"><ProjectCreatives slug="acme" live={live} /></I18nProvider>);
const openMenu = async (title: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `Actions for ${title}` }));
  return screen.findByRole('menu', { name: `Actions for ${title}` });
};

beforeEach(() => { history.replaceState(null, '', '/#/p/acme'); __resetToasts(); });
afterEach(() => { vi.clearAllMocks(); history.replaceState(null, '', '/'); });

describe('creative removal · card menu', () => {
  it('Archive acts at once and offers Undo, which restores it', async () => {
    api.listCreatives.mockResolvedValue([item('spring', 'Spring launch')]);
    en();
    const menu = await openMenu('Spring launch');
    await userEvent.click(await within(menu).findByRole('menuitem', { name: 'Archive' }));
    expect(api.archiveCreative).toHaveBeenCalledWith('acme', 'spring', false);
    await waitFor(() => expect(getToasts().some((x) => x.text === '“Spring launch” archived')).toBe(true));
    const toast = getToasts().find((x) => x.text === '“Spring launch” archived')!;
    expect(toast.action?.label).toBe('Undo');
    toast.action!.run();
    await waitFor(() => expect(api.unarchiveCreative).toHaveBeenCalledWith('acme', 'spring'));
  });

  it('Delete asks first, naming the creative and the Trash', async () => {
    api.listCreatives.mockResolvedValue([item('spring', 'Spring launch')]);
    en();
    const menu = await openMenu('Spring launch');
    await userEvent.click(await within(menu).findByRole('menuitem', { name: 'Delete…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete “Spring launch”?' });
    expect(dialog.textContent).toContain('goes to the Trash');
    expect(api.deleteCreative).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move to Trash' }));
    expect(api.deleteCreative).toHaveBeenCalledWith('acme', 'spring', false);
    await waitFor(() => expect(getToasts().some((x) => x.text === '“Spring launch” moved to the Trash')).toBe(true));
  });

  it('while the core refuses, both items are disabled and say why', async () => {
    api.listCreatives.mockResolvedValue([item('spring', 'Spring launch')]);
    api.creativeRemoval.mockResolvedValueOnce(info({ blocked: { code: 'creative-busy', message: 'A render of this creative is running or queued: wait for it to end' } }));
    en();
    const menu = await openMenu('Spring launch');
    await within(menu).findByText('A render of this creative is running or queued: wait for it to end');
    for (const name of ['Archive', 'Delete…']) {
      const el = within(menu).getByRole('menuitem', { name });
      expect(el.getAttribute('aria-disabled')).toBe('true');
      await userEvent.click(el);
    }
    expect(api.archiveCreative).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a group (its variant A) is archived or deleted whole, after a question', async () => {
    api.listCreatives.mockResolvedValue([item('spring', 'Spring launch', { variants: { count: 3, active: 3, missing: [] } })]);
    api.creativeRemoval.mockResolvedValue(info({ role: 'host', members: 3, letter: 'a' }));
    en();
    let menu = await openMenu('Spring launch');
    await userEvent.click(await within(menu).findByRole('menuitem', { name: 'Archive all 3 variants' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive “Spring launch”?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(api.archiveCreative).toHaveBeenCalledWith('acme', 'spring', true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    menu = await openMenu('Spring launch');
    await userEvent.click(await within(menu).findByRole('menuitem', { name: 'Delete all 3 variants…' }));
    const del = await screen.findByRole('dialog', { name: 'Delete “Spring launch”?' });
    expect(del.textContent).toContain('All 3 variants of this group');
    await userEvent.click(within(del).getByRole('button', { name: 'Move to Trash' }));
    expect(api.deleteCreative).toHaveBeenCalledWith('acme', 'spring', true);
  });
});

describe('creative removal · Archived section', () => {
  it('lists the archived creatives apart, with Restore; an archived item never shows among the others', async () => {
    const archived = item('old', 'Old teaser', { archivedAt: at });
    api.listCreatives.mockResolvedValue([item('spring', 'Spring launch'), archived]);
    api.listArchivedCreatives.mockResolvedValue([archived]);
    en();
    await screen.findByText('Spring launch');
    expect(screen.queryByText('Old teaser')).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Archived (1)' }));
    const list = await screen.findByRole('list', { name: 'Archived creatives' });
    expect(within(list).getByText('Old teaser')).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.unarchiveCreative).toHaveBeenCalledWith('acme', 'old'));
    await userEvent.click(screen.getByRole('button', { name: 'Back to creatives' }));
    expect(await screen.findByText('Spring launch')).toBeTruthy();
  });

  it('reaches the archive when every creative is archived', async () => {
    api.listCreatives.mockResolvedValue([]);
    api.listArchivedCreatives.mockResolvedValue([item('old', 'Old teaser', { archivedAt: at })]);
    en();
    await userEvent.click(await screen.findByRole('button', { name: 'Archived (1)' }));
    expect(await screen.findByText('Old teaser')).toBeTruthy();
  });
});

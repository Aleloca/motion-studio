import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, storePackFormats, type CreativeDetail, type StorePack, type VersionEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';

// The creative's formats column (Phase 14, Task 6): the store pack's instances are one group, with the export in its header.
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });

const at = '2026-10-15T10:00:00.000Z';
const pack: StorePack = {
  app: { name: 'Tasky', tagline: '' }, stores: ['appstore', 'playstore'], devices: { appstore: ['iphone-69'], playstore: ['phone'] },
  screenshots: [{ caption: 'Uno', screen: null }, { caption: 'Due', screen: null }], preview: false,
};
const packFormats = storePackFormats(pack);
const version: VersionEntry = { n: 1, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: 'Dal brief', problems: [], tools: [], renderCommand: null, basedOn: null,
  outputs: [{ format: 'instagram-post-1x1', file: 'post.png', width: 1080, height: 1080, durationSec: null, verified: true, preview: null }] };
const makeDetail = (over: Partial<CreativeDetail['creative']['brief']> = {}): CreativeDetail => ({
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions: [version],
  creative: {
    schemaVersion: 1, title: 'Lancio estivo', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'Mostrare la nuova app', message: '', durationSec: null, assets: [], notes: '',
      formats: ['instagram-post-1x1', 'appstore-ipad-13', ...packFormats.formats], formatLabels: packFormats.formatLabels, storePack: pack, ...over },
  },
});
let detail = makeDetail();
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async () => detail),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  updateCreative: vi.fn(async () => detail.creative),
  exportStorePack: vi.fn(async (..._a: unknown[]) => ({ folder: '/out/pack', written: [], failed: [] })),
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');

const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
const route: Route = { name: 'creative', slug: 'acme', creative: 'lancio' };
function Harness() {
  const shell = { route, live, catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {} } as unknown as Shell;
  return (
    <I18nProvider locale="it"><ShellContext.Provider value={shell}>
      <header className="ms-topbar"><TopBar /></header>
      <CreativeCanvas slug="acme" creative="lancio" live={live} />
    </ShellContext.Provider></I18nProvider>
  );
}
const ready = () => screen.findByRole('img', { name: /Post 1:1 v\d/ });
beforeEach(() => { vi.clearAllMocks(); detail = makeDetail(); location.hash = '#/p/acme/c/lancio'; localStorage.clear(); });

const column = () => screen.getByLabelText('Formati di questa creatività');
const items = (el: HTMLElement) => Array.from(el.querySelectorAll('button[aria-pressed]'));

describe('CreativeCanvas · the store pack is one group', () => {
  it('groups only the pack instances, with App Store and Play Store as sub-groups; hand-picked store presets stay in their channel', async () => {
    render(<Harness />);
    await ready();
    const group = within(column()).getByRole('group', { name: 'Pacchetto store' });
    expect(items(group)).toHaveLength(4);
    expect(within(group).getByRole('group', { name: 'App Store' })).toBeTruthy();
    expect(within(group).getByRole('group', { name: 'Play Store' })).toBeTruthy();
    expect(items(within(group).getByRole('group', { name: 'App Store' }))).toHaveLength(2);
    // The hand-picked iPad is not in the pack group: it sits in the App Store channel group, outside it.
    const outside = within(column()).getAllByRole('group', { name: 'App Store' }).filter((g) => !group.contains(g));
    expect(outside).toHaveLength(1);
    expect(items(outside[0]!)).toHaveLength(1);
    expect(group.contains(outside[0]!)).toBe(false);
  });

  it('"Esporta pacchetto" is in the group header, not in the top bar, and opens the export for the version on screen', async () => {
    localStorage.setItem('ms.exportFolder', '/out');
    render(<Harness />);
    await ready();
    // The only "pacchetto" export button is the group's: the bar has none.
    const exports = screen.getAllByRole('button', { name: 'Esporta pacchetto' });
    expect(exports).toHaveLength(1);
    expect(column().contains(exports[0]!)).toBe(true);
    expect(document.querySelector('.ms-topbar')!.querySelector('.ms-cv-pack-export')).toBeNull();
    const group = within(column()).getByRole('group', { name: 'Pacchetto store' });
    await userEvent.click(within(group).getByRole('button', { name: 'Esporta pacchetto' }));
    const dialog = await screen.findByRole('dialog', { name: /pacchetto store/ });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Esporta il pacchetto' }));
    await waitFor(() => expect(api.exportStorePack).toHaveBeenCalledWith('acme', 'lancio', 1, { destination: '/out' }));
  });

  it('a creative without a pack has no pack group and no export', async () => {
    detail = makeDetail({ storePack: undefined, formats: ['instagram-post-1x1', 'appstore-iphone-69'], formatLabels: undefined });
    render(<Harness />);
    await ready();
    expect(within(column()).queryByRole('group', { name: 'Pacchetto store' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Esporta pacchetto' })).toBeNull();
    // A store preset picked by hand stays in its own channel group.
    expect(within(column()).getByRole('group', { name: 'App Store' })).toBeTruthy();
  });

  it('with every pack instance taken out the group is still there, empty, and the export stays', async () => {
    detail = makeDetail({ formats: ['instagram-post-1x1', 'appstore-ipad-13'], formatLabels: undefined });
    render(<Harness />);
    await ready();
    const group = within(column()).getByRole('group', { name: 'Pacchetto store' });
    expect(items(group)).toHaveLength(0);
    expect((within(group).getByRole('button', { name: 'Esporta pacchetto' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('follows the pack\'s own instances, not the ids a pack would have: a pack grown over a hand-picked @3 owns @4', async () => {
    const owned = { ...pack, screenshots: [...pack.screenshots, { caption: 'Tre', screen: null }], stores: ['appstore' as const], devices: { appstore: ['iphone-69' as const] }, instances: ['appstore-iphone-69', 'appstore-iphone-69@2', 'appstore-iphone-69@4'] };
    detail = makeDetail({ storePack: owned, formats: ['instagram-post-1x1', 'appstore-iphone-69', 'appstore-iphone-69@2', 'appstore-iphone-69@3', 'appstore-iphone-69@4'], formatLabels: undefined });
    render(<Harness />);
    await ready();
    const group = within(column()).getByRole('group', { name: 'Pacchetto store' });
    expect(items(group)).toHaveLength(3);
    const outside = within(column()).getAllByRole('group', { name: 'App Store' }).filter((g) => !group.contains(g));
    expect(items(outside[0]!)).toHaveLength(1);
  });

  it('report 42: the chat\'s "Si applica a" menu groups the formats as the column (the pack by store, the hand-picked ones in their channel)', async () => {
    const errors = vi.spyOn(console, 'error');
    render(<Harness />);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: /^Si applica a: Tutti i formati/ }));
    // Two groups called "App Store" (review F): no duplicate React keys.
    expect(errors.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
    errors.mockRestore();
    const menu = screen.getByRole('menu', { name: 'Si applica a' });
    expect(within(menu).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Instagram', 'App Store', 'App Store', 'Play Store']);
    const store = within(menu).getAllByRole('group', { name: 'App Store' })[1]!;
    await userEvent.click(within(store).getByRole('menuitemcheckbox', { name: 'App Store: tutto il gruppo' }));
    expect(screen.getByRole('button', { name: /^Si applica a: / }).textContent).toBe('Si applica a:App Store · 2 formati');
  });
});

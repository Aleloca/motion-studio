import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_BRAND_KIT, type BrandOverview, type BrandProposal, type JobSummary } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { __resetDeferred } from '../src/screens/deferred.ts';
import { __resetToasts } from '../src/ui/toast.tsx';

let overview: BrandOverview;
let linked: Array<{ path: string; note?: string }>;
class FakeApiError extends Error {}
const api = {
  getBrand: vi.fn(async () => structuredClone(overview)),
  getProject: vi.fn(async () => ({ slug: 'acme', project: { name: 'Acme', linkedCodebases: linked }, jobKey: 'k' })),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })),
  listReferences: vi.fn(async () => ({ references: [], error: null })),
  saveBrandKit: vi.fn(),
  saveGuidelines: vi.fn(),
  addBrandSource: vi.fn(async (..._a: unknown[]) => ({})),
  removeBrandSource: vi.fn(async () => ({ ok: true })),
  analyzeBrand: vi.fn(async () => ({ id: 'j1' })),
  cancelJob: vi.fn(),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: FakeApiError }));
const { Brand } = await import('../src/screens/Brand.tsx');
const { BrandReview } = await import('../src/screens/BrandReview.tsx');

const live = (over: Partial<EventsState> = {}): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {}, ...over });
const show = (locale: 'en' | 'it' = 'en', l = live()) => render(<I18nProvider locale={locale}><Brand slug="acme" live={l} /></I18nProvider>);
const source = { id: 's-c', kind: 'codebase' as const, url: null, file: null, path: '/Users/me/dev/app', note: 'iOS app', addedAt: '2026-10-07T10:00:00.000Z', lastAnalyzedAt: null };
const emptyOverview = (): BrandOverview => ({ kit: { ...EMPTY_BRAND_KIT }, kitError: null, guidelines: '', sourcesError: null, proposals: [], jobKey: 'brand:k', sources: [] });

beforeEach(() => { __resetToasts(); overview = emptyOverview(); linked = [{ path: '/Users/me/dev/app' }, { path: '/Users/me/dev/api' }]; });
afterEach(() => { vi.clearAllMocks(); __resetToasts(); __resetDeferred(); });

describe('Brand · codebase source, empty screen', () => {
  it('offers the two choices, adds the chosen folder and analyzes', async () => {
    show();
    expect(await screen.findByText('Teach Claude this brand')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'From a codebase' }));
    expect(screen.getByText(/never opens secret files/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Codebase folder'), '/Users/me/dev/shop');
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'web shop');
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.analyzeBrand).toHaveBeenCalledTimes(1));
    expect(api.addBrandSource).toHaveBeenCalledWith('acme', { kind: 'codebase', path: '/Users/me/dev/shop', note: 'web shop' });
  });

  it('fills the path from a project codebase suggestion', async () => {
    show();
    await userEvent.click(await screen.findByRole('radio', { name: 'From a codebase' }));
    const group = screen.getByRole('group', { name: 'Codebases of this project' });
    await userEvent.click(within(group).getByRole('button', { name: 'api' }));
    expect((screen.getByLabelText('Codebase folder') as HTMLInputElement).value).toBe('/Users/me/dev/api');
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.addBrandSource).toHaveBeenCalledWith('acme', { kind: 'codebase', path: '/Users/me/dev/api' }));
  });

  it('shows the core\'s refusal in the field and does not analyze', async () => {
    api.addBrandSource.mockRejectedValueOnce(new Error('The codebase cannot contain the project or the workspace, nor sit inside them'));
    show();
    await userEvent.click(await screen.findByRole('radio', { name: 'From a codebase' }));
    await userEvent.type(screen.getByLabelText('Codebase folder'), '/Users/me');
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    expect((await screen.findByRole('alert')).textContent).toContain('cannot contain the project');
    expect(api.analyzeBrand).not.toHaveBeenCalled();
  });

  it('is translated', async () => {
    show('it');
    await userEvent.click(await screen.findByRole('radio', { name: 'Da una codebase' }));
    expect(screen.getByText(/sola lettura e non apre file segreti/)).toBeTruthy();
  });
});

describe('Brand · codebase source, sources panel', () => {
  const kitWithCodebaseItem = () => {
    overview.kit = { ...EMPTY_BRAND_KIT, colors: [{ id: 'c1', name: 'Ink', hex: '#111111', role: 'background', source: { kind: 'codebase', ref: 'src/theme.css' } }] };
    overview.sources = [source];
  };

  it('lists the folder with its name and full path, and a suggestion adds a source without analyzing', async () => {
    kitWithCodebaseItem();
    show();
    const side = await screen.findByRole('complementary', { name: 'Sources' });
    expect(within(side).getByText('app')).toBeTruthy();
    expect(within(side).getByText('/Users/me/dev/app')).toBeTruthy();
    expect(within(side).getByText('iOS app')).toBeTruthy();
    await userEvent.click(within(side).getByRole('radio', { name: 'From a codebase' }));
    // The folder that is already a source is not offered again.
    expect(within(side).queryByRole('button', { name: 'app' })).toBeNull();
    await userEvent.click(within(side).getByRole('button', { name: 'api' }));
    await userEvent.click(within(side).getByRole('button', { name: 'Add folder' }));
    await waitFor(() => expect(api.addBrandSource).toHaveBeenCalledWith('acme', { kind: 'codebase', path: '/Users/me/dev/api' }));
    expect(api.analyzeBrand).not.toHaveBeenCalled();
  });

  it('shows a server error in the field', async () => {
    kitWithCodebaseItem();
    api.addBrandSource.mockRejectedValueOnce(new Error('Folder not found: /nope'));
    show();
    const side = await screen.findByRole('complementary', { name: 'Sources' });
    await userEvent.click(within(side).getByRole('radio', { name: 'From a codebase' }));
    await userEvent.type(within(side).getByLabelText('Codebase folder'), '/nope');
    await userEvent.click(within(side).getByRole('button', { name: 'Add folder' }));
    expect((await within(side).findByRole('alert')).textContent).toBe('Folder not found: /nope');
  });

  it('analyzes with only a codebase source', async () => {
    kitWithCodebaseItem();
    show();
    const side = await screen.findByRole('complementary', { name: 'Sources' });
    await userEvent.click(within(side).getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.analyzeBrand).toHaveBeenCalledWith('acme'));
  });

  it('renders the notes of the analysis job, including the no-sandbox one', async () => {
    kitWithCodebaseItem();
    const job: JobSummary = { id: 'j1', key: 'brand:k', kind: 'brand-analysis', label: 'Brand analysis', state: 'succeeded', createdAt: '2026-10-08T10:00:00.000Z',
      notes: ['No sandbox: the agent runs no commands in this analysis', 'Codebase /Users/me/dev/app cannot be checked (not a git repository)'] };
    show('en', live({ jobs: { j1: job } }));
    const notes = await screen.findByRole('region', { name: 'Notes on the analysis' });
    expect(within(notes).getByText(/^No sandbox/)).toBeTruthy();
    expect(within(notes).getByText(/cannot be checked/)).toBeTruthy();
  });
});

describe('Brand · codebase source label', () => {
  it('shows "from codebase · ref" on a suggested item, in both languages', () => {
    const color = { id: 'ink', name: 'Ink', hex: '#111111', role: 'background' as const, source: { kind: 'codebase' as const, ref: 'src/theme.css' } };
    const proposal = { schemaVersion: 1, id: 'p-1', createdAt: '2026-10-08T10:05:00.000Z', sourceIds: ['s-c'], status: 'open', summary: '', assetsAdded: [], guidelines: null,
      changes: [{ id: 'colors:add:ink', field: 'colors', op: 'add', itemId: 'ink', before: null, after: color }] } as unknown as BrandProposal;
    for (const [locale, text] of [['en', 'from codebase · src/theme.css'], ['it', 'da codebase · src/theme.css']] as const) {
      const { unmount } = render(<I18nProvider locale={locale}><BrandReview open slug="acme" proposal={proposal} kit={EMPTY_BRAND_KIT} guidelines="" sources={[source]} onClose={() => {}} onApplied={() => {}} onUndo={() => {}} onChanged={() => {}} /></I18nProvider>);
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
      unmount();
    }
  });
});

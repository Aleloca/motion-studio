import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_BRAND_KIT, type BrandKit, type BrandOverview, type BrandProposal, type JobSummary } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { __resetToasts, getToasts } from '../src/ui/toast.tsx';

const site = { kind: 'website' as const, ref: 'https://acme.example' };
let overview: BrandOverview;
const api = {
  getBrand: vi.fn(async () => structuredClone(overview)),
  getProject: vi.fn(async () => ({ slug: 'acme', project: { name: 'Acme Studio' }, jobKey: 'k' })),
  listAssets: vi.fn(async () => ({ assets: [{ file: 'fonts/Inter.woff2', kind: 'font', origin: 'upload', description: '', tags: [], addedAt: '2026-10-07T10:00:00.000Z' }], error: null, unregistered: [] })),
  listReferences: vi.fn(async () => ({ references: [], error: null })),
  saveBrandKit: vi.fn(async (_s: string, k: BrandKit) => { overview.kit = structuredClone(k); return k; }),
  saveGuidelines: vi.fn(async (_s: string, text: string) => { overview.guidelines = text; return { ok: true as const }; }),
  addBrandSource: vi.fn(async () => ({})),
  removeBrandSource: vi.fn(async () => ({ ok: true })),
  analyzeBrand: vi.fn(async () => ({ id: 'j1' })),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
  uploadFiles: vi.fn(async () => ({ assets: [] })),
  applyProposal: vi.fn(),
  discardProposal: vi.fn(),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { Brand } = await import('../src/screens/Brand.tsx');
const { normalizeFamily, swatchText } = await import('../src/screens/brandModel.ts');
const { __flushDeferred } = await import('../src/screens/deferred.ts');

const live = (over: Partial<EventsState> = {}): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {}, ...over });
const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);
const lastKit = () => api.saveBrandKit.mock.calls.at(-1)![1] as BrandKit;
const job = (over: Partial<JobSummary> = {}): JobSummary => ({ id: 'j1', key: 'brand:k', kind: 'brand-analysis', label: 'Brand analysis', state: 'running', createdAt: '2026-10-08T10:00:00.000Z', ...over });

beforeEach(() => {
  __resetToasts();
  overview = {
    kit: {
      ...EMPTY_BRAND_KIT,
      colors: [
        { id: 'ink', name: 'Ink black', hex: '#1B1913', role: 'background', source: site },
        { id: 'paper', name: 'Parchment', hex: '#FBE8C3', role: 'text', source: site },
      ],
      fonts: [{ id: 'inter', family: 'Inter', role: 'body', weights: [400, 700], file: null, source: site }],
      dos: [{ id: 'd1', text: 'Show the case number', source: site }],
    },
    kitError: null, guidelines: '# Acme\n\nA detective game.', sourcesError: null, proposals: [], jobKey: 'brand:k',
    sources: [{ id: 's-1', kind: 'website', url: 'https://acme.example', file: null, addedAt: '2026-10-07T10:00:00.000Z', lastAnalyzedAt: '2026-10-07T10:00:00.000Z' }],
  };
});
afterEach(() => { vi.clearAllMocks(); __resetToasts(); });

describe('Brand · colors', () => {
  it('editing a color saves the kit (as a manual edit)', async () => {
    en(<Brand slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit color Ink black' }));
    const hex = screen.getByLabelText('Hex');
    await userEvent.clear(hex);
    await userEvent.type(hex, '112233');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(api.saveBrandKit).toHaveBeenCalled());
    expect(lastKit().colors[0]).toMatchObject({ id: 'ink', hex: '#112233', source: { kind: 'manual', ref: null } });
    expect(lastKit().colors).toHaveLength(2);
  });

  it('shows Saving… then Saved while the kit is saved (T12)', async () => {
    let finish!: (k: BrandKit) => void;
    api.saveBrandKit.mockImplementationOnce((_s, k) => new Promise((r) => { finish = r; void k; }));
    en(<Brand slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit color Ink black' }));
    await userEvent.click(screen.getByRole('button', { name: 'Accent' }));
    expect(await screen.findByText('Saving…')).toBeTruthy();
    await act(async () => { finish(lastKit()); });
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(lastKit().colors[0]!.role).toBe('accent');
  });

  it('removing a color offers Undo, which restores it in place', async () => {
    en(<Brand slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit color Ink black' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(lastKit().colors.map((c) => c.id)).toEqual(['paper']));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit color Ink black' })).toBeNull());
    const toast = getToasts().find((x) => x.text === 'Ink black removed');
    expect(toast?.action?.label).toBe('Undo');
    await act(async () => { toast!.action!.run(); });
    await waitFor(() => expect(lastKit().colors.map((c) => c.id)).toEqual(['ink', 'paper']));
    expect(await screen.findByRole('button', { name: 'Edit color Ink black' })).toBeTruthy();
  });

  it('computes the contrast text on a swatch from the palette', async () => {
    en(<Brand slug="acme" live={live()} />);
    const swatch = await screen.findByRole('button', { name: 'Edit color Ink black' });
    // Parchment on ink black: the best text color of the palette, ratio computed (not hard-coded).
    expect(within(swatch).getByText(/^Aa \d+(\.\d)?$/)).toBeTruthy();
  });
});

describe('Brand · typography', () => {
  it('normalizes a CSS stack to its first family', () => {
    expect(normalizeFamily('Newsreader, "Newsreader Fallback", Georgia')).toBe('Newsreader');
    expect(normalizeFamily("'Special Elite', monospace")).toBe('Special Elite');
    expect(normalizeFamily('  Source Sans 3  ')).toBe('Source Sans 3');
  });

  it('saves the first family when a whole stack is typed', async () => {
    en(<Brand slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit font Inter' }));
    const family = screen.getByLabelText('Family');
    await userEvent.clear(family);
    fireEvent.change(family, { target: { value: 'Newsreader, "Newsreader Fallback", Georgia' } });
    fireEvent.blur(family);
    await waitFor(() => expect(lastKit().fonts[0]!.family).toBe('Newsreader'));
    expect(screen.getByText('Kept the first family of the CSS stack: Newsreader')).toBeTruthy();
  });

  it('says the preview is not available without a font file', async () => {
    en(<Brand slug="acme" live={live()} />);
    expect(await screen.findByText('Preview unavailable: add the font file to the project')).toBeTruthy();
  });
});

describe('Brand · logos and health', () => {
  it('flags the missing logo for light backgrounds; its action opens the upload', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    en(<Brand slug="acme" live={live()} />);
    const missing = (await screen.findByText('Missing: logo for light backgrounds')).closest('div')!;
    await userEvent.click(within(missing).getByRole('button', { name: 'Upload logo' }));
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('derives brand health from the kit only', async () => {
    en(<Brand slug="acme" live={live()} />);
    const health = await screen.findByRole('region', { name: 'Brand health' });
    expect(within(health).getByText('Palette with roles').closest('[data-state]')!.getAttribute('data-state')).toBe('ok');
    expect(within(health).getByText('Font files in the project').closest('[data-state]')!.getAttribute('data-state')).toBe('todo');
    expect(within(health).getByText('Do and avoid rules').closest('[data-state]')!.getAttribute('data-state')).toBe('todo');
    expect(within(health).getByText('Logo for light backgrounds').closest('[data-state]')!.getAttribute('data-state')).toBe('todo');
    expect(within(health).queryByText(/%|score/i)).toBeNull();
  });
});

describe('Brand · analysis', () => {
  it('shows the steps from the job progress events, with no invented percentage', async () => {
    const events = { j1: [{ kind: 'progress' as const, text: 'Reading acme.example (4 pages)' }] };
    const view = en(<Brand slug="acme" live={live({ jobs: { j1: job() }, events })} />);
    const card = await screen.findByRole('region', { name: 'Learning the brand' });
    expect(within(card).getByText('Reading acme.example (4 pages)')).toBeTruthy();
    const bar = within(card).getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBeNull(); // report_progress carries text only: indeterminate
    expect(within(card).queryByText(/\d+%/)).toBeNull();
    view.rerender(<I18nProvider locale="en"><Brand slug="acme" live={live({ jobs: { j1: job() }, events: { j1: [...events.j1, { kind: 'tool_use', id: 't', name: 'WebFetch', input: {} }, { kind: 'progress', text: 'Sampling colors from 6 illustrations' }] } })} /></I18nProvider>);
    expect(within(card).getByText('Sampling colors from 6 illustrations')).toBeTruthy();
    expect(within(card).getByText('Reading acme.example (4 pages)')).toBeTruthy();
    expect(screen.getByText('Analysis in progress')).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(api.cancelJob).toHaveBeenCalledWith('j1');
  });

  it('announces a finished analysis and opens the review', async () => {
    const view = en(<Brand slug="acme" live={live({ jobs: { j1: job() } })} />);
    await screen.findByRole('region', { name: 'Learning the brand' });
    const proposal: BrandProposal = {
      schemaVersion: 1, id: 'p-1', createdAt: '2026-10-08T10:05:00.000Z', sourceIds: ['s-1'], status: 'open', summary: '', guidelines: null, assetsAdded: [],
      changes: [{ id: 'colors:add:amber', field: 'colors', op: 'add', itemId: 'amber', before: null, after: { id: 'amber', name: 'Lamp amber', hex: '#C8873A', role: 'accent', source: site } }],
    };
    overview.proposals = [proposal];
    view.rerender(<I18nProvider locale="en"><Brand slug="acme" live={live({ jobs: { j1: job({ state: 'succeeded' }) }, projectTicks: { acme: 1 } })} /></I18nProvider>);
    expect(await screen.findByRole('dialog', { name: 'Review brand suggestions' })).toBeTruthy();
    expect(getToasts().some((x) => x.text === 'Brand suggestions are ready')).toBe(true);
  });
});

describe('Brand · overview and sources', () => {
  it('shows the project name and where the brand was learned', async () => {
    en(<Brand slug="acme" live={live()} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Acme Studio' })).toBeTruthy();
    expect(screen.getByText(/^Learned from acme\.example · /)).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Brand sections' })).toBeTruthy();
  });

  it('removing a source hides it with Undo; the delete is sent only once the Undo time is over', async () => {
    en(<Brand slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for acme.example' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByText('acme.example')).toBeNull();
    const undo = getToasts().find((x) => x.text === 'acme.example removed')!;
    await act(async () => { undo.action!.run(); });
    expect(await screen.findByText('acme.example')).toBeTruthy();
    expect(api.removeBrandSource).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for acme.example' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await act(async () => { __flushDeferred(); });
    expect(api.removeBrandSource).toHaveBeenCalledWith('acme', 's-1');
  });

  it('picks AA text for a swatch, falling back to black or white', () => {
    const ink = swatchText('#1B1913', [{ hex: '#FBE8C3', name: 'Parchment' }]);
    expect(ink.name).toBe('Parchment');
    expect(ink.ratio).toBeGreaterThan(14);
    const mid = swatchText('#808080', [{ hex: '#7F7F7F', name: 'Grey' }]);
    expect(mid.name).toBeNull();
    expect(mid.ratio).toBeGreaterThan(3.9);
  });
});

describe('Brand · empty project', () => {
  it('shows the designed empty state with the website field, and analyzes', async () => {
    overview = { ...overview, kit: EMPTY_BRAND_KIT, guidelines: '', sources: [] };
    en(<Brand slug="acme" live={live()} />);
    expect(await screen.findByText('Teach Claude this brand')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Website'), 'acme.example');
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.addBrandSource).toHaveBeenCalledWith('acme', { kind: 'website', url: 'https://acme.example' }));
    await waitFor(() => expect(api.analyzeBrand).toHaveBeenCalledWith('acme'));
  });
});

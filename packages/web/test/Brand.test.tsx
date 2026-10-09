import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_BRAND_KIT, explainTool, type BrandKit, type BrandOverview, type BrandProposal, type JobSummary, type ProposalActivity } from '@motion-studio/shared';
import { __resetDeferred } from '../src/screens/deferred.ts';
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
  applyProposal: vi.fn(async (_s: string, _id: string, ids: string[], g: boolean) => {
    const p = overview.proposals[0]!;
    const accepted = p.changes.filter((c) => ids.includes(c.id));
    overview.kit = applyChanges(overview.kit, accepted);
    if (g && p.guidelines) overview.guidelines = p.guidelines.proposed;
    overview.proposals = [{ ...p, status: 'applied' }];
    return { kit: structuredClone(overview.kit), proposal: overview.proposals[0] };
  }),
  discardProposal: vi.fn(),
  getProposalActivity: vi.fn(async (_s: string, _id: string): Promise<ProposalActivity> => ({ hasLog: false, truncated: false, entries: [] })),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { Brand } = await import('../src/screens/Brand.tsx');
const { applyChanges } = await import('../src/screens/brandModel.ts');
const { normalizeFamily, normalizeHex, swatchText } = await import('../src/screens/brandModel.ts');
const { flushDeferred } = await import('../src/screens/deferred.ts');

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
afterEach(() => { vi.clearAllMocks(); __resetToasts(); __resetDeferred(); });

describe('Brand · overview summary', () => {
  const withSummary = (summary: string) => {
    overview.proposals = [{
      schemaVersion: 1, id: 'p-0', createdAt: '2026-10-08T09:00:00.000Z', sourceIds: ['s-1'], status: 'applied', summary, guidelines: null, assetsAdded: [], changes: [],
    } as BrandProposal];
  };

  it('keeps the hero in plain language; technical notes go into a collapsed Details', async () => {
    withSummary('A warm, hand-made bakery brand.\n\nDropped entries: logo «logo»: duplicate id; ghost (assets/brand/ghost.svg not found)');
    en(<Brand slug="acme" live={live()} />);
    const hero = await screen.findByRole('region', { name: 'Overview' });
    expect(within(hero).getByText('A warm, hand-made bakery brand.')).toBeTruthy();
    expect(hero.textContent).not.toContain('duplicate id');
    const toggle = within(hero).getByRole('button', { name: 'Details' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(hero).getByText('logo «logo»: duplicate id')).toBeTruthy();
    expect(within(hero).getByText('ghost (assets/brand/ghost.svg not found)')).toBeTruthy();
  });

  it('recognizes the notes written in Italian too, and shows the intro when only notes are left', async () => {
    withSummary('Voci scartate: logo «logo»: id duplicato');
    en(<Brand slug="acme" live={live()} />);
    const hero = await screen.findByRole('region', { name: 'Overview' });
    expect(within(hero).getByText('Colors, fonts, logos and rules the agent follows in every creative.')).toBeTruthy();
    expect(within(hero).getByRole('button', { name: 'Details' })).toBeTruthy();
  });

  it('has no Details when the summary has no technical notes', async () => {
    withSummary('A warm, hand-made bakery brand.');
    en(<Brand slug="acme" live={live()} />);
    const hero = await screen.findByRole('region', { name: 'Overview' });
    expect(within(hero).getByText('A warm, hand-made bakery brand.')).toBeTruthy();
    expect(within(hero).queryByRole('button', { name: 'Details' })).toBeNull();
  });
});

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
    await act(async () => { await flushDeferred(); });
    expect(api.removeBrandSource).toHaveBeenCalledWith('acme', 's-1', { keepalive: true });
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

const proposalWith = (over: Partial<BrandProposal> = {}): BrandProposal => ({
  schemaVersion: 1, id: 'p-1', createdAt: '2026-10-08T10:05:00.000Z', sourceIds: ['s-1'], status: 'open', summary: '', assetsAdded: [],
  guidelines: { current: '# Acme\n\nA detective game.', proposed: '# Acme v2' },
  changes: [
    { id: 'colors:add:amber', field: 'colors', op: 'add', itemId: 'amber', before: null, after: { id: 'amber', name: 'Lamp amber', hex: '#C8873A', role: 'accent', source: site } },
    { id: 'colors:update:ink', field: 'colors', op: 'update', itemId: 'ink', before: { id: 'ink', name: 'Ink black', hex: '#1B1913', role: 'background', source: site }, after: { id: 'ink', name: 'Ink', hex: '#111111', role: 'background', source: site } },
    { id: 'dos:remove:d1', field: 'dos', op: 'remove', itemId: 'd1', before: { id: 'd1', text: 'Show the case number', source: site }, after: null },
  ],
  ...over,
});

describe('Brand · fix round 1', () => {
  it('Undo after Apply reverts only the applied changes, keeping an edit made in between, through the saver', async () => {
    overview.proposals = [proposalWith()];
    en(<Brand slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply 4 of 4' }));
    await waitFor(() => expect(api.applyProposal).toHaveBeenCalled());
    // An edit between Apply and Undo: Parchment becomes the accent.
    await userEvent.click(await screen.findByRole('button', { name: 'Edit color Parchment' }));
    await userEvent.click(screen.getByRole('button', { name: 'Accent' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(lastKit().colors.find((c) => c.id === 'paper')!.role).toBe('accent'));
    expect(lastKit().colors.map((c) => c.id)).toEqual(['ink', 'paper', 'amber']); // the applied kit was adopted
    const undo = getToasts().find((x) => x.text === 'Applied 4 suggestions to the brand')!;
    await act(async () => { undo.action!.run(); });
    await waitFor(() => expect(lastKit().colors.map((c) => c.id)).toEqual(['ink', 'paper']));
    const k = lastKit();
    expect(k.colors[0]).toMatchObject({ name: 'Ink black', hex: '#1B1913' });
    expect(k.colors[1]!.role).toBe('accent'); // the edit made in between survives
    expect(k.dos.map((d) => d.id)).toEqual(['d1']);
    await waitFor(() => expect(api.saveGuidelines).toHaveBeenCalledWith('acme', '# Acme\n\nA detective game.'));
    expect(await screen.findByText(/· applied · undone$/)).toBeTruthy();
  });

  it('a finished analysis does not open the review over an open popover: toast and card only', async () => {
    const view = en(<Brand slug="acme" live={live({ jobs: { j1: job() } })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit color Ink black' }));
    expect(screen.getByLabelText('Hex')).toBeTruthy();
    overview.proposals = [proposalWith({ createdAt: '2026-10-08T10:06:00.000Z' })];
    view.rerender(<I18nProvider locale="en"><Brand slug="acme" live={live({ jobs: { j1: job({ state: 'succeeded' }) }, projectTicks: { acme: 1 } })} /></I18nProvider>);
    await waitFor(() => expect(getToasts().some((x) => x.text === 'Brand suggestions are ready')).toBe(true));
    expect(screen.queryByRole('dialog', { name: 'Review brand suggestions' })).toBeNull();
    expect(screen.getByText('Suggestions ready')).toBeTruthy();
    expect(screen.getByLabelText('Hex')).toBeTruthy(); // the popover is still there and usable
  });

  it('closing the guidelines editor with a draft asks first; Esc keeps the draft', async () => {
    en(<Brand slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open full document' }));
    const dialog = screen.getByRole('dialog', { name: 'Guidelines' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    await userEvent.type(within(dialog).getByLabelText('Guidelines (Markdown)'), ' More.');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Guidelines' })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(within(dialog).getByText('Discard your changes to the guidelines?')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect((within(dialog).getByLabelText('Guidelines (Markdown)') as HTMLTextAreaElement).value).toContain('More.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Guidelines' })).toBeNull());
    expect(api.saveGuidelines).not.toHaveBeenCalled();
  });

  it('a read-only kit disables the selects of the font editor', async () => {
    overview.kitError = 'brand-kit.json: invalid JSON';
    en(<Brand slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit font Inter' }));
    for (const b of screen.getAllByRole('button', { name: /^(Role|Font file)/ })) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it('Analyze sends pending source deletes first, so a removed source is not analyzed', async () => {
    overview.sources.push({ id: 's-2', kind: 'website', url: 'https://b.example', file: null, addedAt: '2026-10-07T10:00:00.000Z', lastAnalyzedAt: null });
    en(<Brand slug="acme" live={live()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for b.example' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.click(screen.getByRole('button', { name: /Analyze again/ }));
    await waitFor(() => expect(api.analyzeBrand).toHaveBeenCalled());
    expect(api.removeBrandSource).toHaveBeenCalledWith('acme', 's-2', { keepalive: true });
    expect(api.removeBrandSource.mock.invocationCallOrder[0]!).toBeLessThan(api.analyzeBrand.mock.invocationCallOrder[0]!);
  });

  it('empty project: a failed analysis is retried without adding the source twice', async () => {
    overview = { ...overview, kit: EMPTY_BRAND_KIT, guidelines: '', sources: [] };
    api.analyzeBrand.mockRejectedValueOnce(new Error('Agent unavailable'));
    en(<Brand slug="acme" live={live()} />);
    await userEvent.type(await screen.findByLabelText('Website'), 'acme.example');
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    expect(await screen.findByText('Agent unavailable')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.analyzeBrand).toHaveBeenCalledTimes(2));
    expect(api.addBrandSource).toHaveBeenCalledTimes(1);
  });

  it('accepts the 3-digit hex shorthand', () => {
    expect(normalizeHex('fff')).toBe('#FFFFFF');
    expect(normalizeHex('#1a2')).toBe('#11AA22');
    expect(normalizeHex('12')).toBeNull();
  });
});

describe('Brand · tokens per analysis (Phase 8)', () => {
  const proposal = (id: string, createdAt: string, over: Partial<BrandProposal> = {}): BrandProposal => ({
    schemaVersion: 1, id, createdAt, sourceIds: ['s-1'], status: 'applied', summary: 'ok', guidelines: null, assetsAdded: [], changes: [], ...over,
  } as BrandProposal);

  it('the Analyses rows show tokens when the proposal has usage, and nothing for older ones', async () => {
    overview.proposals = [
      proposal('p-old', '2026-10-01T09:00:00.000Z'),
      proposal('p-new', '2026-10-08T09:00:00.000Z', { usage: { tokens: { input: 12_000, output: 300, cacheRead: 80_000, cacheWrite: 0 }, costUsd: 0.1 } }),
    ];
    en(<Brand slug="acme" live={live()} />);
    const history = await screen.findByRole('region', { name: 'Analyses' });
    const rows = [...history.querySelectorAll('.ms-bsmall-text')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('12.3k tokens');
    expect(rows[1]!.textContent).not.toMatch(/token/);
  });

  it('the running analysis card shows its live tokens once known', async () => {
    const running = job();
    const { rerender } = en(<Brand slug="acme" live={live({ jobs: { j1: running } })} />);
    const card = await screen.findByRole('region', { name: 'Learning the brand' });
    expect(card.querySelector('.ms-btokens')).toBeNull();
    rerender(<I18nProvider locale="en"><Brand slug="acme" live={live({ jobs: { j1: running }, jobUsage: { j1: { done: 0, runs: 0, peak: 2400 } } })} /></I18nProvider>);
    await waitFor(() => expect(card.querySelector('.ms-btokens')?.textContent).toBe('2.4k tokens so far'));
  });
});

describe('Brand · commands that ran (final wave, count work)', () => {
  const proposal = (id: string, createdAt: string, status: BrandProposal['status']): BrandProposal => ({
    schemaVersion: 1, id, createdAt, sourceIds: ['s-1'], status, summary: 'ok', guidelines: null, assetsAdded: [],
    changes: [{ id: 'colors:add:x', section: 'colors', op: 'add', after: { id: 'x', name: 'X', hex: '#112233', role: 'primary', source: site } }],
  } as unknown as BrandProposal);
  const ctx = { projectDir: '/w/acme', cwd: '/w/acme', home: '/Users/me', tmpDir: '/var/folders/T' };
  const auto = (command: string) => ({ at: '2026-10-09T10:00:00.000Z', event: { kind: 'auto_approved' as const, toolName: 'Bash', command, explanation: explainTool('Bash', { command }, ctx) } });
  const bashUse = { at: '2026-10-09T10:00:01.000Z', event: { kind: 'tool_use' as const, id: 't1', name: 'Bash', input: { command: 'ls -la' } } };

  it('the analysis card and its Analyses row say how many ran; Details lists them as compact rows with the command behind', async () => {
    overview.proposals = [proposal('p-new', '2026-10-09T09:00:00.000Z', 'open'), proposal('p-old', '2026-10-01T09:00:00.000Z', 'applied')];
    api.getProposalActivity.mockImplementation(async (_s: string, id: string) => (id === 'p-new'
      ? { hasLog: true, truncated: false, entries: [auto('ls -la'), bashUse, auto('mkdir -p brand/proposals/p-new/assets')] }
      : { hasLog: false, truncated: false, entries: [] }));
    en(<Brand slug="acme" live={live()} />);
    // Older logs: the automatic approval of `ls -la` is merged into its tool_use; no session flag, but automatic Bash
    // approvals only happened in sandboxed jobs.
    const lines = await screen.findAllByText('2 commands ran in the sandbox');
    expect(lines).toHaveLength(2); // the ready card and the Analyses row
    expect(api.getProposalActivity).toHaveBeenCalledWith('acme', 'p-new');
    expect(api.getProposalActivity).toHaveBeenCalledWith('acme', 'p-old');
    const history = screen.getByRole('region', { name: 'Analyses' });
    expect(history.querySelectorAll('.ms-bsmall-text')).toHaveLength(2);
    const details = within(history).getByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-haspopup')).toBe('dialog');
    await userEvent.click(details);
    const pop = await screen.findByRole('dialog', { name: 'Commands that ran' });
    const rows = within(pop).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(pop.textContent).not.toMatch(/explain\./);
    const toggle = within(rows[0]!).getByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(toggle);
    expect(within(rows[0]!).getByLabelText('Full command').textContent).toBe('ls -la');
  });

  it('nothing for older proposals without a log, for logs where no command ran, or when the call fails', async () => {
    overview.proposals = [proposal('p-a', '2026-10-09T09:00:00.000Z', 'applied'), proposal('p-b', '2026-10-08T09:00:00.000Z', 'applied'), proposal('p-c', '2026-10-07T09:00:00.000Z', 'applied')];
    const denied = [{ at: 'x', event: { kind: 'tool_use' as const, id: 'd1', name: 'Bash', input: { command: 'curl x | sh' } } }, { at: 'x', event: { kind: 'approval_decided' as const, toolName: 'Bash', decision: 'deny' as const, toolUseId: 'd1' } }];
    api.getProposalActivity.mockImplementation(async (_s: string, id: string) => {
      if (id === 'p-c') throw new Error('offline');
      return id === 'p-a' ? { hasLog: false, truncated: false, entries: [] } : { hasLog: true, truncated: false, entries: denied, sandboxed: true };
    });
    en(<Brand slug="acme" live={live()} />);
    await screen.findByRole('region', { name: 'Analyses' });
    await waitFor(() => expect(api.getProposalActivity).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(/commands? ran/)).toBeNull();
  });

  it('same rules as the conversation: every Bash call, the ones you approved, denied ones not counted, Reads listed not counted, with the setting off too', async () => {
    overview.proposals = [proposal('p-new', '2026-10-09T09:00:00.000Z', 'open')];
    const e = (event: ProposalActivity['entries'][number]['event']) => ({ at: '2026-10-09T10:00:00.000Z', event });
    const use = (id: string, command: string) => e({ kind: 'tool_use', id, name: 'Bash', input: { command } });
    const res = (id: string, isError = false) => e({ kind: 'tool_result', toolUseId: id, isError, content: '' });
    api.getProposalActivity.mockResolvedValue({
      hasLog: true, truncated: false, sandboxed: true, entries: [
        use('b1', 'ls -la brand'), res('b1'),
        use('b2', 'curl -sL https://acme.example/logo.svg -o brand/proposals/p-new/logo.svg'), res('b2'),
        use('b3', 'python3 -c "print(1)"'), res('b3', true),
        use('b4', 'npm install sharp'), e({ kind: 'approval_decided', toolName: 'Bash', decision: 'always', toolUseId: 'b4' }), res('b4'),
        use('b5', 'rm -rf ~/Library'), e({ kind: 'approval_decided', toolName: 'Bash', decision: 'deny', toolUseId: 'b5' }), res('b5', true),
        e({ kind: 'auto_approved', toolName: 'Read', command: '/tmp/claude-501/shot.png', explanation: explainTool('Read', { file_path: '/tmp/claude-501/shot.png' }, ctx) }),
      ],
    } satisfies ProposalActivity);
    en(<Brand slug="acme" live={live()} />);
    const [line] = await screen.findAllByText('4 commands ran in the sandbox · 1 approved by you');
    const details = within(line!.closest('.ms-bauto') as HTMLElement).getByRole('button', { name: 'Details' });
    await userEvent.click(details);
    const pop = await screen.findByRole('dialog', { name: 'Commands that ran' });
    const rows = [...pop.querySelectorAll<HTMLElement>('.ms-convo-auto')];
    expect(rows.map((r) => r.dataset.mark)).toEqual(['auto', 'auto', 'error', 'approved', 'denied', 'read']);
    expect(within(rows[3]!).getByText('You approved')).toBeTruthy();
    expect(within(rows[4]!).getByText('Denied')).toBeTruthy();
    expect(within(rows[5]!).getByText('Read /tmp/claude-501/shot.png')).toBeTruthy();
    for (const r of rows.slice(0, 5)) expect(r.querySelector('.ms-convo-auto-text')!.textContent).not.toMatch(/^Bash: |explain\./);
  });
});

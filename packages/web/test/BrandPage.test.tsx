import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_BRAND_KIT, type BrandOverview, type JobSummary } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const site = { kind: 'website' as const, ref: 'https://acme.example' };
let overview: BrandOverview;
const api = {
  getBrand: vi.fn(async () => structuredClone(overview)),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })),
  saveBrandKit: vi.fn(async (_s: string, k: unknown) => { overview.kit = k as BrandOverview['kit']; return k; }),
  saveGuidelines: vi.fn(async (_s: string, text: string) => { overview.guidelines = text; return { ok: true }; }),
  addBrandSource: vi.fn(async () => ({})),
  removeBrandSource: vi.fn(async () => ({ ok: true })),
  analyzeBrand: vi.fn(async () => ({ id: 'j1' })),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
  applyProposal: vi.fn(), discardProposal: vi.fn(),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { BrandPage } = await import('../src/screens/BrandPage.tsx');
const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };

beforeEach(() => {
  vi.clearAllMocks();
  overview = {
    kit: { ...EMPTY_BRAND_KIT, colors: [{ id: 'blu', name: 'Blu', hex: '#1E3A5F', role: 'primary', source: site }] },
    kitError: null, guidelines: 'Tono diretto', sources: [{ id: 's-1', kind: 'website', url: 'https://acme.example', file: null, addedAt: '2026-10-07T10:00:00.000Z', lastAnalyzedAt: null }],
    sourcesError: null, proposals: [], jobKey: 'brand:k',
  };
});

describe('BrandPage', () => {
  it('shows the kit with sources and saves manual edits as manual', async () => {
    render(<BrandPage slug="acme" live={live} />);
    await waitFor(() => screen.getByDisplayValue('Blu'));
    expect(screen.getByText('Sito: acme.example')).toBeTruthy();
    const hex = screen.getByLabelText('Hex colore 1');
    await userEvent.clear(hex);
    await userEvent.type(hex, '#112233');
    await userEvent.click(screen.getByRole('button', { name: 'Salva brand kit' }));
    await waitFor(() => expect(api.saveBrandKit).toHaveBeenCalled());
    const saved = api.saveBrandKit.mock.calls[0]![1] as typeof overview.kit;
    expect(saved.colors[0]).toMatchObject({ hex: '#112233', source: { kind: 'manual', ref: null } });
  });
  it('adds a website source and starts an analysis', async () => {
    render(<BrandPage slug="acme" live={live} />);
    await waitFor(() => screen.getByText('Mai analizzata'));
    await userEvent.type(screen.getByLabelText('Indirizzo del sito'), 'https://acme.example/chi-siamo');
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi sito' }));
    await waitFor(() => expect(api.addBrandSource).toHaveBeenCalledWith('acme', { kind: 'website', url: 'https://acme.example/chi-siamo' }));
    await userEvent.click(screen.getByRole('button', { name: 'Analizza brand' }));
    await waitFor(() => expect(api.analyzeBrand).toHaveBeenCalledWith('acme'));
  });
  it('shows progress for a running analysis and disables a corrupt kit', async () => {
    overview = { ...overview, kitError: 'brand-kit.json: JSON non valido' };
    render(<BrandPage slug="acme" live={{ ...live, jobs: { j1: { id: 'j1', key: 'brand:k', label: 'Analisi brand', state: 'running', createdAt: '2026-10-07T10:00:00.000Z' } } }} />);
    await waitFor(() => screen.getByText('Analisi in corso…'));
    expect(screen.getByRole('alert').textContent).toContain('non è leggibile');
    expect((screen.getByRole('button', { name: 'Analizza brand' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '+ Colore' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(api.cancelJob).toHaveBeenCalledWith('j1');
  });
  it('keeps unsaved kit edits when a source is added or guidelines are saved', async () => {
    render(<BrandPage slug="acme" live={live} />);
    await waitFor(() => screen.getByDisplayValue('Blu'));
    await userEvent.type(screen.getByLabelText('Nome colore 1'), 'x');
    await userEvent.type(screen.getByLabelText('Indirizzo del sito'), 'https://b.example');
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi sito' }));
    await waitFor(() => expect(api.getBrand).toHaveBeenCalledTimes(2));
    await userEvent.type(screen.getByLabelText('Linee guida (Markdown)'), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Salva linee guida' }));
    await waitFor(() => expect(api.getBrand).toHaveBeenCalledTimes(3));
    await waitFor(() => expect((screen.getByLabelText('Linee guida (Markdown)') as HTMLTextAreaElement).value).toBe('Tono diretto!'));
    expect((screen.getByLabelText('Nome colore 1') as HTMLInputElement).value).toBe('Blux');
    expect((screen.getByRole('button', { name: 'Salva linee guida' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('lets font weights be typed freely and parses them', async () => {
    overview.kit = { ...overview.kit, fonts: [{ id: 'f1', family: 'Inter', role: 'body', weights: [400], file: null, source: site }] };
    render(<BrandPage slug="acme" live={live} />);
    await waitFor(() => screen.getByDisplayValue('Inter'));
    const w = screen.getByLabelText('Pesi font 1') as HTMLInputElement;
    await userEvent.clear(w);
    await userEvent.type(w, '400, 700');
    expect(w.value).toBe('400, 700');
    await userEvent.tab();
    expect(w.value).toBe('400, 700');
    await userEvent.click(screen.getByRole('button', { name: 'Salva brand kit' }));
    await waitFor(() => expect(api.saveBrandKit).toHaveBeenCalled());
    expect((api.saveBrandKit.mock.calls[0]![1] as typeof overview.kit).fonts[0]!.weights).toEqual([400, 700]);
  });
});

const bjob = (over: Partial<JobSummary>): JobSummary => ({ id: 'j1', key: 'brand:k', label: 'Analisi brand', state: 'running', createdAt: '2026-10-07T10:00:00.000Z', ...over });
const proposal = (createdAt: string) => ({ schemaVersion: 1 as const, id: 'p-1', createdAt, sourceIds: [], status: 'applied' as const, summary: '', changes: [], guidelines: null, assetsAdded: [] });

describe('BrandPage (final review)', () => {
  it('shows roles, variants and backgrounds in Italian', async () => {
    overview.kit = { ...overview.kit, fonts: [{ id: 'f1', family: 'Inter', role: 'heading', weights: [400], file: null, source: site }], logos: [{ id: 'l1', file: 'assets/logo.svg', variant: 'mono', background: 'dark', source: site }] };
    render(<BrandPage slug="acme" live={live} />);
    await screen.findByDisplayValue('Blu');
    expect((screen.getByLabelText('Ruolo colore 1') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Primario');
    expect((screen.getByLabelText('Ruolo font 1') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Titoli');
    expect((screen.getByLabelText('Variante logo 1') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Monocromatico');
    expect((screen.getByLabelText('Sfondo logo 1') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Scuro');
  });
  it('names a running describe job as such', async () => {
    render(<BrandPage slug="acme" live={{ ...live, jobs: { j1: bjob({ label: 'Descrizione asset' }) } }} />);
    await screen.findByText('Descrizione in corso…');
    expect(screen.queryByText('Analisi in corso…')).toBeNull();
  });
  it('shows a failed analysis only while no newer proposal exists', async () => {
    const failed = { j1: bjob({ state: 'failed', error: 'boom', createdAt: '2026-10-07T10:00:00.000Z' }) };
    const { unmount } = render(<BrandPage slug="acme" live={{ ...live, jobs: failed }} />);
    await screen.findByText('Analisi non riuscita: boom');
    unmount();
    overview.proposals = [proposal('2026-10-07T11:00:00.000Z')];
    render(<BrandPage slug="acme" live={{ ...live, jobs: failed }} />);
    await screen.findByDisplayValue('Blu');
    expect(screen.queryByText(/Analisi non riuscita/)).toBeNull();
  });
  it('reports a failed describe job as a description failure', async () => {
    render(<BrandPage slug="acme" live={{ ...live, jobs: { j1: bjob({ label: 'Descrizione asset', state: 'failed', error: 'boom' }) } }} />);
    await screen.findByText('Descrizione non riuscita: boom');
    expect(screen.queryByText(/Analisi non riuscita/)).toBeNull();
  });
});

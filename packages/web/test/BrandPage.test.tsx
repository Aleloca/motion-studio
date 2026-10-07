import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_BRAND_KIT, type BrandOverview } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const site = { kind: 'website' as const, ref: 'https://acme.example' };
let overview: BrandOverview;
const api = {
  getBrand: vi.fn(async () => overview),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })),
  saveBrandKit: vi.fn(async (_s: string, k: unknown) => k),
  saveGuidelines: vi.fn(async () => ({ ok: true })),
  addBrandSource: vi.fn(async () => ({})),
  removeBrandSource: vi.fn(async () => ({ ok: true })),
  analyzeBrand: vi.fn(async () => ({ id: 'j1' })),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
  applyProposal: vi.fn(), discardProposal: vi.fn(),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { BrandPage } = await import('../src/screens/BrandPage.tsx');
const live = { jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };

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
});

import type { JobSummary } from '@motion-studio/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const at = '2026-10-07T10:00:00.000Z';
let listing: { assets: unknown[]; error: string | null; unregistered: string[] };
const api = {
  listAssets: vi.fn(async () => structuredClone(listing)),
  getBrand: vi.fn(async (): Promise<{ jobKey: string }> => ({ jobKey: 'brand:k' })),
  uploadFiles: vi.fn(async () => ({})),
  registerAssets: vi.fn(async () => ({ assets: [] })),
  describeAssets: vi.fn(async (): Promise<unknown> => ({ id: 'j' })),
  updateAsset: vi.fn(async (_s: string, file: string, patch: object) => {
    const a = (listing.assets as Array<{ file: string }>).find((x) => x.file === file);
    Object.assign(a ?? {}, patch);
    return { file, ...patch };
  }),
  deleteAsset: vi.fn(async () => ({ ok: true })),
  cancelJob: vi.fn(),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { AssetsPage } = await import('../src/screens/AssetsPage.tsx');
const live = { jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };

beforeEach(() => {
  vi.clearAllMocks();
  listing = {
    error: null, unregistered: ['manual.png'],
    assets: [
      { file: 'logo.svg', kind: 'svg', origin: 'website', sourceUrl: 'https://acme.example/logo.svg', description: 'Logo principale', tags: ['logo'], width: null, height: null, addedAt: at },
      { file: 'foto.jpg', kind: 'image', origin: 'upload', sourceUrl: null, description: '', tags: [], width: 1920, height: 1080, addedAt: at },
    ],
  };
});

describe('AssetsPage', () => {
  it('filters, opens the detail and saves metadata', async () => {
    render(<AssetsPage slug="acme" live={live} />);
    await waitFor(() => screen.getByRole('button', { name: 'Apri logo.svg' }));
    expect(screen.getByText('1920×1080')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Origine'), 'website');
    expect(screen.queryByRole('button', { name: 'Apri foto.jpg' })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Origine'), 'all');
    await userEvent.type(screen.getByLabelText('Cerca negli asset'), 'LOGO');
    expect(screen.queryByRole('button', { name: 'Apri foto.jpg' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Apri logo.svg' }));
    const panel = screen.getByLabelText('Dettaglio asset');
    expect(within(panel).getByRole('link', { name: 'https://acme.example/logo.svg' })).toBeTruthy();
    const tags = within(panel).getByLabelText('Tag (separati da virgola)');
    await userEvent.clear(tags);
    await userEvent.type(tags, 'logo, principale');
    await userEvent.click(within(panel).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(api.updateAsset).toHaveBeenCalledWith('acme', 'logo.svg', { tags: ['logo', 'principale'] }));
  });
  it('registers unregistered files, deletes and asks for descriptions', async () => {
    render(<AssetsPage slug="acme" live={live} />);
    await waitFor(() => screen.getByText('1 file nella cartella assets/ non sono registrati'));
    await userEvent.click(screen.getByRole('button', { name: 'Registra' }));
    await waitFor(() => expect(api.registerAssets).toHaveBeenCalledWith('acme', ['manual.png']));
    await userEvent.click(screen.getByRole('button', { name: "Descrivi con l'agente" }));
    await waitFor(() => expect(api.describeAssets).toHaveBeenCalledWith('acme'));
    await userEvent.click(screen.getByRole('button', { name: 'Apri foto.jpg' }));
    await userEvent.click(within(screen.getByLabelText('Dettaglio asset')).getByRole('button', { name: 'Elimina' }));
    expect(api.deleteAsset).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByLabelText('Dettaglio asset')).getByRole('button', { name: 'Conferma eliminazione' }));
    await waitFor(() => expect(api.deleteAsset).toHaveBeenCalledWith('acme', 'foto.jpg'));
  });
  it('shows a corrupt listing and disables uploads', async () => {
    listing = { assets: [], unregistered: [], error: 'assets.json: JSON non valido' };
    render(<AssetsPage slug="acme" live={live} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('assets.json'));
    expect(screen.getByRole('button', { name: 'Carica asset' }).getAttribute('aria-disabled')).toBe('true');
  });
  it('keeps in-progress edits across live reloads and reseeds after saving', async () => {
    const { rerender } = render(<AssetsPage slug="acme" live={live} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Apri logo.svg' }));
    const desc = within(screen.getByLabelText('Dettaglio asset')).getByLabelText('Descrizione') as HTMLTextAreaElement;
    await userEvent.type(desc, ' extra');
    const reloads = api.listAssets.mock.calls.length;
    rerender(<AssetsPage slug="acme" live={{ ...live, projectTicks: { acme: 1 } }} />);
    await waitFor(() => expect(api.listAssets.mock.calls.length).toBeGreaterThan(reloads));
    expect((screen.getByLabelText('Descrizione') as HTMLTextAreaElement).value).toBe('Logo principale extra');
    await userEvent.click(within(screen.getByLabelText('Dettaglio asset')).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(api.updateAsset).toHaveBeenCalledWith('acme', 'logo.svg', { description: 'Logo principale extra' }));
    // saved: a later external change is picked up again
    await waitFor(() => expect(api.listAssets.mock.calls.length).toBeGreaterThan(reloads + 1));
    (listing.assets[0] as { description: string }).description = 'Aggiornato altrove';
    rerender(<AssetsPage slug="acme" live={{ ...live, projectTicks: { acme: 2 } }} />);
    await waitFor(() => expect((screen.getByLabelText('Descrizione') as HTMLTextAreaElement).value).toBe('Aggiornato altrove'));
  });
});

const job = (over: Partial<JobSummary>): JobSummary => ({ id: 'j1', key: 'brand:k', label: 'Descrizione asset', state: 'running', createdAt: at, ...over });

describe('AssetsPage (final review)', () => {
  afterEach(() => vi.useRealTimers());
  it('shows the asset kinds in Italian', async () => {
    render(<AssetsPage slug="acme" live={live} />);
    await screen.findByRole('button', { name: 'Apri logo.svg' });
    const kinds = within(screen.getByLabelText('Tipo')).getAllByRole('option').map((o) => o.textContent);
    expect(kinds).toEqual(['Tutti', 'Immagine', 'SVG', 'Video', 'Font', 'Audio', 'Altro']);
  });
  it('names the running brand job by its kind', async () => {
    const { rerender } = render(<AssetsPage slug="acme" live={{ ...live, jobs: { j1: job({}) } }} />);
    await screen.findByText('Descrizione in corso…');
    rerender(<AssetsPage slug="acme" live={{ ...live, jobs: { j1: job({ label: 'Analisi brand' }) } }} />);
    await screen.findByText('Analisi in corso…');
    expect(screen.queryByText('Descrizione in corso…')).toBeNull();
    rerender(<AssetsPage slug="acme" live={{ ...live, jobs: { j1: job({ state: 'failed', error: 'boom' }) } }} />);
    await screen.findByText('Descrizione non riuscita: boom');
    rerender(<AssetsPage slug="acme" live={{ ...live, jobs: { j1: job({ state: 'succeeded', notes: ["L'agente ha provato a modificare direttamente brand/brand-kit.json: modifica annullata"] }) } }} />);
    await screen.findByText("L'agente ha provato a modificare direttamente brand/brand-kit.json: modifica annullata");
  });
  it('disables the describe button when the job key is unknown and a brand job runs, and surfaces a 409', async () => {
    api.getBrand.mockRejectedValueOnce(new Error('brand-kit.json rotto'));
    const { rerender } = render(<AssetsPage slug="acme" live={{ ...live, jobs: { j1: job({ key: 'brand:/w:acme', label: 'Analisi brand' }) } }} />);
    await screen.findByRole('button', { name: 'Apri logo.svg' });
    expect((screen.getByRole('button', { name: "Descrivi con l'agente" }) as HTMLButtonElement).disabled).toBe(true);
    api.describeAssets.mockRejectedValueOnce(new Error("Un'analisi del brand o una descrizione degli asset è già in corso per questo progetto"));
    rerender(<AssetsPage slug="acme" live={live} />);
    await userEvent.click(screen.getByRole('button', { name: "Descrivi con l'agente" }));
    expect((await screen.findByRole('alert')).textContent).toContain('già in corso');
  });
  it('asks for confirmation before deleting and reverts after 5 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<AssetsPage slug="acme" live={live} />);
    await user.click(await screen.findByRole('button', { name: 'Apri foto.jpg' }));
    const panel = screen.getByLabelText('Dettaglio asset');
    await user.click(within(panel).getByRole('button', { name: 'Elimina' }));
    expect(within(panel).getByRole('button', { name: 'Conferma eliminazione' })).toBeTruthy();
    vi.advanceTimersByTime(5100);
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Elimina' })).toBeTruthy());
    expect(api.deleteAsset).not.toHaveBeenCalled();
  });
  it('closes the detail when the selected file disappears after a reload', async () => {
    const { rerender } = render(<AssetsPage slug="acme" live={live} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Apri foto.jpg' }));
    listing.assets = listing.assets.filter((a) => (a as { file: string }).file !== 'foto.jpg');
    rerender(<AssetsPage slug="acme" live={{ ...live, projectTicks: { acme: 1 } }} />);
    await waitFor(() => expect(screen.queryByLabelText('Dettaglio asset')).toBeNull());
    // the same name coming back later does not reopen it
    listing.assets.push({ file: 'foto.jpg', kind: 'image', origin: 'upload', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: at });
    rerender(<AssetsPage slug="acme" live={{ ...live, projectTicks: { acme: 2 } }} />);
    await screen.findByRole('button', { name: 'Apri foto.jpg' });
    expect(screen.queryByLabelText('Dettaglio asset')).toBeNull();
  });
});

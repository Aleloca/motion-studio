import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = { exportVersion: vi.fn(async (..._a: unknown[]) => ({ destination: '/Users/me/Consegna', files: [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }], skipped: [] as string[] })) };
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ExportDialog } = await import('../src/components/ExportDialog.tsx');

const bridge = (revealPath = vi.fn(async () => {})) => {
  (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => '/Users/me/Consegna', revealPath };
  return revealPath;
};

afterEach(() => { delete (window as unknown as { motionStudio?: unknown }).motionStudio; vi.clearAllMocks(); });

describe('ExportDialog', () => {
  it('exports to a typed folder in the browser', async () => {
    render(<ExportDialog slug="acme" creative="c1" version={2} onClose={() => {}} />);
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    await userEvent.type(screen.getByLabelText('Cartella di destinazione (percorso assoluto)'), '/Users/me/Consegna');
    await userEvent.click(screen.getByRole('button', { name: 'Esporta' }));
    await waitFor(() => expect(screen.getByText('Esportati 2 file in /Users/me/Consegna')).toBeTruthy());
    expect(api.exportVersion).toHaveBeenCalledWith('acme', 'c1', 2, '/Users/me/Consegna');
    expect(screen.queryByRole('button', { name: 'Mostra nella cartella' })).toBeNull();
    expect(screen.queryByText(/Non esportati/)).toBeNull();
  });
  it('uses the native picker and reveal in the app', async () => {
    const revealPath = bridge();
    render(<ExportDialog slug="acme" creative="c1" version={2} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Scegli cartella…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Esporta' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mostra nella cartella' }));
    expect(revealPath).toHaveBeenCalledWith('/Users/me/Consegna');
  });
  it('lists skipped outputs, shows errors and closes on Escape', async () => {
    api.exportVersion.mockResolvedValueOnce({ destination: '/d', files: [{ from: 'a', to: 'b' }], skipped: ['x.mp4', 'y.png'] });
    api.exportVersion.mockRejectedValueOnce(new Error('Cartella non valida'));
    const onClose = vi.fn();
    render(<ExportDialog slug="acme" creative="c1" version={1} onClose={onClose} />);
    const input = screen.getByLabelText('Cartella di destinazione (percorso assoluto)');
    await userEvent.type(input, '/d');
    await userEvent.click(screen.getByRole('button', { name: 'Esporta' }));
    expect((await screen.findByText('Non esportati: x.mp4, y.png')).closest('[role="status"]')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Esporta' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Cartella non valida');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
  it('keeps the typed value when the picker is cancelled, and disables Esporta when empty', async () => {
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => null, revealPath: async () => {} };
    render(<ExportDialog slug="acme" creative="c1" version={2} onClose={() => {}} />);
    expect((screen.getByRole('button', { name: 'Esporta' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Cartella di destinazione (percorso assoluto)'), '/typed');
    await userEvent.click(screen.getByRole('button', { name: 'Scegli cartella…' }));
    expect((screen.getByLabelText('Cartella di destinazione (percorso assoluto)') as HTMLInputElement).value).toBe('/typed');
  });
  it('shows an alert when the picker rejects', async () => {
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => { throw new Error('Selettore non disponibile'); }, revealPath: async () => {} };
    render(<ExportDialog slug="acme" creative="c1" version={2} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Scegli cartella…' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Selettore non disponibile');
  });
  it('clears the previous result when the destination is edited, and Escape works while exporting', async () => {
    const onClose = vi.fn();
    render(<ExportDialog slug="acme" creative="c1" version={2} onClose={onClose} />);
    const input = screen.getByLabelText('Cartella di destinazione (percorso assoluto)');
    await userEvent.type(input, '/a');
    await userEvent.click(screen.getByRole('button', { name: 'Esporta' }));
    await screen.findByText(/Esportati 2 file/);
    await userEvent.type(input, 'b');
    expect(screen.queryByText(/Esportati/)).toBeNull();
    let release: () => void = () => {};
    api.exportVersion.mockImplementationOnce(() => new Promise((r) => { release = () => r({ destination: '/ab', files: [], skipped: [] }); }));
    await userEvent.click(screen.getByRole('button', { name: 'Esporta' }));
    expect((screen.getByRole('button', { name: 'Esporta' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    release();
  });
});

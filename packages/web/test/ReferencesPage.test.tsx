import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const api = {
  listReferences: vi.fn(async () => ({ references: [{ file: 'mood.jpg', note: '', useForBrand: true, addedAt: '2026-10-07T10:00:00.000Z' }], error: null })),
  uploadFiles: vi.fn(async () => ({})),
  updateReference: vi.fn(async () => ({})),
  deleteReference: vi.fn(async () => ({ ok: true })),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ReferencesPage } = await import('../src/screens/ReferencesPage.tsx');

describe('ReferencesPage', () => {
  it('edits notes, toggles brand use and deletes', async () => {
    render(<ReferencesPage slug="acme" live={{ jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} }} />);
    const note = await screen.findByLabelText('Nota per mood.jpg');
    await userEvent.type(note, 'Luce calda');
    note.blur();
    await waitFor(() => expect(api.updateReference).toHaveBeenCalledWith('acme', 'mood.jpg', { note: 'Luce calda' }));
    await userEvent.click(screen.getByRole('checkbox', { name: "Usa per l'analisi brand" }));
    await waitFor(() => expect(api.updateReference).toHaveBeenCalledWith('acme', 'mood.jpg', { useForBrand: false }));
    await userEvent.click(screen.getByRole('button', { name: 'Elimina mood.jpg' }));
    expect(api.deleteReference).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Conferma eliminazione di mood.jpg' }));
    await waitFor(() => expect(api.deleteReference).toHaveBeenCalledWith('acme', 'mood.jpg'));
  });
  it('keeps a note being typed across a live reload', async () => {
    const live = { jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };
    const { rerender } = render(<ReferencesPage slug="acme" live={live} />);
    const note = await screen.findByLabelText('Nota per mood.jpg');
    await userEvent.type(note, 'Bozza');
    const calls = api.listReferences.mock.calls.length;
    rerender(<ReferencesPage slug="acme" live={{ ...live, projectTicks: { acme: 1 } }} />);
    await waitFor(() => expect(api.listReferences.mock.calls.length).toBeGreaterThan(calls));
    expect((screen.getByLabelText('Nota per mood.jpg') as HTMLTextAreaElement).value).toBe('Bozza');
  });
});

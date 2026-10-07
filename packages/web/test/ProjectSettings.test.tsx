import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const at = '2026-10-07T10:00:00.000Z';
const proj = (name: string) => ({ slug: 'acme', jobKey: 'k', project: { schemaVersion: 1, name, description: '', createdAt: at, updatedAt: at, linkedCodebases: [] } });
const api = {
  getProject: vi.fn(),
  getCodebases: vi.fn(async () => []),
  updateProject: vi.fn(async () => ({})),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ProjectSettings } = await import('../src/screens/ProjectSettings.tsx');

beforeEach(() => { vi.clearAllMocks(); api.getProject.mockResolvedValue(proj('Acme')); });

describe('ProjectSettings', () => {
  it('keeps in-progress edits across tick reloads and reseeds after saving', async () => {
    const { rerender } = render(<ProjectSettings slug="acme" tick={0} />);
    const input = (await screen.findByLabelText('Nome')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('Acme'));
    await userEvent.clear(input);
    await userEvent.type(input, 'Nuovo');
    api.getProject.mockResolvedValue(proj('Dal server'));
    rerender(<ProjectSettings slug="acme" tick={1} />);
    await waitFor(() => expect(api.getProject).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Nuovo');
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Dal server'));
    expect(screen.getByRole('status').textContent).toBe('Salvato');
  });
  it('shows save errors as alert', async () => {
    api.updateProject.mockRejectedValueOnce(new Error('Percorso non valido'));
    render(<ProjectSettings slug="acme" tick={0} />);
    await screen.findByLabelText('Nome');
    await userEvent.click(screen.getByRole('button', { name: 'Salva' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Percorso non valido');
  });
});

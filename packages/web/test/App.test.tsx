import type { DoctorCheck, WorkspaceInfo } from '@motion-studio/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.ts';
import { App } from '../src/App.tsx';

vi.mock('../src/api.ts', () => ({
  ApiError: class extends Error {},
  api: {
    getDoctor: vi.fn(),
    getWorkspace: vi.fn(),
    updateSettings: vi.fn(),
    listProjects: vi.fn(() => Promise.resolve([])),
  },
}));

class FakeWebSocket {
  onmessage: unknown; onclose: unknown; onerror: unknown;
  close() {}
}

const okChecks: DoctorCheck[] = [{ id: 'git', label: 'Git', ok: true, required: true, message: 'Installato' }];
const settings = { schemaVersion: 1 as const, maxConcurrentJobs: 2, expertMode: false, theme: 'system' as const, model: null };

function start(workspace: Promise<WorkspaceInfo>, doctor: Promise<DoctorCheck[]> = Promise.resolve(okChecks)) {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.mocked(api.getDoctor).mockReturnValue(doctor);
  vi.mocked(api.getWorkspace).mockReturnValue(workspace);
  render(<App />);
}

describe('App startup', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
  it('shows an alert in onboarding when the server is unreachable', async () => {
    start(Promise.reject(new Error('Failed to fetch')), Promise.reject(new Error('Failed to fetch')));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Impossibile contattare il server di Motion Studio: Failed to fetch');
    expect(screen.queryByText('Controllo in corso…')).toBeNull();
  });
  it('explains a workspace folder that no longer exists and prefills its path', async () => {
    start(Promise.resolve({ path: '/Users/me/Studio', settings: null, error: { code: 'not-found', message: 'Cartella del workspace non trovata: /Users/me/Studio' } }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("Cartella non trovata: /Users/me/Studio, scegline un'altra");
    expect(screen.getByLabelText<HTMLInputElement>('Cartella di lavoro').value).toBe('/Users/me/Studio');
    expect(alert.textContent).not.toContain('Impossibile contattare');
  });
  it('explains invalid workspace content', async () => {
    start(Promise.resolve({ path: '/w', settings: null, error: { code: 'invalid', message: '/w/.studio/settings.json: JSON non valido' } }));
    expect((await screen.findByRole('alert')).textContent).toBe('Contenuto non valido in /w: /w/.studio/settings.json: JSON non valido');
  });
  it('shows an error when saving settings fails', async () => {
    start(Promise.resolve({ path: '/w', settings, error: null }));
    vi.mocked(api.updateSettings).mockRejectedValue(new Error('disco pieno'));
    await userEvent.click(await screen.findByLabelText('Modalità esperto'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Impossibile salvare le impostazioni: disco pieno'));
  });
});

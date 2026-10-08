import type { DoctorCheck, WorkspaceInfo } from '@motion-studio/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.ts';
import { App } from '../src/App.tsx';
import { captureUiToken, markPairingNeeded, resetUiTokenForTests } from '../src/uiToken.ts';

vi.mock('../src/api.ts', () => ({
  ApiError: class extends Error {},
  api: {
    getDoctor: vi.fn(),
    getWorkspace: vi.fn(),
    updateSettings: vi.fn(),
    listProjects: vi.fn(() => Promise.resolve([])),
    getSecrets: vi.fn(() => Promise.resolve([])),
  },
}));

class FakeWebSocket {
  onmessage: unknown; onclose: unknown; onerror: unknown;
  close() {}
}

const okChecks: DoctorCheck[] = [{ id: 'git', label: 'Git', ok: true, required: true, message: 'Installato' }];
const settings = { schemaVersion: 1 as const, maxConcurrentJobs: 2, expertMode: false, theme: 'system' as const, model: null, sandboxMode: 'auto' as const, extraAllowedDomains: [] as string[], confirmPaidProviders: true };

function start(workspace: Promise<WorkspaceInfo>, doctor: Promise<DoctorCheck[]> = Promise.resolve(okChecks)) {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.mocked(api.getDoctor).mockReturnValue(doctor);
  vi.mocked(api.getWorkspace).mockReturnValue(workspace);
  render(<App />);
}

describe('App startup', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); history.replaceState(null, '', '/'); });
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
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Cartella di lavoro').value).toBe('/Users/me/Studio'));
    expect(alert.textContent).not.toContain('Impossibile contattare');
  });
  it('explains invalid workspace content', async () => {
    start(Promise.resolve({ path: '/w', settings: null, error: { code: 'invalid', message: '/w/.studio/settings.json: JSON non valido' } }));
    expect((await screen.findByRole('alert')).textContent).toBe('Contenuto non valido in /w: /w/.studio/settings.json: JSON non valido');
  });
  it('shows an error when saving settings fails', async () => {
    history.replaceState(null, '', '/#/settings');
    start(Promise.resolve({ path: '/w', settings, error: null }));
    vi.mocked(api.updateSettings).mockRejectedValue(new Error('disco pieno'));
    // Expert mode and the theme moved from the top bar to Settings.
    await userEvent.click(await screen.findByRole('switch', { name: 'Modalità esperto' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('disco pieno'));
  });
  it('does not show onboarding when only the optional sandbox check fails', async () => {
    const checks: DoctorCheck[] = [...okChecks, { id: 'sandbox', label: 'Sandbox', ok: false, required: false, message: 'Non disponibile' }];
    start(Promise.resolve({ path: '/w', settings, error: null }), Promise.resolve(checks));
    expect(await screen.findByRole('button', { name: /^Attività/ })).toBeTruthy();
    expect(screen.queryByText('Benvenuto in Motion Studio')).toBeNull();
  });
});

describe('App pairing and notifications', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); resetUiTokenForTests(); });
  it('shows a full page asking to open the app from the terminal link when the token is refused', async () => {
    start(Promise.resolve({ path: '/w', settings, error: null }));
    await screen.findByRole('button', { name: /^Attività/ });
    act(() => markPairingNeeded());
    expect(await screen.findByText('Apri Motion Studio dal link mostrato nel terminale')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Attività/ })).toBeNull();
    const loads = vi.mocked(api.getWorkspace).mock.calls.length;
    history.replaceState(null, '', `/#t=${'ef'.repeat(32)}`);
    act(() => { captureUiToken(); });
    expect(await screen.findByRole('button', { name: /^Attività/ })).toBeTruthy();
    expect(vi.mocked(api.getWorkspace).mock.calls.length).toBeGreaterThan(loads);
    localStorage.clear();
    history.replaceState(null, '', '/');
  });
  it('survives a Notification constructor that throws', async () => {
    let sockets: FakeEventsSocket[] = [];
    class FakeEventsSocket { onmessage: ((e: { data: string }) => void) | null = null; onclose: unknown; onerror: unknown; constructor() { sockets.push(this); } close() {} }
    class ThrowingNotification { static permission = 'granted'; constructor() { throw new Error('Illegal constructor'); } }
    vi.stubGlobal('Notification', ThrowingNotification);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    vi.mocked(api.getDoctor).mockReturnValue(Promise.resolve(okChecks));
    vi.mocked(api.getWorkspace).mockReturnValue(Promise.resolve({ path: '/w', settings, error: null }));
    vi.stubGlobal('WebSocket', FakeEventsSocket);
    render(<App />);
    await screen.findByRole('button', { name: /^Attività/ });
    const approval = { id: 'a1', jobId: 'j1', projectSlug: 'acme', creativeSlug: null, kind: 'tool', title: 'Eseguire un comando', detail: 'ls', toolName: 'Bash', alwaysRule: null, createdAt: 'x', expiresAt: '2026-10-08T10:10:00.000Z' };
    act(() => sockets.at(-1)!.onmessage!({ data: JSON.stringify({ type: 'approval', approval }) }));
    expect(await screen.findByRole('button', { name: 'Attività, 1 in attesa' })).toBeTruthy();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    sockets = [];
  });
});

describe('Onboarding sandbox check', () => {
  it('shows the optional sandbox check with the Consigliato badge, message and fix', async () => {
    const { Onboarding } = await import('../src/screens/Onboarding.tsx');
    render(<Onboarding checks={[{ id: 'sandbox', label: 'Sandbox', ok: false, required: false, message: 'Non disponibile', fix: 'installa bubblewrap' }]} workspacePath={null} onRecheck={() => {}} onWorkspaceSet={() => {}} />);
    expect(screen.getByText('Consigliato')).toBeTruthy();
    expect(screen.getByText(/Non disponibile/)).toBeTruthy();
    expect(screen.getByText('installa bubblewrap')).toBeTruthy();
  });
});

describe('Onboarding native picker', () => {
  it('fills the workspace path from the folder picker in the app', async () => {
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => '/Users/me/MS', revealPath: async () => {} };
    try {
      const { Onboarding } = await import('../src/screens/Onboarding.tsx');
      render(<Onboarding checks={[]} workspacePath={null} onRecheck={() => {}} onWorkspaceSet={() => {}} />);
      await userEvent.click(screen.getByRole('button', { name: 'Scegli cartella…' }));
      expect((screen.getByLabelText('Cartella di lavoro') as HTMLInputElement).value).toBe('/Users/me/MS');
    } finally { delete (window as unknown as { motionStudio?: unknown }).motionStudio; }
  });
});

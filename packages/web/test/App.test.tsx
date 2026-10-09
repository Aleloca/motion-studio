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
    setWorkspace: vi.fn(),
    createProject: vi.fn(),
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
const settings = { schemaVersion: 1 as const, maxConcurrentJobs: 2, expertMode: false, theme: 'system' as const, model: null, sandboxMode: 'auto' as const, extraAllowedDomains: [] as string[], confirmPaidProviders: true, autoApproveSandboxed: true };

function start(workspace: Promise<WorkspaceInfo>, doctor: Promise<DoctorCheck[]> = Promise.resolve(okChecks)) {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.mocked(api.getDoctor).mockReturnValue(doctor);
  vi.mocked(api.getWorkspace).mockReturnValue(workspace);
  render(<App />);
}

describe('App startup', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); history.replaceState(null, '', '/'); });
  it('shows an alert in the setup when the server is unreachable', async () => {
    start(Promise.reject(new Error('Failed to fetch')), Promise.reject(new Error('Failed to fetch')));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Impossibile contattare il server di Motion Studio: Failed to fetch');
    expect(screen.queryByText('Controllo in corso…')).toBeNull();
  });
  it('explains a workspace folder that no longer exists and prefills its path', async () => {
    start(Promise.resolve({ path: '/Users/me/Studio', settings: null, error: { code: 'not-found', message: 'Cartella del workspace non trovata: /Users/me/Studio' } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Continua' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("Cartella non trovata: /Users/me/Studio, scegline un'altra");
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Cartella').value).toBe('/Users/me/Studio'));
    expect(alert.textContent).not.toContain('Impossibile contattare');
  });
  it('explains invalid workspace content', async () => {
    start(Promise.resolve({ path: '/w', settings: null, error: { code: 'invalid', message: '/w/.studio/settings.json: JSON non valido' } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Continua' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Contenuto non valido in /w: /w/.studio/settings.json: JSON non valido');
  });
  it('shows an error when saving settings fails', async () => {
    history.replaceState(null, '', '/#/settings');
    start(Promise.resolve({ path: '/w', settings, error: null }));
    vi.mocked(api.updateSettings).mockRejectedValue(new Error('disco pieno'));
    // The theme moved from the top bar to Settings → General.
    await userEvent.click(await screen.findByRole('radio', { name: 'Scuro' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Impossibile salvare le impostazioni: disco pieno'));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
  it('the theme chosen in Settings changes data-theme', async () => {
    history.replaceState(null, '', '/#/settings/general');
    start(Promise.resolve({ path: '/w', settings, error: null }));
    vi.mocked(api.updateSettings).mockImplementation(async (patch) => ({ ...settings, ...patch }));
    await userEvent.click(await screen.findByRole('radio', { name: 'Scuro' }));
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
    expect(api.updateSettings).toHaveBeenCalledWith({ theme: 'dark' });
    expect(screen.getByRole('radio', { name: 'Scuro' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('radio', { name: 'Sistema' }));
    await waitFor(() => expect(document.documentElement.hasAttribute('data-theme')).toBe(false));
    // Expert mode is gone (spec §3.2).
    expect(screen.queryByText(/esperto/i)).toBeNull();
  });
  it('sends an old Agent console link to the project creatives, without a history entry', () => {
    history.replaceState(null, '', '/#/p/acme/console');
    const length = history.length;
    start(new Promise(() => {}));
    expect(location.hash).toBe('#/p/acme');
    expect(history.length).toBe(length);
  });
  it('does not show the setup when only the optional sandbox check fails', async () => {
    const checks: DoctorCheck[] = [...okChecks, { id: 'sandbox', label: 'Sandbox', ok: false, required: false, message: 'Non disponibile' }];
    start(Promise.resolve({ path: '/w', settings, error: null }), Promise.resolve(checks));
    expect(await screen.findByRole('button', { name: /^Attività/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Controlla il sistema' })).toBeNull();
  });
  it('keeps the setup open after the workspace is saved, until the first project step is done', async () => {
    start(Promise.resolve({ path: null, settings: null, error: null }));
    vi.mocked(api.setWorkspace).mockResolvedValue({ path: '/w', settings });
    await userEvent.click(await screen.findByRole('button', { name: 'Continua' }));
    await userEvent.type(screen.getByLabelText('Cartella'), '/w');
    await userEvent.click(screen.getByRole('button', { name: 'Continua' }));
    expect(await screen.findByRole('heading', { name: 'Crea il primo progetto' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Attività/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Salta per ora' }));
    expect(await screen.findByRole('button', { name: /^Attività/ })).toBeTruthy();
    expect(location.hash).toBe('#/');
  });
  it('opens the setup when a required check fails even with a valid workspace', async () => {
    const failing: DoctorCheck[] = [{ id: 'git', label: 'Git', ok: false, required: true, message: 'Non trovato', fix: 'brew install git' }];
    start(Promise.resolve({ path: '/w', settings, error: null }), Promise.resolve(failing));
    expect(await screen.findByRole('heading', { name: 'Controlla il sistema' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Attività/ })).toBeNull();
    expect(await screen.findByText('brew install git')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Continua' }).disabled).toBe(true);
  });
  it('slides from the setup to the projects with T1 (deeper: in from the right)', async () => {
    const frames: Array<{ el: Element; f: Keyframe[] }> = [];
    const orig = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, f: Keyframe[]) {
      frames.push({ el: this, f });
      return { finished: Promise.resolve(), cancel() {} } as unknown as Animation;
    } as never;
    try {
      history.replaceState(null, '', '/#/welcome');
      start(Promise.resolve({ path: '/w', settings, error: null }));
      await screen.findByRole('heading', { name: 'Controlla il sistema' });
      frames.length = 0;
      await userEvent.click(screen.getByRole('link', { name: 'Home di Motion Studio' }));
      expect(await screen.findByRole('button', { name: /^Attività/ })).toBeTruthy();
      const pages = frames.filter((x) => x.el.classList.contains('ms-page')).map((x) => String(x.f[0]?.transform));
      // depth welcome 0 → projects 1: the setup leaves to the left, the projects come in from +24 px.
      expect(pages).toContain('translate(24px,0px) scale(1)');
      expect(frames.some((x) => x.el.classList.contains('ms-page') && String(x.f[1]?.transform) === 'translate(-16px,0px)')).toBe(true);
    } finally { Element.prototype.animate = orig; }
  });
  it('opens the setup again from Replay setup and leads back to the projects', async () => {
    history.replaceState(null, '', '/#/welcome');
    start(Promise.resolve({ path: '/w', settings, error: null }));
    expect(await screen.findByRole('heading', { name: 'Controlla il sistema' })).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: 'Home di Motion Studio' }));
    expect(await screen.findByRole('button', { name: /^Attività/ })).toBeTruthy();
  });
});

describe('App pairing and notifications', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); resetUiTokenForTests(); });
  it('shows a full page asking to open the app from the terminal link when the token is refused', async () => {
    start(Promise.resolve({ path: '/w', settings, error: null }));
    await screen.findByRole('button', { name: /^Attività/ });
    act(() => markPairingNeeded());
    expect(await screen.findByRole('heading', { name: 'Apri Motion Studio dal link nel terminale' })).toBeTruthy();
    expect(screen.getByText('npx @motion-studio/cli --print-url')).toBeTruthy();
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
    const approval = { id: 'a1', jobId: 'j1', projectSlug: 'acme', creativeSlug: null, kind: 'tool', title: 'Eseguire un comando', detail: 'ls', toolName: 'Bash', alwaysRule: null, explanation: null, agentReason: null, createdAt: 'x', expiresAt: '2026-10-08T10:10:00.000Z' };
    act(() => sockets.at(-1)!.onmessage!({ data: JSON.stringify({ type: 'approval', approval }) }));
    expect(await screen.findByRole('button', { name: 'Attività, 1 in attesa' })).toBeTruthy();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    sockets = [];
  });
});


import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { workspaceSettingsSchema } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const statuses = [
  { provider: 'openai', configured: true, source: 'keychain' },
  { provider: 'elevenlabs', configured: false, source: null },
  { provider: 'pexels', configured: true, source: 'env' },
  { provider: 'unsplash', configured: false, source: null },
];
const api = {
  getSecrets: vi.fn(async () => statuses),
  setSecret: vi.fn(async () => ({ provider: 'elevenlabs', configured: true, source: 'keychain' })),
  deleteSecret: vi.fn(async () => ({ provider: 'openai', configured: false, source: null })),
  updateSettings: vi.fn(async (patch: object) => workspaceSettingsSchema.parse({ schemaVersion: 1, ...patch })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { SettingsPage } = await import('../src/screens/SettingsPage.tsx');
const settings = workspaceSettingsSchema.parse({ schemaVersion: 1 });
const checks = [{ id: 'sandbox' as const, label: 'Sandbox', ok: true, required: false, message: 'ok' }];

beforeEach(() => vi.clearAllMocks());

describe('SettingsPage', () => {
  it('shows key status without values and saves a new key', async () => {
    render(<SettingsPage settings={settings} checks={checks} onSaved={() => {}} />);
    await waitFor(() => screen.getByText('Configurata nel portachiavi'));
    expect(screen.getByText('Gestita da PEXELS_API_KEY')).toBeTruthy();
    expect((screen.getByLabelText('Nuova chiave Pexels') as HTMLInputElement).disabled).toBe(true);
    const input = screen.getByLabelText('Nuova chiave ElevenLabs') as HTMLInputElement;
    expect(input.type).toBe('password');
    await userEvent.type(input, 'xi-123');
    await userEvent.click(screen.getByRole('button', { name: 'Salva chiave ElevenLabs' }));
    await waitFor(() => expect(api.setSecret).toHaveBeenCalledWith('elevenlabs', 'xi-123'));
    expect(input.value).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Rimuovi chiave OpenAI' }));
    expect(api.deleteSecret).toHaveBeenCalledWith('openai');
  });
  it('updates security, costs and domains', async () => {
    const onSaved = vi.fn();
    render(<SettingsPage settings={settings} checks={checks} onSaved={onSaved} />);
    expect(screen.getByText("Sandbox attiva: l'agente lavora isolato nella cartella del progetto")).toBeTruthy();
    await userEvent.click(screen.getByLabelText('Chiedi conferma prima di usare provider a pagamento'));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ confirmPaidProviders: false }));
    await userEvent.selectOptions(screen.getByLabelText("Isolamento dell'agente"), 'off');
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ sandboxMode: 'off' }));
    await userEvent.type(screen.getByLabelText('Dominio da consentire'), 'api.acme.io');
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi dominio' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ extraAllowedDomains: ['api.acme.io'] }));
    expect(onSaved).toHaveBeenCalled();
  });
  it('says the sandbox is active only when it is on in the settings and available', () => {
    const active = "Sandbox attiva: l'agente lavora isolato nella cartella del progetto";
    const { unmount } = render(<SettingsPage settings={{ ...settings, sandboxMode: 'off' }} checks={checks} onSaved={() => {}} />);
    expect(screen.queryByText(active)).toBeNull();
    unmount();
    render(<SettingsPage settings={settings} checks={[{ ...checks[0]!, ok: false, message: 'Isolamento disattivato nelle Impostazioni' }]} onSaved={() => {}} />);
    expect(screen.queryByText(active)).toBeNull();
    expect(screen.getByText('Isolamento disattivato nelle Impostazioni')).toBeTruthy();
  });
  it('lists the stored domains that were ignored because invalid', () => {
    render(<SettingsPage settings={{ ...settings, droppedDomains: ['printer.local', '*.co.uk'] }} checks={checks} onSaved={() => {}} />);
    expect(screen.getByText('Domini ignorati perché non validi: printer.local, *.co.uk')).toBeTruthy();
  });
});

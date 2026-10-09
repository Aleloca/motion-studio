import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { workspaceSettingsSchema, type DoctorCheck, type ServerMessage } from '@motion-studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = {
  getDoctor: vi.fn(),
  getWorkspace: vi.fn(),
  getSecrets: vi.fn(async () => []),
  setLanguage: vi.fn(),
  listProjects: vi.fn(() => Promise.resolve([])),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { App } = await import('../src/App.tsx');
const { I18nProvider, formatDate, formatNumber, formatWhen, useLocale, useT } = await import('../src/i18n.tsx');
const { AppSettings } = await import('../src/screens/AppSettings.tsx');
const { markPairingNeeded, resetUiTokenForTests } = await import('../src/uiToken.ts');
const { browserLanguages } = await import('./setup-locale.ts');

const sockets: FakeWebSocket[] = [];
class FakeWebSocket {
  onmessage: ((e: { data: string }) => void) | null = null; onclose: unknown; onerror: unknown;
  constructor() { sockets.push(this); }
  close() {}
}
const send = (msg: ServerMessage) => act(() => { sockets[0]!.onmessage!({ data: JSON.stringify(msg) }); });
const checks: DoctorCheck[] = [{ id: 'git', label: 'Git', ok: true, required: true, message: 'ok' }];
const settings = workspaceSettingsSchema.parse({ schemaVersion: 1 });

function Probe() {
  const t = useT();
  return <span>{useLocale()}:{t.common.cancel}</span>;
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); sockets.length = 0; document.documentElement.lang = ''; history.replaceState(null, '', '/'); });

describe('I18nProvider', () => {
  it('serves the catalog of its locale and sets the document language', () => {
    const { rerender } = render(<I18nProvider locale="en"><Probe /></I18nProvider>);
    expect(screen.getByText('en:Cancel')).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
    rerender(<I18nProvider locale="it"><Probe /></I18nProvider>);
    expect(screen.getByText('it:Annulla')).toBeTruthy();
    expect(document.documentElement.lang).toBe('it');
  });
  it('formats dates and numbers with the locale', () => {
    expect(formatDate('en', '2026-10-08T10:00:00.000Z', { timeZone: 'UTC' })).toBe('10/8/2026');
    expect(formatDate('it', '2026-10-08T10:00:00.000Z', { timeZone: 'UTC' })).toBe('08/10/2026');
    expect(formatDate('en', 'not a date')).toBe('not a date');
    expect(formatNumber('it', 2, { minimumFractionDigits: 1 })).toBe('2,0');
    expect(formatNumber('en', 2, { minimumFractionDigits: 1 })).toBe('2.0');
  });
});

describe('formatWhen (relative dates, A4)', () => {
  // Local times: "today" and "yesterday" are calendar days where the user is.
  const now = new Date(2026, 9, 9, 15, 0).getTime();
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString();
  it('says today with the time, yesterday, then the date', () => {
    expect(formatWhen('en', at(9, 14, 28), now)).toBe('today 14:28');
    expect(formatWhen('it', at(9, 14, 28), now)).toBe('oggi 14:28');
    expect(formatWhen('en', at(8, 23, 50), now)).toBe('yesterday');
    expect(formatWhen('it', at(8, 9, 0), now)).toBe('ieri');
    expect(formatWhen('en', at(7, 9, 0), now)).toBe(formatDate('en', at(7, 9, 0), { day: 'numeric', month: 'short' }));
    expect(formatWhen('en', new Date(2025, 0, 3).toISOString(), now)).toBe(formatDate('en', new Date(2025, 0, 3).toISOString(), { day: 'numeric', month: 'short', year: 'numeric' }));
    expect(formatWhen('en', 'not a date', now)).toBe('not a date');
  });
});

describe('language switching', () => {
  it('follows the snapshot and the locale event without reloading', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    api.getDoctor.mockResolvedValue(checks);
    api.getWorkspace.mockResolvedValue({ path: '/w', settings, error: null });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Attività' })).toBeTruthy();
    await send({ type: 'snapshot', jobs: [], approvals: [], locale: 'en', languageSetting: 'system', systemLocale: 'en' });
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(await screen.findByRole('button', { name: 'Activity' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attività' })).toBeNull();
    await send({ type: 'locale', locale: 'it', setting: 'it', systemLocale: 'en' });
    await waitFor(() => expect(document.documentElement.lang).toBe('it'));
    expect(await screen.findByRole('button', { name: 'Attività' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
  });
  it('applies the result of a change made in Settings without waiting for the server event', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    history.replaceState(null, '', '/#/settings');
    api.getDoctor.mockResolvedValue(checks);
    api.getWorkspace.mockResolvedValue({ path: '/w', settings, error: null });
    api.setLanguage.mockResolvedValue({ locale: 'en', languageSetting: 'en', systemLocale: 'it' });
    render(<App />);
    await send({ type: 'snapshot', jobs: [], approvals: [], locale: 'it', languageSetting: 'system', systemLocale: 'it' });
    await userEvent.click(await screen.findByRole('button', { name: 'Lingua Sistema (Italiano)' }));
    await userEvent.click(screen.getByRole('option', { name: 'English' }));
    expect(await screen.findByRole('heading', { name: 'General' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
    await userEvent.click(screen.getByRole('button', { name: 'Language English' }));
    expect(screen.getByRole('option', { name: 'English' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('option', { name: 'System (Italiano)' })).toBeTruthy();
  });
  it('labels System with the language the core resolved, not the browser one', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    history.replaceState(null, '', '/#/settings');
    api.getDoctor.mockResolvedValue(checks);
    api.getWorkspace.mockResolvedValue({ path: '/w', settings, error: null });
    render(<App />);
    await send({ type: 'snapshot', jobs: [], approvals: [], locale: 'en', languageSetting: 'system', systemLocale: 'en' });
    expect(await screen.findByRole('button', { name: 'Language System (English)' })).toBeTruthy();
    await send({ type: 'locale', locale: 'it', setting: 'system', systemLocale: 'en' });
    expect(await screen.findByRole('button', { name: 'Lingua Sistema (English)' })).toBeTruthy();
  });
  it('reloads the doctor checks in the new language', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    history.replaceState(null, '', '/#/settings/system');
    let lang: 'it' | 'en' = 'it';
    const sandbox = (): DoctorCheck[] => [...checks, { id: 'sandbox', label: 'Sandbox', ok: false, required: false, message: lang === 'it' ? 'Sandbox non disponibile' : 'Sandbox unavailable' }];
    api.getDoctor.mockImplementation(async () => sandbox());
    api.getWorkspace.mockResolvedValue({ path: '/w', settings, error: null });
    render(<App />);
    expect(await screen.findByText('Sandbox non disponibile')).toBeTruthy();
    await send({ type: 'snapshot', jobs: [], approvals: [], locale: 'it', languageSetting: 'system', systemLocale: 'it' });
    expect(api.getDoctor).toHaveBeenCalledTimes(1);
    lang = 'en';
    await send({ type: 'locale', locale: 'en', setting: 'en', systemLocale: 'it' });
    expect(await screen.findByText('Sandbox unavailable')).toBeTruthy();
    expect(screen.queryByText('Sandbox non disponibile')).toBeNull();
    expect(api.getDoctor).toHaveBeenCalledTimes(2);
  });
  it('before the first snapshot follows the browser, English when it has no languages', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    browserLanguages([]);
    api.getDoctor.mockResolvedValue(checks);
    api.getWorkspace.mockResolvedValue({ path: '/w', settings, error: null });
    render(<App />);
    act(() => markPairingNeeded());
    try {
      expect(await screen.findByRole('heading', { name: 'Open Motion Studio from the link in your terminal' })).toBeTruthy();
    } finally { resetUiTokenForTests(); }
  });
});

describe('language selector', () => {
  const page = (onLanguage = vi.fn()) => (
    <I18nProvider locale="en">
      <AppSettings section="general" settings={settings} checks={checks} checking={false} checksRun={1} loadError={null} onRecheck={() => {}}
        language="system" systemLocale="it" onLanguage={onLanguage} onSettings={() => {}} />
    </I18nProvider>
  );
  it('lists System with the detected language and each language in its own', async () => {
    render(page());
    await userEvent.click(screen.getByRole('button', { name: 'Language System (Italiano)' }));
    const list = screen.getByRole('listbox', { name: 'Language' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['System (Italiano)', 'English', 'Italiano']);
    expect(within(list).getByRole('option', { name: /^System/ }).getAttribute('aria-selected')).toBe('true');
  });
  it('saves the choice and applies it at once', async () => {
    api.setLanguage.mockResolvedValue({ locale: 'it', languageSetting: 'it', systemLocale: 'en' });
    const onLanguage = vi.fn();
    render(page(onLanguage));
    await userEvent.click(screen.getByRole('button', { name: 'Language System (Italiano)' }));
    await userEvent.click(screen.getByRole('option', { name: 'Italiano' }));
    await waitFor(() => expect(onLanguage).toHaveBeenCalledWith({ locale: 'it', setting: 'it', systemLocale: 'en' }));
    expect(api.setLanguage).toHaveBeenCalledWith('it');
  });
  it('shows why a change failed', async () => {
    api.setLanguage.mockRejectedValue(new Error('boom'));
    render(page());
    await userEvent.click(screen.getByRole('button', { name: 'Language System (Italiano)' }));
    await userEvent.click(screen.getByRole('option', { name: 'English' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Language not changed: boom');
  });
});


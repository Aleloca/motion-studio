import { act, render, screen, waitFor } from '@testing-library/react';
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
const { I18nProvider, formatDate, formatNumber, useLocale, useT } = await import('../src/i18n.tsx');
const { SettingsPage } = await import('../src/screens/SettingsPage.tsx');

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

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); sockets.length = 0; document.documentElement.lang = ''; });

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

describe('language switching', () => {
  it('follows the snapshot and the locale event without reloading', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    api.getDoctor.mockResolvedValue(checks);
    api.getWorkspace.mockResolvedValue({ path: '/w', settings, error: null });
    render(<App />);
    expect(await screen.findByText('Impostazioni')).toBeTruthy();
    await send({ type: 'snapshot', jobs: [], approvals: [], locale: 'en', languageSetting: 'system' });
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    await send({ type: 'locale', locale: 'it', setting: 'it' });
    await waitFor(() => expect(document.documentElement.lang).toBe('it'));
  });
});

describe('language selector', () => {
  it('lists System with the detected language and each language in its own', () => {
    render(<I18nProvider locale="en"><SettingsPage settings={settings} checks={checks} language="system" onLanguage={() => {}} onSaved={() => {}} /></I18nProvider>);
    const group = screen.getByRole('radiogroup', { name: 'Language' });
    expect(group.textContent).toMatch(/^System \((English|Italiano)\)EnglishItaliano$/);
    expect(screen.getByRole('radio', { name: /^System/ }).getAttribute('aria-checked')).toBe('true');
  });
  it('saves the choice and applies it at once', async () => {
    api.setLanguage.mockResolvedValue({ locale: 'it', languageSetting: 'it' });
    const onLanguage = vi.fn();
    render(<I18nProvider locale="en"><SettingsPage settings={settings} checks={checks} language="system" onLanguage={onLanguage} onSaved={() => {}} /></I18nProvider>);
    await userEvent.click(screen.getByRole('radio', { name: 'Italiano' }));
    await waitFor(() => expect(onLanguage).toHaveBeenCalledWith({ locale: 'it', setting: 'it' }));
    expect(api.setLanguage).toHaveBeenCalledWith('it');
  });
  it('shows why a change failed', async () => {
    api.setLanguage.mockRejectedValue(new Error('boom'));
    render(<I18nProvider locale="en"><SettingsPage settings={settings} checks={checks} language="system" onLanguage={() => {}} onSaved={() => {}} /></I18nProvider>);
    await userEvent.click(screen.getByRole('radio', { name: 'English' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Language not changed: boom');
  });
});

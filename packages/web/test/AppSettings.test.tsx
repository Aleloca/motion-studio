import { workspaceSettingsSchema, type DoctorCheck, type JobSummary, type SecretStatus } from '@motion-studio/shared';
import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import type { SettingsSection } from '../src/routes.ts';
import { __resetToasts, getToasts } from '../src/ui/toast.tsx';

let secrets: SecretStatus[];
const api = {
  getSecrets: vi.fn(async () => structuredClone(secrets)),
  setSecret: vi.fn(async (provider: SecretStatus['provider']) => {
    secrets = secrets.map((s) => (s.provider === provider ? { provider, configured: true, source: 'keychain' } : s));
    return { provider, configured: true, source: 'keychain' as const };
  }),
  deleteSecret: vi.fn(async (provider: SecretStatus['provider']) => {
    secrets = secrets.map((s) => (s.provider === provider ? { provider, configured: false, source: null } : s));
    return { provider, configured: false, source: null };
  }),
  setLanguage: vi.fn(),
  updateSettings: vi.fn(),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { AppSettings } = await import('../src/screens/AppSettings.tsx');
const { useReadyNotice } = await import('../src/shell/useAttention.ts');
const { NOTIFY_APPROVALS_KEY, NOTIFY_READY_KEY } = await import('../src/shell/notify.ts');

const settings = workspaceSettingsSchema.parse({ schemaVersion: 1 });
const okChecks: DoctorCheck[] = [
  { id: 'claude', label: 'Claude Code', ok: true, required: true, version: '2.1.293', message: 'Installed' },
  { id: 'sandbox', label: 'Sandbox', ok: true, required: false, message: 'macOS Seatbelt' },
];
const failing: DoctorCheck[] = [
  ...okChecks,
  { id: 'ffmpeg', label: 'FFmpeg', ok: false, required: true, message: 'FFmpeg is not installed', fix: 'brew install ffmpeg' },
];
const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);
const onRecheck = vi.fn();
const onLanguage = vi.fn();
const page = (section: SettingsSection, checks: DoctorCheck[] | null = okChecks) => (
  <AppSettings section={section} settings={settings} checks={checks} checking={false} checksRun={1} loadError={null} onRecheck={onRecheck}
    language="system" systemLocale="en" onLanguage={onLanguage} onSettings={() => {}} />
);

beforeEach(() => {
  __resetToasts();
  localStorage.clear();
  secrets = [
    { provider: 'openai', configured: true, source: 'keychain' },
    { provider: 'elevenlabs', configured: false, source: null },
    { provider: 'pexels', configured: true, source: 'env' },
    { provider: 'unsplash', configured: false, source: null },
  ];
});
afterEach(() => { vi.clearAllMocks(); __resetToasts(); });

describe('App settings · navigation', () => {
  it('lists General, System check, Paid services, Notifications and Updates; no Usage', async () => {
    en(page('general'));
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const names = within(nav).getAllByRole('button').map((b) => b.textContent ?? '');
    expect(names.map((n) => n.replace(/[0-9. of]+$/, ''))).toEqual(['General', 'System check', 'Paid services', 'Notifications', 'Updates']);
    expect(screen.queryByText(/Usage/)).toBeNull();
    expect(screen.queryByText(/tokens/i)).toBeNull();
    await waitFor(() => expect(within(nav).getByText('2 of 4')).toBeTruthy());
    await userEvent.click(within(nav).getByRole('button', { name: /^Notifications/ }));
    expect(location.hash).toBe('#/settings/notifications');
  });

  it('has no expert mode anywhere', () => {
    en(page('general'));
    expect(screen.queryByText(/expert/i)).toBeNull();
  });
});

describe('App settings · general', () => {
  it('chooses the language from a list', async () => {
    api.setLanguage.mockResolvedValue({ locale: 'it', languageSetting: 'it', systemLocale: 'en' });
    en(page('general'));
    await userEvent.click(screen.getByRole('button', { name: /Language/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Italiano' }));
    await waitFor(() => expect(onLanguage).toHaveBeenCalledWith({ locale: 'it', setting: 'it', systemLocale: 'en' }));
    expect(api.setLanguage).toHaveBeenCalledWith('it');
  });

  it('shows the theme choices with previews, the current one checked', () => {
    en(page('general'));
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['System', 'Light', 'Dark']);
    expect(within(group).getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');
    expect(group.querySelectorAll('.ms-theme-preview')).toHaveLength(3);
  });

  it('points to where the workspace-wide agent settings live', () => {
    en(page('general'));
    expect(screen.getByText(/are in any project’s Settings, and apply to every project/)).toBeTruthy();
  });

  it('summarizes the system check, with a link to the details', async () => {
    en(page('general', failing));
    expect(screen.getByText('1 problem to fix')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onRecheck).toHaveBeenCalled();
  });
});

describe('App settings · system check', () => {
  it('shows a failed check with its remedy, and checks again', async () => {
    en(page('system', failing));
    expect(screen.getByRole('heading', { name: 'System check' })).toBeTruthy();
    expect(screen.getByText('FFmpeg is not installed')).toBeTruthy();
    expect(screen.getByText('brew install ffmpeg')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Check again' })[0]!);
    expect(onRecheck).toHaveBeenCalled();
  });
});

describe('App settings · paid services', () => {
  it('shows each key state and saves a new key, read back from the Keychain', async () => {
    en(page('paid'));
    const openai = (await screen.findByText('OpenAI')).closest('.ms-key') as HTMLElement;
    expect(within(openai).getByText('Key saved in the Keychain')).toBeTruthy();
    const pexels = screen.getByText('Pexels').closest('.ms-key') as HTMLElement;
    expect(within(pexels).getByText('From the PEXELS_API_KEY environment variable')).toBeTruthy();
    expect(within(pexels).queryByRole('button')).toBeNull();
    const eleven = screen.getByText('ElevenLabs').closest('.ms-key') as HTMLElement;
    expect(within(eleven).getByText('Not connected')).toBeTruthy();
    await userEvent.click(within(eleven).getByRole('button', { name: 'Add key' }));
    const save = within(eleven).getByRole('button', { name: 'Save' });
    expect(screen.queryByText(/test/i)).toBeNull();
    expect((save as HTMLButtonElement).disabled).toBe(true);
    const field = within(eleven).getByLabelText('ElevenLabs API key') as HTMLInputElement;
    expect(field.type).toBe('password');
    await userEvent.type(field, 'sk-secret');
    await userEvent.click(save);
    expect(api.setSecret).toHaveBeenCalledWith('elevenlabs', 'sk-secret');
    await waitFor(() => expect(api.getSecrets).toHaveBeenCalledTimes(2));
    expect(await within(eleven).findByText('Key saved in the Keychain')).toBeTruthy();
    expect(screen.queryByDisplayValue('sk-secret')).toBeNull();
    expect(getToasts().some((x) => x.text === 'ElevenLabs key saved in the Keychain')).toBe(true);
  });

  it('removes a key from the Keychain only after an inline confirmation', async () => {
    en(page('paid'));
    const openai = (await screen.findByText('OpenAI')).closest('.ms-key') as HTMLElement;
    await userEvent.click(within(openai).getByRole('button', { name: 'Remove OpenAI key' }));
    expect(api.deleteSecret).not.toHaveBeenCalled();
    expect(within(openai).getByText('Remove the OpenAI key?')).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Cancel');
    await userEvent.click(within(openai).getByRole('button', { name: 'Cancel' }));
    expect(within(openai).queryByText('Remove the OpenAI key?')).toBeNull();
    expect(api.deleteSecret).not.toHaveBeenCalled();
    await userEvent.click(within(openai).getByRole('button', { name: 'Remove OpenAI key' }));
    await userEvent.click(within(openai).getByRole('button', { name: 'Remove' }));
    expect(api.deleteSecret).toHaveBeenCalledWith('openai');
    expect(await within(openai).findByText('Not connected')).toBeTruthy();
  });

  it('explains a failed save', async () => {
    api.setSecret.mockRejectedValueOnce(new Error('keychain locked'));
    en(page('paid'));
    const eleven = (await screen.findByText('ElevenLabs')).closest('.ms-key') as HTMLElement;
    await userEvent.click(within(eleven).getByRole('button', { name: 'Add key' }));
    await userEvent.type(within(eleven).getByLabelText('ElevenLabs API key'), 'x{Enter}');
    expect((await within(eleven).findByRole('alert')).textContent).toBe('Key not saved: keychain locked');
  });
});

describe('App settings · notifications and updates', () => {
  it('stores the two notification switches in localStorage (approvals on by default)', async () => {
    en(page('notifications'));
    const approvals = screen.getByRole('switch', { name: 'Notify for approvals' });
    const ready = screen.getByRole('switch', { name: 'Notify when ready' });
    expect(approvals.getAttribute('aria-checked')).toBe('true');
    expect(ready.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(approvals);
    expect(localStorage.getItem(NOTIFY_APPROVALS_KEY)).toBe('false');
    await userEvent.click(ready);
    expect(localStorage.getItem(NOTIFY_READY_KEY)).toBe('false');
    expect(approvals.getAttribute('aria-checked')).toBe('false');
  });

  it('shows the version and how updates arrive, never claiming it is up to date, with no fake buttons', () => {
    en(page('updates'));
    expect(screen.getByText(`Motion Studio ${__APP_VERSION__}`)).toBeTruthy();
    expect(screen.getByText('The desktop app downloads updates automatically and asks you to restart.')).toBeTruthy();
    expect(screen.queryByText(/up to date/i)).toBeNull();
    const main = screen.getByRole('main');
    expect(within(main).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('notify when a creative is ready', () => {
  const job = (state: JobSummary['state'], kind: JobSummary['kind'] = 'creative'): Record<string, JobSummary> =>
    ({ j1: { id: 'j1', key: 'creative:acme/launch', kind, label: 'Summer launch', state, createdAt: '2026-10-08T10:00:00.000Z' } });
  const bridge = () => {
    const notify = vi.fn(async () => {});
    (window as unknown as { motionStudio: object }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: vi.fn(), revealPath: vi.fn(), notify, setBadge: vi.fn() };
    return notify;
  };
  afterEach(() => { delete (window as unknown as { motionStudio?: object }).motionStudio; vi.restoreAllMocks(); });

  it('notifies once when a creative job it saw running succeeds while the app is in the background', () => {
    const notify = bridge();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { rerender } = renderHook(({ jobs }) => useReadyNotice(jobs), { initialProps: { jobs: job('running') }, wrapper: ({ children }) => <I18nProvider locale="en">{children}</I18nProvider> });
    rerender({ jobs: job('succeeded') });
    rerender({ jobs: job('succeeded') });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ title: 'Motion Studio: creative ready', body: 'Summer launch' });
  });

  it('stays quiet when the setting is off, in the foreground, or for other jobs', () => {
    const notify = bridge();
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { rerender } = renderHook(({ jobs }) => useReadyNotice(jobs), { initialProps: { jobs: job('running') }, wrapper: ({ children }) => <I18nProvider locale="en">{children}</I18nProvider> });
    rerender({ jobs: job('succeeded') });
    focus.mockReturnValue(false);
    localStorage.setItem(NOTIFY_READY_KEY, 'false');
    rerender({ jobs: job('running') });
    rerender({ jobs: job('succeeded') });
    localStorage.clear();
    rerender({ jobs: job('running', 'brand-analysis') });
    rerender({ jobs: job('succeeded', 'brand-analysis') });
    expect(notify).not.toHaveBeenCalled();
  });
});

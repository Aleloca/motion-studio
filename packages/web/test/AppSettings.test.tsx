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
const { NOTIFY_APPROVALS_KEY, NOTIFY_READY_KEY, NOTIFY_SOUND_KEY } = await import('../src/shell/notify.ts');

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
  it('lists General, System check, Paid services, Usage, Notifications and Updates; no tokens on General', async () => {
    en(page('general'));
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const names = within(nav).getAllByRole('button').map((b) => b.textContent ?? '');
    expect(names.map((n) => n.replace(/[0-9. of]+$/, ''))).toEqual(['General', 'System check', 'Paid services', 'Usage', 'Notifications', 'Updates']);
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

  it('the "Play a sound" switch is on by default and persists', async () => {
    en(page('notifications'));
    const sound = screen.getByRole('switch', { name: 'Play a sound' });
    expect(sound.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(sound);
    expect(localStorage.getItem(NOTIFY_SOUND_KEY)).toBe('false');
    expect(sound.getAttribute('aria-checked')).toBe('false');
  });

  describe('test notification and visibility', () => {
    const setBridge = (b: object) => { (window as unknown as { motionStudio: object }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: vi.fn(), revealPath: vi.fn(), ...b }; };
    afterEach(() => { delete (window as unknown as { motionStudio?: object }).motionStudio; vi.unstubAllGlobals(); });

    it('desktop: the test button goes through notify with the validated args and the sound setting', async () => {
      const notify = vi.fn(async () => ({ shown: true }));
      setBridge({ notify, notifyStatus: async () => ({ supported: true }) });
      localStorage.setItem(NOTIFY_SOUND_KEY, 'false');
      en(page('notifications'));
      await userEvent.click(screen.getByRole('button', { name: 'Send a test notification' }));
      await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      expect(notify).toHaveBeenCalledWith({ title: 'Motion Studio: approval needed', body: 'Send a test notification', sound: false });
      expect((await screen.findByRole('status')).textContent).toBe('Sent: the system showed the notification.');
      expect(screen.getByText(/System Settings → Notifications → Motion Studio \(or Electron in development\)/)).toBeTruthy();
    });

    it.each([
      ['failed', { shown: false, reason: 'failed', detail: 'The operation couldn’t be completed. (UNErrorDomain error 1.)' }],
      ['timeout', { shown: false, reason: 'timeout' }],
      ['unsupported', { shown: false, reason: 'unsupported' }],
    ])('desktop: %s → "blocked or not shown", with where to allow it', async (_name, outcome) => {
      setBridge({ notify: vi.fn(async () => outcome), notifyStatus: async () => ({ supported: true }) });
      en(page('notifications'));
      await userEvent.click(screen.getByRole('button', { name: 'Send a test notification' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('The system blocked the notification or did not show it. Allow it in System Settings → Notifications → Motion Studio (or Electron in development) → Allow notifications.');
      if ('detail' in outcome) expect(alert.textContent).toContain('System message: The operation couldn’t be completed. (UNErrorDomain error 1.)');
      else expect(alert.textContent).not.toContain('System message');
      expect(screen.queryByText(/^Sent/)).toBeNull();
    });

    it('desktop: an older desktop app that answers nothing is "sent, not confirmed"', async () => {
      setBridge({ notify: vi.fn(async () => undefined), notifyStatus: async () => ({ supported: true }) });
      en(page('notifications'));
      await userEvent.click(screen.getByRole('button', { name: 'Send a test notification' }));
      expect((await screen.findByRole('status')).textContent).toBe('Sent, but this version of the desktop app cannot confirm that it was shown.');
    });

    it('desktop: a refusal from the main process is shown inline', async () => {
      setBridge({ notify: vi.fn(async () => { throw new Error('This system cannot show notifications.'); }), notifyStatus: async () => ({ supported: true }) });
      en(page('notifications'));
      await userEvent.click(screen.getByRole('button', { name: 'Send a test notification' }));
      expect((await screen.findByRole('alert', { name: '' })).textContent).toContain("Couldn't show the notification: This system cannot show notifications.");
    });

    it('desktop: unsupported platform says so', async () => {
      setBridge({ notify: vi.fn(), notifyStatus: async () => ({ supported: false }) });
      en(page('notifications'));
      expect(await screen.findByText('This system reports that it cannot show notifications.')).toBeTruthy();
    });

    it('web: denied permission is explained; default offers the permission request', async () => {
      class Denied { static permission = 'denied'; }
      vi.stubGlobal('Notification', Denied);
      en(page('notifications'));
      expect(await screen.findByText(/The browser blocks notifications for this page/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Allow notifications' })).toBeNull();
      vi.unstubAllGlobals();
      const requestPermission = vi.fn(async () => 'granted');
      class Ask { static permission = 'default'; static requestPermission = requestPermission; }
      vi.stubGlobal('Notification', Ask);
      document.body.innerHTML = '';
      en(page('notifications'));
      await userEvent.click(await screen.findByRole('button', { name: 'Allow notifications' }));
      expect(requestPermission).toHaveBeenCalled();
    });

    it('web: the test button shows the reason when permission is missing, and sends silent: !sound when granted', async () => {
      const made: Array<[string, unknown]> = [];
      class Granted { static permission = 'granted'; onshow: (() => void) | null = null; constructor(t: string, o: unknown) { made.push([t, o]); setTimeout(() => this.onshow?.(), 0); } }
      vi.stubGlobal('Notification', Granted);
      localStorage.setItem(NOTIFY_SOUND_KEY, 'false');
      en(page('notifications'));
      await userEvent.click(screen.getByRole('button', { name: 'Send a test notification' }));
      await waitFor(() => expect(made).toHaveLength(1));
      expect(made[0]![1]).toEqual({ body: 'Send a test notification', silent: true });
      expect((await screen.findByRole('status')).textContent).toBe('Sent: the system showed the notification.');
      vi.stubGlobal('Notification', class { static permission = 'denied'; });
      await userEvent.click(screen.getByRole('button', { name: 'Send a test notification' }));
      expect(await screen.findByText(/Couldn't show the notification: The browser blocks/)).toBeTruthy();
    });
  });

  it('web: an error event (or no show event) is "blocked or not shown"', async () => {
    class Failing { static permission = 'granted'; onerror: (() => void) | null = null; constructor() { setTimeout(() => this.onerror?.(), 0); } }
    vi.stubGlobal('Notification', Failing);
    try {
      en(page('notifications'));
      await userEvent.click(screen.getByRole('button', { name: 'Send a test notification' }));
      expect((await screen.findByRole('alert')).textContent).toContain('The browser or the system did not show the notification.');
    } finally { vi.unstubAllGlobals(); }
  });

  it('in the desktop app: the version and how updates arrive, never claiming it is up to date, with no fake buttons', () => {
    (window as unknown as { motionStudio: object }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: vi.fn(), revealPath: vi.fn() };
    try {
      en(page('updates'));
      expect(screen.getByText(`Motion Studio ${__APP_VERSION__}`)).toBeTruthy();
      expect(screen.getByText('The desktop app downloads updates automatically and asks you to restart.')).toBeTruthy();
      expect(screen.queryByText(/up to date/i)).toBeNull();
      const main = screen.getByRole('main');
      expect(within(main).queryAllByRole('button')).toHaveLength(0);
    } finally { delete (window as unknown as { motionStudio?: object }).motionStudio; }
  });

  it('in a browser: only the version (AS5), no sentence about the desktop app', () => {
    en(page('updates'));
    expect(screen.getByText(`Motion Studio ${__APP_VERSION__}`)).toBeTruthy();
    expect(screen.queryByText(/desktop app/i)).toBeNull();
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
    expect(notify).toHaveBeenCalledWith({ title: 'Motion Studio: creative ready', body: 'Summer launch', sound: true });
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

import { workspaceSettingsSchema, type DoctorCheck, type JobSummary, type KeyCheckResult, type RenderEngineStatus, type SecretStatus } from '@motion-studio/shared';
import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import type { SettingsSection } from '../src/routes.ts';
import { __resetToasts, getToasts } from '../src/ui/toast.tsx';

let secrets: SecretStatus[];
let checks: Record<string, KeyCheckResult | null>;
const restricted: KeyCheckResult = { provider: 'elevenlabs', checkedAt: '2026-10-13T10:00:00.000Z', capabilities: [
  { capability: 'key', status: 'ok' },
  { capability: 'account', status: 'missing', permission: 'user_read' },
  { capability: 'voices', status: 'missing', permission: 'voices_read' },
  { capability: 'tts', status: 'unverified', permission: 'text_to_speech' },
  { capability: 'sfx', status: 'unverified', permission: 'sound_generation' },
  { capability: 'music', status: 'missing', permission: 'music_generation' },
] };
const electron: RenderEngineStatus = { kind: 'electron', downloadable: false, download: { state: 'idle', bytes: 0, total: null } };
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
  checkSecret: vi.fn(async (provider: SecretStatus['provider']): Promise<KeyCheckResult> => checks[provider] ?? { provider, checkedAt: 'x', capabilities: [{ capability: 'key', status: 'ok' }] }),
  getKeyChecks: vi.fn(async () => structuredClone(checks)),
  getUpdatesState: vi.fn(async (): Promise<{ state: 'active' | 'off' | 'unknown' }> => ({ state: 'active' })),
  setLanguage: vi.fn(),
  updateSettings: vi.fn(),
  getRenderEngine: vi.fn(async (): Promise<RenderEngineStatus> => electron),
  getChromeDownloadInfo: vi.fn(async () => ({ version: '131.0.6778.85', sizeBytes: 98_765_432 })),
  downloadChrome: vi.fn(async (sizeBytes: number): Promise<RenderEngineStatus> => ({ kind: null, downloadable: true, download: { state: 'running', bytes: 0, total: sizeBytes } })),
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
  checks = { openai: null, elevenlabs: null, pexels: null, unsplash: null };
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

describe('App settings · system check · render engine (Task 8)', () => {
  const none: RenderEngineStatus = { kind: null, downloadable: true, download: { state: 'idle', bytes: 0, total: null } };
  afterEach(() => { api.getRenderEngine.mockImplementation(async () => electron); });
  it('desktop: the built-in Electron engine, nothing to download', async () => {
    en(page('system'));
    const row = (await screen.findByText('Built in (Electron)')).closest('.ms-engine') as HTMLElement;
    expect(within(row).getByText('Render engine')).toBeTruthy();
    expect(within(row).queryByRole('button')).toBeNull();
  });
  it('system Chrome with its version', async () => {
    api.getRenderEngine.mockResolvedValueOnce({ kind: 'system', version: '131.0.6778.86', downloadable: false, download: { state: 'idle', bytes: 0, total: null } });
    en(page('system'));
    expect(await screen.findByText('Google Chrome 131.0.6778.86')).toBeTruthy();
  });
  it('none: offers Chrome for Testing, and downloads only after the consent to the exact size', async () => {
    api.getRenderEngine.mockResolvedValue(none);
    en(page('system'));
    expect(await screen.findByText('Not available')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Download Chrome for Testing (about 100 MB)' }));
    // The offer reads the size; nothing is downloaded yet.
    expect(api.getChromeDownloadInfo).toHaveBeenCalledTimes(1);
    const consent = await screen.findByRole('group', { name: 'Download Chrome for Testing?' });
    expect(consent.textContent).toContain('131.0.6778.85');
    expect(consent.textContent).toContain('98.8 MB');
    expect(api.downloadChrome).not.toHaveBeenCalled();
    // Cancel: still nothing.
    await userEvent.click(within(consent).getByRole('button', { name: 'Cancel' }));
    expect(api.downloadChrome).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Download Chrome for Testing (about 100 MB)' }));
    const again = await screen.findByRole('group', { name: 'Download Chrome for Testing?' });
    api.getRenderEngine.mockResolvedValue({ kind: null, downloadable: true, download: { state: 'running', bytes: 49_382_716, total: 98_765_432 } });
    await userEvent.click(within(again).getByRole('button', { name: 'Download 98.8 MB' }));
    expect(api.downloadChrome).toHaveBeenCalledWith(98_765_432);
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50'), { timeout: 4000 });
    expect(screen.getByText('Downloading 49.4 MB of 98.8 MB')).toBeTruthy();
    api.getRenderEngine.mockResolvedValue({ kind: 'cft', version: '131.0.6778.85', downloadable: false, download: { state: 'done', bytes: 98_765_432, total: 98_765_432 } });
    expect(await screen.findByText('Chrome for Testing 131.0.6778.85', undefined, { timeout: 4000 })).toBeTruthy();
  });
  it('a failed download says why and offers it again', async () => {
    api.getRenderEngine.mockResolvedValueOnce({ ...none, download: { state: 'failed', bytes: 10, total: 98_765_432, error: 'the archive has no chrome-headless-shell' } });
    en(page('system'));
    expect(await screen.findByText(/The download failed: the archive has no chrome-headless-shell/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download Chrome for Testing (about 100 MB)' })).toBeTruthy();
  });
});

describe('App settings · paid services', () => {
  it('shows each key state and saves a new key, read back from the Keychain', async () => {
    en(page('paid'));
    const openai = (await screen.findByText('OpenAI')).closest('.ms-key') as HTMLElement;
    expect(within(openai).getByText('Key saved in the Keychain')).toBeTruthy();
    const pexels = screen.getByText('Pexels').closest('.ms-key') as HTMLElement;
    expect(within(pexels).getByText('From the PEXELS_API_KEY environment variable')).toBeTruthy();
    // A key from the environment can only be tested.
    expect(within(pexels).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Test the Pexels key']);
    const eleven = screen.getByText('ElevenLabs').closest('.ms-key') as HTMLElement;
    expect(within(eleven).getByText('Not connected')).toBeTruthy();
    await userEvent.click(within(eleven).getByRole('button', { name: 'Add key' }));
    const save = within(eleven).getByRole('button', { name: 'Save' });
    expect(within(eleven).queryByRole('button', { name: /test/i })).toBeNull();
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

  it('after saving it says "Saved · checking…", then shows the results per capability with the permissions to enable', async () => {
    checks.elevenlabs = restricted;
    let finish!: () => void;
    api.checkSecret.mockImplementationOnce(async () => { await new Promise<void>((r) => { finish = r; }); return restricted; });
    en(page('paid'));
    const eleven = (await screen.findByText('ElevenLabs')).closest('.ms-key') as HTMLElement;
    await userEvent.click(within(eleven).getByRole('button', { name: 'Add key' }));
    await userEvent.type(within(eleven).getByLabelText('ElevenLabs API key'), 'xi-secret-key{Enter}');
    expect(await within(eleven).findByText('Saved · checking…')).toBeTruthy();
    expect(api.setSecret).toHaveBeenCalledWith('elevenlabs', 'xi-secret-key');
    await waitFor(() => expect(api.checkSecret).toHaveBeenCalledWith('elevenlabs'));
    finish();
    const list = await within(eleven).findByRole('list', { name: 'What the ElevenLabs key can do' });
    // Restricted, not invalid: the key works, the read permissions are missing, generation is not verified.
    expect(within(list).getByText('Key · works')).toBeTruthy();
    expect(within(list).getByText('Account · missing')).toBeTruthy();
    expect(within(list).getByText('Voice-over · not verified')).toBeTruthy();
    expect(within(list).getByText('Music · missing')).toBeTruthy();
    expect(within(eleven).queryByText(/refused this key or the request/)).toBeNull();
    expect(within(eleven).queryByText('Saved · checking…')).toBeNull();
    const help = within(eleven).getByRole('region', { name: 'Permissions to enable' });
    for (const perm of ['text_to_speech', 'sound_generation', 'music_generation', 'voices_read', 'user_read']) expect(within(help).getByText(perm)).toBeTruthy();
    expect(within(eleven).getByText(/The first real use updates it/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('xi-secret-key');
  });

  it('"Test" re-runs the checks, also for a key from the environment, and shows earlier results on open', async () => {
    checks.openai = { provider: 'openai', checkedAt: 'x', capabilities: [{ capability: 'key', status: 'missing' }, { capability: 'images', status: 'missing' }, { capability: 'tts', status: 'missing' }] };
    en(page('paid'));
    const openai = (await screen.findByText('OpenAI')).closest('.ms-key') as HTMLElement;
    expect(await within(openai).findByText('The service refused this key or the request: check the key, or a region, organization or firewall restriction at the provider.')).toBeTruthy();
    expect(api.checkSecret).not.toHaveBeenCalled();
    const pexels = screen.getByText('Pexels').closest('.ms-key') as HTMLElement;
    checks.pexels = { provider: 'pexels', checkedAt: 'x', capabilities: [{ capability: 'key', status: 'error', detail: 'No answer within 15 s' }, { capability: 'search', status: 'error', detail: 'No answer within 15 s' }] };
    await userEvent.click(within(pexels).getByRole('button', { name: 'Test the Pexels key' }));
    expect(api.checkSecret).toHaveBeenCalledWith('pexels');
    expect(await within(pexels).findByText('Search · error')).toBeTruthy();
    expect(within(pexels).getByText('Some checks did not finish (No answer within 15 s). Press Test to try again.')).toBeTruthy();
    // An error is never shown as a missing permission.
    expect(within(pexels).queryByText(/refused this key or the request/)).toBeNull();
    expect(within(pexels).queryByRole('region', { name: 'Permissions to enable' })).toBeNull();
  });

  it('explains a failed test', async () => {
    api.checkSecret.mockRejectedValueOnce(new Error('core offline'));
    en(page('paid'));
    const openai = (await screen.findByText('OpenAI')).closest('.ms-key') as HTMLElement;
    await userEvent.click(within(openai).getByRole('button', { name: 'Test the OpenAI key' }));
    expect((await within(openai).findByRole('alert')).textContent).toBe('Test not run: core offline');
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
      // No "how to allow" under a notification the system did show.
      expect(screen.queryByText(/Development builds can't show system notifications/)).toBeNull();
    });

    const HOW = "macOS shows notifications only for the installed (signed) Motion Studio app: System Settings → Notifications → Motion Studio → Allow notifications. Development builds can't show system notifications.";
    it('desktop: before any test, the hint says where to allow them and that dev builds cannot', async () => {
      setBridge({ notify: vi.fn(), notifyStatus: async () => ({ supported: true }) });
      en(page('notifications'));
      expect(await screen.findByText(HOW)).toBeTruthy();
      expect(screen.queryByText(/Electron/)).toBeNull();
    });

    it('desktop: failed → a refusal with where to allow it and the system message (the hint is not repeated)', async () => {
      setBridge({ notify: vi.fn(async () => ({ shown: false, reason: 'failed', detail: 'The operation couldn’t be completed. (UNErrorDomain error 1.)' })), notifyStatus: async () => ({ supported: true }) });
      en(page('notifications'));
      await userEvent.click(screen.getByRole('button', { name: 'Send a test notification' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(`The system refused the notification. ${HOW}`);
      expect(alert.textContent).toContain('System message: The operation couldn’t be completed. (UNErrorDomain error 1.)');
      expect(screen.getAllByText(HOW, { exact: false })).toHaveLength(1);
      expect(screen.queryByText(/^Sent/)).toBeNull();
    });

    it('desktop: timeout → "no answer", told apart from a refusal', async () => {
      setBridge({ notify: vi.fn(async () => ({ shown: false, reason: 'timeout' })), notifyStatus: async () => ({ supported: true }) });
      en(page('notifications'));
      await userEvent.click(screen.getByRole('button', { name: 'Send a test notification' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('No answer from the system. If macOS asked for permission, answer the prompt and try again.');
      expect(alert.textContent).not.toContain('refused');
      expect(alert.textContent).not.toContain('System message');
      expect(screen.getByText(HOW)).toBeTruthy();
    });

    it('desktop: unsupported → the system cannot show notifications', async () => {
      setBridge({ notify: vi.fn(async () => ({ shown: false, reason: 'unsupported' })), notifyStatus: async () => ({ supported: true }) });
      en(page('notifications'));
      await userEvent.click(screen.getByRole('button', { name: 'Send a test notification' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('This system reports that it cannot show notifications.');
      expect(alert.textContent).not.toContain('refused');
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

  it('in the desktop app: the version and how updates arrive, never claiming it is up to date, with no fake buttons', async () => {
    (window as unknown as { motionStudio: object }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: vi.fn(), revealPath: vi.fn() };
    try {
      en(page('updates'));
      expect(screen.getByText(`Motion Studio ${__APP_VERSION__}`)).toBeTruthy();
      expect(await screen.findByText('The desktop app downloads updates automatically and asks you to restart.')).toBeTruthy();
      expect(screen.queryByText(/up to date/i)).toBeNull();
      const main = screen.getByRole('main');
      expect(within(main).queryAllByRole('button')).toHaveLength(0);
    } finally { delete (window as unknown as { motionStudio?: object }).motionStudio; }
  });

  it('decision 802: a dev or unsigned desktop build says automatic updates are not active, no dialog and no button', async () => {
    (window as unknown as { motionStudio: object }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: vi.fn(), revealPath: vi.fn() };
    api.getUpdatesState.mockResolvedValueOnce({ state: 'off' });
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    try {
      en(page('updates'));
      expect(await screen.findByText('Automatic updates are not active in this version')).toBeTruthy();
      expect(screen.queryByText(/downloads updates automatically/)).toBeNull();
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(alert).not.toHaveBeenCalled();
      expect(within(screen.getByRole('main')).queryAllByRole('button')).toHaveLength(0);
    } finally { alert.mockRestore(); delete (window as unknown as { motionStudio?: object }).motionStudio; }
  });

  it('decision 802: the state unknown (or unreachable) claims nothing either way', async () => {
    (window as unknown as { motionStudio: object }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: vi.fn(), revealPath: vi.fn() };
    api.getUpdatesState.mockRejectedValueOnce(new Error('down'));
    try {
      en(page('updates'));
      await waitFor(() => expect(api.getUpdatesState).toHaveBeenCalled());
      expect(screen.queryByText(/updates/i, { selector: '.ms-set-sub' })).toBeNull();
    } finally { delete (window as unknown as { motionStudio?: object }).motionStudio; }
  });

  it('in a browser: only the version (AS5), no sentence about the desktop app', () => {
    en(page('updates'));
    expect(screen.getByText(`Motion Studio ${__APP_VERSION__}`)).toBeTruthy();
    expect(screen.queryByText(/desktop app/i)).toBeNull();
    expect(api.getUpdatesState).not.toHaveBeenCalled();
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

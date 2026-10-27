/**
 * User report 91: the first-run setup for a non-technical user. The API is a fake: nothing is installed, nothing reaches a
 * server. The rows come as the core sends them (the doctor's `action`, `waitsFor`, `technical`).
 */
import type { DoctorCheck, SetupStatus, SetupTaskState } from '@motion-studio/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const idle: SetupTaskState = { state: 'idle' };
const statusOf = (tasks: Partial<SetupStatus['tasks']> = {}, over: Partial<SetupStatus> = {}): SetupStatus => ({
  platform: 'windows', allowed: true, claudeManual: 'irm https://claude.ai/install.ps1 | iex',
  ffmpeg: { version: '9.0.2', source: 'gyan.dev', sizeBytes: 114_768_076, license: 'GPLv3' },
  tasks: { claudeInstall: idle, claudeLogin: idle, ffmpegInstall: idle, ...tasks }, ...over,
});
const api = {
  getSetup: vi.fn(async () => statusOf()),
  setupInstallClaude: vi.fn(async () => statusOf({ claudeInstall: { state: 'running' } })),
  setupSignIn: vi.fn(async () => statusOf({ claudeLogin: { state: 'running' } })),
  setupInstallFfmpeg: vi.fn(async () => statusOf({ ffmpegInstall: { state: 'running', bytes: 0, total: 114_768_076 } })),
  setupCancel: vi.fn(async () => statusOf({ claudeLogin: { state: 'cancelled' } })),
  setWorkspace: vi.fn(), listProjects: vi.fn(async () => []), createProject: vi.fn(), addBrandSource: vi.fn(), analyzeBrand: vi.fn(), setLanguage: vi.fn(),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { Welcome } = await import('../src/screens/Welcome.tsx');

/** What the doctor reports on Windows with only the Claude desktop app installed (the report's screenshot). */
const missing: DoctorCheck[] = [
  { id: 'node', label: 'Node.js', required: true, ok: true, version: '24.9.0', message: 'Supported version', technical: true },
  { id: 'git', label: 'Git', required: true, ok: true, version: '2.47.1', message: 'Installed' },
  { id: 'ffmpeg', label: 'FFmpeg', required: false, ok: false, message: 'Needed to export videos; images work without it.', fix: 'Download the build…', action: 'install-ffmpeg' },
  { id: 'claude', label: 'Claude Code', required: true, ok: false, message: 'Claude Code not found', fix: 'irm https://claude.ai/install.ps1 | iex', action: 'install-claude' },
  { id: 'claude-auth', label: 'Claude sign-in', required: true, ok: false, message: 'Install Claude Code first', waitsFor: 'claude' },
  { id: 'updates', label: 'Automatic updates', required: false, ok: true, info: true, message: 'Not active in this version', technical: true },
];

function setup(checks: DoctorCheck[]) {
  const onRecheck = vi.fn();
  const view = render(<I18nProvider locale="en"><Welcome checks={checks} loadError={null} workspace={{ path: null, settings: null, error: null }} onRecheck={onRecheck} onWorkspace={vi.fn()} onFinish={vi.fn()} /></I18nProvider>);
  return { onRecheck, view };
}
const row = (label: string) => screen.getByText(label, { selector: '.ms-syscheck-label' }).closest('li')!;
const flush = async (ms = 0) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => { vi.useFakeTimers(); api.getSetup.mockImplementation(async () => statusOf()); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('first-run setup (user report 91)', () => {
  it('lists only what is needed to start; the technical rows wait under a collapsed "Technical details"', async () => {
    setup(missing);
    await flush(3000);
    const main = screen.getByRole('list', { name: 'System checks' });
    expect(within(main).queryByText('Node.js')).toBeNull();
    expect(within(main).queryByText('Automatic updates')).toBeNull();
    const details = screen.getByText('Technical details').closest('details')!;
    expect(details.open).toBe(false);
    expect(within(details).getByText('Node.js')).toBeTruthy();
    expect(within(details).getByText('Automatic updates')).toBeTruthy();
  });

  it('the sign-in row waits for Claude Code: its message, no empty remedy box, no button', async () => {
    setup(missing);
    await flush(3000);
    const auth = row('Claude sign-in');
    expect(within(auth).getByText('Install Claude Code first')).toBeTruthy();
    expect(auth.querySelector('.ms-remedy')).toBeNull();
    expect(within(auth).queryByRole('button')).toBeNull();
  });

  it('says plainly that Claude Code needs a paid plan and that the desktop app alone is not enough', async () => {
    setup(missing);
    await flush(3000);
    expect(screen.getByText(/needs a paid Claude plan \(Pro, Max, Team or Enterprise\).*the free plan is not enough.*Claude desktop app alone is not enough/)).toBeTruthy();
  });

  it('Install Claude Code: a confirmation saying what runs, then the install, its progress, and the checks again when it ends', async () => {
    const { onRecheck } = setup(missing);
    await flush(3000);
    const claude = row('Claude Code');
    fireEvent.click(within(claude).getByRole('button', { name: 'Install Claude Code' }));
    // Nothing runs before the confirmation.
    expect(api.setupInstallClaude).not.toHaveBeenCalled();
    expect(within(claude).getByText(/Anthropic's official installer, downloaded from claude\.ai.*only Claude Code, just for your user, without administrator rights/)).toBeTruthy();
    api.getSetup.mockImplementation(async () => statusOf({ claudeInstall: { state: 'running' } }));
    fireEvent.click(within(claude).getByRole('button', { name: 'Install' }));
    await flush();
    expect(api.setupInstallClaude).toHaveBeenCalledTimes(1);
    expect(within(claude).getByText(/Installing Claude Code/)).toBeTruthy();
    expect(onRecheck).not.toHaveBeenCalled();
    api.getSetup.mockImplementation(async () => statusOf({ claudeInstall: { state: 'done' } }));
    await flush(1100);
    await flush();
    expect(onRecheck).toHaveBeenCalled();
  });

  it('a failed install: a short message, the troubleshooting link, and the manual command with Copy', async () => {
    api.getSetup.mockImplementation(async () => statusOf({ claudeInstall: { state: 'failed', error: 'exit' } }));
    setup(missing);
    await flush(3000);
    const claude = row('Claude Code');
    expect(within(claude).getByRole('alert').textContent).toContain("The install didn't finish");
    expect(within(claude).getByRole('link', { name: 'Installation help from Anthropic' }).getAttribute('href')).toBe('https://code.claude.com/docs/en/troubleshoot-install');
    const manual = within(claude).getByText('Prefer to do it by hand?').closest('details')!;
    expect(within(manual).getByText('irm https://claude.ai/install.ps1 | iex')).toBeTruthy();
    expect(within(manual).getByText(/Open PowerShell/)).toBeTruthy();
    expect(within(manual).getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(manual.textContent).not.toContain('npm');
  });

  it('Sign in to Claude: "finish in the browser", the sign-in page link, and Cancel', async () => {
    const signedOut: DoctorCheck[] = [
      { id: 'claude', label: 'Claude Code', required: true, ok: true, version: '2.1.301', message: 'Installed' },
      { id: 'claude-auth', label: 'Claude sign-in', required: true, ok: false, message: 'Claude Code is not signed in', fix: 'claude auth login', action: 'sign-in' },
    ];
    setup(signedOut);
    await flush(3000);
    const auth = row('Claude sign-in');
    fireEvent.click(within(auth).getByRole('button', { name: 'Sign in to Claude' }));
    api.getSetup.mockImplementation(async () => statusOf({ claudeLogin: { state: 'running', loginUrl: 'https://claude.ai/oauth/authorize?x=1' } }));
    fireEvent.click(within(auth).getByRole('button', { name: 'Continue' }));
    await flush();
    expect(api.setupSignIn).toHaveBeenCalled();
    expect(within(auth).getByText('Finish signing in in your browser…')).toBeTruthy();
    await flush(1100);
    expect(within(auth).getByRole('link', { name: 'Open the sign-in page' }).getAttribute('href')).toBe('https://claude.ai/oauth/authorize?x=1');
    fireEvent.click(within(auth).getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(api.setupCancel).toHaveBeenCalledWith('claude-login');
  });

  it('Install FFmpeg: the confirmation names the version, size, source and licence; progress shows', async () => {
    setup(missing);
    await flush(3000);
    const ff = row('FFmpeg');
    expect(within(ff).getByText('Needed to export videos; images work without it.')).toBeTruthy();
    fireEvent.click(within(ff).getByRole('button', { name: 'Install FFmpeg' }));
    expect(within(ff).getByText(/FFmpeg 9\.0\.2 \(115 MB\) from gyan\.dev.*checked before it is used.*GPLv3 build/)).toBeTruthy();
    api.getSetup.mockImplementation(async () => statusOf({ ffmpegInstall: { state: 'running', bytes: 57_000_000, total: 114_768_076 } }));
    fireEvent.click(within(ff).getByRole('button', { name: 'Install' }));
    await flush();
    expect(api.setupInstallFfmpeg).toHaveBeenCalled();
    await flush(1100);
    expect(within(ff).getByText('Downloading FFmpeg… 57 MB of 115 MB')).toBeTruthy();
  });

  it('a server open to the network offers no install button and says why', async () => {
    api.getSetup.mockImplementation(async () => statusOf({}, { allowed: false }));
    setup(missing);
    await flush(3000);
    expect(screen.queryByRole('button', { name: 'Install Claude Code' })).toBeNull();
    expect(screen.getAllByText(/open to the network here/).length).toBeGreaterThan(0);
  });

  it('a technical row the user cannot fix is a note, without "Recommended" nor "Check again"', async () => {
    const checks: DoctorCheck[] = [
      ...missing.slice(1, 2),
      { id: 'shell-path', label: 'Login shell PATH', required: false, ok: false, message: 'Programs are looked up in the usual folders', fix: 'Start Motion Studio from the terminal', technical: true },
    ];
    setup(checks);
    await flush(3000);
    const details = screen.getByText('Technical details').closest('details')!;
    const shell = within(details).getByText('Login shell PATH').closest('li')!;
    expect(within(shell).getByText('Note')).toBeTruthy();
    expect(within(shell).queryByText('Recommended')).toBeNull();
    expect(within(shell).queryByRole('button', { name: 'Check again' })).toBeNull();
  });
});

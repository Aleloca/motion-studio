import { workspaceSettingsSchema, type DoctorCheck, type WorkspaceSettings } from '@motion-studio/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { __resetToasts, getToasts } from '../src/ui/toast.tsx';

const at = '2026-10-07T10:00:00.000Z';
const proj = (name: string, linkedCodebases: Array<{ path: string; note?: string }> = []) =>
  ({ slug: 'acme', jobKey: 'k', project: { schemaVersion: 1, name, description: 'Detective game', createdAt: at, updatedAt: at, linkedCodebases } });
let rules: Array<{ rule: string; label: string; addedAt: string }>;
const api = {
  getProject: vi.fn(),
  getCodebases: vi.fn(async () => [{ path: '/Users/me/code/app', exists: true }]),
  updateProject: vi.fn(async (_s: string, body: object) => ({ ...proj('Acme'), ...body })),
  getPermissions: vi.fn(async () => structuredClone(rules)),
  deletePermission: vi.fn(async () => ({ ok: true })),
  updateSettings: vi.fn(async (patch: Partial<WorkspaceSettings>) => ({ ...settings, ...patch })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ProjectSettings } = await import('../src/screens/ProjectSettings.tsx');

const settings = workspaceSettingsSchema.parse({ schemaVersion: 1, extraAllowedDomains: ['cdn.acme.example'] });
const live = (over: Partial<EventsState> = {}): EventsState => ({ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {}, ...over });
const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);
const onSettings = vi.fn();
const page = (over: { tick?: number } = {}) => <ProjectSettings slug="acme" live={live({ projectTicks: { acme: over.tick ?? 0 } })} settings={settings} onSettings={onSettings} />;

beforeEach(() => {
  __resetToasts();
  api.getProject.mockResolvedValue(proj('Acme', [{ path: '/Users/me/code/app', note: 'iOS app' }]));
  rules = [
    { rule: 'Bash(pngquant:*)', label: 'Compress images with pngquant', addedAt: at },
    { rule: 'WebFetch(domain:acme.example)', label: 'Read pages on acme.example', addedAt: at },
  ];
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); __resetToasts(); });

describe('Project settings · sections', () => {
  it('has General, Agent and approvals, Internet access and Linked code; no Delete', async () => {
    en(page());
    const nav = await screen.findByRole('navigation', { name: 'Project settings sections' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['General', 'Agent and approvals', 'Internet access', 'Linked code1']);
    expect(screen.getByRole('heading', { name: 'Agent and approvals' })).toBeTruthy();
    expect(screen.queryByText(/Delete project/i)).toBeNull();
  });
});

describe('Project settings · always allowed', () => {
  it('shows the plain label with the rule below', async () => {
    en(page());
    const row = (await screen.findByText('Compress images with pngquant')).closest('.ms-perm') as HTMLElement;
    expect(within(row).getByText('Bash(pngquant:*)')).toBeTruthy();
    expect(screen.getByText('2 · added from approval cards')).toBeTruthy();
  });

  it('revoke asks first; Cancel keeps the rule and sends nothing', async () => {
    en(page());
    await screen.findByText('Compress images with pngquant');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Compress images with pngquant' }));
    const row = screen.getByText('Compress images with pngquant').closest('.ms-perm') as HTMLElement;
    expect(within(row).getByText('Revoke this rule?')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }));
    expect(within(row).queryByText('Revoke this rule?')).toBeNull();
    expect(api.deletePermission).not.toHaveBeenCalled();
    expect(screen.getByText('Compress images with pngquant')).toBeTruthy();
  });

  it('a confirmed revoke deletes the rule at once (no Undo), then the row collapses', async () => {
    en(page());
    await screen.findByText('Read pages on acme.example');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Read pages on acme.example' }));
    const row = screen.getByText('Read pages on acme.example').closest('.ms-perm') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke Read pages on acme.example' }));
    // Sent immediately: the security control takes effect when the UI says so.
    expect(api.deletePermission).toHaveBeenCalledWith('acme', 'WebFetch(domain:acme.example)');
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.queryByText('Read pages on acme.example')).toBeNull();
    const toast = getToasts().find((x) => x.text === 'Revoked: Read pages on acme.example')!;
    expect(toast).toBeTruthy();
    expect(toast.action).toBeUndefined();
    expect(screen.getByText('Compress images with pngquant')).toBeTruthy();
  });

  it('a failed revoke keeps the rule on screen and explains why', async () => {
    api.deletePermission.mockRejectedValueOnce(new Error('locked'));
    en(page());
    await screen.findByText('Compress images with pngquant');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Compress images with pngquant' }));
    const row = screen.getByText('Compress images with pngquant').closest('.ms-perm') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke Compress images with pngquant' }));
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(api.deletePermission).toHaveBeenCalledTimes(1);
    const back = screen.getByText('Compress images with pngquant').closest('.ms-perm') as HTMLElement;
    expect(within(back).getByRole('alert').textContent).toBe('Not revoked: locked');
  });

  it('Revoke all asks once, then deletes every rule at once', async () => {
    en(page());
    await screen.findByText('Compress images with pngquant');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke all' }));
    expect(screen.getByText('Revoke all 2 rules?')).toBeTruthy();
    expect(api.deletePermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke all 2 rules' }));
    expect(api.deletePermission).toHaveBeenCalledWith('acme', 'Bash(pngquant:*)');
    await act(async () => {});
    expect(api.deletePermission).toHaveBeenCalledWith('acme', 'WebFetch(domain:acme.example)');
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.getByText('Nothing is always allowed')).toBeTruthy();
    expect(getToasts().find((x) => x.text === '2 permissions revoked')!.action).toBeUndefined();
  });

  it('Revoke all that fails half way keeps only the rules that are still saved', async () => {
    api.deletePermission.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('locked'));
    en(page());
    await screen.findByText('Compress images with pngquant');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke all' }));
    rules = rules.slice(1); // the first delete went through on the server
    fireEvent.click(screen.getByRole('button', { name: 'Revoke all 2 rules' }));
    await waitFor(() => expect(screen.queryByText('Compress images with pngquant')).toBeNull());
    expect(screen.getByText('Read pages on acme.example')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Not revoked: locked');
  });

  it('shows the designed empty state', async () => {
    rules = [];
    en(page());
    expect(await screen.findByText('Nothing is always allowed')).toBeTruthy();
    expect(screen.getByText('Choose “Always here” on an approval card to add a rule.')).toBeTruthy();
  });
});

describe('Project settings · agent, internet and code', () => {
  it('changes the jobs at the same time and the paid-service confirmation', async () => {
    en(page());
    await userEvent.click(await screen.findByRole('button', { name: 'More jobs' }));
    expect(api.updateSettings).toHaveBeenCalledWith({ maxConcurrentJobs: 3 });
    await waitFor(() => expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrentJobs: 3 })));
    await userEvent.click(screen.getByRole('switch', { name: 'Confirm before using paid services' }));
    expect(api.updateSettings).toHaveBeenCalledWith({ confirmPaidProviders: false });
  });

  it('marks the workspace-wide rows and saves one jobs change at a time', async () => {
    let finish!: (s: WorkspaceSettings) => void;
    api.updateSettings.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    en(page());
    const paid = (await screen.findByText('Confirm before using paid services')).closest('.ms-set-row') as HTMLElement;
    expect(within(paid).getByText('Shared by every project')).toBeTruthy();
    const more = screen.getByRole('button', { name: 'More jobs' }) as HTMLButtonElement;
    await userEvent.click(more);
    expect(more.disabled).toBe(true);
    await userEvent.click(more);
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ...settings, maxConcurrentJobs: 3 }); });
    expect(more.disabled).toBe(false);
  });

  it('changes the isolation and the model, and shows the sandbox check', async () => {
    const { rerender } = en(<ProjectSettings slug="acme" live={live()} settings={settings} onSettings={onSettings}
      checks={[{ id: 'sandbox', label: 'Sandbox', ok: false, required: false, message: 'Seatbelt unavailable' }]} />);
    expect(await screen.findByText('Seatbelt unavailable')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /^Agent isolation/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Off' }));
    expect(api.updateSettings).toHaveBeenCalledWith({ sandboxMode: 'off' });
    rerender(<I18nProvider locale="en"><ProjectSettings slug="acme" live={live()} settings={{ ...settings, sandboxMode: 'off' }} onSettings={onSettings} checks={[]} /></I18nProvider>);
    expect(screen.getByText('Without isolation, the agent can write anywhere with the commands you allow.')).toBeTruthy();
    rerender(<I18nProvider locale="en"><ProjectSettings slug="acme" live={live()} settings={settings} onSettings={onSettings}
      checks={[{ id: 'sandbox', label: 'Sandbox', ok: true, required: false, message: 'ok' }]} /></I18nProvider>);
    expect(screen.getByText('Sandbox on: the agent works isolated in the project folder.')).toBeTruthy();
    const model = screen.getByRole('textbox', { name: 'Model' });
    await userEvent.type(model, 'claude-opus-5-5{Enter}');
    expect(api.updateSettings).toHaveBeenLastCalledWith({ model: 'claude-opus-5-5' });
  });

  it('adds and removes websites, refusing what is not a domain', async () => {
    en(page());
    await userEvent.click(await screen.findByRole('button', { name: /^Internet access/ }));
    const field = screen.getByRole('textbox', { name: 'Add a website' });
    await userEvent.type(field, 'not a domain{Enter}');
    expect(screen.getByText('Use a domain like assets.example.com or *.example.com')).toBeTruthy();
    expect(api.updateSettings).not.toHaveBeenCalled();
    await userEvent.clear(field);
    await userEvent.type(field, 'https://Media.Acme.example/path{Enter}');
    expect(api.updateSettings).toHaveBeenCalledWith({ extraAllowedDomains: ['cdn.acme.example', 'media.acme.example'] });
    await userEvent.click(screen.getByRole('button', { name: 'Remove cdn.acme.example' }));
    expect(api.updateSettings).toHaveBeenLastCalledWith({ extraAllowedDomains: [] });
  });

  it('explains a settings save failure', async () => {
    api.updateSettings.mockRejectedValueOnce(new Error('disk full'));
    en(page());
    await userEvent.click(await screen.findByRole('button', { name: 'Fewer jobs' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Settings not saved: disk full');
  });

  it('links a folder by path and unlinks one', async () => {
    en(page());
    await userEvent.click(await screen.findByRole('button', { name: /^Linked code/ }));
    expect(screen.getByText('/Users/me/code/app')).toBeTruthy();
    expect(screen.getByText('Read only')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Link a folder…' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder path' }), 'relative/path{Enter}');
    expect(screen.getByText('Enter an absolute path')).toBeTruthy();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Folder path' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder path' }), '/Users/me/code/web{Enter}');
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('acme', { linkedCodebases: [{ path: '/Users/me/code/app', note: 'iOS app' }, { path: '/Users/me/code/web' }] }));
    await userEvent.click(screen.getByRole('button', { name: 'Unlink /Users/me/code/app' }));
    await waitFor(() => expect(api.updateProject).toHaveBeenLastCalledWith('acme', { linkedCodebases: [{ path: '/Users/me/code/web' }] }));
  });
});

describe('Project settings · automatic approval (Phase 8)', () => {
  const NAME = 'Approve sandboxed commands automatically';
  const sandboxOk: DoctorCheck[] = [{ id: 'sandbox', label: 'Sandbox', ok: true, required: false, message: 'ok' }];
  const job = (id: string, state: 'running' | 'queued' | 'succeeded') => ({ id, key: 'k', kind: 'creative' as const, label: 'x', state, createdAt: at });

  it('is in Agent and approvals with the spec text, applies to new jobs and is shared by every project', async () => {
    en(<ProjectSettings slug="acme" live={live()} settings={settings} onSettings={onSettings} checks={sandboxOk} />);
    const row = (await screen.findByText(NAME)).closest('.ms-set-row') as HTMLElement;
    expect(row.closest('.ms-set-card')!.querySelector('[role="switch"][aria-label="Confirm before using paid services"]')).toBeTruthy();
    expect(within(row).getByText(/Commands that stay inside this project, with no internet, run without asking\. You still decide on files outside the project, paid services and new websites\./)).toBeTruthy();
    expect(within(row).getByText(/Applies to new jobs/)).toBeTruthy();
    expect(within(row).getByText('Shared by every project')).toBeTruthy();
    const sw = within(row).getByRole('switch', { name: NAME });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect((sw as HTMLButtonElement).disabled).toBe(false);
    // The status line is the switch's description.
    expect(document.getElementById(sw.getAttribute('aria-describedby')!)!.textContent).toBe('Applies to new jobs');
  });

  it('turning it off saves autoApproveSandboxed:false and says every command will ask', async () => {
    en(<ProjectSettings slug="acme" live={live()} settings={settings} onSettings={onSettings} checks={sandboxOk} />);
    await userEvent.click(await screen.findByRole('switch', { name: NAME }));
    expect(api.updateSettings).toHaveBeenCalledWith({ autoApproveSandboxed: false });
    await waitFor(() => expect(getToasts().map((x) => x.text)).toEqual(['Every command will ask for your OK']));
  });

  it('turning it on says so, and tells that running jobs keep their setting', async () => {
    const off = { ...settings, autoApproveSandboxed: false };
    const jobs = { a: job('a', 'running'), b: job('b', 'queued'), c: job('c', 'succeeded') };
    en(<ProjectSettings slug="acme" live={live({ jobs })} settings={off} onSettings={onSettings} checks={sandboxOk} />);
    await userEvent.click(await screen.findByRole('switch', { name: NAME }));
    expect(api.updateSettings).toHaveBeenCalledWith({ autoApproveSandboxed: true });
    await waitFor(() => expect(getToasts().map((x) => x.text)).toEqual(['Sandboxed commands now run without asking · Applies to new jobs · 1 running job keeps its current setting']));
  });

  it('counts every running job in the toast', async () => {
    const jobs = { a: job('a', 'running'), b: job('b', 'running') };
    en(<ProjectSettings slug="acme" live={live({ jobs })} settings={settings} onSettings={onSettings} checks={sandboxOk} />);
    await userEvent.click(await screen.findByRole('switch', { name: NAME }));
    await waitFor(() => expect(getToasts().map((x) => x.text)).toEqual(['Every command will ask for your OK · Applies to new jobs · 2 running jobs keep their current setting']));
  });

  it('no toast when the save fails', async () => {
    api.updateSettings.mockRejectedValueOnce(new Error('disk full'));
    en(<ProjectSettings slug="acme" live={live()} settings={settings} onSettings={onSettings} checks={sandboxOk} />);
    await userEvent.click(await screen.findByRole('switch', { name: NAME }));
    expect((await screen.findByRole('alert')).textContent).toBe('Settings not saved: disk full');
    expect(getToasts()).toEqual([]);
  });

  it('is disabled with "Needs agent isolation" when isolation is off or the sandbox is unavailable', async () => {
    const { rerender } = en(<ProjectSettings slug="acme" live={live()} settings={{ ...settings, sandboxMode: 'off' }} onSettings={onSettings} checks={sandboxOk} />);
    const sw = await screen.findByRole('switch', { name: NAME }) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    const row = sw.closest('.ms-set-row') as HTMLElement;
    expect(within(row).getByText('Needs agent isolation')).toBeTruthy();
    // A disabled switch says why.
    expect(document.getElementById(sw.getAttribute('aria-describedby')!)!.textContent).toBe('Needs agent isolation');
    await userEvent.click(sw);
    expect(api.updateSettings).not.toHaveBeenCalled();
    rerender(<I18nProvider locale="en"><ProjectSettings slug="acme" live={live()} settings={settings} onSettings={onSettings}
      checks={[{ id: 'sandbox', label: 'Sandbox', ok: false, required: false, message: 'Seatbelt unavailable' }]} /></I18nProvider>);
    expect((screen.getByRole('switch', { name: NAME }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(screen.getByRole('switch', { name: NAME }).closest('.ms-set-row') as HTMLElement).getByText('Needs agent isolation')).toBeTruthy();
    rerender(<I18nProvider locale="en"><ProjectSettings slug="acme" live={live()} settings={settings} onSettings={onSettings} checks={sandboxOk} /></I18nProvider>);
    expect((screen.getByRole('switch', { name: NAME }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Needs agent isolation')).toBeNull();
  });
});

describe('Project settings · linked code notes', () => {
  it('a note follows live changes, except while it is being typed', async () => {
    const { rerender } = en(page());
    await userEvent.click(await screen.findByRole('button', { name: /^Linked code/ }));
    const note = screen.getByRole('textbox', { name: 'Note for /Users/me/code/app' }) as HTMLInputElement;
    expect(note.value).toBe('iOS app');
    api.getProject.mockResolvedValue(proj('Acme', [{ path: '/Users/me/code/app', note: 'iPad app' }]));
    rerender(<I18nProvider locale="en">{page({ tick: 1 })}</I18nProvider>);
    await waitFor(() => expect(note.value).toBe('iPad app'));
    await userEvent.clear(note);
    await userEvent.type(note, 'Android app');
    api.getProject.mockResolvedValue(proj('Acme', [{ path: '/Users/me/code/app', note: 'Watch app' }]));
    rerender(<I18nProvider locale="en">{page({ tick: 2 })}</I18nProvider>);
    await waitFor(() => expect(api.getProject).toHaveBeenCalledTimes(3));
    expect(note.value).toBe('Android app');
    fireEvent.blur(note);
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('acme', { linkedCodebases: [{ path: '/Users/me/code/app', note: 'Android app' }] }));
  });
});

describe('Project settings · general', () => {
  it('keeps in-progress edits across live reloads and saves the name and description', async () => {
    const { rerender } = en(page());
    await userEvent.click(await screen.findByRole('button', { name: 'General' }));
    const input = (await screen.findByRole('textbox', { name: 'Project name' })) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('Acme'));
    await userEvent.clear(input);
    await userEvent.type(input, 'Half Story');
    api.getProject.mockResolvedValue(proj('From the server'));
    rerender(<I18nProvider locale="en">{page({ tick: 1 })}</I18nProvider>);
    await waitFor(() => expect(api.getProject).toHaveBeenCalledTimes(2));
    expect(input.value).toBe('Half Story');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('acme', { name: 'Half Story', description: 'Detective game' }));
    expect((await screen.findByRole('status')).textContent).toBe('Saved');
  });

  it('explains a load failure with a retry', async () => {
    api.getProject.mockRejectedValueOnce(new Error('Project not found'));
    en(page());
    expect(await screen.findByText("Can't load the project: Project not found")).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Agent and approvals' })).toBeTruthy();
  });
});

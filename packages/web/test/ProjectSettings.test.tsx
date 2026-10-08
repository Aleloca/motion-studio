import { workspaceSettingsSchema, type WorkspaceSettings } from '@motion-studio/shared';
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
const { UNDO_MS } = await import('../src/screens/Assets.tsx');

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
  it('has General, Agent and approvals, Internet access and Linked code; no automatic approval and no Delete', async () => {
    en(page());
    const nav = await screen.findByRole('navigation', { name: 'Project settings sections' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['General', 'Agent and approvals', 'Internet access', 'Linked code1']);
    expect(screen.getByRole('heading', { name: 'Agent and approvals' })).toBeTruthy();
    expect(screen.queryByText(/automatically/i)).toBeNull();
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

  it('revoke hides the rule with Undo: Undo never calls deletePermission', async () => {
    en(page());
    await screen.findByText('Compress images with pngquant');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Compress images with pngquant' }));
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.queryByText('Compress images with pngquant')).toBeNull();
    const toast = getToasts().find((x) => x.text === 'Revoked: Compress images with pngquant')!;
    expect(toast.action!.label).toBe('Undo');
    await act(async () => { toast.action!.run(); });
    await act(async () => { vi.advanceTimersByTime(UNDO_MS * 2); });
    expect(api.deletePermission).not.toHaveBeenCalled();
    expect(screen.getByText('Compress images with pngquant')).toBeTruthy();
  });

  it('revoke without Undo sends deletePermission when the time is over', async () => {
    en(page());
    await screen.findByText('Compress images with pngquant');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Read pages on acme.example' }));
    await act(async () => {}); // the row collapses (T15), then the Undo time starts
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 500); });
    expect(api.deletePermission).toHaveBeenCalledWith('acme', 'WebFetch(domain:acme.example)');
  });

  it('Revoke all hides every rule with one Undo', async () => {
    en(page());
    await screen.findByText('Compress images with pngquant');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke all' }));
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.getByText('Nothing is always allowed')).toBeTruthy();
    const toast = getToasts().find((x) => x.text === '2 permissions revoked')!;
    await act(async () => { toast.action!.run(); });
    expect(screen.getByText('Compress images with pngquant')).toBeTruthy();
    expect(api.deletePermission).not.toHaveBeenCalled();
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

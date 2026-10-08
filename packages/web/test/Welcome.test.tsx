import type { DoctorCheck, WorkspaceInfo } from '@motion-studio/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const api = {
  setWorkspace: vi.fn(),
  listProjects: vi.fn(async () => []),
  createProject: vi.fn(),
  addBrandSource: vi.fn(),
  analyzeBrand: vi.fn(),
  setLanguage: vi.fn(),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { Welcome } = await import('../src/screens/Welcome.tsx');
const { Toasts, toast } = await import('../src/ui/index.ts');

const settings = { schemaVersion: 1 as const, maxConcurrentJobs: 2, expertMode: false, theme: 'system' as const, model: null, sandboxMode: 'auto' as const, extraAllowedDomains: [] as string[], confirmPaidProviders: true };
const okChecks: DoctorCheck[] = [
  { id: 'claude', label: 'Claude Code', ok: true, required: true, version: '2.1.293', message: 'Installed' },
  { id: 'git', label: 'Git', ok: true, required: true, version: '2.47.1', message: 'Installed' },
];
const noWorkspace: WorkspaceInfo = { path: null, settings: null, error: null };

type Props = Parameters<typeof Welcome>[0];
function setup(over: Partial<Props> = {}) {
  const props: Props = {
    checks: okChecks, loadError: null, workspace: noWorkspace,
    onRecheck: vi.fn(), onWorkspace: vi.fn(), onFinish: vi.fn(),
    ...over,
  };
  const view = render(<I18nProvider locale="en"><Welcome {...props} /><Toasts /></I18nProvider>);
  return { props, view };
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); delete (window as unknown as { motionStudio?: unknown }).motionStudio; });

describe('Welcome · step 1 (system check)', () => {
  it('reveals the doctor checks one by one', () => {
    vi.useFakeTimers();
    setup();
    // Nothing is shown as passed before the first tick: every row is still checking.
    expect(screen.queryByText('2.1.293')).toBeNull();
    act(() => { vi.advanceTimersByTime(280); });
    expect(screen.getByText('2.1.293')).toBeTruthy();
    expect(screen.queryByText('2.47.1')).toBeNull();
    act(() => { vi.advanceTimersByTime(280); });
    expect(screen.getByText('2.47.1')).toBeTruthy();
    expect(screen.getAllByText('2 of 2 checks passed').length).toBeGreaterThan(0);
  });

  it('a failed required check blocks Continue and shows its remedy with Check again', () => {
    vi.useFakeTimers();
    const failing: DoctorCheck[] = [okChecks[0]!, { id: 'git', label: 'Git', ok: false, required: true, message: 'Not found', fix: 'brew install git' }];
    const { props } = setup({ checks: failing });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText('brew install git')).toBeTruthy();
    expect(screen.getByText('Not found')).toBeTruthy();
    expect(screen.getByText('Missing')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' }).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Check again' })[0]!);
    expect(props.onRecheck).toHaveBeenCalled();
  });

  it('an optional failing check does not block Continue', () => {
    vi.useFakeTimers();
    const checks: DoctorCheck[] = [...okChecks, { id: 'sandbox', label: 'Sandbox', ok: false, required: false, message: 'Not available', fix: 'install bubblewrap' }];
    setup({ checks });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText('Recommended')).toBeTruthy();
    expect(screen.getByText('install bubblewrap')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' }).disabled).toBe(false);
  });

  it('explains an unreachable server with a remedy', () => {
    setup({ checks: null, loadError: 'Failed to fetch' });
    expect(screen.getByRole('alert').textContent).toContain("Can't reach the Motion Studio server: Failed to fetch");
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' }).disabled).toBe(true);
  });

  it('moves the panel out to −16 px and back in from +16 px between steps (T17)', async () => {
    const frames: Keyframe[][] = [];
    const orig = Element.prototype.animate;
    Element.prototype.animate = function (f: Keyframe[]) {
      frames.push(f);
      return { finished: Promise.resolve(), cancel() {} } as unknown as Animation;
    } as never;
    try {
      setup({ step: 2 });
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      await screen.findByRole('heading', { name: 'Check your setup' });
      const moves = frames.map((f) => f.map((k) => String(k.transform ?? '')).join(' | '));
      // Backwards: out towards +16 and in from −16; the same distance as forwards (T17).
      expect(moves.some((m) => m.includes('translate(16px,0px)') && m.startsWith('none'))).toBe(true);
      expect(moves.some((m) => m.startsWith('translate(-16px,0px)'))).toBe(true);
    } finally { Element.prototype.animate = orig; }
  });
});

describe('Welcome · step 2 (workspace)', () => {
  it('uses the native folder picker on the desktop app and saves the folder on Continue', async () => {
    const pickFolder = vi.fn(async () => '/Users/me/MotionStudio');
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder, revealPath: async () => {} };
    api.setWorkspace.mockResolvedValue({ path: '/Users/me/MotionStudio', settings });
    const { props } = setup({ step: 2 });
    await userEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    expect(pickFolder).toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>('Folder').value).toBe('/Users/me/MotionStudio');
    expect(screen.getByText('/Users/me/MotionStudio/')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(api.setWorkspace).toHaveBeenCalledWith('/Users/me/MotionStudio');
    expect(props.onWorkspace).toHaveBeenCalledWith({ path: '/Users/me/MotionStudio', settings });
    expect(await screen.findByRole('heading', { name: 'Create your first project' })).toBeTruthy();
  });

  it('offers a text field (no picker) in the browser', () => {
    setup({ step: 2 });
    expect(screen.queryByRole('button', { name: 'Choose folder…' })).toBeNull();
    expect(screen.getByLabelText('Folder')).toBeTruthy();
  });

  it('shows what the server says about the configured folder and its projects', async () => {
    api.listProjects.mockResolvedValue([{ ok: true, slug: 'acme', project: { name: 'Acme' } }] as never);
    setup({ step: 2, workspace: { path: '/w', settings, error: null } });
    expect(await screen.findByText(/Current workspace · 1 project/)).toBeTruthy();
    expect(screen.getByText('acme/')).toBeTruthy();
  });

  it('explains a workspace problem reported by the server', () => {
    setup({ step: 2, workspace: { path: '/Users/me/Studio', settings: null, error: { code: 'not-found', message: 'x' } } });
    expect(screen.getByRole('alert').textContent).toBe('Folder not found: /Users/me/Studio. Choose another.');
    expect(screen.getByLabelText<HTMLInputElement>('Folder').value).toBe('/Users/me/Studio');
  });

  it('stays on the step and explains a folder the server refuses', async () => {
    api.setWorkspace.mockRejectedValue(new Error('The folder is not writable'));
    const { props } = setup({ step: 2 });
    await userEvent.type(screen.getByLabelText('Folder'), '/nope');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The folder is not writable');
    expect(props.onWorkspace).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Choose a workspace' })).toBeTruthy();
  });
});

describe('Welcome · step 3 (first project)', () => {
  const ws: WorkspaceInfo = { path: '/w', settings, error: null };
  beforeEach(() => {
    api.createProject.mockResolvedValue({ slug: 'acme', project: { name: 'Acme' } });
    api.addBrandSource.mockResolvedValue({ id: 's1', kind: 'website', url: 'https://acme.com' });
    api.analyzeBrand.mockResolvedValue({ id: 'j1' });
  });

  it('with a website creates the project, adds the site and starts the analysis in order, then opens Brand', async () => {
    const { props } = setup({ step: 3, workspace: ws });
    await userEvent.type(screen.getByLabelText('Project name'), 'Acme');
    await userEvent.type(screen.getByLabelText(/Website/), 'acme.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(props.onFinish).toHaveBeenCalledWith('#/p/acme/brand'));
    expect(api.createProject).toHaveBeenCalledWith('Acme');
    expect(api.addBrandSource).toHaveBeenCalledWith('acme', { kind: 'website', url: 'https://acme.com' });
    expect(api.analyzeBrand).toHaveBeenCalledWith('acme', ['s1']);
    const order = [api.createProject, api.addBrandSource, api.analyzeBrand].map((f) => f.mock.invocationCallOrder[0]!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(await screen.findByText('Acme created · learning the brand from acme.com')).toBeTruthy();
  });

  it('without a website creates the project only and opens Brand', async () => {
    const { props } = setup({ step: 3, workspace: ws });
    await userEvent.type(screen.getByLabelText('Project name'), 'Acme{Enter}');
    await waitFor(() => expect(props.onFinish).toHaveBeenCalledWith('#/p/acme/brand'));
    expect(api.addBrandSource).not.toHaveBeenCalled();
    expect(api.analyzeBrand).not.toHaveBeenCalled();
  });

  it('lands on Brand and explains the error when the analysis does not start', async () => {
    api.analyzeBrand.mockRejectedValue(new Error('Claude Code is busy'));
    const show = vi.spyOn(toast, 'show');
    const { props } = setup({ step: 3, workspace: ws });
    await userEvent.type(screen.getByLabelText('Project name'), 'Acme');
    await userEvent.type(screen.getByLabelText(/Website/), 'https://acme.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(props.onFinish).toHaveBeenCalledWith('#/p/acme/brand'));
    const [text, opts] = show.mock.calls.at(-1)!;
    expect(text).toContain('Claude Code is busy');
    expect(opts?.sticky).toBe(true);
    show.mockRestore();
  });

  it('stays on the step and explains a project that cannot be created', async () => {
    api.createProject.mockRejectedValue(new Error('A project with this name exists'));
    const { props } = setup({ step: 3, workspace: ws });
    await userEvent.type(screen.getByLabelText('Project name'), 'Acme');
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect((await screen.findByRole('alert')).textContent).toContain('A project with this name exists');
    expect(props.onFinish).not.toHaveBeenCalled();
    expect(api.addBrandSource).not.toHaveBeenCalled();
  });

  it('refuses an invalid website before creating anything', async () => {
    setup({ step: 3, workspace: ws });
    await userEvent.type(screen.getByLabelText('Project name'), 'Acme');
    await userEvent.type(screen.getByLabelText(/Website/), 'not a site');
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect((await screen.findByRole('alert')).textContent).toContain('https://www.example.com');
    expect(api.createProject).not.toHaveBeenCalled();
  });

  it('cannot open step 3 before a workspace is set', () => {
    setup({ step: 3 });
    expect(screen.getByRole('heading', { name: 'Choose a workspace' })).toBeTruthy();
  });
});

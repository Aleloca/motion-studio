import type { ApprovalRequest, DoctorCheck, JobSummary, ServerMessage, WorkspaceInfo } from '@motion-studio/shared';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.ts';
import { App } from '../src/App.tsx';
import { NOTIFY_APPROVALS_KEY } from '../src/shell/notify.ts';
import { useAttention } from '../src/shell/useAttention.ts';
import { Toasts } from '../src/ui/index.ts';
import { __resetToasts } from '../src/ui/toast.tsx';

// Every API call the old screens make resolves to "pending forever" unless a test sets it.
vi.mock('../src/api.ts', () => {
  const base: Record<string, unknown> = {};
  const api = new Proxy(base, {
    get: (t, k: string) => (t[k] ??= vi.fn(() => new Promise(() => {}))),
  });
  return { ApiError: class extends Error {}, api };
});

/* A controllable Web Animations stub (as in ui-overlay.test.tsx): page transitions stay "in flight" until finished. */
class FakeAnim {
  cancelled = false;
  done = false;
  finished: Promise<unknown>;
  private res!: () => void;
  private rej!: () => void;
  constructor(readonly holds: boolean) {
    this.finished = new Promise((r, j) => { this.res = () => r(undefined); this.rej = () => j(new Error('cancelled')); });
    this.finished.catch(() => {});
  }
  cancel() { if (!this.cancelled && !this.done) { this.cancelled = true; this.rej(); } }
  finish() { this.done = true; this.res(); }
}
const live = new Map<Element, FakeAnim[]>();
const origAnimate = Element.prototype.animate;
const origGetAnimations = Element.prototype.getAnimations;
function stubAnimations() {
  Element.prototype.animate = function (this: Element, _f: Keyframe[], opts: KeyframeAnimationOptions) {
    const fake = new FakeAnim(opts.fill === 'forwards');
    live.set(this, [...(live.get(this) ?? []), fake]);
    return fake as unknown as Animation;
  } as never;
  Element.prototype.getAnimations = function (this: Element) {
    return (live.get(this) ?? []).filter((a) => !a.cancelled && (!a.done || a.holds)) as unknown as Animation[];
  } as never;
}
const finishAll = async () => {
  await act(async () => { for (const list of live.values()) for (const a of list) if (!a.cancelled && !a.done) a.finish(); });
};

const okChecks: DoctorCheck[] = [{ id: 'git', label: 'Git', ok: true, required: true, message: 'ok' }];
const settings = { schemaVersion: 1 as const, maxConcurrentJobs: 2, expertMode: false, theme: 'system' as const, model: null, sandboxMode: 'auto' as const, extraAllowedDomains: [] as string[], confirmPaidProviders: true };
const project = (slug: string, name: string) => ({ slug, ok: true as const, project: { schemaVersion: 1 as const, name, description: '', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', linkedCodebases: [] } });

const approval = (id: string, title = `Richiesta ${id}`): ApprovalRequest => ({
  id, jobId: 'j1', projectSlug: 'acme', creativeSlug: 'lancio', kind: 'tool', title, detail: 'ls -la', toolName: 'Bash', alwaysRule: null,
  createdAt: '2026-10-08T10:00:00.000Z', expiresAt: '2026-10-08T10:10:00.000Z',
});
const job = (id: string, state: JobSummary['state'], label: string, finishedAt?: string): JobSummary => ({
  id, key: `acme/${id}`, kind: 'creative', label, state, createdAt: '2026-10-08T10:00:00.000Z', ...(finishedAt ? { finishedAt } : {}),
});

let sockets: FakeEventsSocket[] = [];
class FakeEventsSocket {
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: unknown; onerror: unknown;
  constructor() { sockets.push(this); }
  close() {}
}
const send = (msg: ServerMessage) => act(() => sockets.at(-1)!.onmessage!({ data: JSON.stringify(msg) }));

type Bridge = { notify: ReturnType<typeof vi.fn>; setBadge: ReturnType<typeof vi.fn> };
function desktopBridge(): Bridge {
  const b = { isDesktop: true, platform: 'darwin', pickFolder: async () => null, revealPath: async () => {}, notify: vi.fn(async () => {}), setBadge: vi.fn(async () => {}) };
  (window as unknown as { motionStudio: unknown }).motionStudio = b;
  return b;
}

async function startApp() {
  vi.stubGlobal('WebSocket', FakeEventsSocket);
  vi.mocked(api.getDoctor).mockResolvedValue(okChecks);
  vi.mocked(api.getWorkspace).mockResolvedValue({ path: '/w', settings, error: null } as WorkspaceInfo);
  vi.mocked(api.listProjects).mockResolvedValue([project('acme', 'Acme'), project('bravo', 'Bravo Studio')]);
  vi.mocked(api.listCreatives).mockResolvedValue([]);
  render(<App />);
  return screen.findByRole('button', { name: /^Attività/ });
}

let platform: ReturnType<typeof vi.spyOn> | null = null;
/** navigator.platform for the ⌘K / Ctrl+K choice. */
function onPlatform(name: 'MacIntel' | 'Win32') { platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue(name); }
const snapshot = (approvals: ApprovalRequest[]): ServerMessage => ({ type: 'snapshot', jobs: [], approvals, locale: 'it', languageSetting: 'system', systemLocale: 'it' });

beforeEach(() => {
  sockets = [];
  history.replaceState(null, '', '/#/');
  document.title = 'Motion Studio';
});
afterEach(() => {
  platform?.mockRestore();
  platform = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete (window as unknown as { motionStudio?: unknown }).motionStudio;
  localStorage.clear();
  __resetToasts();
  Element.prototype.animate = origAnimate;
  Element.prototype.getAnimations = origGetAnimations;
  live.clear();
  history.replaceState(null, '', '/');
});

describe('top bar bell', () => {
  it('counts the pending approvals: 2, then 1 after a decision', async () => {
    const bell = await startApp();
    send({ type: 'approval', approval: approval('a1') });
    send({ type: 'approval', approval: approval('a2') });
    expect(bell.getAttribute('aria-label')).toBe('Attività, 2 in attesa');
    expect(within(bell).getByText('2')).toBeTruthy();
    send({ type: 'approval_resolved', id: 'a1', decision: 'once' });
    expect(bell.getAttribute('aria-label')).toBe('Attività, 1 in attesa');
    expect(within(bell).getByText('1')).toBeTruthy();
    send({ type: 'approval_resolved', id: 'a2', decision: 'once' });
    expect(bell.getAttribute('aria-label')).toBe('Attività');
    expect(within(bell).queryByText(/\d/)).toBeNull();
  });

  it('shows "N running" from the active jobs and no token counter or theme switch', async () => {
    await startApp();
    expect(screen.queryByText(/in corso$/)).toBeNull();
    send({ type: 'job', job: job('j1', 'running', 'Lancio') });
    send({ type: 'job', job: job('j2', 'queued', 'Teaser') });
    expect(screen.getByRole('button', { name: '2 in corso' })).toBeTruthy();
    expect(screen.queryByText(/token/i)).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Tema' })).toBeNull();
  });

  it('keeps one bell with the right count when an approval arrives while the page changes', async () => {
    stubAnimations();
    const bridge = desktopBridge();
    const bell = await startApp();
    await finishAll();
    act(() => {
      history.replaceState(null, '', '/#/settings/general');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    // Mid-transition: the leaving and the entering page are both on stage.
    expect(document.querySelectorAll('.ms-main > .ms-stage > .ms-page')).toHaveLength(2);
    send({ type: 'approval', approval: approval('a1') });
    send({ type: 'approval', approval: approval('a1') }); // the same event again (e.g. a replay after reconnect)
    expect(screen.getAllByRole('button', { name: /^Attività/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Attività/ })).toBe(bell);
    expect(bell.getAttribute('aria-label')).toBe('Attività, 1 in attesa');
    // A second navigation before the first one finished.
    act(() => {
      history.replaceState(null, '', '/#/');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    send({ type: 'snapshot', jobs: [], approvals: [approval('a1')], locale: 'it', languageSetting: 'system', systemLocale: 'it' });
    await finishAll();
    expect(document.querySelectorAll('.ms-main > .ms-stage > .ms-page')).toHaveLength(1);
    expect(document.querySelectorAll('.ms-main > .ms-stage > .ms-page[data-page-active]')).toHaveLength(1);
    expect(bell.getAttribute('aria-label')).toBe('Attività, 1 in attesa');
    expect(bridge.notify).toHaveBeenCalledTimes(1);
    expect(document.title).toBe('(1) Motion Studio');
    expect(bridge.setBadge).toHaveBeenLastCalledWith(1);
  });
});

describe('approval toast', () => {
  it('Review opens the creative of the request, or the activity center when there is none', async () => {
    await startApp();
    send({ type: 'approval', approval: approval('a1') });
    await userEvent.click(screen.getByRole('button', { name: 'Rivedi' }));
    expect(location.hash).toBe('#/p/acme/c/lancio');
    send({ type: 'approval', approval: { ...approval('a2', 'Usare un servizio a pagamento'), creativeSlug: null } });
    await userEvent.click(screen.getByRole('button', { name: 'Rivedi' }));
    const tabs = await screen.findByRole('tablist', { name: 'Sezioni attività' });
    expect(within(tabs).getByRole('tab', { selected: true }).textContent).toContain('Serve a te');
  });

  it('goes away when the request is handled elsewhere', async () => {
    await startApp();
    send({ type: 'approval', approval: approval('a1') });
    expect(screen.getByRole('button', { name: 'Rivedi' })).toBeTruthy();
    send({ type: 'approval_resolved', id: 'a1', decision: 'deny' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Rivedi' })).toBeNull());
  });

  it('bounces the bell badge when the count grows (T8)', async () => {
    stubAnimations();
    const bell = await startApp();
    send({ type: 'approval', approval: approval('a1') });
    const badge = within(bell).getByText('1');
    expect(live.get(badge)?.length).toBe(1);
    send({ type: 'approval_resolved', id: 'a1', decision: 'once' });
    send({ type: 'approval', approval: approval('a2') });
    expect(live.get(within(bell).getByText('1'))?.length).toBe(1);
  });
});

describe('activity center', () => {
  it('opens from the bell with the Needs you, Running and Done tabs', async () => {
    const bell = await startApp();
    send({ type: 'approval', approval: approval('a1', 'Eseguire un comando') });
    send({ type: 'job', job: job('j1', 'running', 'Lancio estivo') });
    send({ type: 'job', job: job('j2', 'succeeded', 'Teaser autunno', '2026-10-08T10:05:00.000Z') });
    send({ type: 'job', job: job('j3', 'failed', 'Spot inverno', '2026-10-08T10:06:00.000Z') });
    await userEvent.click(bell);
    const tabs = screen.getByRole('tablist', { name: 'Sezioni attività' });
    const [needs, running, done] = within(tabs).getAllByRole('tab');
    expect(needs!.textContent).toContain('Serve a te');
    expect(running!.textContent).toContain('In corso');
    expect(done!.textContent).toContain('Finiti');
    expect(needs!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('group', { name: 'Eseguire un comando' })).toBeTruthy();
    await userEvent.click(running!);
    expect(screen.getByText('Lancio estivo')).toBeTruthy();
    await userEvent.click(done!);
    const doneItems = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(doneItems[0]).toContain('Spot inverno'); // newest first
    expect(doneItems[1]).toContain('Teaser autunno');
  });

  it('opens on Running when nothing needs the user, with designed empty states', async () => {
    const bell = await startApp();
    await userEvent.click(bell);
    const tabs = screen.getByRole('tablist', { name: 'Sezioni attività' });
    expect(within(tabs).getByRole('tab', { selected: true }).textContent).toContain('In corso');
    expect(screen.getByText('Niente in corso')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tablist', { name: 'Sezioni attività' })).toBeNull());
  });

  it('keeps at most the last 20 results', async () => {
    const bell = await startApp();
    for (let i = 0; i < 25; i++) send({ type: 'job', job: job(`d${i}`, 'succeeded', `Lavoro ${i}`, `2026-10-08T10:${String(i).padStart(2, '0')}:00.000Z`) });
    await userEvent.click(bell);
    await userEvent.click(screen.getByRole('tab', { name: /Finiti/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
    expect(screen.getByText('Lavoro 24')).toBeTruthy();
    expect(screen.queryByText('Lavoro 4')).toBeNull();
  });
});

describe('useAttention', () => {
  const Probe = ({ list }: { list: ApprovalRequest[] }) => { useAttention(list.length, list); return <Toasts />; };

  it('updates title and badge, notifies once per new approval and shows a Review toast', () => {
    const bridge = desktopBridge();
    const { rerender } = render(<Probe list={[]} />);
    expect(document.title).toBe('Motion Studio');
    expect(bridge.setBadge).toHaveBeenLastCalledWith(0);
    rerender(<Probe list={[approval('a1', 'Eseguire un comando')]} />);
    expect(document.title).toBe('(1) Motion Studio');
    expect(bridge.setBadge).toHaveBeenLastCalledWith(1);
    expect(bridge.notify).toHaveBeenCalledTimes(1);
    expect(bridge.notify).toHaveBeenCalledWith({ title: 'Motion Studio: serve la tua approvazione', body: 'Eseguire un comando' });
    expect(screen.getByRole('button', { name: 'Rivedi' })).toBeTruthy();
    // The same id again (a repeated event): no second notification.
    rerender(<Probe list={[{ ...approval('a1', 'Eseguire un comando') }]} />);
    expect(bridge.notify).toHaveBeenCalledTimes(1);
    rerender(<Probe list={[]} />);
    expect(document.title).toBe('Motion Studio');
    expect(bridge.setBadge).toHaveBeenLastCalledWith(0);
  });

  it('clips notification texts to the 200 characters the main process accepts', () => {
    const bridge = desktopBridge();
    const { rerender } = render(<Probe list={[]} />);
    rerender(<Probe list={[approval('a1', 'x'.repeat(300))]} />);
    const sent = bridge.notify.mock.calls[0]![0] as { title: string; body: string };
    expect(sent.body).toHaveLength(200);
    expect(sent.body.endsWith('…')).toBe(true);
    expect(sent.title).toBe('Motion Studio: serve la tua approvazione');
  });

  it('resets the title and clears the badge on unmount', () => {
    const bridge = desktopBridge();
    const { unmount } = render(<Probe list={[approval('a1'), approval('a2')]} />);
    expect(document.title).toBe('(2) Motion Studio');
    unmount();
    expect(document.title).toBe('Motion Studio');
    expect(bridge.setBadge).toHaveBeenLastCalledWith(0);
  });

  it('respects notifyApprovals = false but still updates title and badge', () => {
    localStorage.setItem(NOTIFY_APPROVALS_KEY, 'false');
    const bridge = desktopBridge();
    const { rerender } = render(<Probe list={[]} />);
    rerender(<Probe list={[approval('a1')]} />);
    expect(bridge.notify).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Rivedi' })).toBeNull();
    expect(document.title).toBe('(1) Motion Studio');
    expect(bridge.setBadge).toHaveBeenLastCalledWith(1);
  });

  it('sums several arrivals into one notification', () => {
    const bridge = desktopBridge();
    const { rerender } = render(<Probe list={[]} />);
    rerender(<Probe list={[approval('a1'), approval('a2'), approval('a3')]} />);
    expect(bridge.notify).toHaveBeenCalledTimes(1);
    expect(bridge.notify).toHaveBeenCalledWith({ title: 'Motion Studio: serve la tua approvazione', body: '3 approvazioni in attesa' });
  });

  it('falls back to the web Notification API when granted and the page is hidden', () => {
    const made: unknown[] = [];
    class FakeNotification { static permission = 'granted'; constructor(title: string, o: { body: string }) { made.push([title, o.body]); } }
    vi.stubGlobal('Notification', FakeNotification);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      const { rerender } = renderHook(({ list }) => useAttention(list.length, list), { initialProps: { list: [] as ApprovalRequest[] } });
      rerender({ list: [approval('a1', 'Eseguire un comando')] });
      expect(made).toEqual([['Motion Studio: serve la tua approvazione', 'Eseguire un comando']]);
    } finally {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    }
  });

  it('notifies on the web when the page is visible but not focused, not when focused', () => {
    const made: unknown[] = [];
    class FakeNotification { static permission = 'granted'; constructor(title: string) { made.push(title); } }
    vi.stubGlobal('Notification', FakeNotification);
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      const { rerender } = renderHook(({ list }) => useAttention(list.length, list), { initialProps: { list: [] as ApprovalRequest[] } });
      rerender({ list: [approval('a1')] });
      expect(made).toHaveLength(0);
      focus.mockReturnValue(false);
      rerender({ list: [approval('a1'), approval('a2')] });
      expect(made).toHaveLength(1);
    } finally { focus.mockRestore(); }
  });

  it('survives a desktop bridge that rejects', async () => {
    const bridge = desktopBridge();
    bridge.notify.mockRejectedValue(new Error('denied'));
    bridge.setBadge.mockRejectedValue(new Error('denied'));
    const { rerender } = render(<Probe list={[]} />);
    rerender(<Probe list={[approval('a1')]} />);
    await act(async () => {});
    expect(document.title).toBe('(1) Motion Studio');
  });
});

describe('command palette', () => {
  it('opens with ⌘K on Mac, filters and navigates with Enter', async () => {
    onPlatform('MacIntel');
    await startApp();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Vai a' });
    const input = within(dialog).getByRole('combobox');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: /Bravo Studio/ })).toBeTruthy());
    await userEvent.type(input, 'brav');
    expect(within(dialog).getAllByRole('option')).toHaveLength(1);
    await userEvent.keyboard('{Enter}');
    expect(location.hash).toBe('#/p/bravo');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Vai a' })).toBeNull());
  });

  it('opens with Ctrl+K off Mac, moves with the arrows and lists pages', async () => {
    onPlatform('Win32');
    await startApp();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Vai a' });
    const all = within(dialog).getAllByRole('option');
    expect(all[0]!.getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{ArrowDown}');
    expect(all[1]!.getAttribute('aria-selected')).toBe('true');
    expect(within(dialog).getByRole('combobox').getAttribute('aria-activedescendant')).toBe(all[1]!.id);
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(within(dialog).getAllByRole('option').at(-1)!.getAttribute('aria-selected')).toBe('true'); // wraps
    await userEvent.type(within(dialog).getByRole('combobox'), 'controllo');
    const options = within(dialog).getAllByRole('option');
    expect(options[0]!.textContent).toContain('Controllo di sistema');
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{Enter}');
    expect(location.hash).toBe('#/settings/system');
  });

  it('shows a designed empty state and closes with Esc', async () => {
    onPlatform('Win32');
    await startApp();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Vai a' });
    await userEvent.type(within(dialog).getByRole('combobox'), 'zzzz');
    expect(within(dialog).queryAllByRole('option')).toHaveLength(0);
    expect(within(dialog).getByText('Nessun risultato per “zzzz”')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Vai a' })).toBeNull());
    expect(location.hash).toBe('#/');
  });

  it('ignores Ctrl+K on Mac, Alt/Shift+K, key repeats and IME composition', async () => {
    onPlatform('MacIntel');
    await startApp();
    for (const init of [{ ctrlKey: true }, { metaKey: true, altKey: true }, { metaKey: true, shiftKey: true }, { metaKey: true, repeat: true }, { metaKey: true, isComposing: true }]) {
      fireEvent.keyDown(document, { key: 'k', ...init });
    }
    expect(screen.queryByRole('dialog', { name: 'Vai a' })).toBeNull();
    platform!.mockReturnValue('Win32');
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.queryByRole('dialog', { name: 'Vai a' })).toBeNull();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Vai a' })).toBeTruthy();
  });

  it('includes the creatives of visited projects', async () => {
    onPlatform('Win32');
    vi.mocked(api.listCreatives).mockImplementation(async () => []);
    await startApp();
    vi.mocked(api.listCreatives).mockResolvedValue([{ ok: true, slug: 'lancio', title: 'Lancio estivo', status: 'ready', formats: [], versions: 1, updatedAt: '2026-10-08T10:00:00.000Z', cover: null }]);
    act(() => { history.replaceState(null, '', '/#/p/acme'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await waitFor(() => expect(api.listCreatives).toHaveBeenCalledWith('acme'));
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Vai a' });
    await userEvent.type(within(dialog).getByRole('combobox'), 'lancio');
    await userEvent.keyboard('{Enter}');
    expect(location.hash).toBe('#/p/acme/c/lancio');
  });
});

describe('project bar', () => {
  it('shows the project switcher and the section tabs', async () => {
    history.replaceState(null, '', '/#/p/acme/brand');
    await startApp();
    const switcher = await screen.findByRole('button', { name: 'Progetto Acme, cambia progetto' });
    const nav = screen.getByRole('navigation', { name: 'Sezioni progetto' });
    expect(within(nav).getByRole('link', { name: 'Brand' }).getAttribute('aria-current')).toBe('page');
    await userEvent.click(switcher);
    await userEvent.click(screen.getByRole('button', { name: /Bravo Studio/ }));
    expect(location.hash).toBe('#/p/bravo');
  });

  it('changes from Creatives to Brand in place with T2 (soft fade, 6 px lift)', async () => {
    history.replaceState(null, '', '/#/p/acme');
    stubAnimations();
    const frames: string[] = [];
    const stubbed = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, f: Keyframe[], o: KeyframeAnimationOptions) {
      if (this.classList.contains('ms-page')) frames.push(String(f[0]?.transform ?? ''));
      return stubbed.call(this, f, o);
    } as never;
    await startApp();
    expect(await screen.findByText('Ancora nessuna creatività')).toBeTruthy();
    frames.length = 0;
    const nav = screen.getByRole('navigation', { name: 'Sezioni progetto' });
    await userEvent.click(within(nav).getByRole('link', { name: 'Brand' }));
    await waitFor(() => expect(location.hash).toBe('#/p/acme/brand'));
    // The project page stays (no T1 slide); its tab content enters from 6 px below, the old one fades out in place.
    await waitFor(() => expect(frames).toContain('translate(0px,6px) scale(1)'));
    expect(frames.some((t) => /translate\((-?16|24)px/.test(t))).toBe(false);
    await finishAll();
    expect(screen.queryByText('Ancora nessuna creatività')).toBeNull();
  });

  it('explains above an older tab when the project cannot be loaded', async () => {
    history.replaceState(null, '', '/#/p/acme/assets');
    vi.mocked(api.getProject).mockRejectedValue(new Error('Progetto non trovato'));
    await startApp();
    expect((await screen.findByText(/Impossibile caricare il progetto/)).textContent).toBe('Impossibile caricare il progetto: Progetto non trovato');
  });

  it('opens the account menu with Settings, System check and Replay setup', async () => {
    await startApp();
    await userEvent.click(screen.getByRole('button', { name: 'Menu account' }));
    await userEvent.click(screen.getByRole('button', { name: 'Controllo di sistema' }));
    expect(location.hash).toBe('#/settings/system');
    await userEvent.click(screen.getByRole('button', { name: 'Menu account' }));
    await userEvent.click(screen.getByRole('button', { name: 'Rifai la configurazione' }));
    expect(location.hash).toBe('#/welcome');
  });
});

describe('startup policy', () => {
  it('sums the requests already waiting into one toast, without a native notification', async () => {
    const bridge = desktopBridge();
    await startApp();
    send(snapshot([approval('a1'), approval('a2')]));
    expect(bridge.notify).not.toHaveBeenCalled();
    expect(screen.getByText('2 richieste hanno bisogno di te')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Rivedi' })).toHaveLength(1);
    expect(document.title).toBe('(2) Motion Studio');
    expect(bridge.setBadge).toHaveBeenLastCalledWith(2);
    // A later arrival is a real one.
    send({ type: 'approval', approval: approval('a3', 'Scaricare un font') });
    expect(bridge.notify).toHaveBeenCalledTimes(1);
    expect(bridge.notify).toHaveBeenCalledWith({ title: 'Motion Studio: serve la tua approvazione', body: 'Scaricare un font' });
    // A reconnection while requests were known: the new one in the snapshot is an arrival, the known ones are not.
    send(snapshot([approval('a1'), approval('a2'), approval('a3'), approval('a4', 'Usare internet')]));
    expect(bridge.notify).toHaveBeenCalledTimes(2);
    expect(bridge.notify).toHaveBeenLastCalledWith({ title: 'Motion Studio: serve la tua approvazione', body: 'Usare internet' });
  });

  it('treats a reconnection with nothing known before as a restore (singular toast)', async () => {
    const bridge = desktopBridge();
    await startApp();
    send(snapshot([]));
    send(snapshot([approval('a1')]));
    expect(bridge.notify).not.toHaveBeenCalled();
    expect(screen.getByText('1 richiesta ha bisogno di te')).toBeTruthy();
    expect(document.title).toBe('(1) Motion Studio');
  });
});

describe('activity center requests', () => {
  it('switches tab when asked while already open', async () => {
    const bell = await startApp();
    send({ type: 'approval', approval: approval('a1') });
    send({ type: 'job', job: job('j1', 'running', 'Lancio estivo') });
    await userEvent.click(bell);
    const tabs = screen.getByRole('tablist', { name: 'Sezioni attività' });
    expect(within(tabs).getByRole('tab', { selected: true }).textContent).toContain('Serve a te');
    // A click without the pointer-down that would close the popover first (as a keyboard activation).
    fireEvent.click(screen.getByRole('button', { name: '1 in corso' }));
    expect(within(screen.getByRole('tablist', { name: 'Sezioni attività' })).getByRole('tab', { selected: true }).textContent).toContain('In corso');
    expect(screen.getByText('Lancio estivo')).toBeTruthy();
  });
});

describe('new project from the switcher', () => {
  it('goes to Projects and focuses the name field', async () => {
    history.replaceState(null, '', '/#/p/acme');
    await startApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Progetto Acme, cambia progetto' }));
    await userEvent.click(screen.getByRole('button', { name: 'Nuovo progetto' }));
    expect(location.hash).toBe('#/');
    await waitFor(() => expect(document.activeElement?.id).toBe('new-project'));
  });
});

// End to end as far as tests reach: an approval arriving over the events WebSocket → useAttention → showNotification →
// the REAL desktop preload bridge → ms:notify → the REAL main-process handlers (origin guard with the dev origin,
// argument validation) → the Notification shown, and its outcome back to the page. Only Electron itself is faked: the
// IPC (which carries the sender like Electron does) and the Notification class.
import type { ApprovalRequest, DoctorCheck, ServerMessage, WorkspaceInfo } from '@motion-studio/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.ts';
import { App } from '../src/App.tsx';
import { __resetToasts } from '../src/ui/toast.tsx';

vi.mock('../src/api.ts', () => {
  const base: Record<string, unknown> = {};
  const api = new Proxy(base, { get: (t, k: string) => (t[k] ??= vi.fn(() => new Promise(() => {}))) });
  return { ApiError: class extends Error {}, api };
});

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (e: unknown, arg?: unknown) => unknown>(), event: null as unknown, exposed: null as unknown }));
// The preload imports `electron` from apps/desktop: mock that module (the web package itself has no Electron).
vi.mock('../../../apps/desktop/node_modules/electron/index.js', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { ipc.exposed = api; } },
  ipcRenderer: {
    invoke: async (channel: string, arg?: unknown) => ipc.handlers.get(channel)!(ipc.event, arg),
    on: () => {}, removeListener: () => {},
  },
}));

const { registerAttention, notificationOptions, showKept } = await import('../../../apps/desktop/src/notify.ts');
const { ipcSenderTrusted } = await import('../../../apps/desktop/src/window.ts');

type Listener = (...a: unknown[]) => void;
class FakeNotification {
  static made: FakeNotification[] = [];
  static answer: 'show' | 'failed' = 'show';
  handlers: Record<string, Listener[]> = {};
  constructor(readonly opts: unknown) { FakeNotification.made.push(this); }
  on(ev: string, fn: Listener) { (this.handlers[ev] ??= []).push(fn); return this; }
  show() {
    queueMicrotask(() => {
      const args = FakeNotification.answer === 'show' ? [{}] : [{}, 'The operation couldn’t be completed. (UNErrorDomain error 1.)'];
      for (const fn of this.handlers[FakeNotification.answer] ?? []) fn(...args);
    });
  }
}

const ORIGIN = 'http://127.0.0.1:64278'; // dev: the core on a free port, the UI loaded from it over http
let outcomes: unknown[] = [];
let reached: unknown[] = [];

async function installDesktop() {
  ipc.handlers.clear();
  const mainFrame = { url: `${ORIGIN}/#/` };
  const webContents = { mainFrame };
  ipc.event = { sender: webContents, senderFrame: mainFrame };
  const live = new Set<FakeNotification>();
  registerAttention({ handle: (ch, fn) => { ipc.handlers.set(ch, fn as never); } }, {
    trusted: (e) => ipcSenderTrusted(e, webContents, ORIGIN),
    isSupported: () => true,
    showNotification: async (args) => {
      reached.push(args);
      const o = await showKept(live, new FakeNotification(notificationOptions(args, 'darwin')), () => {});
      outcomes.push(o);
      return o;
    },
    dock: { setBadge: () => {}, bounce: () => 0 },
    invalid: () => new Error('Invalid request'),
  });
  vi.resetModules();
  await import('../../../apps/desktop/src/preload.ts');
  (window as unknown as { motionStudio: unknown }).motionStudio = ipc.exposed;
}

let sockets: FakeEventsSocket[] = [];
class FakeEventsSocket {
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: unknown; onerror: unknown;
  constructor() { sockets.push(this); }
  close() {}
}
const send = (msg: ServerMessage) => act(() => sockets.at(-1)!.onmessage!({ data: JSON.stringify(msg) }));
const okChecks: DoctorCheck[] = [{ id: 'git', label: 'Git', ok: true, required: true, message: 'ok' }];
const settings = { schemaVersion: 1 as const, maxConcurrentJobs: 2, expertMode: false, theme: 'system' as const, model: null, sandboxMode: 'auto' as const, extraAllowedDomains: [] as string[], confirmPaidProviders: true, autoApproveSandboxed: true, exportNamePattern: '{title}-{format}-v{v}' };
const approval = (id: string, title: string): ApprovalRequest => ({
  id, jobId: 'j1', projectSlug: 'acme', creativeSlug: 'lancio', kind: 'tool', title, detail: 'https://example.com', toolName: 'WebFetch', alwaysRule: null, explanation: null, agentReason: null,
  createdAt: '2026-10-08T10:00:00.000Z', expiresAt: '2026-10-08T10:10:00.000Z',
});

async function startApp() {
  vi.stubGlobal('WebSocket', FakeEventsSocket);
  vi.mocked(api.getDoctor).mockResolvedValue(okChecks);
  vi.mocked(api.getWorkspace).mockResolvedValue({ path: '/w', settings, error: null } as WorkspaceInfo);
  vi.mocked(api.listProjects).mockResolvedValue([]);
  render(<App />);
  await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
}

beforeEach(async () => {
  sockets = []; outcomes = []; reached = []; FakeNotification.made = []; FakeNotification.answer = 'show';
  history.replaceState(null, '', '/#/');
  await installDesktop();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { motionStudio?: unknown }).motionStudio;
  localStorage.clear();
  __resetToasts();
});

describe('approval → system notification, through the real preload and main handlers', () => {
  it('an approval arriving after the startup snapshot reaches Notification.show, with the dev origin', async () => {
    await startApp();
    send({ type: 'snapshot', jobs: [], approvals: [], locale: 'en', languageSetting: 'system', systemLocale: 'en' });
    expect(reached).toEqual([]);
    send({ type: 'approval', approval: approval('a1', 'Open a web page') });
    await waitFor(() => expect(outcomes).toEqual([{ shown: true }]));
    expect(reached).toEqual([{ title: 'Motion Studio: approval needed', body: 'Open a web page', sound: true }]);
    expect(FakeNotification.made.map((n) => n.opts)).toEqual([{ title: 'Motion Studio: approval needed', body: 'Open a web page', silent: false, sound: 'Glass' }]);
  });

  it('a refusal by the system (macOS dev build) is reported back, and the page keeps working with its toast', async () => {
    FakeNotification.answer = 'failed';
    await startApp();
    send({ type: 'snapshot', jobs: [], approvals: [], locale: 'en', languageSetting: 'system', systemLocale: 'en' });
    send({ type: 'approval', approval: approval('a1', 'Open a web page') });
    await waitFor(() => expect(outcomes).toEqual([{ shown: false, reason: 'failed', detail: 'The operation couldn’t be completed. (UNErrorDomain error 1.)' }]));
    expect(screen.getAllByText('Open a web page').length).toBeGreaterThan(0);
  });

  it('requests waiting at the first snapshot do not notify (startup rule); a later arrival does', async () => {
    await startApp();
    send({ type: 'snapshot', jobs: [], approvals: [approval('a1', 'Old one')], locale: 'en', languageSetting: 'system', systemLocale: 'en' });
    await Promise.resolve();
    expect(reached).toEqual([]);
    send({ type: 'approval', approval: approval('a2', 'New one') });
    await waitFor(() => expect(reached).toHaveLength(1));
    expect(reached[0]).toMatchObject({ body: 'New one' });
  });
});

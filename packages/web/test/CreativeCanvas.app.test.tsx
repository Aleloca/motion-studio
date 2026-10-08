import type { ApprovalRequest, CreativeDetail, DoctorCheck, ServerMessage, WorkspaceInfo } from '@motion-studio/shared';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { __resetToasts, getToasts } from '../src/ui/toast.tsx';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.ts';
import { App } from '../src/App.tsx';

// Review Focus 3: socket events while the board → editor transition runs.
vi.mock('../src/api.ts', () => {
  const base: Record<string, unknown> = { fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}` };
  const api = new Proxy(base, { get: (t, k: string) => (t[k] ??= vi.fn(() => new Promise(() => {}))) });
  return { ApiError: class extends Error {}, api };
});

/* Web Animations stub: page transitions stay in flight until finished (as in shell.test.tsx). */
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
const anims = new Map<Element, FakeAnim[]>();
const origAnimate = Element.prototype.animate;
const origGetAnimations = Element.prototype.getAnimations;
function stubAnimations() {
  Element.prototype.animate = function (this: Element, _f: Keyframe[], opts: KeyframeAnimationOptions) {
    const fake = new FakeAnim(opts.fill === 'forwards');
    anims.set(this, [...(anims.get(this) ?? []), fake]);
    return fake as unknown as Animation;
  } as never;
  Element.prototype.getAnimations = function (this: Element) {
    return (anims.get(this) ?? []).filter((a) => !a.cancelled && (!a.done || a.holds)) as unknown as Animation[];
  } as never;
}
const finishAll = async () => {
  await act(async () => { for (const list of anims.values()) for (const a of list) if (!a.cancelled && !a.done) a.finish(); });
};

let sockets: FakeEventsSocket[] = [];
class FakeEventsSocket {
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: unknown; onerror: unknown;
  constructor() { sockets.push(this); }
  close() {}
}
const send = (msg: ServerMessage) => act(() => sockets.at(-1)!.onmessage!({ data: JSON.stringify(msg) }));

const at = '2026-10-08T10:00:00.000Z';
const okChecks: DoctorCheck[] = [{ id: 'git', label: 'Git', ok: true, required: true, message: 'ok' }];
const settings = { schemaVersion: 1 as const, maxConcurrentJobs: 2, expertMode: false, theme: 'system' as const, model: null, sandboxMode: 'auto' as const, extraAllowedDomains: [] as string[], confirmPaidProviders: true };
const detail: CreativeDetail = {
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio',
  versions: [{ n: 1, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', outputs: [{ format: 'instagram-post-1x1', file: 'post.png', width: 1080, height: 1080, durationSec: null, verified: true, preview: null }], problems: [], tools: [], renderCommand: null, basedOn: null }],
  creative: { schemaVersion: 1, title: 'Lancio estivo', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: '', formats: ['instagram-post-1x1'], durationSec: 6, assets: [], notes: '' } },
};
const approval = (id: string): ApprovalRequest => ({
  id, jobId: 'j1', projectSlug: 'acme', creativeSlug: 'lancio', kind: 'tool', title: `Richiesta ${id}`, detail: 'ls -la', toolName: 'Bash', alwaysRule: null,
  createdAt: at, expiresAt: '2026-10-08T10:10:00.000Z',
});

beforeEach(() => { sockets = []; history.replaceState(null, '', '/#/p/acme/c/lancio'); });
afterEach(() => {
  __resetToasts();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  Element.prototype.animate = origAnimate;
  Element.prototype.getAnimations = origGetAnimations;
  anims.clear();
  history.replaceState(null, '', '/');
});

describe('creative canvas in the app', () => {
  it('an approval arriving while the editor opens: no error, one bell with the right count', async () => {
    const errors = vi.spyOn(console, 'error');
    stubAnimations();
    vi.stubGlobal('WebSocket', FakeEventsSocket);
    vi.mocked(api.getDoctor).mockResolvedValue(okChecks);
    vi.mocked(api.getWorkspace).mockResolvedValue({ path: '/w', settings, error: null } as WorkspaceInfo);
    vi.mocked(api.listProjects).mockResolvedValue([{ slug: 'acme', ok: true, project: { schemaVersion: 1, name: 'Acme', description: '', createdAt: at, updatedAt: at, linkedCodebases: [] } }]);
    vi.mocked(api.listCreatives).mockResolvedValue([]);
    vi.mocked(api.getFormats).mockResolvedValue({ presets: DEFAULT_FORMATS, error: null, path: '/x' });
    vi.mocked(api.getCreative).mockResolvedValue(detail);
    vi.mocked(api.getConversation).mockResolvedValue([]);
    render(<App />);
    const img = await screen.findByRole('img', { name: /Post 1:1 v1/ });
    await finishAll();
    const bell = screen.getByRole('button', { name: /^Attività/ });

    // Double click: the creative page leaves while the format page enters.
    fireEvent.doubleClick(img.closest('[data-frame]')!);
    await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(location.hash).toBe('#/p/acme/c/lancio/f/instagram-post-1x1');
    expect(document.querySelectorAll('.ms-main > .ms-stage > .ms-page')).toHaveLength(2);

    send({ type: 'approval', approval: approval('a1') });
    send({ type: 'approval', approval: approval('a1') }); // replayed
    expect(screen.getAllByRole('button', { name: /^Attività/ })).toEqual([bell]);
    expect(bell.getAttribute('aria-label')).toBe('Attività, 1 in attesa');

    await finishAll();
    expect(document.querySelectorAll('.ms-main > .ms-stage > .ms-page')).toHaveLength(1);
    expect(bell.getAttribute('aria-label')).toBe('Attività, 1 in attesa');
    send({ type: 'approval_resolved', id: 'a1', decision: 'once' });
    expect(bell.getAttribute('aria-label')).toBe('Attività');
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('a new version arriving while the editor opens: no error, the format page shows it, no stray toast from the leaving page', async () => {
    const errors = vi.spyOn(console, 'error');
    stubAnimations();
    vi.stubGlobal('WebSocket', FakeEventsSocket);
    vi.mocked(api.getDoctor).mockResolvedValue(okChecks);
    vi.mocked(api.getWorkspace).mockResolvedValue({ path: '/w', settings, error: null } as WorkspaceInfo);
    vi.mocked(api.listProjects).mockResolvedValue([{ slug: 'acme', ok: true, project: { schemaVersion: 1, name: 'Acme', description: '', createdAt: at, updatedAt: at, linkedCodebases: [] } }]);
    vi.mocked(api.listCreatives).mockResolvedValue([]);
    vi.mocked(api.getFormats).mockResolvedValue({ presets: DEFAULT_FORMATS, error: null, path: '/x' });
    vi.mocked(api.getCreative).mockResolvedValue(detail);
    vi.mocked(api.getConversation).mockResolvedValue([]);
    render(<App />);
    const img = await screen.findByRole('img', { name: /Post 1:1 v1/ });
    await finishAll();
    fireEvent.doubleClick(img.closest('[data-frame]')!);
    await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(document.querySelectorAll('.ms-main > .ms-stage > .ms-page')).toHaveLength(2);

    // v2 lands mid-transition.
    const v2 = { ...detail.versions[0]!, n: 2, outputs: [{ ...detail.versions[0]!.outputs[0]!, file: 'post2.png' }] };
    vi.mocked(api.getCreative).mockResolvedValue({ ...detail, versions: [...detail.versions, v2] });
    send({ type: 'creative', project: 'acme', creative: 'lancio' } as ServerMessage);
    await act(async () => { await Promise.resolve(); });
    await finishAll();
    expect(document.querySelectorAll('.ms-main > .ms-stage > .ms-page')).toHaveLength(1);
    expect(location.hash).toBe('#/p/acme/c/lancio/f/instagram-post-1x1');
    // Only the page on screen announces it (the leaving canvas is not active).
    expect(getToasts().filter((x) => x.text === 'v2 è pronta').length).toBeLessThanOrEqual(1);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

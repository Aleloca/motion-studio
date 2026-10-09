import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTENTION_CLICK, attentionHandlers, badgeArg, notificationOptions, notifyArgs, registerAttention, sendAttentionClick, showKept, type AttentionDeps } from '../src/notify.ts';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(() => Promise.resolve()) },
}));

describe('preload', () => {
  afterEach(() => { vi.resetModules(); });
  it('exposes notify and setBadge over the ms:notify / ms:badge channels', async () => {
    const electron = await import('electron');
    await import('../src/preload.ts');
    const expose = vi.mocked(electron.contextBridge.exposeInMainWorld);
    expect(expose).toHaveBeenCalledWith('motionStudio', expect.any(Object));
    const bridge = expose.mock.calls[0]![1] as { notify(p: { title: string; body: string }): Promise<void>; setBadge(n: number): Promise<void>; pickFolder: unknown; revealPath: unknown };
    expect(typeof bridge.pickFolder).toBe('function');
    expect(typeof bridge.revealPath).toBe('function');
    await bridge.notify({ title: 'Motion Studio', body: 'Run a command' });
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith('ms:notify', { title: 'Motion Studio', body: 'Run a command' });
    await bridge.setBadge(3);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith('ms:badge', 3);
  });
});

describe('argument validation', () => {
  it('accepts a title and body up to 200 characters', () => {
    expect(notifyArgs({ title: 'Motion Studio', body: 'Run ls' })).toEqual({ title: 'Motion Studio', body: 'Run ls' });
    expect(notifyArgs({ title: 'T', body: '' })).toEqual({ title: 'T', body: '' });
    expect(notifyArgs({ title: 'x'.repeat(200), body: 'y'.repeat(200) })).not.toBeNull();
  });
  it.each([
    ['too long title', { title: 'x'.repeat(201), body: '' }],
    ['too long body', { title: 'T', body: 'y'.repeat(201) }],
    ['empty title', { title: '', body: 'b' }],
    ['number title', { title: 5, body: 'b' }],
    ['missing body', { title: 'T' }],
    ['null', null],
    ['string', 'Motion Studio'],
    ['array', ['T', 'b']],
  ])('rejects %s', (_name, arg) => { expect(notifyArgs(arg)).toBeNull(); });

  it('accepts integer badges from 0 to 99 only', () => {
    expect(badgeArg(0)).toBe(0);
    expect(badgeArg(7)).toBe(7);
    expect(badgeArg(99)).toBe(99);
    for (const bad of [-1, 100, 1.5, Number.NaN, Infinity, '3', null, undefined, {}]) expect(badgeArg(bad)).toBeNull();
  });
});

describe('main handlers', () => {
  const event = { sender: 'win' } as never;
  function deps(trusted = true, supported = true) {
    const shown: Array<{ title: string; body: string; sound?: boolean }> = [];
    const dock = { setBadge: vi.fn(), bounce: vi.fn(() => 1) };
    const d: AttentionDeps = { trusted: () => trusted, isSupported: () => supported, unsupported: () => new Error('Unsupported'), showNotification: (a) => { shown.push(a); }, dock, invalid: () => new Error('Invalid request') };
    return { d, shown, dock };
  }

  it('shows a native notification for a valid request', () => {
    const { d, shown } = deps();
    attentionHandlers(d).notify(event, { title: 'Motion Studio', body: 'Run ls' });
    expect(shown).toEqual([{ title: 'Motion Studio', body: 'Run ls' }]);
  });

  it('rejects invalid arguments and untrusted senders', () => {
    const ok = deps();
    const h = attentionHandlers(ok.d);
    expect(() => h.notify(event, { title: 'x'.repeat(201), body: '' })).toThrow('Invalid request');
    expect(() => h.badge(event, 100)).toThrow('Invalid request');
    expect(() => h.badge(event, '2')).toThrow('Invalid request');
    expect(ok.shown).toEqual([]);
    expect(ok.dock.setBadge).not.toHaveBeenCalled();
    const bad = deps(false);
    const u = attentionHandlers(bad.d);
    expect(() => u.notify(event, { title: 'T', body: 'b' })).toThrow('Invalid request');
    expect(() => u.badge(event, 1)).toThrow('Invalid request');
    expect(bad.shown).toEqual([]);
    expect(bad.dock.setBadge).not.toHaveBeenCalled();
  });

  it('bounces once with each notification; the badge only mirrors the count', () => {
    const { d, dock } = deps();
    const h = attentionHandlers(d);
    h.badge(event, 3); // restored at startup: no bounce
    expect(dock.setBadge).toHaveBeenLastCalledWith('3');
    expect(dock.bounce).not.toHaveBeenCalled();
    h.notify(event, { title: 'Motion Studio', body: 'Run ls' });
    expect(dock.bounce).toHaveBeenCalledTimes(1);
    expect(dock.bounce).toHaveBeenCalledWith('informational');
    h.badge(event, 4);
    expect(dock.bounce).toHaveBeenCalledTimes(1);
    h.badge(event, 0);
    expect(dock.setBadge).toHaveBeenLastCalledWith('');
    expect(() => h.notify(event, { title: '', body: '' })).toThrow();
    expect(dock.bounce).toHaveBeenCalledTimes(1); // a refused request does not bounce
  });

  it('works without a dock (Windows, Linux)', () => {
    const { d } = deps();
    const h = attentionHandlers({ ...d, dock: undefined });
    expect(() => h.badge(event, 3)).not.toThrow();
    expect(() => h.notify(event, { title: 'T', body: 'b' })).not.toThrow();
  });

  it('registers both channels on ipcMain', () => {
    const handle = vi.fn();
    registerAttention({ handle }, deps().d);
    expect(handle.mock.calls.map((c) => c[0])).toEqual(['ms:notify', 'ms:notify-status', 'ms:badge']);
  });

  it('is wired in main.ts with the same origin guard as the other IPC handlers', () => {
    const main = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(main).toMatch(/registerAttention\(ipcMain, \{\s*trusted,/);
  });
});

describe('notification sound and visibility', () => {
  const event = { sender: 'win' } as never;
  const mk = (trusted = true, supported = true) => {
    const shown: unknown[] = [];
    const d: AttentionDeps = { trusted: () => trusted, isSupported: () => supported, unsupported: () => new Error('Unsupported'), showNotification: (a) => { shown.push(a); }, dock: undefined, invalid: () => new Error('Invalid request') };
    return { d, shown };
  };
  const base = { title: 'T', body: 'b' };

  it('sound on: silent false, plus the named sound on macOS only', () => {
    expect(notificationOptions({ ...base, sound: true }, 'darwin')).toEqual({ ...base, silent: false, sound: 'Glass' });
    expect(notificationOptions({ ...base, sound: true }, 'win32')).toEqual({ ...base, silent: false });
    expect(notificationOptions({ ...base, sound: true }, 'linux')).toEqual({ ...base, silent: false });
    expect(notificationOptions(base, 'darwin').silent).toBe(false); // absent = default sound
  });
  it('sound off: silent true, no sound name', () => {
    expect(notificationOptions({ ...base, sound: false }, 'darwin')).toEqual({ ...base, silent: true });
  });
  it('accepts a boolean sound and rejects anything else', () => {
    expect(notifyArgs({ ...base, sound: false })).toEqual({ ...base, sound: false });
    expect(notifyArgs({ ...base, sound: true })).toEqual({ ...base, sound: true });
    for (const bad of ['false', 0, 1, null, {}, []]) expect(notifyArgs({ ...base, sound: bad })).toBeNull();
    const { d, shown } = mk();
    expect(() => attentionHandlers(d).notify(event, { ...base, sound: 'yes' })).toThrow('Invalid request');
    expect(shown).toEqual([]);
  });
  it('reports an error when notifications are not supported', () => {
    const { d, shown } = mk(true, false);
    expect(() => attentionHandlers(d).notify(event, base)).toThrow('Unsupported');
    expect(shown).toEqual([]);
    expect(attentionHandlers(d).status(event)).toEqual({ supported: false });
    expect(attentionHandlers(mk().d).status(event)).toEqual({ supported: true });
  });
  it('keeps the origin check on notify and status', () => {
    const { d, shown } = mk(false);
    expect(() => attentionHandlers(d).notify(event, { ...base, sound: true })).toThrow('Invalid request');
    expect(() => attentionHandlers(d).status(event)).toThrow('Invalid request');
    expect(shown).toEqual([]);
  });
  it('preload exposes notifyStatus over ms:notify-status and forwards sound', async () => {
    const electron = await import('electron');
    vi.mocked(electron.contextBridge.exposeInMainWorld).mockClear();
    vi.resetModules();
    await import('../src/preload.ts');
    const bridge = vi.mocked((await import('electron')).contextBridge.exposeInMainWorld).mock.calls[0]![1] as { notify(p: unknown): Promise<void>; notifyStatus(): Promise<unknown> };
    await bridge.notify({ ...base, sound: false });
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith('ms:notify', { ...base, sound: false });
    await bridge.notifyStatus();
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith('ms:notify-status');
  });
});

describe('notification clicks (D1)', () => {
  afterEach(() => { vi.resetModules(); });

  it('keeps each notification alive until it is clicked, closed or fails', () => {
    const live = new Set<{ on: (ev: string, fn: () => void) => void; show: () => void; fire: (ev: string) => void }>();
    const make = () => {
      const handlers: Record<string, () => void> = {};
      return { on: (ev: string, fn: () => void) => { handlers[ev] = fn; }, show: vi.fn(), fire: (ev: string) => handlers[ev]?.() };
    };
    const clicked = vi.fn();
    const [a, b, c] = [make(), make(), make()];
    for (const n of [a, b, c]) showKept(live, n, clicked);
    expect(live.size).toBe(3);
    expect(a.show).toHaveBeenCalled();
    a.fire('click');
    expect(clicked).toHaveBeenCalledTimes(1);
    b.fire('close');
    c.fire('failed');
    expect(live.size).toBe(0);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('sends the click to the page only while the window shows the app', () => {
    const wc = { isDestroyed: vi.fn(() => false), getURL: vi.fn(() => 'http://127.0.0.1:4317/#/'), send: vi.fn() };
    const isApp = (u: string) => u.startsWith('http://127.0.0.1:4317/');
    expect(sendAttentionClick(wc, isApp)).toBe(true);
    expect(wc.send).toHaveBeenCalledWith(ATTENTION_CLICK);
    expect(wc.send.mock.calls[0]).toHaveLength(1); // no data goes with it
    wc.getURL.mockReturnValue('https://evil.example/');
    expect(sendAttentionClick(wc, isApp)).toBe(false);
    wc.isDestroyed.mockReturnValue(true);
    wc.getURL.mockReturnValue('http://127.0.0.1:4317/#/');
    expect(sendAttentionClick(wc, isApp)).toBe(false);
    expect(wc.send).toHaveBeenCalledTimes(1);
  });

  it('preload: onAttentionClick listens on ms:attention-click, calls back without the event, and unsubscribes', async () => {
    const electron = await import('electron');
    const on = vi.fn();
    const removeListener = vi.fn();
    Object.assign(electron.ipcRenderer, { on, removeListener });
    vi.mocked(electron.contextBridge.exposeInMainWorld).mockClear();
    await import('../src/preload.ts');
    const bridge = vi.mocked(electron.contextBridge.exposeInMainWorld).mock.calls[0]![1] as { onAttentionClick(cb: unknown): () => void };
    const cb = vi.fn();
    const off = bridge.onAttentionClick(cb);
    expect(on).toHaveBeenCalledWith('ms:attention-click', expect.any(Function));
    const listener = on.mock.calls[0]![1] as (...a: unknown[]) => void;
    listener({ sender: 'secret' }, 'x');
    expect(cb).toHaveBeenCalledWith();
    off();
    expect(removeListener).toHaveBeenCalledWith('ms:attention-click', listener);
    // A non-function is ignored.
    expect(typeof bridge.onAttentionClick('nope')).toBe('function');
    expect(on).toHaveBeenCalledTimes(1);
  });
});

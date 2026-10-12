// @vitest-environment node
/**
 * The desktop's Electron render provider (phase 10a Task 7), without Electron: window options, the per-session lockdown,
 * the `webContents.debugger` CDP adapter, closing windows, and the window cap. The same code in real Electron (renders,
 * hostile layers, quit, memory) is in render-window.electron.test.ts.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppMetrics: vi.fn(() => []) },
  powerSaveBlocker: { start: vi.fn(() => 7), stop: vi.fn() },
  BrowserWindow: vi.fn(),
  session: { fromPartition: vi.fn() },
}));

const {
  renderWindowOptions, renderProxyConfig, renderRequestAllowed, lockRenderSession, closeRenderWindow, DebuggerCdpClient,
  ElectronProvider, RENDER_PARTITION_PREFIX, desktopRenderOptions, DESKTOP_RENDER_PARALLEL,
} = await import('../src/render-window.ts');

const PREFIX = 'http://127.0.0.1:43210/abcdefghijklmnop0123/';

describe('render window options', () => {
  it('is hidden, offscreen, sandboxed, isolated, with no preload and no node, on its own in-memory partition', () => {
    const o = renderWindowOptions(`${RENDER_PARTITION_PREFIX}x1`, 1080, 1920);
    expect(o.show).toBe(false);
    expect(o).toMatchObject({ width: 1080, height: 1920, useContentSize: true, enableLargerThanScreen: true, frame: false, skipTaskbar: true, focusable: false });
    const w = o.webPreferences!;
    expect(w).toMatchObject({
      offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      backgroundThrottling: false, spellcheck: false, partition: 'ms-render-x1',
    });
    expect(w.preload).toBeUndefined();
    // Non-persistent: an Electron partition without the `persist:` prefix lives in memory only.
    expect(w.partition!.startsWith('persist:')).toBe(false);
  });

  it('refuses a persistent partition', () => {
    expect(() => renderWindowOptions('persist:ms-render-x', 10, 10)).toThrow();
  });
});

describe('render session lockdown', () => {
  it('a dead proxy that bypasses only the composition server (loopback bypass removed)', () => {
    expect(renderProxyConfig(PREFIX)).toEqual({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '<-loopback>;127.0.0.1:43210' });
    expect(() => renderProxyConfig('http://localhost:43210/abcdefghijklmnop0123/')).toThrow();
  });

  it.each([
    [`${PREFIX}runtime/index.html?mode=render`, true],
    [`${PREFIX}layers/a.html`, true],
    ['http://127.0.0.1:43210/other-token-0123456789/x', false],
    ['http://127.0.0.1:43211/abcdefghijklmnop0123/x', false],
    ['ws://127.0.0.1:43210/abcdefghijklmnop0123/ws', false],
    ['https://example.com/', false],
    ['file:///etc/hosts', false],
    ['data:text/html,x', false],
    ['http://user:pw@127.0.0.1:43210/abcdefghijklmnop0123/x', false],
  ])('allows %s: %s', (url, ok) => {
    expect(renderRequestAllowed(url, PREFIX)).toBe(ok);
  });

  it('installs the proxy, the request filter, and denies permissions and downloads', async () => {
    const handlers: Record<string, (...a: never[]) => unknown> = {};
    const ses = {
      setProxy: vi.fn(async () => {}),
      closeAllConnections: vi.fn(async () => {}),
      webRequest: { onBeforeRequest: vi.fn((f: never) => { handlers.request = f; }), onBeforeSendHeaders: vi.fn((f: never) => { handlers.headers = f; }) },
      setPermissionRequestHandler: vi.fn((f: never) => { handlers.permission = f; }),
      setPermissionCheckHandler: vi.fn((f: never) => { handlers.check = f; }),
      setDevicePermissionHandler: vi.fn((f: never) => { handlers.device = f; }),
      setDisplayMediaRequestHandler: vi.fn((f: never) => { handlers.display = f; }),
      setSpellCheckerEnabled: vi.fn(),
      on: vi.fn((ev: string, f: never) => { handlers[ev] = f; }),
    };
    await lockRenderSession(ses as never, PREFIX);
    expect(ses.setProxy).toHaveBeenCalledWith(renderProxyConfig(PREFIX));
    expect(ses.closeAllConnections).toHaveBeenCalled();
    const decide = (url: string) => new Promise<unknown>((r) => (handlers.request as unknown as (d: unknown, cb: (x: unknown) => void) => void)({ url, resourceType: 'xhr' }, r));
    expect(await decide(`${PREFIX}a.png`)).toEqual({ cancel: false });
    expect(await decide('http://127.0.0.1:4318/api/health')).toEqual({ cancel: true });
    expect(await decide('ws://127.0.0.1:43210/abcdefghijklmnop0123/ws')).toEqual({ cancel: true });
    const headers = (h: Record<string, string>) => new Promise<unknown>((r) => (handlers.headers as unknown as (d: unknown, cb: (x: unknown) => void) => void)({ url: `${PREFIX}sw.js`, requestHeaders: h }, r));
    expect(await headers({ 'Service-Worker': 'script' })).toMatchObject({ cancel: true });
    expect(await headers({ 'Sec-Fetch-Dest': 'sharedworker' })).toMatchObject({ cancel: true });
    expect(await headers({ 'sec-fetch-dest': 'serviceworker' })).toMatchObject({ cancel: true });
    expect(await headers({ 'Sec-Fetch-Dest': 'worker' })).toMatchObject({ cancel: false, requestHeaders: { 'Sec-Fetch-Dest': 'worker' } });
    expect(await headers({ Accept: '*/*' })).toMatchObject({ cancel: false });
    const granted = await new Promise((r) => (handlers.permission as unknown as (...a: unknown[]) => void)({}, 'media', r, {}));
    expect(granted).toBe(false);
    expect((handlers.check as unknown as () => boolean)()).toBe(false);
    expect((handlers.device as unknown as () => boolean)()).toBe(false);
    const prevented = vi.fn();
    (handlers['will-download'] as unknown as (e: unknown) => void)({ preventDefault: prevented });
    expect(prevented).toHaveBeenCalled();
    expect(ses.setSpellCheckerEnabled).toHaveBeenCalledWith(false);
    // Display media: refused with null (never an empty stream set), and a destroyed frame's throw is swallowed.
    const display = vi.fn();
    (handlers.display as unknown as (r: unknown, cb: (s: unknown) => void) => void)({}, display);
    expect(display).toHaveBeenCalledWith(null);
    expect(() => (handlers.display as unknown as (r: unknown, cb: (s: unknown) => void) => void)({}, () => { throw new Error('gone'); })).not.toThrow();
  });
});

/** A fake `webContents.debugger`. */
function fakeDebugger(answer: (method: string, params: unknown, sessionId?: string) => Promise<unknown>) {
  const d = new EventEmitter() as EventEmitter & { attached: boolean; attach: (v: string) => void; detach: () => void; isAttached: () => boolean; sendCommand: (m: string, p?: unknown, s?: string) => Promise<unknown> };
  d.attached = false;
  d.attach = () => { d.attached = true; };
  d.detach = () => { d.attached = false; d.emit('detach', {}, 'target closed'); };
  d.isAttached = () => d.attached;
  d.sendCommand = (m, p, s) => answer(m, p, s);
  return d;
}

describe('webContents.debugger as a CDP client', () => {
  it('passes the session id, reports the own target with no session id, and maps errors', async () => {
    const calls: Array<[string, string | undefined]> = [];
    const d = fakeDebugger(async (m, _p, s) => { calls.push([m, s]); if (m === 'Bad.call') throw new Error('nope'); return { ok: 1 }; });
    const c = new DebuggerCdpClient(d as never);
    c.attach();
    expect(await c.send('Page.enable', {}, { sessionId: 'S1' })).toEqual({ ok: 1 });
    await c.send('Target.getTargetInfo');
    expect(calls).toEqual([['Page.enable', 'S1'], ['Target.getTargetInfo', undefined]]);
    await expect(c.send('Bad.call')).rejects.toMatchObject({ name: 'CdpError', code: 'remote' });
    const events: unknown[] = [];
    c.onEvent((e) => events.push(e));
    d.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'S2' }, '');
    d.emit('message', {}, 'Page.loadEventFired', { timestamp: 1 }, 'S1');
    expect(events).toEqual([{ method: 'Target.attachedToTarget', params: { sessionId: 'S2' } }, { method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S1' }]);
  });

  it('times out a call that never answers, and fails the calls of a detached session at once', async () => {
    const d = fakeDebugger(() => new Promise(() => {}));
    const c = new DebuggerCdpClient(d as never, 50);
    c.attach();
    await expect(c.send('Runtime.evaluate')).rejects.toMatchObject({ code: 'timeout' });
    const pending = c.send('Page.navigate', {}, { sessionId: 'S1', timeoutMs: 10_000 });
    d.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'S1' }, '');
    await expect(pending).rejects.toMatchObject({ code: 'closed' });
  });

  it('ends on detach: pending and later calls fail, close listeners run once', async () => {
    const d = fakeDebugger(() => new Promise(() => {}));
    const c = new DebuggerCdpClient(d as never, 10_000);
    c.attach();
    const closed = vi.fn();
    c.onClose(closed);
    const pending = c.send('Page.navigate');
    d.emit('detach', {}, 'render process gone');
    await expect(pending).rejects.toMatchObject({ code: 'closed' });
    await expect(c.send('Page.enable')).rejects.toMatchObject({ code: 'closed' });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(c.closed).not.toBeNull();
  });
});

/** A fake BrowserWindow for close(). */
function fakeWindow(o: { closes: boolean }) {
  const w = new EventEmitter() as EventEmitter & { destroyed: boolean; isDestroyed(): boolean; close(): void; destroy(): void; webContents: EventEmitter & { debugger: { isAttached(): boolean; detach(): void } } };
  w.destroyed = false;
  w.isDestroyed = () => w.destroyed;
  const finish = () => { if (w.destroyed) return; w.destroyed = true; setImmediate(() => w.emit('closed')); };
  w.close = vi.fn(() => { if (o.closes) finish(); });
  w.destroy = vi.fn(finish);
  w.webContents = Object.assign(new EventEmitter(), { debugger: { isAttached: () => false, detach: vi.fn() } });
  return w;
}

describe('closing a render window', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('waits for closed (never a bare destroy() before a new loadURL)', async () => {
    const w = fakeWindow({ closes: true });
    let done = false;
    const p = closeRenderWindow(w as never).then(() => { done = true; });
    expect(w.close).toHaveBeenCalled();
    expect(done).toBe(false);
    await p;
    expect(w.destroy).not.toHaveBeenCalled();
  });

  it('destroys a window that does not close in time (a page that blocks unload), and still waits for closed', async () => {
    const w = fakeWindow({ closes: false });
    await closeRenderWindow(w as never, 30);
    expect(w.destroy).toHaveBeenCalled();
    expect(w.isDestroyed()).toBe(true);
  });

  it('is a no-op on a destroyed window', async () => {
    const w = fakeWindow({ closes: true });
    w.destroyed = true;
    await closeRenderWindow(w as never);
    expect(w.close).not.toHaveBeenCalled();
  });
});

describe('app-wide window slots (M7, N3)', () => {
  it('a render page past its share waits for a window to close; an abort ends the wait', async () => {
    const { WindowSlots } = await import('../src/render-window.ts');
    const slots = new WindowSlots(3); // 2 for renders, 1 reserved for the preview lane
    expect(slots.renderLimit).toBe(2);
    const a = await slots.acquire();
    await slots.acquire();
    let third = false;
    const p = slots.acquire().then((r) => { third = true; return r; });
    const ac = new AbortController();
    const aborted = slots.acquire(ac.signal);
    await new Promise((r) => setTimeout(r, 10));
    expect(third).toBe(false);
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'cancelled' });
    a();
    a(); // idempotent
    await p;
    expect(third).toBe(true);
    expect(slots.inUse).toBe(2);
  });

  it('a render holding its maximum still lets a preview window open (the reserved slot); then previews share what is free', async () => {
    const { WindowSlots } = await import('../src/render-window.ts');
    const slots = new WindowSlots(5); // the desktop: 4 render pages + 1 reserved
    const render = await Promise.all([0, 1, 2, 3].map(() => slots.acquire(undefined, 'render')));
    // The render lane never exceeds limit - 1, even with a window free.
    const ac = new AbortController();
    let fifthRender = false;
    const fifth = slots.acquire(ac.signal, 'render').then(() => { fifthRender = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(fifthRender).toBe(false);
    ac.abort();
    await fifth.catch(() => {});
    const preview = await Promise.race([slots.acquire(undefined, 'preview'), new Promise<null>((r) => setTimeout(() => r(null), 200))]);
    expect(preview, 'the preview lane is never queued behind the render').not.toBeNull();
    expect(slots.inUse).toBe(5);
    // A second preview waits for a free window (any one).
    let second = false;
    const p2 = slots.acquire(undefined, 'preview').then((r) => { second = true; return r; });
    await new Promise((r) => setTimeout(r, 10));
    expect(second).toBe(false);
    render[0]!();
    await p2;
    expect(second).toBe(true);
  });

  it('desktopRenderOptions sets the app-wide limit to the pages plus the reserved slot', async () => {
    const { renderWindowSlots } = await import('../src/render-window.ts');
    desktopRenderOptions('/r', 3);
    expect(renderWindowSlots.limit).toBe(4);
    expect(renderWindowSlots.renderLimit).toBe(3);
    desktopRenderOptions('/r');
    expect(renderWindowSlots.limit).toBe(DESKTOP_RENDER_PARALLEL + 1);
  });
});

describe('quit (M1)', () => {
  it('cancels the jobs (server close) before closing the render windows, then gives the server a last grace', async () => {
    const { shutdownForQuit } = await import('../src/render-window.ts');
    const order: string[] = [];
    let finish!: () => void;
    const closeServer = () => { order.push('server'); return new Promise<void>((r) => { finish = () => { order.push('server done'); r(); }; }); };
    const done = shutdownForQuit({ closeServer, serverMs: 30, windowsMs: 30, graceMs: 1000 }).then(() => order.push('quit'));
    await new Promise((r) => setTimeout(r, 60));
    expect(order).toEqual(['server']); // still waiting in the grace for the server
    finish();
    await done;
    expect(order).toEqual(['server', 'server done', 'quit']);
  });
});

describe('ElectronProvider', () => {
  it('is kind electron and opens at most maxWindows windows at once', async () => {
    const created: unknown[] = [];
    const provider = new ElectronProvider({ maxWindows: 2, limits: { timeLimitMs: 60_000 }, createWindow: (o) => { created.push(o); return new Promise(() => {}); } });
    expect(provider.kind).toBe('electron');
    const signal = new AbortController().signal;
    const url = `${PREFIX}runtime/index.html?mode=render`;
    void provider.open({ width: 320, height: 180, url, signal }).catch(() => {});
    void provider.open({ width: 320, height: 180, url, signal }).catch(() => {});
    await expect(provider.open({ width: 320, height: 180, url, signal })).rejects.toThrow(/at most 2/);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ prefix: PREFIX, width: 320, height: 180 });
  });

  it('close() waits for a window still being created, and that window is closed (M6)', async () => {
    let resolveCreate!: (rw: unknown) => void;
    const win = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
    const rwClose = vi.fn(async () => { win.emit('closed'); });
    const createWindow = vi.fn(() => new Promise<never>((r) => { resolveCreate = r as (rw: unknown) => void; }));
    const provider = new ElectronProvider({ limits: { timeLimitMs: 60_000 }, createWindow });
    const opened = provider.open({ width: 10, height: 10, url: `${PREFIX}runtime/index.html`, signal: new AbortController().signal });
    opened.catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    let closed = false;
    const closing = provider.close().then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false);
    resolveCreate({ win, pids: () => [], close: rwClose });
    await closing;
    expect(rwClose).toHaveBeenCalled();
    await expect(opened).rejects.toMatchObject({ code: 'cancelled' });
    expect(provider.openWindows).toBe(0);
  });

  it('close() ends a wait for an app-wide slot even when the open\'s own signal never fires (N2), and frames pages ask the preview lane', async () => {
    const seen: Array<{ lane?: string; signal?: AbortSignal }> = [];
    const createWindow = vi.fn((o: { lane?: string; signal?: AbortSignal }) => {
      seen.push(o);
      return new Promise<never>((_r, reject) => o.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    const provider = new ElectronProvider({ limits: { timeLimitMs: 60_000 }, createWindow: createWindow as never });
    const live = new AbortController().signal;
    const opened = provider.open({ width: 10, height: 10, url: `${PREFIX}runtime/index.html`, signal: live, purpose: 'frames' });
    opened.catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(seen[0]!.lane).toBe('preview');
    await Promise.race([provider.close(), new Promise((_r, reject) => setTimeout(() => reject(new Error('close() did not end the wait')), 2000))]);
    expect(seen[0]!.signal!.aborted).toBe(true);
    await expect(opened).rejects.toBeTruthy();
  });

  it('refuses a page URL that is not a composition server page, and opens nothing after close', async () => {
    const createWindow = vi.fn(() => new Promise<never>(() => {}));
    const provider = new ElectronProvider({ limits: { timeLimitMs: 60_000 }, createWindow });
    const signal = new AbortController().signal;
    await expect(provider.open({ width: 10, height: 10, url: 'https://example.com/x', signal })).rejects.toThrow();
    await provider.close();
    await expect(provider.open({ width: 10, height: 10, url: `${PREFIX}runtime/index.html`, signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(createWindow).not.toHaveBeenCalled();
  });
});

describe('desktop wiring', () => {
  it('Electron is the provider, with the runtime folder and one parallel value for pages and windows', async () => {
    const o = desktopRenderOptions('/res/runtime');
    expect(o.renderOptions).toEqual({ distDir: '/res/runtime', parallel: DESKTOP_RENDER_PARALLEL });
    expect(o.renderProvider.kind).toBe('electron');
    const provider = await o.renderProvider();
    expect(provider.kind).toBe('electron');
    await provider.close();
    expect(DESKTOP_RENDER_PARALLEL).toBe(4);
  });

  it('packages the composition runtime (RUNTIME_DIST_DIR) as an extra resource', () => {
    const dir = join(import.meta.dirname, '..');
    expect(readFileSync(join(dir, 'electron-builder.yml'), 'utf8')).toMatch(/- \{ from: resources\/runtime, to: runtime \}/);
    const scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts['prepare-resources']).toContain("fs.cpSync('../../packages/composition-runtime/dist','resources/runtime'");
    // main.ts hands the packaged copy to the core.
    expect(readFileSync(join(dir, 'src', 'main.ts'), 'utf8')).toContain("runtimeDir: join(process.resourcesPath, 'runtime')");
  });
});

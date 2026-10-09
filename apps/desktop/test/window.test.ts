import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { externalUrlAllowed, isAppUrl, windowOptions } from '../src/window.ts';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(() => Promise.resolve()), on: vi.fn(), removeListener: vi.fn() },
}));

describe('window security', () => {
  it('locks down the renderer', () => {
    const o = windowOptions('/p/preload.cjs');
    expect(o.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, preload: '/p/preload.cjs' });
  });
  it('keeps navigation on the core origin', () => {
    expect(isAppUrl('http://127.0.0.1:4318/#/p/acme', 'http://127.0.0.1:4318')).toBe(true);
    expect(isAppUrl('http://127.0.0.1:4318/#t=abc', 'http://127.0.0.1:4318/#t=abc')).toBe(true);
    expect(isAppUrl('http://127.0.0.1:9999/', 'http://127.0.0.1:4318')).toBe(false);
    expect(isAppUrl('https://evil.example/', 'http://127.0.0.1:4318')).toBe(false);
    expect(isAppUrl('file:///etc/passwd', 'http://127.0.0.1:4318')).toBe(false);
    expect(isAppUrl('not a url', 'http://127.0.0.1:4318')).toBe(false);
  });
  it('opens only web and mail links externally', () => {
    expect(externalUrlAllowed('https://github.com/Aleloca/motion-studio')).toBe(true);
    expect(externalUrlAllowed('mailto:a@b.it')).toBe(true);
    expect(externalUrlAllowed('file:///Applications/Calculator.app')).toBe(false);
    expect(externalUrlAllowed('javascript:alert(1)')).toBe(false);
  });
});

describe('IPC sender guard', () => {
  it("accepts only the window's main frame on the core origin (dev and packaged load the same http origin)", async () => {
    const { ipcSenderTrusted } = await import('../src/window.ts');
    const main = { url: 'http://127.0.0.1:64278/#/p/acme' };
    const wc = { mainFrame: main };
    expect(ipcSenderTrusted({ sender: wc, senderFrame: main } as never, wc, 'http://127.0.0.1:64278')).toBe(true);
    expect(ipcSenderTrusted({ sender: wc, senderFrame: main } as never, wc, 'http://127.0.0.1:4318')).toBe(false);
    expect(ipcSenderTrusted({ sender: wc, senderFrame: { url: main.url } } as never, wc, 'http://127.0.0.1:64278')).toBe(false); // a subframe
    expect(ipcSenderTrusted({ sender: { mainFrame: main }, senderFrame: main } as never, wc, 'http://127.0.0.1:64278')).toBe(false); // another webContents
    expect(ipcSenderTrusted({ sender: wc, senderFrame: null } as never, wc, 'http://127.0.0.1:64278')).toBe(false);
  });

  it('rejects a missing sender frame (null or undefined) without throwing, even when mainFrame is missing too', async () => {
    const { ipcSenderTrusted } = await import('../src/window.ts');
    const bare = { mainFrame: undefined };
    expect(() => ipcSenderTrusted({ sender: bare, senderFrame: undefined }, bare, 'http://127.0.0.1:64278')).not.toThrow();
    expect(ipcSenderTrusted({ sender: bare, senderFrame: undefined }, bare, 'http://127.0.0.1:64278')).toBe(false);
    const gone = { mainFrame: null };
    expect(ipcSenderTrusted({ sender: gone, senderFrame: null }, gone, 'http://127.0.0.1:64278')).toBe(false);
  });
});

describe('integrated title bar', () => {
  it('macOS: hidden inset title bar with the traffic lights centred in the app bar', async () => {
    const { TITLEBAR_HEIGHT, TRAFFIC_LIGHT_SIZE } = await import('../src/titlebar.ts');
    const o = windowOptions('/p/preload.cjs', true, 'darwin');
    expect(o.titleBarStyle).toBe('hiddenInset');
    expect(o.titleBarOverlay).toBeUndefined();
    const p = o.trafficLightPosition!;
    expect(p.x).toBeGreaterThan(0);
    // Vertically centred: the same space above and below the buttons.
    expect(p.y).toBe((TITLEBAR_HEIGHT - TRAFFIC_LIGHT_SIZE) / 2);
  });

  it('Windows and Linux: hidden title bar with an overlay in the theme colours, as tall as the app bar', async () => {
    const { TITLEBAR_COLORS, TITLEBAR_HEIGHT } = await import('../src/titlebar.ts');
    for (const platform of ['win32', 'linux'] as const) {
      const dark = windowOptions('/p/preload.cjs', true, platform);
      expect(dark.titleBarStyle).toBe('hidden');
      expect(dark.trafficLightPosition).toBeUndefined();
      expect(dark.titleBarOverlay).toEqual({ color: TITLEBAR_COLORS.dark.bar, symbolColor: TITLEBAR_COLORS.dark.symbol, height: TITLEBAR_HEIGHT });
      const light = windowOptions('/p/preload.cjs', false, platform);
      expect(light.titleBarOverlay).toEqual({ color: TITLEBAR_COLORS.light.bar, symbolColor: TITLEBAR_COLORS.light.symbol, height: TITLEBAR_HEIGHT });
    }
  });

  it('uses the theme background (dark #0F0F0F, light --bg), not the old values', () => {
    expect(windowOptions('/p', true, 'darwin').backgroundColor).toBe('#0F0F0F');
    expect(windowOptions('/p', false, 'darwin').backgroundColor).toBe('#F5F5F4');
    expect(windowOptions('/p', true, 'win32').backgroundColor).toBe('#0F0F0F');
  });

  it('keeps the colour constants equal to the web theme tokens (theme.css) and the bar height equal to shell.css', async () => {
    const { TITLEBAR_COLORS, TITLEBAR_HEIGHT } = await import('../src/titlebar.ts');
    const web = join(import.meta.dirname, '..', '..', '..', 'packages', 'web', 'src');
    const css = readFileSync(join(web, 'theme.css'), 'utf8');
    const block = (sel: string) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
    const tok = (b: string, name: string) => new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(b)![1]!.toUpperCase();
    const light = block(':root {');
    for (const sel of [':root:not([data-theme="light"])', ':root[data-theme="dark"]']) {
      const dark = block(sel);
      expect(TITLEBAR_COLORS.dark).toEqual({ background: tok(dark, '--bg'), bar: tok(dark, '--panel'), symbol: tok(dark, '--text') });
    }
    expect(TITLEBAR_COLORS.light).toEqual({ background: tok(light, '--bg'), bar: tok(light, '--panel'), symbol: tok(light, '--text') });
    const shell = readFileSync(join(web, 'shell', 'shell.css'), 'utf8');
    expect(/\.ms-topbar \{[^}]*height: (\d+)px/.exec(shell)![1]).toBe(String(TITLEBAR_HEIGHT));
  });
});

describe('ms:titlebar-theme', () => {
  async function setup(platform: string, trusted = true) {
    const { registerTitleBar } = await import('../src/titlebar.ts');
    const handlers: Record<string, (e: unknown, arg: unknown) => unknown> = {};
    const setOverlay = vi.fn();
    const setBackground = vi.fn();
    registerTitleBar({ handle: (ch, fn) => { handlers[ch] = fn as never; } }, {
      trusted: () => trusted, platform, setOverlay, setBackground, invalid: () => new Error('Invalid request'),
    });
    return { call: (arg: unknown) => handlers['ms:titlebar-theme']!({ sender: 'win' }, arg), setOverlay, setBackground };
  }

  it('accepts only "light" or "dark"', async () => {
    const { titleBarThemeArg } = await import('../src/titlebar.ts');
    expect(titleBarThemeArg('light')).toBe('light');
    expect(titleBarThemeArg('dark')).toBe('dark');
    for (const bad of ['system', 'Dark', 'dark ', '', null, undefined, 1, true, {}, ['dark'], { theme: 'dark' }]) expect(titleBarThemeArg(bad)).toBeNull();
  });

  it('Windows: updates the overlay and the background for a valid theme', async () => {
    const { TITLEBAR_COLORS, TITLEBAR_HEIGHT } = await import('../src/titlebar.ts');
    const s = await setup('win32');
    s.call('light');
    expect(s.setOverlay).toHaveBeenLastCalledWith({ color: TITLEBAR_COLORS.light.bar, symbolColor: TITLEBAR_COLORS.light.symbol, height: TITLEBAR_HEIGHT });
    expect(s.setBackground).toHaveBeenLastCalledWith(TITLEBAR_COLORS.light.background);
    s.call('dark');
    expect(s.setOverlay).toHaveBeenLastCalledWith({ color: TITLEBAR_COLORS.dark.bar, symbolColor: TITLEBAR_COLORS.dark.symbol, height: TITLEBAR_HEIGHT });
  });

  it('macOS: no overlay to update, only the background', async () => {
    const s = await setup('darwin');
    s.call('dark');
    expect(s.setOverlay).not.toHaveBeenCalled();
    expect(s.setBackground).toHaveBeenCalledWith('#0F0F0F');
  });

  it('rejects invalid values and untrusted senders without touching the window', async () => {
    const s = await setup('win32');
    for (const bad of ['system', 'purple', 3, null, { theme: 'dark' }]) expect(() => s.call(bad)).toThrow('Invalid request');
    const u = await setup('win32', false);
    expect(() => u.call('dark')).toThrow('Invalid request');
    expect([...s.setOverlay.mock.calls, ...u.setOverlay.mock.calls, ...s.setBackground.mock.calls, ...u.setBackground.mock.calls]).toEqual([]);
  });
});

describe('ms:fullscreen', () => {
  it('sends a plain boolean to the page, only while the window shows the app', async () => {
    const { FULLSCREEN, sendFullscreen } = await import('../src/titlebar.ts');
    const wc = { isDestroyed: vi.fn(() => false), getURL: vi.fn(() => 'http://127.0.0.1:4317/#/'), send: vi.fn() };
    const isApp = (u: string) => u.startsWith('http://127.0.0.1:4317/');
    expect(FULLSCREEN).toBe('ms:fullscreen');
    expect(sendFullscreen(wc, true, isApp)).toBe(true);
    expect(wc.send).toHaveBeenLastCalledWith('ms:fullscreen', true);
    expect(sendFullscreen(wc, false, isApp)).toBe(true);
    expect(wc.send).toHaveBeenLastCalledWith('ms:fullscreen', false);
    wc.getURL.mockReturnValue('https://evil.example/');
    expect(sendFullscreen(wc, true, isApp)).toBe(false);
    wc.isDestroyed.mockReturnValue(true);
    wc.getURL.mockReturnValue('http://127.0.0.1:4317/#/');
    expect(sendFullscreen(wc, true, isApp)).toBe(false);
    expect(wc.send).toHaveBeenCalledTimes(2);
  });
});

describe('preload: title bar', () => {
  afterEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  async function bridge() {
    const electron = await import('electron');
    await import('../src/preload.ts');
    const b = vi.mocked(electron.contextBridge.exposeInMainWorld).mock.calls.at(-1)![1] as {
      onFullscreenChange(cb: unknown): () => void; setTitleBarTheme(t: unknown): Promise<void>;
    };
    return { b, ipc: vi.mocked(electron.ipcRenderer) };
  }
  const listeners = (ipc: { on: ReturnType<typeof vi.fn> }) => ipc.on.mock.calls.filter((c) => c[0] === 'ms:fullscreen').map((c) => c[1] as (...a: unknown[]) => void);

  it('setTitleBarTheme invokes ms:titlebar-theme with the theme only', async () => {
    const { b, ipc } = await bridge();
    await b.setTitleBarTheme('dark');
    expect(ipc.invoke).toHaveBeenLastCalledWith('ms:titlebar-theme', 'dark');
  });

  it('onFullscreenChange passes a boolean (never the event), ignores non-booleans, and unsubscribes', async () => {
    const { b, ipc } = await bridge();
    const cb = vi.fn();
    const off = b.onFullscreenChange(cb);
    const mine = listeners(ipc).at(-1)!;
    mine({ sender: 'secret' }, true);
    expect(cb).toHaveBeenLastCalledWith(true);
    expect(cb.mock.calls.at(-1)).toHaveLength(1);
    mine({ sender: 'secret' }, false);
    expect(cb).toHaveBeenLastCalledWith(false);
    const n = cb.mock.calls.length;
    mine({ sender: 'secret' }, 'true');
    mine({ sender: 'secret' }, 1);
    mine({ sender: 'secret' });
    expect(cb).toHaveBeenCalledTimes(n);
    off();
    expect(ipc.removeListener).toHaveBeenCalledWith('ms:fullscreen', mine);
  });

  it('a late subscriber gets the state the main process already sent (fullscreen before the page subscribed)', async () => {
    const { b, ipc } = await bridge();
    // The preload's own listener, installed at load: it remembers the last state.
    for (const l of listeners(ipc)) l({ sender: 'secret' }, true);
    const cb = vi.fn();
    b.onFullscreenChange(cb);
    expect(cb).toHaveBeenCalledWith(true);
  });

  it('rejects a non-function callback', async () => {
    const { b, ipc } = await bridge();
    const before = ipc.on.mock.calls.length;
    for (const bad of ['nope', null, undefined, 1, {}]) expect(typeof b.onFullscreenChange(bad)).toBe('function');
    expect(ipc.on.mock.calls.length).toBe(before);
  });

  it('a throwing callback does not break the listener', async () => {
    const { b, ipc } = await bridge();
    b.onFullscreenChange(() => { throw new Error('page'); });
    expect(() => listeners(ipc).at(-1)!({}, true)).not.toThrow();
  });
});

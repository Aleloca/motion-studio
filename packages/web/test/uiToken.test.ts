import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.ts';
import { captureUiToken, listenForUiToken, markPairingNeeded, onUiTokenChange, pairingNeeded, resetUiTokenForTests, uiToken } from '../src/uiToken.ts';

const TOKEN = 'ab'.repeat(32);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); resetUiTokenForTests(); history.replaceState(null, '', '/'); delete (window as { motionStudio?: unknown }).motionStudio; });

const STALE = 'cd'.repeat(32);
/** The desktop preload bridge, answering the token of the core the window was opened for. */
const desktopWith = (token: () => string | null) => { (window as { motionStudio?: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => null, revealPath: async () => {}, uiToken: token }; };

describe('UI token', () => {
  it('takes the token from the address fragment, stores it and strips it', () => {
    history.replaceState(null, '', `/#t=${TOKEN}`);
    captureUiToken();
    expect(uiToken()).toBe(TOKEN);
    expect(localStorage.getItem('motion-studio-ui-token')).toBe(TOKEN);
    expect(location.hash).toBe('#/');
    resetUiTokenForTests();
    expect(uiToken()).toBe(TOKEN); // from storage after a reload
  });
  it('ignores other fragments and keeps working when storage is unavailable', () => {
    history.replaceState(null, '', '/#/projects/acme');
    captureUiToken();
    expect(uiToken()).toBeNull();
    expect(location.hash).toBe('#/projects/acme');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    history.replaceState(null, '', `/#t=${TOKEN}`);
    captureUiToken();
    expect(uiToken()).toBe(TOKEN);
    expect(location.hash).toBe('#/');
  });
  it('sends the token on API calls and uploads', async () => {
    history.replaceState(null, '', `/#t=${TOKEN}`);
    captureUiToken();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.getWorkspace();
    await api.updateSettings({ theme: 'dark' });
    await api.uploadFiles('acme', 'assets', [new File(['x'], 'a.png')]);
    for (const call of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(new Headers(call[1].headers).get('x-motion-studio-ui')).toBe(TOKEN);
    }
    expect(new Headers((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers).get('content-type')).toBe('application/json');
  });
  it('asks to reopen the app from the terminal link when the server refuses the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'ui-token', error: 'x' }), { status: 401 })));
    expect(pairingNeeded()).toBe(false);
    await expect(api.getWorkspace()).rejects.toThrow();
    expect(pairingNeeded()).toBe(true);
  });
  it('takes a link pasted into an open tab: stores the token, strips it and ends the pairing request', () => {
    const off = listenForUiToken();
    const changed = vi.fn();
    const offChange = onUiTokenChange(changed);
    try {
      markPairingNeeded();
      location.hash = `#t=${'ef'.repeat(32)}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      expect(uiToken()).toBe('ef'.repeat(32));
      expect(localStorage.getItem('motion-studio-ui-token')).toBe('ef'.repeat(32));
      expect(location.hash).toBe('#/');
      expect(pairingNeeded()).toBe(false);
      expect(changed).toHaveBeenCalledTimes(1);
    } finally { off(); offChange(); }
  });

  // Final wave B3: the core-provided launch token always wins over a stale one in localStorage; a 401 renews the token.
  it('desktop: the launch link wins over a stale stored token', () => {
    localStorage.setItem('motion-studio-ui-token', STALE);
    history.replaceState(null, '', `/#t=${TOKEN}`);
    captureUiToken();
    expect(uiToken()).toBe(TOKEN);
    expect(localStorage.getItem('motion-studio-ui-token')).toBe(TOKEN);
  });
  it('desktop: a reload (no link in the address) takes the main process\'s token, never the stale stored one', () => {
    localStorage.setItem('motion-studio-ui-token', STALE);
    desktopWith(() => TOKEN);
    expect(captureUiToken()).toBe(false);
    expect(uiToken()).toBe(TOKEN);
    expect(localStorage.getItem('motion-studio-ui-token')).toBe(TOKEN);
  });
  it('desktop: a 401 renews the token from the main process and retries once; no pairing page', async () => {
    localStorage.setItem('motion-studio-ui-token', STALE);
    let current = STALE;
    desktopWith(() => current);
    expect(uiToken()).toBe(STALE);
    // The core restarted with a new token meanwhile.
    current = TOKEN;
    const changed = vi.fn();
    const off = onUiTokenChange(changed);
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => (new Headers(init.headers).get('x-motion-studio-ui') === TOKEN
      ? new Response('{"path":"/w"}', { status: 200 })
      : new Response(JSON.stringify({ code: 'ui-token', error: 'x' }), { status: 401 })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(api.getWorkspace()).resolves.toEqual({ path: '/w' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(pairingNeeded()).toBe(false);
      expect(uiToken()).toBe(TOKEN);
      expect(localStorage.getItem('motion-studio-ui-token')).toBe(TOKEN);
      expect(changed).toHaveBeenCalledTimes(1);
    } finally { off(); }
  });
  it('browser: a token another tab stored after a new link is taken on a 401; with nothing newer, the pairing page', async () => {
    history.replaceState(null, '', `/#t=${STALE}`);
    captureUiToken();
    localStorage.setItem('motion-studio-ui-token', TOKEN);
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => (new Headers(init.headers).get('x-motion-studio-ui') === TOKEN
      ? new Response('{}', { status: 200 })
      : new Response(JSON.stringify({ code: 'ui-token', error: 'x' }), { status: 401 })));
    vi.stubGlobal('fetch', fetchMock);
    await api.getWorkspace();
    expect(pairingNeeded()).toBe(false);
    expect(uiToken()).toBe(TOKEN);
    // The token itself is refused now: nothing newer anywhere, so the user is asked for the link.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'ui-token', error: 'x' }), { status: 401 })));
    await expect(api.getWorkspace()).rejects.toThrow();
    expect(pairingNeeded()).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { externalUrlAllowed, isAppUrl, windowOptions } from '../src/window.ts';

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

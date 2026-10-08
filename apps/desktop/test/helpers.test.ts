import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfigStore, defaultConfigDir, t } from '@motion-studio/core';
import { absolutePathArg, attachedGone, attachedGoneAction, attachedLocale, bootLocale, focusOnReady, readSavedLanguage, watchAttached, loginShellOptions, pickFolderArgs, serverOptions, tokenFromAppUrl, userDataDir } from '../src/helpers.ts';

describe('desktop helpers', () => {
  it('reads the UI token from the URL fragment only', () => {
    expect(tokenFromAppUrl('http://127.0.0.1:4318/#t=abc123')).toBe('abc123');
    expect(tokenFromAppUrl('http://127.0.0.1:4318/')).toBeNull();
    expect(tokenFromAppUrl('http://127.0.0.1:4318/?t=zzz')).toBeNull();
  });
  it('validates the pick-folder payload', () => {
    expect(pickFolderArgs({ title: 'Scegli', defaultPath: '/tmp' })).toEqual({ title: 'Scegli', defaultPath: '/tmp' });
    expect(pickFolderArgs({ title: 'Scegli' })).toEqual({ title: 'Scegli' });
    expect(pickFolderArgs({ title: 5 })).toBeNull();
    expect(pickFolderArgs({ title: 'x', defaultPath: 3 })).toBeNull();
    expect(pickFolderArgs(null)).toBeNull();
    expect(pickFolderArgs('x')).toBeNull();
  });
  it('accepts only absolute paths for reveal', () => {
    expect(absolutePathArg('/Users/a/out')).toBe('/Users/a/out');
    expect(absolutePathArg('out/video.mp4')).toBeNull();
    expect(absolutePathArg('')).toBeNull();
    expect(absolutePathArg(42)).toBeNull();
    expect(absolutePathArg('/a\0b')).toBeNull();
  });
  it('gives the login shell 15 s (a slow rc file must not push the app onto the fallback PATH)', () => {
    expect(loginShellOptions()).toEqual({ timeoutMs: 15_000 });
  });
  it('builds the server options, telling the Doctor where PATH came from', () => {
    const resources = { webDir: '/r/web', mcpServerPath: '/r/mcp-studio.mjs' };
    expect(serverOptions({ resources, shellPath: { path: '/a:/b', source: 'fallback', error: 'codice 1' } })).toEqual({
      port: 'auto', webDir: '/r/web', mcpServerPath: '/r/mcp-studio.mjs', mcpEnv: { ELECTRON_RUN_AS_NODE: '1' },
      shellPath: { source: 'fallback', error: 'codice 1' },
    });
    expect(serverOptions({ resources, configDir: '/tmp/x', shellPath: { path: '/a', source: 'login-shell' } })).toMatchObject({
      configDir: '/tmp/x', shellPath: { source: 'login-shell' },
    });
  });
  it('keeps Electron\'s own data outside the Motion Studio config folder', () => {
    const appData = join(homedir(), 'Library', 'Application Support');
    expect(userDataDir(appData)).toBe(join(appData, 'Motion Studio Electron'));
    const saved = process.env.MOTION_STUDIO_CONFIG_DIR;
    delete process.env.MOTION_STUDIO_CONFIG_DIR;
    try { expect(userDataDir(appData)).not.toBe(defaultConfigDir()); } finally { if (saved !== undefined) process.env.MOTION_STUDIO_CONFIG_DIR = saved; }
  });
  it('remembers a focus request that arrives before the window is ready', () => {
    const calls: string[] = [];
    const win = { isMinimized: () => true, restore: () => calls.push('restore'), focus: () => calls.push('focus') };
    const focus = focusOnReady();
    focus.request();
    expect(calls).toEqual([]);
    focus.ready(win);
    expect(calls).toEqual(['restore', 'focus']);
    focus.ready(win);
    expect(calls).toHaveLength(2); // a request is served once
    focus.request();
    expect(calls).toEqual(['restore', 'focus', 'restore', 'focus']);
  });
  it('does not focus on ready when nobody asked', () => {
    const calls: string[] = [];
    focusOnReady().ready({ isMinimized: () => false, restore: () => calls.push('restore'), focus: () => calls.push('focus') });
    expect(calls).toEqual([]);
  });
});

describe('attached to another instance', () => {
  afterEach(() => { vi.useRealTimers(); });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  it('polls the other server every 5 s and reports once when it stops answering', async () => {
    vi.useFakeTimers();
    const answers = [true, true, false, false];
    let calls = 0;
    let gone = 0;
    watchAttached({ check: async () => answers[calls++] ?? false, onGone: () => { gone++; } });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect([calls, gone]).toEqual([3, 1]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect([calls, gone]).toEqual([3, 1]); // stopped after the first failure
  });
  it('reports at once on a failed page load, and only once', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let gone = 0;
    const w = watchAttached({ check: async () => { calls++; return true; }, onGone: () => { gone++; } });
    w.failed();
    w.failed();
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect([calls, gone]).toEqual([0, 1]);
  });
  it('does not stack checks while one is still pending', async () => {
    vi.useFakeTimers();
    let calls = 0;
    watchAttached({ check: () => { calls++; return new Promise<boolean>(() => {}); }, onGone: () => {} });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toBe(1);
  });
  it('stop() ends the polling without reporting', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let gone = 0;
    const w = watchAttached({ check: async () => { calls++; return false; }, onGone: () => { gone++; } });
    w.stop();
    w.failed();
    await vi.advanceTimersByTimeAsync(30_000);
    expect([calls, gone]).toEqual([0, 0]);
  });
  it('asks to restart or close, in Italian', () => {
    expect(attachedGone(t().desktop)).toEqual({ message: 'Il Motion Studio a cui l\'app era collegata si è chiuso.', buttons: ['Riavvia', 'Chiudi'] });
    expect(attachedGoneAction(0)).toBe('relaunch');
    expect(attachedGoneAction(1)).toBe('quit');
    expect(attachedGoneAction(-1)).toBe('quit');
  });
  it('takes the live instance language, else the fallback', async () => {
    const ok = (locale: unknown) => vi.fn(async () => new Response(JSON.stringify({ locale }), { status: 200 })) as unknown as typeof fetch;
    const base = { origin: 'http://127.0.0.1:4318', token: 'tok', fallback: 'en' as const };
    expect(await attachedLocale({ ...base, fetchFn: ok('it') })).toBe('it');
    expect(await attachedLocale({ ...base, fetchFn: ok('de') })).toBe('en');
    expect(await attachedLocale({ ...base, fetchFn: vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch })).toBe('en');
    expect(await attachedLocale({ ...base, fetchFn: vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch })).toBe('en');
  });
});

describe('boot language', () => {
  it('uses the saved setting, else the first supported system language, else English', () => {
    expect(bootLocale('it', ['en-US'])).toBe('it');
    expect(bootLocale('en', ['it-IT'])).toBe('en');
    expect(bootLocale('system', ['de-DE', 'it-IT'])).toBe('it');
    expect(bootLocale(undefined, ['it-IT'])).toBe('it');
    expect(bootLocale('de', ['fr-FR'])).toBe('en');
    expect(bootLocale(undefined, [])).toBe('en');
  });
  it('reads the saved language without creating or rewriting anything', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ms-desk-lang-'));
    try {
      const missing = join(base, 'missing');
      expect(await readSavedLanguage(missing)).toBe('system');
      expect(existsSync(missing)).toBe(false);
      const saved = join(base, 'saved');
      await new AppConfigStore(saved).setLanguage('it');
      expect(await readSavedLanguage(saved)).toBe('it');
      const corrupt = join(base, 'corrupt');
      await new AppConfigStore(corrupt).setLanguage('en');
      await writeFile(join(corrupt, 'config.json'), '{ nope');
      expect(await readSavedLanguage(corrupt)).toBeUndefined();
      expect(await readFile(join(corrupt, 'config.json'), 'utf8')).toBe('{ nope');
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});

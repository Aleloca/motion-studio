import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfigDir } from '@motion-studio/core';
import { absolutePathArg, focusOnReady, loginShellOptions, pickFolderArgs, serverOptions, tokenFromAppUrl, userDataDir } from '../src/helpers.ts';

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

import { describe, expect, it, vi } from 'vitest';
import { appSigned, macSignatureTrusted, pickAutoUpdater, setupUpdates, type UpdaterLike } from '../src/updater.ts';

type Handler = (arg: never) => void;
const fake = (check: () => Promise<unknown> | null = async () => ({})) => {
  const handlers: Record<string, Handler> = {};
  const u = {
    autoDownload: false, checkForUpdates: vi.fn(check), quitAndInstall: vi.fn(),
    on: vi.fn((e: string, cb: Handler) => { handlers[e] = cb; }),
    fire: (v: string) => (handlers['update-downloaded'] as (i: { version: string }) => void)({ version: v }),
    emitError: (e: unknown) => (handlers['error'] as (e: unknown) => void)(e),
    has: (e: string) => e in handlers,
  };
  return u as typeof u & UpdaterLike;
};

const base = (over: Partial<Parameters<typeof setupUpdates>[0]> = {}) => {
  const notify = vi.fn();
  const log = vi.fn();
  return { opts: { isPackaged: true, signed: async () => true, load: async () => ({}), notify, log, ...over }, notify, log };
};

const SIGNED = 'Format=app bundle\nAuthority=Developer ID Application: X\nTeamIdentifier=ABCDE12345\nSealed Resources version=2\n';
const ADHOC = 'Format=app bundle\nCodeDirectory v=20400 flags=0x20002(adhoc,linker-signed)\nSignature=adhoc\nTeamIdentifier=not set\n';

describe('pickAutoUpdater', () => {
  it('takes the named export, else module.exports (default) as Node exposes electron-updater', () => {
    const u = fake();
    expect(pickAutoUpdater({ autoUpdater: u })).toBe(u);
    expect(pickAutoUpdater({ autoUpdater: undefined, default: { autoUpdater: u } })).toBe(u);
  });
  it('is null for a missing module, a missing autoUpdater, a non-updater or a throwing getter', () => {
    expect(pickAutoUpdater(undefined)).toBeNull();
    expect(pickAutoUpdater({})).toBeNull();
    expect(pickAutoUpdater({ default: {} })).toBeNull();
    expect(pickAutoUpdater({ autoUpdater: { autoDownload: true } })).toBeNull();
    expect(pickAutoUpdater({ default: Object.defineProperty({}, 'autoUpdater', { get: () => { throw new Error('no Squirrel'); } }) })).toBeNull();
  });
});

describe('signature', () => {
  it('trusts a team signature, never an ad-hoc or missing one', () => {
    expect(macSignatureTrusted(SIGNED)).toBe(true);
    expect(macSignatureTrusted(ADHOC)).toBe(false);
    expect(macSignatureTrusted('')).toBe(false);
  });
  it('reads the bundle of the running binary on macOS; a failing codesign is unsigned', async () => {
    const codesign = vi.fn(async () => SIGNED);
    expect(await appSigned({ platform: 'darwin', execPath: '/A/Motion Studio.app/Contents/MacOS/Motion Studio', codesign })).toBe(true);
    expect(codesign).toHaveBeenCalledWith('/A/Motion Studio.app');
    expect(await appSigned({ platform: 'darwin', execPath: '/A/x.app/Contents/MacOS/x', codesign: async () => { throw new Error('exit 1'); } })).toBe(false);
    expect(await appSigned({ platform: 'darwin', execPath: '/usr/bin/node', codesign })).toBe(false);
    expect(await appSigned({ platform: 'win32', execPath: 'C:\\x.exe', codesign })).toBe(true);
  });
});

describe('setupUpdates turns itself off with a log line, no dialog', () => {
  it('in development, without loading electron-updater', async () => {
    const load = vi.fn(async () => ({}));
    const { opts, notify, log } = base({ isPackaged: false, load });
    await expect(setupUpdates(opts)).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Automatic updates off: development run');
  });
  it('when unsigned (or the signature check fails)', async () => {
    for (const signed of [async () => false, async () => { throw new Error('codesign'); }]) {
      const load = vi.fn(async () => ({}));
      const { opts, notify, log } = base({ signed, load });
      await expect(setupUpdates(opts)).resolves.toBeUndefined();
      expect(load).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('Automatic updates off: unsigned build');
    }
  });
  it('when the module is missing or autoUpdater is undefined (the packaged-bundle crash)', async () => {
    const cases: Array<() => Promise<unknown>> = [
      async () => { throw new Error("Cannot find module 'electron-updater'"); },
      async () => ({ autoUpdater: undefined, default: {} }),
      async () => undefined,
    ];
    for (const load of cases) {
      const { opts, notify, log } = base({ load });
      await expect(setupUpdates(opts)).resolves.toBeUndefined();
      expect(notify).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toMatch(/^Automatic updates off: electron-updater/);
    }
  });
});

describe('setupUpdates survives updater failures', () => {
  it('a check that rejects, throws synchronously or emits error: log lines, no dialog, the app goes on', async () => {
    const rejecting = fake(async () => { throw new Error('no releases'); });
    const throwing = fake(() => { throw new Error('app-update.yml missing'); });
    for (const u of [rejecting, throwing]) {
      const { opts, notify, log } = base({ load: async () => ({ default: { autoUpdater: u } }) });
      await expect(setupUpdates(opts)).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/no releases|app-update\.yml missing/));
      expect(u.has('error')).toBe(true);
      expect(() => u.emitError(new Error('net::ERR_INTERNET_DISCONNECTED'))).not.toThrow();
      expect(log).toHaveBeenLastCalledWith(expect.stringContaining('ERR_INTERNET_DISCONNECTED'));
      expect(notify).not.toHaveBeenCalled();
    }
  });
  it('a failed automatic download leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const u = fake(async () => ({ downloadPromise: Promise.reject(new Error('download failed')) }));
      const { opts, notify } = base({ load: async () => ({ autoUpdater: u }) });
      await setupUpdates(opts);
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
  it('a throwing logger or setter still never rejects', async () => {
    const u = fake();
    Object.defineProperty(u, 'autoDownload', { set: () => { throw new Error('read-only'); } });
    const log = vi.fn(() => { throw new Error('log broken'); });
    await expect(setupUpdates({ ...base().opts, log, load: async () => ({ autoUpdater: u }) })).resolves.toBeUndefined();
  });
});

describe('setupUpdates offers a downloaded update', () => {
  it('checks, enables automatic download and offers a restart', async () => {
    const u = fake();
    const { opts, notify } = base({ load: async () => ({ default: { autoUpdater: u } }) });
    await setupUpdates(opts);
    expect(u.checkForUpdates).toHaveBeenCalled();
    expect(u.autoDownload).toBe(true);
    u.fire('0.5.0');
    expect(notify.mock.calls[0]![0]).toBe('È disponibile Motion Studio 0.5.0: riavvia per aggiornare');
    notify.mock.calls[0]![1]();
    expect(u.quitAndInstall).toHaveBeenCalled();
  });
  it('words the notification in the current language', async () => {
    const { setLocale } = await import('@motion-studio/core');
    const u = fake();
    const { opts, notify } = base({ load: async () => ({ autoUpdater: u }) });
    await setupUpdates(opts);
    setLocale('en');
    u.fire('0.5.0');
    expect(notify.mock.calls[0]![0]).toBe('Motion Studio 0.5.0 is available: restart to update');
  });
});

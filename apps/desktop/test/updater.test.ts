import { describe, expect, it, vi } from 'vitest';
import { setupUpdates, type UpdaterLike } from '../src/updater.ts';

const fake = (check: () => Promise<unknown>) => {
  const handlers: Record<string, (i: { version: string }) => void> = {};
  const u: UpdaterLike & { fire(v: string): void } = {
    autoDownload: false, checkForUpdates: vi.fn(check), quitAndInstall: vi.fn(),
    on: (e, cb) => { handlers[e] = cb; }, fire: (v) => handlers['update-downloaded']!({ version: v }),
  };
  return u;
};

describe('setupUpdates', () => {
  it('does nothing in development', () => {
    const u = fake(async () => ({}));
    setupUpdates({ updater: u, isPackaged: false, notify: vi.fn(), log: vi.fn() });
    expect(u.checkForUpdates).not.toHaveBeenCalled();
  });
  it('checks, survives errors and offers a restart', async () => {
    const u = fake(async () => { throw new Error('no releases'); });
    const notify = vi.fn();
    const log = vi.fn();
    setupUpdates({ updater: u, isPackaged: true, notify, log });
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no releases'));
    u.fire('0.5.0');
    expect(notify.mock.calls[0]![0]).toBe('È disponibile Motion Studio 0.5.0: riavvia per aggiornare');
    notify.mock.calls[0]![1]();
    expect(u.quitAndInstall).toHaveBeenCalled();
  });
});

describe('setupUpdates language', () => {
  it('words the notification in the current language', async () => {
    const { setLocale } = await import('@motion-studio/core');
    const u = fake(async () => ({}));
    const notify = vi.fn();
    setupUpdates({ updater: u, isPackaged: true, notify, log: vi.fn() });
    setLocale('en');
    u.fire('0.5.0');
    expect(notify.mock.calls[0]![0]).toBe('Motion Studio 0.5.0 is available: restart to update');
  });
});

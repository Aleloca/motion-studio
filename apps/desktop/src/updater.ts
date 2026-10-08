import { t } from '@motion-studio/core';

export interface UpdaterLike { checkForUpdates(): Promise<unknown>; on(event: 'update-downloaded', cb: (info: { version: string }) => void): void; quitAndInstall(): void; autoDownload: boolean }

export function setupUpdates(opts: { updater: UpdaterLike; isPackaged: boolean; notify(message: string, onRestart: () => void): void; log(msg: string): void }): void {
  if (!opts.isPackaged) return;
  opts.updater.autoDownload = true;
  opts.updater.on('update-downloaded', (info) => opts.notify(t().desktop.updateAvailable({ version: info.version }), () => opts.updater.quitAndInstall()));
  opts.updater.checkForUpdates().catch((e: unknown) => opts.log(t().desktop.updateCheckFailed({ detail: e instanceof Error ? e.message : String(e) })));
}

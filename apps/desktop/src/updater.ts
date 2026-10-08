export interface UpdaterLike { checkForUpdates(): Promise<unknown>; on(event: 'update-downloaded', cb: (info: { version: string }) => void): void; quitAndInstall(): void; autoDownload: boolean }

export function setupUpdates(opts: { updater: UpdaterLike; isPackaged: boolean; notify(message: string, onRestart: () => void): void; log(msg: string): void }): void {
  if (!opts.isPackaged) return;
  opts.updater.autoDownload = true;
  opts.updater.on('update-downloaded', (info) => opts.notify(`È disponibile Motion Studio ${info.version}: riavvia per aggiornare`, () => opts.updater.quitAndInstall()));
  opts.updater.checkForUpdates().catch((e: unknown) => opts.log(`Controllo aggiornamenti non riuscito: ${e instanceof Error ? e.message : String(e)}`));
}

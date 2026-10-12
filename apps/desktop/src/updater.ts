import { t } from '@motion-studio/core';

export interface UpdaterLike {
  checkForUpdates(): Promise<unknown> | null | undefined;
  on(event: 'update-downloaded', cb: (info: { version: string }) => void): unknown;
  on(event: 'error', cb: (err: unknown) => void): unknown;
  quitAndInstall(): void;
  autoDownload: boolean;
}

const detail = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The `autoUpdater` of an `import('electron-updater')` namespace. electron-updater is CommonJS and defines `autoUpdater` with
 * an arrow-function getter, which Node's detection of CommonJS named exports (cjs-module-lexer) does not see: through the
 * native `import()` the bundle keeps, the named export is missing and only `default` (module.exports) carries it. Reading
 * the getter builds the platform updater, which may throw: anything but an updater-shaped object is null.
 */
export function pickAutoUpdater(mod: unknown): UpdaterLike | null {
  try {
    const m = mod as { autoUpdater?: unknown; default?: { autoUpdater?: unknown } } | null | undefined;
    const u = (m?.autoUpdater ?? m?.default?.autoUpdater) as Partial<UpdaterLike> | null | undefined;
    return u && typeof u.checkForUpdates === 'function' && typeof u.on === 'function' ? (u as UpdaterLike) : null;
  } catch {
    return null;
  }
}

/**
 * macOS: whether `codesign -dv --verbose=2` (its stderr) describes a real signature. A build made without an identity is
 * ad-hoc (linker-signed, no team): Squirrel.Mac refuses to update it, so the updater stays off.
 */
export function macSignatureTrusted(codesignOutput: string): boolean {
  if (/^Signature=adhoc$/m.test(codesignOutput)) return false;
  const team = /^TeamIdentifier=(.+)$/m.exec(codesignOutput)?.[1]?.trim();
  return !!team && team !== 'not set';
}

/**
 * Whether the running app is signed for updates. macOS: the bundle holding `execPath` read by `codesign` (any failure is
 * unsigned). Elsewhere true: electron-updater checks the publisher itself where it applies (Windows).
 */
export async function appSigned(o: { platform: NodeJS.Platform; execPath: string; codesign(bundle: string): Promise<string> }): Promise<boolean> {
  if (o.platform !== 'darwin') return true;
  const bundle = o.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, '');
  if (bundle === o.execPath) return false;
  try {
    return macSignatureTrusted(await o.codesign(bundle));
  } catch {
    return false;
  }
}

/**
 * Automatic updates, best effort: never throws, never rejects, never opens a dialog. A development run, an unsigned build
 * and a missing or broken electron-updater turn the updater off with one log line; a failed check or download and every
 * `error` event end in a log line too (the activity center has no channel for the main process). Only a downloaded update
 * reaches the user, through `notify` (a system notification and the menu).
 */
export async function setupUpdates(opts: {
  isPackaged: boolean;
  signed(): Promise<boolean>;
  load(): Promise<unknown>;
  notify(message: string, onRestart: () => void): void;
  log(msg: string): void;
}): Promise<void> {
  const off = (why: string) => opts.log(`Automatic updates off: ${why}`);
  const failed = (e: unknown) => opts.log(t().desktop.updateCheckFailed({ detail: detail(e) }));
  try {
    if (!opts.isPackaged) return off('development run');
    if (!(await opts.signed().catch(() => false))) return off('unsigned build');
    let mod: unknown;
    try {
      mod = await opts.load();
    } catch (e) {
      return off(`electron-updater not loaded (${detail(e)})`);
    }
    const updater = pickAutoUpdater(mod);
    if (!updater) return off('electron-updater has no autoUpdater');
    // Needed: an `error` event with no listener throws, and an uncaught main-process exception is Electron's error dialog.
    updater.on('error', failed);
    updater.on('update-downloaded', (info) => opts.notify(t().desktop.updateAvailable({ version: info.version }), () => {
      try { updater.quitAndInstall(); } catch (e) { failed(e); }
    }));
    updater.autoDownload = true;
    const result = (await Promise.resolve(updater.checkForUpdates())) as { downloadPromise?: Promise<unknown> | null } | null | undefined;
    // A failed download is already an `error` event (logged): its rejected promise must not go unhandled.
    void result?.downloadPromise?.catch(() => undefined);
  } catch (e) {
    try { failed(e); } catch { /* logging is best effort too */ }
  }
}

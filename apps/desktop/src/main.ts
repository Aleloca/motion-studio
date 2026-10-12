import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, session, shell, type IpcMainInvokeEvent } from 'electron';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AlreadyRunningError, answersHealth, defaultConfigDir, resolveLocale, resolveLoginShellPath, setLocale, startServer, t } from '@motion-studio/core';
import { absolutePathArg, attachedGone, attachedGoneAction, attachedLocale, bootLocale, focusOnReady, readSavedLanguage, watchAttached, loginShellOptions, pickFolderArgs, serverOptions, tokenFromAppUrl, USER_DATA_ENV, userDataDir, userDataOverride } from './helpers.ts';
import { menuTemplate } from './menu.ts';
import { notificationOptions, registerAttention, sendAttentionClick, showKept } from './notify.ts';
import { appSigned, setupUpdates } from './updater.ts';
import { registerFullscreenQuery, registerTitleBar, registerUiTokenQuery, sendFullscreen } from './titlebar.ts';
import { ipcSenderTrusted, isAppUrl, windowOpenToBrowser, windowOptions, type IpcSender } from './window.ts';
import { desktopRenderOptions, shutdownForQuit } from './render-window.ts';
import { createRenderGuard, registerRenderGuard, renderRunningPrompt } from './render-guard.ts';
import { frameChain, hardenUiWindow, installPreviewFilter, pollCompositionOrigin, subframeNavigationBlocked, type FilterContext } from './preview-filter.ts';

const execFileAsync = promisify(execFile);
const REPO_URL = 'https://github.com/Aleloca/motion-studio';
const smokeArg = process.argv.find((a) => a === '--smoke-test' || a.startsWith('--smoke-test='));

// Electron's data folder, set before anything reads it (the single-instance lock lives there too): a throwaway one for a smoke
// run, removed on exit; otherwise a folder of its own beside (never inside) the Motion Studio config folder.
// `MOTION_STUDIO_USER_DATA_DIR` (checks, tests: final wave B1) moves it, sessionData and the logs elsewhere; one that is,
// contains or is inside a real Motion Studio folder stops the app before anything is written.
const override = userDataOverride(process.env, app.getPath('appData'));
if (override && 'error' in override) {
  process.stderr.write(`Motion Studio: ${override.error}\n`);
  app.exit(2);
  process.exit(2);
}
const overrideDir = override && 'dir' in override ? override.dir : null;
const smokeUserData = smokeArg && !overrideDir ? mkdtempSync(join(tmpdir(), 'motion-studio-smoke-electron-')) : null;
const removeSmokeUserData = () => { if (smokeUserData) rmSync(smokeUserData, { recursive: true, force: true }); };
process.on('exit', removeSmokeUserData);
app.setPath('userData', overrideDir ?? smokeUserData ?? userDataDir(app.getPath('appData')));
if (overrideDir) {
  app.setPath('sessionData', overrideDir);
  app.setPath('crashDumps', join(overrideDir, 'Crashpad'));
  app.setAppLogsPath(join(overrideDir, 'logs'));
  console.log(`Motion Studio: ${USER_DATA_ENV} set, Electron data in ${app.getPath('userData')}`);
}

/**
 * Dev: the source tree (dist/main.cjs is two levels under apps/desktop). Packaged: extraResources. `runtimeDir` is the
 * built composition runtime (the bundled core cannot find it next to its own file).
 */
function resourcePaths() {
  if (app.isPackaged) {
    // extraResources: outside the asar so the MCP server can be run by plain node.
    return { webDir: join(process.resourcesPath, 'web'), mcpServerPath: join(process.resourcesPath, 'mcp-studio.mjs'), runtimeDir: join(process.resourcesPath, 'runtime') };
  }
  const root = join(__dirname, '..', '..', '..');
  return {
    webDir: join(root, 'packages', 'web', 'dist'), mcpServerPath: join(root, 'packages', 'mcp-studio', 'src', 'server.mjs'),
    runtimeDir: join(root, 'packages', 'composition-runtime', 'dist'),
  };
}

async function boot(configDir?: string) {
  // Errors shown before the core is up (dialogs, logs) already speak the saved or system language.
  setLocale(bootLocale(await readSavedLanguage(configDir ?? defaultConfigDir()), app.getPreferredSystemLanguages()));
  const shellPath = await resolveLoginShellPath(loginShellOptions());
  process.env.PATH = shellPath.path;
  console.log(`PATH source: ${shellPath.source}`);
  const { runtimeDir, ...resources } = resourcePaths();
  return startServer({
    ...serverOptions({ resources, shellPath, ...(configDir ? { configDir } : {}) }),
    systemLocales: app.getPreferredSystemLanguages(),
    // Electron's own Chromium renders (hidden offscreen windows), never a Chrome found on disk.
    ...desktopRenderOptions(runtimeDir),
  });
}

/** Our own core, or the address of the Motion Studio (desktop or CLI) already serving the same config folder. */
async function bootOrAttach(): Promise<{ url: string; appUrl: string; close: () => Promise<void>; onLocaleChange: (cb: () => void) => void; compositionOrigin: () => string | null; attached?: { port: number; pid: number } }> {
  try {
    const server = await boot();
    return { url: server.url, appUrl: server.appUrl, close: server.close, onLocaleChange: (cb) => { server.onLocaleChange(cb); }, compositionOrigin: server.compositionOrigin };
  } catch (err) {
    if (!(err instanceof AlreadyRunningError)) throw err;
    const { port, pid, appUrl } = err.alreadyRunning;
    // Before the first message: no core of our own, so the system language until the live instance is asked.
    setLocale(resolveLocale('system', app.getPreferredSystemLanguages()));
    console.log(t().desktop.alreadyRunning({ port }));
    // The live instance's composition server, asked over its API (with the UI token) and kept fresh.
    const origin = new URL(appUrl).origin;
    const token = tokenFromAppUrl(appUrl) ?? '';
    const poll = pollCompositionOrigin({
      fetchOrigin: async () => {
        const res = await fetch(`${origin}/api/preview/origin`, { headers: { 'x-motion-studio-ui': token } });
        return res.ok ? ((await res.json()) as { origin?: unknown }).origin : undefined;
      },
    });
    return { url: origin, appUrl, close: async () => { poll.stop(); }, onLocaleChange: () => {}, compositionOrigin: poll.get, attached: { port, pid } };
  }
}

/** Attached window: when the other instance goes away, offer to restart (with an own core) or close. */
function watchAttachedInstance(win: BrowserWindow, target: { port: number; pid: number }) {
  const watch = watchAttached({
    check: () => answersHealth(target.port, 3000, target.pid),
    onGone: () => {
      const prompt = attachedGone(t().desktop);
      void dialog.showMessageBox(win, { type: 'warning', message: prompt.message, buttons: prompt.buttons, defaultId: 0, cancelId: 1 })
        .then(({ response }) => {
          if (attachedGoneAction(response) === 'relaunch') { app.relaunch(); app.exit(0); } else app.quit();
        });
    },
  });
  // -3 (ERR_ABORTED) is a navigation replaced by another one, not a dead server.
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => { if (isMainFrame && code !== -3) watch.failed(); });
  win.on('closed', () => watch.stop());
}

/** The smoke output never contains the token. */
async function smoke(mode: string) {
  // Throwaway config: a smoke run never touches the user's real Motion Studio folder.
  const configDir = await mkdtemp(join(tmpdir(), 'motion-studio-smoke-'));
  const server = await boot(configDir);
  try {
    // Only resolves the native module (no keychain call): proves it is reachable from the bundle.
    await import('@napi-rs/keyring');
    console.log('KEYRING_OK');
    if (mode === 'doctor') {
      const res = await fetch(`${server.url}/api/doctor`, { headers: { 'x-motion-studio-ui': tokenFromAppUrl(server.appUrl) ?? '' } });
      if (!res.ok) throw new Error(`doctor HTTP ${res.status}`);
      const checks = (await res.json()) as { id: string; ok: boolean }[];
      console.log(`DOCTOR_OK ${checks.filter((c) => c.ok).map((c) => c.id).join(',')}`);
    } else {
      const res = await fetch(`${server.url}/api/health`);
      if (!res.ok) throw new Error(`health HTTP ${res.status}`);
      const page = await fetch(`${server.url}/`);
      if (!page.ok || !(await page.text()).includes('id="root"')) throw new Error('index.html not served at /');
      console.log(`SMOKE_OK ${server.url}`);
    }
  } finally { await server.close(); await rm(configDir, { recursive: true, force: true }); }
}

let menuRestart: (() => void) | undefined;
function buildMenu(restart?: () => void) {
  if (restart) menuRestart = restart;
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(t(), {
    mac: process.platform === 'darwin', ...(menuRestart ? { restart: menuRestart } : {}), openRepo: () => void shell.openExternal(REPO_URL),
  })));
}

const focus = focusOnReady();

async function run() {
  const server = await bootOrAttach();
  const origin = new URL(server.url).origin;
  if (server.attached) {
    // No in-process core: speak the live instance's language (read once), else the system one.
    setLocale(await attachedLocale({ origin, token: tokenFromAppUrl(server.appUrl), fallback: resolveLocale('system', app.getPreferredSystemLanguages()) }));
  } else {
    // The in-process core owns the language: rebuild the menu when it changes in Settings.
    server.onLocaleChange(() => buildMenu());
  }
  let closing = false;
  const win = new BrowserWindow(windowOptions(join(__dirname, 'preload.cjs'), nativeTheme.shouldUseDarkColors));

  const trusted = (e: IpcMainInvokeEvent) => ipcSenderTrusted(e, win.webContents, origin);
  ipcMain.handle('ms:pick-folder', async (e, arg: unknown) => {
    const args = trusted(e) ? pickFolderArgs(arg) : null;
    if (!args) throw new Error(t().desktop.invalidRequest);
    const r = await dialog.showOpenDialog({ ...args, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle('ms:reveal', (e, arg: unknown) => {
    const p = trusted(e) ? absolutePathArg(arg) : null;
    if (!p) throw new Error(t().desktop.invalidPath);
    shell.showItemInFolder(p);
  });
  // Approval signals: native notification (also with the window visible) with one Dock bounce, and the Dock badge.
  const notifications = new Set<Notification>();
  registerAttention(ipcMain, {
    trusted,
    isSupported: () => Notification.isSupported(),
    showNotification: async (args) => {
      // Kept alive until clicked or closed. A click brings the window back and asks the page to run its "Review"
      // (the request's creative, or the activity center), as the toast does.
      const outcome = await showKept(notifications, new Notification(notificationOptions(args, process.platform)), () => {
        if (win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show(); win.focus();
        sendAttentionClick(win.webContents, (url) => isAppUrl(url, origin));
      });
      // A refusal by the system is otherwise invisible (macOS refuses an unsigned development Electron).
      if (!outcome.shown) console.warn(`Notification not shown (${outcome.reason})${outcome.detail ? `: ${outcome.detail}` : ''}`);
      return outcome;
    },
    dock: app.dock,
    invalid: () => new Error(t().desktop.invalidRequest),
  });
  // Integrated title bar: the page reports its resolved theme (overlay and background colours), and learns when the
  // window enters or leaves full screen (no traffic lights there, so no room kept for them).
  registerTitleBar(ipcMain, {
    trusted,
    platform: process.platform,
    setOverlay: (o) => { if (!win.isDestroyed()) win.setTitleBarOverlay(o); },
    setBackground: (c) => { if (!win.isDestroyed()) win.setBackgroundColor(c); },
    invalid: () => new Error(t().desktop.invalidRequest),
  });
  const fullscreen = () => { if (!win.isDestroyed()) sendFullscreen(win.webContents, win.isFullScreen(), (url) => isAppUrl(url, origin)); };
  win.on('enter-full-screen', fullscreen);
  win.on('leave-full-screen', fullscreen);
  // A (re)loaded page starts from the current state (the preload remembers it until the page subscribes).
  win.webContents.on('dom-ready', fullscreen);
  // ...and a page that renders before that message can ask synchronously (its first frame).
  registerFullscreenQuery(ipcMain as unknown as Parameters<typeof registerFullscreenQuery>[0], {
    trusted: (e) => ipcSenderTrusted(e as IpcSender, win.webContents, origin),
    isFullScreen: () => !win.isDestroyed() && win.isFullScreen(),
  });
  // The page's token after a reload or a refused one (B3): the one of the core this window was opened for.
  registerUiTokenQuery(ipcMain as unknown as Parameters<typeof registerUiTokenQuery>[0], {
    trusted: (e) => ipcSenderTrusted(e as IpcSender, win.webContents, origin),
    token: () => tokenFromAppUrl(server.appUrl),
  });

  // The live preview's frames (composition server) may reach only the composition server (preview-filter.ts).
  // Pinned to the active composition server's exact origin, read live (it starts lazily and may move to another port).
  const filterContext: FilterContext = { appOrigin: origin, compositionOrigin: server.compositionOrigin };
  installPreviewFilter(session.defaultSession, filterContext);
  hardenUiWindow(win.webContents);
  const allowed = (permission: string, requestingUrl: string) => permission === 'notifications' && isAppUrl(requestingUrl, origin);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => cb(allowed(permission, details.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed(permission, requestingOrigin));
  // A render running when the window closes or the app quits: ask first (carry 11). Attached, the renders belong to the
  // other instance and go on without this window: nothing to ask.
  const renders = createRenderGuard({
    ask: async (count) => {
      if (server.attached || win.isDestroyed()) return true;
      const { response } = await dialog.showMessageBox(win, { type: 'warning', ...renderRunningPrompt(t().desktop, count) });
      return response === 0;
    },
  });
  registerRenderGuard(ipcMain, { trusted, guard: renders, invalid: () => new Error(t().desktop.invalidRequest) });
  win.on('close', (e) => {
    if (closing || renders.running() === 0 || renders.confirmed()) return;
    e.preventDefault();
    void renders.mayClose().then((yes) => { if (yes && !win.isDestroyed()) win.close(); });
  });
  app.on('before-quit', (e) => {
    if (closing) return;
    e.preventDefault();
    if (renders.running() > 0 && !renders.confirmed()) {
      void renders.mayClose().then((yes) => { if (yes) app.quit(); });
      return;
    }
    closing = true;
    // Jobs first (the core cancels them and each render removes its temp files), then any render window left.
    void shutdownForQuit({ closeServer: server.close }).finally(() => app.quit());
  });
  // Deliberate on macOS too: closing the window ends the app, which also stops the in-process core. Hidden render windows
  // are windows too, so "all closed" would wait for them: closing the UI window is what ends the app.
  app.on('window-all-closed', () => app.quit());
  win.on('closed', () => app.quit());

  buildMenu();
  // Not awaited and never rejecting: an updater failure is a log line, never run()'s fatal error box. Lazy: development and
  // smoke runs never load electron-updater.
  void setupUpdates({
    isPackaged: app.isPackaged,
    signed: () => appSigned({ platform: process.platform, execPath: process.execPath, codesign: async (bundle) => (await execFileAsync('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { timeout: 5000 })).stderr }),
    load: () => import('electron-updater'),
    log: (m) => console.log(m),
    notify: (message, onRestart) => {
      buildMenu(onRestart);
      const n = new Notification({ title: 'Motion Studio', body: message });
      n.on('click', onRestart);
      n.show();
    },
  }).catch((e: unknown) => console.log(`Automatic updates off: ${String(e)}`));
  win.once('ready-to-show', () => { win.show(); focus.ready(win); });
  // Only the app's own pages may hand a link to the system browser: a preview frame (no-referrer) never can.
  win.webContents.setWindowOpenHandler((details) => { if (windowOpenToBrowser(details, origin)) void shell.openExternal(details.url); return { action: 'deny' }; });
  const guard = (e: { preventDefault: () => void }, url: string) => { if (!isAppUrl(url, origin)) e.preventDefault(); };
  win.webContents.on('will-navigate', (e, url) => guard(e, url));
  win.webContents.on('will-redirect', (e, url) => guard(e, url));
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) guard(e, e.url);
    // A frame of the UI may show the app or the composition server; a composition frame stays on its server.
    else if (subframeNavigationBlocked({ url: e.url, frameUrls: frameChain(e.frame) }, filterContext)) e.preventDefault();
  });
  if (server.attached) watchAttachedInstance(win, server.attached);
  // Attached: a failed load is handled by the restart prompt (did-fail-load), not by the fatal error box.
  await win.loadURL(server.appUrl).catch((err: unknown) => { if (!server.attached) throw err; });
}

if (smokeArg) {
  void app.whenReady().then(() => smoke(smokeArg.split('=')[1] ?? 'health')).then(
    () => { removeSmokeUserData(); app.exit(0); },
    (err) => { console.error(`SMOKE_FAIL ${(err as Error).message}`); removeSmokeUserData(); app.exit(1); },
  );
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A launch during boot (no window yet, or not shown) is remembered and served on ready-to-show.
  app.on('second-instance', () => focus.request());
  void app.whenReady().then(run).catch((err) => { dialog.showErrorBox('Motion Studio', String((err as Error).message ?? err)); app.exit(1); });
}

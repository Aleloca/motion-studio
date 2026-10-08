import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { resolveLoginShellPath, startServer } from '@motion-studio/core';
import { absolutePathArg, pickFolderArgs, tokenFromAppUrl } from './helpers.ts';
import { externalUrlAllowed, isAppUrl, windowOptions } from './window.ts';

const REPO_URL = 'https://github.com/Aleloca/motion-studio';
const smokeArg = process.argv.find((a) => a === '--smoke-test' || a.startsWith('--smoke-test='));

/** Dev: the source tree (dist/main.cjs is two levels under apps/desktop). Packaged: next to the asar (MCP server outside it). */
function resourcePaths() {
  if (app.isPackaged) {
    const unpacked = join(process.resourcesPath, 'app.asar.unpacked');
    return { webDir: join(unpacked, 'web'), mcpServerPath: join(unpacked, 'mcp-studio.mjs') };
  }
  const root = join(__dirname, '..', '..', '..');
  return { webDir: join(root, 'packages', 'web', 'dist'), mcpServerPath: join(root, 'packages', 'mcp-studio', 'src', 'server.mjs') };
}

async function boot() {
  const shellPath = await resolveLoginShellPath();
  process.env.PATH = shellPath.path;
  console.log(`PATH source: ${shellPath.source}`);
  return startServer({ port: 'auto', ...resourcePaths(), mcpEnv: { ELECTRON_RUN_AS_NODE: '1' } });
}

/** The smoke output never contains the token. */
async function smoke(mode: string) {
  const server = await boot();
  try {
    if (mode === 'doctor') {
      const res = await fetch(`${server.url}/api/doctor`, { headers: { 'x-motion-studio-ui': tokenFromAppUrl(server.appUrl) ?? '' } });
      if (!res.ok) throw new Error(`doctor HTTP ${res.status}`);
      const checks = (await res.json()) as { id: string; ok: boolean }[];
      console.log(`DOCTOR_OK ${checks.filter((c) => c.ok).map((c) => c.id).join(',')}`);
    } else {
      const res = await fetch(`${server.url}/api/health`);
      if (!res.ok) throw new Error(`health HTTP ${res.status}`);
      console.log(`SMOKE_OK ${server.url}`);
    }
  } finally { await server.close(); }
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    { label: 'Modifica', submenu: [{ role: 'undo', label: 'Annulla' }, { role: 'redo', label: 'Ripeti' }, { type: 'separator' }, { role: 'cut', label: 'Taglia' }, { role: 'copy', label: 'Copia' }, { role: 'paste', label: 'Incolla' }, { role: 'selectAll', label: 'Seleziona tutto' }] },
    { label: 'Vista', submenu: [{ role: 'reload', label: 'Ricarica' }, { role: 'togglefullscreen', label: 'Schermo intero' }, { type: 'separator' }, { role: 'resetZoom', label: 'Zoom predefinito' }, { role: 'zoomIn', label: 'Ingrandisci' }, { role: 'zoomOut', label: 'Riduci' }] },
    { label: 'Finestra', submenu: [{ role: 'minimize', label: 'Riduci a icona' }, { role: 'close', label: 'Chiudi' }] },
    { label: 'Aiuto', submenu: [{ label: 'Motion Studio su GitHub', click: () => void shell.openExternal(REPO_URL) }] },
  ]));
}

async function run() {
  const server = await boot();
  const origin = new URL(server.url).origin;
  let win: BrowserWindow | null = null;
  let closing = false;

  const trusted = (e: IpcMainInvokeEvent) => isAppUrl(e.senderFrame?.url ?? '', origin);
  ipcMain.handle('ms:pick-folder', async (e, arg: unknown) => {
    const args = trusted(e) ? pickFolderArgs(arg) : null;
    if (!args) throw new Error('Richiesta non valida');
    const r = await dialog.showOpenDialog({ ...args, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle('ms:reveal', (e, arg: unknown) => {
    const p = trusted(e) ? absolutePathArg(arg) : null;
    if (!p) throw new Error('Percorso non valido');
    shell.showItemInFolder(p);
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'notifications'));
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('before-quit', (e) => {
    if (closing) return;
    closing = true;
    e.preventDefault();
    void server.close().catch(() => {}).finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());

  buildMenu();
  win = new BrowserWindow(windowOptions(join(__dirname, 'preload.cjs'), nativeTheme.shouldUseDarkColors));
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (externalUrlAllowed(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!isAppUrl(url, origin)) e.preventDefault(); });
  await win.loadURL(server.appUrl);
}

if (smokeArg) {
  void app.whenReady().then(() => smoke(smokeArg.split('=')[1] ?? 'health')).then(
    () => app.exit(0),
    (err) => { console.error(`SMOKE_FAIL ${(err as Error).message}`); app.exit(1); },
  );
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(run).catch((err) => { dialog.showErrorBox('Motion Studio', String((err as Error).message ?? err)); app.exit(1); });
}

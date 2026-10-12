/**
 * The real-Electron harness of render-window.electron.test.ts (phase 10a Task 7): bundled by the test and run by the
 * Electron binary as its main script. Every Electron data path points into the test's throwaway folder, and the
 * core's config folder is the test's temp one (`MOTION_STUDIO_CONFIG_DIR`). It reads one scenario from `MS_HARNESS`
 * (JSON) and prints `HARNESS <json>` lines; the test asserts on them.
 */
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, powerSaveBlocker, session } from 'electron';
import type { Composition, FormatPreset } from '../../../../packages/shared/src/index.ts';
import { renderComposition, RenderError, type FfmpegInfo } from '@motion-studio/core';
import { startCompositionServer } from '../../../../packages/core/src/compositions/composition-server.ts';
import { appKeptAwake, closeAllRenderWindows, createRenderWindow, ElectronProvider, liveRenderWindowCount, shutdownForQuit } from '../../src/render-window.ts';
import { readdirSync, existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { hardenUiWindow, installPreviewFilter } from '../../src/preview-filter.ts';

interface Config {
  scenario: 'options' | 'session-rules' | 'render' | 'hostile-render' | 'preview' | 'lifecycle' | 'memory' | 'quit';
  /** The built runtime. */
  dist: string;
  /** The creative folder (render scenarios). */
  creative?: string;
  composition?: Composition;
  format?: string;
  out?: string;
  ffmpeg?: FfmpegInfo;
  /** A server without any CSP (session rules, preview): `<origin>/<token>/page.html` frames every hostile layer. */
  naked?: { origin: string; token: string };
  /**
   * The UI-like pages (preview): every frame (control), the real server's frames, the CSP-less server's frames; with the
   * composition origin the filter is pinned to in each filtered phase (the real server, then the CSP-less one).
   */
  ui?: { origin: string; all: string; real: string; naked: string; inherit: string; realComposition: string; nakedComposition: string };
  parallel?: number;
  /** A throwaway folder under the OS temp folder for every Electron data path (the test removes it after the exit). */
  scratch: string;
}

const config = JSON.parse(process.env.MS_HARNESS ?? '{}') as Config;
const scratch = config.scratch;
if (!scratch || !scratch.includes('ms-test-electron-')) throw new Error('harness: a throwaway scratch folder is required');
// Before anything reads them: no Electron data outside the throwaway folder.
app.setName('ms-electron-harness');
// No real keychain (Chromium's cookie encryption would otherwise ask for it).
app.commandLine.appendSwitch('use-mock-keychain');
app.commandLine.appendSwitch('password-store', 'basic');
for (const k of ['appData', 'userData', 'sessionData', 'logs', 'crashDumps'] as const) app.setPath(k, join(scratch, k));
// Not removed here: an rmSync of it in an 'exit' hook hung Electron's exit once pages had loaded over HTTP. The test does it.

const report = (o: unknown) => console.log(`HARNESS ${JSON.stringify(o)}`);
// Final wave B2: the effective data folders, logged before anything else; one outside the scratch folder stops this run
// at once. The test checks them too and only then says `go` (stdin): nothing runs before.
const PATHS = ['appData', 'userData', 'sessionData', 'logs', 'crashDumps'] as const;
const paths = Object.fromEntries(PATHS.map((k) => [k, app.getPath(k)]));
report({ phase: 'paths', pid: process.pid, ...paths });
if (PATHS.some((k) => !paths[k]!.startsWith(`${scratch}/`))) { report({ error: 'Electron data outside the scratch folder' }); app.exit(3); process.exit(3); }
const go = new Promise<void>((resolve) => {
  let input = '';
  process.stdin.on('data', (d: Buffer) => { input += d.toString(); if (/^go$/m.test(input)) resolve(); });
});
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * How long a CONTROL window (no filter: it must leak, or "nothing leaked" proves nothing) is given to do its work: its base
 * time stretched by the machine load (1 to 6 times), so a slow start under load does not close it before its probes fired.
 */
const controlSettle = (ms: number) => settle(ms * Math.min(6, Math.max(1, loadavg()[0]! / Math.max(1, cpus().length))));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const formatOf = (c: Composition, id: string): FormatPreset => ({ id, channel: 'Test', name: id, width: c.width, height: c.height, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 });

/** Loads `url` in a hidden window on its own partition (`prepare` locks it, or not: a control). */
async function loadIn(partition: string, url: string, prepare: (ses: Electron.Session) => void | Promise<void>, ui = false) {
  const ses = session.fromPartition(partition, { cache: false });
  await prepare(ses);
  // `ui`: the UI window's own protection (preview-filter.ts) on top of the filter.
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition } });
  if (ui) hardenUiWindow(win.webContents);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadURL(url).catch(() => {});
  return win;
}

/**
 * Watches a session's service workers until `stop()`: `serviceWorkers` is the most running at once (sampled every 200 ms and
 * on every status change), `swEvents` every registration and running-status change, timed from the start (the diagnostic
 * of a failure). A single read at the end would miss a worker that ran and was stopped (Chromium stops an idle one after 30 s).
 */
function watchServiceWorkers(ses: Electron.Session) {
  const t0 = Date.now();
  const swEvents: string[] = [];
  let max = 0;
  const sample = () => { max = Math.max(max, Object.keys(ses.serviceWorkers.getAllRunning()).length); };
  const onRegistered = (_e: unknown, d: { scope: string }) => { swEvents.push(`${Date.now() - t0}ms registered ${d.scope}`); sample(); };
  const onStatus = (d: { versionId: number; runningStatus: string }) => { swEvents.push(`${Date.now() - t0}ms v${d.versionId} ${d.runningStatus}`); sample(); };
  ses.serviceWorkers.on('registration-completed', onRegistered);
  ses.serviceWorkers.on('running-status-changed', onStatus);
  const timer = setInterval(sample, 200);
  return {
    stop() {
      clearInterval(timer);
      sample();
      ses.serviceWorkers.off('registration-completed', onRegistered);
      ses.serviceWorkers.off('running-status-changed', onStatus);
      return { serviceWorkers: max, swEvents };
    },
  };
}

async function close(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  const closed = new Promise<void>((r) => win.once('closed', () => r()));
  win.close();
  await closed;
}

async function run(): Promise<void> {
  const c = config;
  switch (c.scenario) {
    case 'options': {
      const prefix = `http://127.0.0.1:47001/abcdefghijklmnop0123/`;
      const rw = await createRenderWindow({ prefix, width: 320, height: 180 });
      const wc = rw.win.webContents;
      // Undocumented in the typings, present at runtime: the preferences the window really got.
      const prefs = ((wc as unknown as { getLastWebPreferences?: () => Record<string, unknown> | null }).getLastWebPreferences?.() ?? {});
      const ses = wc.session;
      const metric = app.getAppMetrics().find((m) => m.pid === wc.getOSProcessId());
      report({
        prefs: { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, nodeIntegrationInSubFrames: prefs.nodeIntegrationInSubFrames, preload: prefs.preload ?? null, webviewTag: prefs.webviewTag },
        // What the page itself sees: no Node, no preload bridge.
        pageGlobals: await wc.executeJavaScript('[typeof require, typeof process, typeof module, typeof window.electron, typeof window.motionStudio].join()'),
        processSandboxed: metric?.sandboxed ?? null,
        visible: rw.win.isVisible(), offscreen: wc.isOffscreen(), persistent: ses.isPersistent(), separate: ses !== session.defaultSession,
        proxy: {
          internet: await ses.resolveProxy('https://example.com/'),
          server: await ses.resolveProxy('http://127.0.0.1:47001/abcdefghijklmnop0123/x'),
          otherLoopback: await ses.resolveProxy('http://127.0.0.1:4318/api/health'),
          localhost: await ses.resolveProxy('http://localhost:47001/'),
        },
        webrtc: wc.getWebRTCIPHandlingPolicy(),
        keptAwake: appKeptAwake(),
        pids: rw.pids().length,
        windowsOpen: liveRenderWindowCount(),
      });
      await rw.close();
      report({ windowsAfterClose: liveRenderWindowCount(), allWindows: BrowserWindow.getAllWindows().length, keptAwake: appKeptAwake() });
      // The destroy()/loadURL race: a fresh window right after a close loads fine.
      const again = await createRenderWindow({ prefix, width: 64, height: 64 });
      report({ freshAfterClose: again.win.webContents.getURL() });
      await again.close();
      return;
    }
    case 'session-rules': {
      // No CDP interception, no CSP: only the session's proxy and webRequest rules (and the WebRTC policy).
      const page = `${c.naked!.origin}/${c.naked!.token}/page.html`;
      let controlWorkers: ReturnType<typeof watchServiceWorkers> | undefined;
      // The service workers of each window are watched for its whole life, not read once at the end: Chromium stops an idle
      // worker after 30 s, and the control's load-stretched settle (up to 36 s) outlived the page's worker.
      const control = await loadIn(`ms-test-control-${Date.now()}`, page, (ses) => { controlWorkers = watchServiceWorkers(ses); });
      const controlLoaded = Date.now();
      await controlSettle(6000);
      const controlSw = controlWorkers!.stop();
      await close(control);
      report({ phase: 'control-sw', ...controlSw, settledMs: Date.now() - controlLoaded, load: loadavg()[0] });
      report({ phase: 'control-done' });
      const rw = await createRenderWindow({ prefix: `${c.naked!.origin}/${c.naked!.token}/`, width: 800, height: 600 });
      const lockedWorkers = watchServiceWorkers(rw.win.webContents.session);
      await rw.win.loadURL(page).catch(() => {});
      const opened = rw.win.webContents.getURL();
      await settle(6000);
      const frames = rw.win.webContents.mainFrame.framesInSubtree.length;
      // The page registers a service worker on the allowed prefix: the session refuses its script, so none ever runs.
      const { serviceWorkers, swEvents } = lockedWorkers.stop();
      await rw.close();
      report({ phase: 'locked-done', opened, frames, serviceWorkers, swEvents });
      return;
    }
    case 'render': {
      const provider = new ElectronProvider({ maxWindows: c.parallel ?? 2, limits: { timeLimitMs: 30 * 60_000 } });
      const t0 = Date.now();
      const r = await renderComposition({
        dir: c.creative!, versionDir: 'outputs/v1', composition: c.composition!, format: formatOf(c.composition!, c.format!), out: c.out!,
        provider, parallel: c.parallel ?? 2, signal: new AbortController().signal, distDir: c.dist, ffmpeg: c.ffmpeg!, encoder: 'libx264',
        tempDir: scratch,
      });
      report({ ok: true, frames: r.frames, width: r.width, height: r.height, warnings: r.warnings, ms: Date.now() - t0, windowsAfter: liveRenderWindowCount(), peak: provider.peakMemory });
      return;
    }
    case 'hostile-render': {
      // All layers: the composition server (CSP), CDP interception, the session rules. Seek past the delayed navigation.
      const server = await startCompositionServer({ uiOrigins: [], distDir: c.dist });
      const provider = new ElectronProvider({ limits: { timeLimitMs: 30 * 60_000 } });
      try {
        const s = await server.mintSession({ creativeDir: c.creative!, versionDir: 'outputs/v1', format: c.format!, composition: c.composition!, mode: 'render' });
        const page = await provider.open({ width: c.composition!.width, height: c.composition!.height, url: s.url, signal: new AbortController().signal });
        const seeks: string[] = [];
        for (const t of [0, 1, 1.6, 1.9]) seeks.push(await page.seek(t).then(() => 'ok', (e: Error) => e.message.slice(0, 80)));
        const png = await page.capture('png');
        // Display media, with a user gesture (so the session's handler is really asked): refused cleanly.
        const win = BrowserWindow.getAllWindows()[0]!;
        const displayMedia = await win.webContents.executeJavaScript("navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => 'granted', (e) => e.name)", true)
          .catch((e: Error) => `threw: ${e.message}`);
        await settle(3000);
        report({ seeks, captured: png.length > 100, failure: provider.failure, errors: page.info.errors.map((e) => e.code), displayMedia });
      } finally {
        await provider.close();
        await server.close();
      }
      report({ windowsAfter: liveRenderWindowCount() });
      return;
    }
    case 'preview': {
      // The UI-like page frames the real preview (composition server, preview mode) and, directly, every hostile layer of
      // a server without CSP (the residual). Control first (no filter), then the UI session with the filter.
      const ui = c.ui!;
      const control = await loadIn(`ms-test-ui-control-${Date.now()}`, ui.all, () => {});
      await controlSettle(7000);
      const controlFrames = control.webContents.mainFrame.framesInSubtree.length;
      await close(control);
      report({ phase: 'control-done', controlFrames });
      // The UI window as the app sets it up: the filter on its session (pinned to that phase's composition server), the
      // WebRTC policy. Never the will-frame-navigate guard: the filter alone is under test.
      for (const [phase, page, comp] of [['real-done', ui.real, ui.realComposition], ['naked-done', ui.naked, ui.nakedComposition], ['inherit-done', ui.inherit, ui.nakedComposition]] as const) {
        const win = await loadIn(`ms-test-ui-${phase}-${Date.now()}`, page, (ses) => installPreviewFilter(ses, { appOrigin: ui.origin, compositionOrigin: () => comp }), true);
        await settle(7000);
        const frames = win.webContents.mainFrame.framesInSubtree.map((f) => f.url);
        const webTransport = await win.webContents.executeJavaScript('typeof WebTransport').catch((e: Error) => e.message);
        await close(win);
        report({ phase, frames, webTransport });
      }
      return;
    }
    case 'lifecycle': {
      const comp = c.composition!;
      const server = await startCompositionServer({ uiOrigins: [], distDir: c.dist });
      const s = await server.mintSession({ creativeDir: c.creative!, versionDir: 'outputs/v1', format: c.format!, composition: comp, mode: 'render' });
      const open = (p: ElectronProvider, signal = new AbortController().signal) => p.open({ width: comp.width, height: comp.height, url: s.url, signal });
      try {
        // App quit: every render window of every provider closes, and their renderers are gone.
        const a = new ElectronProvider({ limits: { timeLimitMs: 30 * 60_000 } });
        const b = new ElectronProvider({ limits: { timeLimitMs: 30 * 60_000 } });
        const pages = await Promise.all([open(a), open(a), open(b)]);
        const pids = BrowserWindow.getAllWindows().flatMap((w) => [w.webContents.getOSProcessId()]);
        report({ phase: 'opened', windows: liveRenderWindowCount(), pages: pages.length, pids: pids.length });
        await closeAllRenderWindows();
        await settle(1500);
        report({ phase: 'quit', windows: liveRenderWindowCount(), allWindows: BrowserWindow.getAllWindows().length, alive: pids.filter(alive).length });
        await a.close(); await b.close();

        // Cancel: aborting closes the window of a page being opened and the open fails as cancelled.
        const p = new ElectronProvider({ limits: { timeLimitMs: 30 * 60_000 } });
        const ac = new AbortController();
        const pending = open(p, ac.signal);
        setTimeout(() => ac.abort(), 50);
        const cancelled = await pending.then(() => 'opened', (e: unknown) => (e instanceof RenderError ? e.code : String(e)));
        await p.close();
        report({ phase: 'cancel', cancelled, windows: liveRenderWindowCount() });

        // Time limit: the watchdog fails the provider and closes its windows.
        const slow = new ElectronProvider({ limits: { timeLimitMs: 1500 } });
        const page = await open(slow);
        const wpid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId() ?? 0;
        await settle(4000);
        const afterTrip = await page.seek(0.5).then(() => 'ok', (e: unknown) => (e instanceof RenderError ? e.code : (e as Error).message.slice(0, 60)));
        report({ phase: 'time', failure: slow.failure?.code ?? null, seek: afterTrip, windows: liveRenderWindowCount(), alive: wpid > 0 && alive(wpid) });
        await slow.close();

        // Window cap: one more page than the provider allows is refused.
        const capped = new ElectronProvider({ maxWindows: 1, limits: { timeLimitMs: 30 * 60_000 } });
        await open(capped);
        const refused = await open(capped).then(() => 'opened', (e: Error) => e.message);
        await capped.close();
        report({ phase: 'cap', refused, windows: liveRenderWindowCount() });
      } finally {
        await closeAllRenderWindows();
        await server.close();
      }
      return;
    }
    case 'quit': {
      // Quit during a render, through the app's quit sequence (shutdownForQuit, as main.ts's before-quit runs it). The
      // core is stood in for by its close(): cancel the render (the core's preClose cancels every job) and wait for it.
      const provider = new ElectronProvider({ maxWindows: 2, limits: { timeLimitMs: 30 * 60_000 } });
      const ac = new AbortController();
      let frames = 0;
      const outcome = renderComposition({
        dir: c.creative!, versionDir: 'outputs/v1', composition: c.composition!, format: formatOf(c.composition!, c.format!), out: c.out!,
        provider, parallel: 2, signal: ac.signal, distDir: c.dist, ffmpeg: c.ffmpeg!, encoder: 'libx264', tempDir: scratch,
        onProgress: (p) => { frames = p.frames; },
      }).then(() => 'rendered', (e: unknown) => (e instanceof RenderError ? e.code : String(e)));
      const started = Date.now();
      while (frames < 3 && Date.now() - started < 300_000) await settle(200);
      const windowsBefore = liveRenderWindowCount();
      const quit = new Promise<void>((resolve) => {
        app.once('before-quit', (e) => {
          e.preventDefault();
          void shutdownForQuit({ closeServer: async () => { ac.abort(); await outcome; } }).then(resolve);
        });
      });
      app.quit();
      await quit;
      const dir = dirname(c.out!);
      const temps = readdirSync(dir).filter((n) => n.startsWith(`.${basename(c.out!)}.render-`));
      const workDirs = readdirSync(scratch).filter((n) => n.startsWith('ms-render-'));
      report({ phase: 'quit', framesAtQuit: frames, windowsBefore, result: await outcome, windows: liveRenderWindowCount(), allWindows: BrowserWindow.getAllWindows().length, out: existsSync(c.out!), temps, workDirs });
      return;
    }
    case 'memory': {
      const provider = new ElectronProvider({ maxWindows: 1, limits: { timeLimitMs: 30 * 60_000, maxProcessMB: 700 } });
      const r = await renderComposition({
        dir: c.creative!, versionDir: 'outputs/v1', composition: c.composition!, format: formatOf(c.composition!, c.format!), out: c.out!,
        provider, parallel: 1, signal: new AbortController().signal, distDir: c.dist, ffmpeg: c.ffmpeg!, encoder: 'libx264', tempDir: scratch,
      }).then(() => 'rendered', (e: unknown) => (e instanceof RenderError ? e.code : String(e)));
      report({ result: r, peak: provider.peakMemory, windowsAfter: liveRenderWindowCount() });
      return;
    }
  }
}

app.dock?.hide();
// The harness's own windows (controls, the UI-like page) are hidden too: keep macOS App Nap off for the whole run (the
// provider holds its own blocker only while render windows are open).
void app.whenReady().then(() => powerSaveBlocker.start('prevent-app-suspension'));
// Hidden windows only: the harness must not end when none is open.
app.on('window-all-closed', () => {});
void app.whenReady().then(() => go).then(run).then(
  async () => { await closeAllRenderWindows(); report({ done: true }); app.exit(0); },
  async (e: unknown) => { report({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), code: (e as { code?: unknown }).code ?? null }); await closeAllRenderWindows(); app.exit(1); },
);

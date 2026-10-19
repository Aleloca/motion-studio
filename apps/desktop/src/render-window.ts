import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, nativeImage, powerSaveBlocker, session, type BrowserWindowConstructorOptions, type Debugger, type ProxyConfig, type Session } from 'electron';
import {
  allowedPrefix, CdpError, DEAD_PROXY, layersAtScale, pagePixels, pageScale, DEFAULT_PARALLEL, isAllowedRequest, openCdpRenderPage, RenderError, samplePidsMemory,
  scaledMemoryLimits, startWatchdog,
  type CdpClient, type CdpEvent, type CdpSendOptions, type ChromiumProvider, type ChromiumProviderFactory, type OpenPageOptions,
  type PageTimeouts, type RawFrame, type RenderFailure, type RenderPage, type Watchdog, type WatchdogLimits,
} from '@motion-studio/core';

/**
 * The desktop's render provider (spec §5.3; phase 10a Task 7): Electron's own Chromium renders compositions, so the
 * desktop needs no Chrome. The core injects it through `startServer({ renderProvider })` and drives it exactly like
 * Chrome: `openCdpRenderPage` (request interception, seeks, captures, timeouts) over `webContents.debugger`.
 *
 * **One hidden window per page** (a parallel segment), created fresh for every page and never reused:
 * - `show: false`, offscreen rendering, `sandbox`, `contextIsolation`, no preload, no Node anywhere, no `<webview>`;
 *   a page at a scale above 1 (decision 974) renders offscreen at that device scale factor (report 51), so its html layers,
 *   out-of-process iframes the page's device metrics override never reaches, are rasterised at it too;
 * - its own **in-memory session partition** (`ms-render-<uuid>`, never `persist:`), locked before the window exists:
 *   - `setProxy` to a dead proxy with only the composition server's `127.0.0.1:<port>` bypassed and the implicit loopback
 *     bypass removed (`<-loopback>`): the per-session equivalent of the Chrome provider's `--proxy-server` flags (an
 *     app-wide switch would cut the UI off too). Nothing else is reachable directly, WebSockets included;
 *   - `webRequest.onBeforeRequest` lets through only `http://127.0.0.1:<port>/<token>/…` (`isAllowedRequest`, the same
 *     check as the CDP interception); it also sees WebSockets, which CDP Fetch does not; `onBeforeSendHeaders` refuses
 *     the script of any service or shared worker, even on the prefix (`isSharedWorkerScript`);
 *   - every permission denied, downloads cancelled, no spell checker (it would call a Google service);
 * - WebRTC IP handling `disable_non_proxied_udp` on the window, `setWindowOpenHandler` → deny, and the window's own
 *   navigations (`will-navigate`, `will-frame-navigate`, `will-redirect`) kept inside the prefix;
 * - CDP: `webContents.debugger` reports its own target's events with an empty session id, and the interception matches
 *   events by session, so the page target is attached again with `Target.attachToTarget({ flatten: true })` and every page
 *   command goes to that real session id. A page-level debugger does not see service or shared workers (no browser-level
 *   `TargetGate` here): their scripts are refused by the session (above), and the layers are opaque origins that cannot
 *   start them anyway; popups are denied by the handler.
 * - a video's frames are read raw (`capturePage`, `rawFrames`; report 53), not with `Page.captureScreenshot`, whose
 *   PNG/JPEG encode runs on this process's UI thread, the app's; only once this machine's raw frames proved to be a
 *   PNG's pixels (`checkRawFrames`, report 56), else the PNG/JPEG frames stay.
 *
 * **Closing.** `destroy()` followed at once by a new window's `loadURL` fails with `ERR_FAILED` in Electron 44 (spike
 * §3a): a window is closed with `close()` (with `beforeunload` ignored) and the provider waits for `closed`, falling back
 * to `destroy()` after a few seconds, then still waits for `closed`. Windows are never reused.
 *
 * **Processes.** The render windows' renderers are Electron's own children: there is no process group to kill. Instead:
 * - cancel, a time limit, a failed segment and `close()` close every window of the provider (the core calls `close()` at
 *   the end of every render); a crashed renderer (`render-process-gone`) fails the render;
 * - every live render window is in a module-wide set, and the app closes them all on quit (`shutdownForQuit`: the core's
 *   jobs are cancelled first, then the windows close); the OS ends the renderers with the app in any case;
 * - the window cap is app-wide (`renderWindowSlots`, every provider: a render's pages plus one slot reserved for the
 *   preview lane, so storyboards and `preview_frames` never wait behind a render), and per provider (`maxWindows`);
 * - the watchdog (the core's, with a sampler of our own): the OS pids of each window's renderers
 *   (`webContents.getOSProcessId()` and every frame's `osProcessId`, for out-of-process layer frames), measured like the
 *   Chrome group (macOS physical footprint with `ps` RSS as a floor, Linux `/proc`) and with `app.getAppMetrics()`'s
 *   working set as another floor (the only reading on Windows). Limits as for Chrome (`scaledMemoryLimits`) over the
 *   render windows only: the GPU and browser processes are shared with the UI and not counted. A trip closes every window
 *   and fails the render with `memoryLimit` / `timeLimit`.
 *
 * **App Nap.** macOS may throttle an app with no visible window (the user hides or minimises Motion Studio during a
 * render): while any render window is open a `prevent-app-suspension` power save blocker is held. (Not measured in
 * isolation: on the test machine, at load 200+, hidden-window Electron runs were slow with or without it.)
 */

/** The partition name of every render window (`<prefix><uuid>`; no `persist:`, so in memory only). */
export const RENDER_PARTITION_PREFIX = 'ms-render-';
/** How long `close()` may take before the window is destroyed. */
const CLOSE_GRACE_MS = 5_000;
/** How long a window may take to emit `closed` after `destroy()`. */
const CLOSED_WAIT_MS = 10_000;
/** How long a raw capture may take (the core's default for a CDP capture). */
const CAPTURE_MS = 90_000;

/**
 * `transparent` (Phase 14, the identity sets' PNGs): the window has no background of its own (`transparent`, fully
 * transparent `backgroundColor`), so a capture keeps the page's alpha; `openCdpRenderPage` also sets the page's default
 * background to transparent over CDP. Every other render window keeps Electron's opaque default.
 */
export function renderWindowOptions(partition: string, width: number, height: number, o: { transparent?: boolean; scale?: number } = {}): BrowserWindowConstructorOptions {
  if (!partition.startsWith(RENDER_PARTITION_PREFIX)) throw new Error('render window: not a render partition');
  const scale = o.scale !== undefined && layersAtScale(o.scale) ? o.scale : null;
  return {
    show: false, width, height, useContentSize: true, enableLargerThanScreen: true, frame: false, skipTaskbar: true, focusable: false,
    paintWhenInitiallyHidden: true,
    ...(o.transparent ? { transparent: true, backgroundColor: '#00000000' } : {}),
    webPreferences: {
      // Report 51 (decision 1341): a page rasterised at a scale gets it as the window's own device scale factor, which every
      // frame of every process gets. The page's `Emulation.setDeviceMetricsOverride` never reached the html layers (sandboxed
      // iframes, out of process): they drew at 1x and were stretched.
      offscreen: scale ? { deviceScaleFactor: scale } : true, sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false,
      backgroundThrottling: false, spellcheck: false, safeDialogs: true, autoplayPolicy: 'no-user-gesture-required',
      partition,
    },
  };
}

/** The dead proxy, with only the composition server of `prefix` direct (see the module comment). */
export function renderProxyConfig(prefix: string): ProxyConfig {
  const u = new URL(allowedPrefix(prefix));
  return { mode: 'fixed_servers', proxyRules: DEAD_PROXY, proxyBypassRules: `<-loopback>;127.0.0.1:${u.port}` };
}

/** Whether a render window's session lets `url` through: the composition server's token prefix only. */
export function renderRequestAllowed(url: string, prefix: string): boolean {
  return isAllowedRequest(url, prefix);
}

/**
 * Whether a request is the script of a service or shared worker (by its headers: `Service-Worker: script`, or
 * `Sec-Fetch-Dest: serviceworker|sharedworker` where present). The page-level debugger never sees those workers (they are
 * not children of the page target), so they are refused here, before they load: even on the token prefix.
 */
export function isSharedWorkerScript(headers: Record<string, string | string[] | undefined>): boolean {
  const get = (k: string) => { for (const [n, v] of Object.entries(headers)) if (n.toLowerCase() === k) return String(v ?? '').toLowerCase(); return ''; };
  return get('service-worker') === 'script' || ['serviceworker', 'sharedworker'].includes(get('sec-fetch-dest'));
}

type LockableSession = Pick<Session, 'setProxy' | 'closeAllConnections' | 'webRequest' | 'setPermissionRequestHandler' | 'setPermissionCheckHandler'
  | 'setDevicePermissionHandler' | 'setDisplayMediaRequestHandler' | 'setSpellCheckerEnabled' | 'on'>;

/** Locks a render window's session to `prefix` (call before the window exists). */
export async function lockRenderSession(ses: LockableSession, prefix: string): Promise<void> {
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !renderRequestAllowed(details.url, prefix) }));
  ses.webRequest.onBeforeSendHeaders((details, callback) => callback({ cancel: isSharedWorkerScript(details.requestHeaders), requestHeaders: details.requestHeaders }));
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // `null`: the request is refused (getDisplayMedia rejects); never an empty stream set (which may throw).
  ses.setDisplayMediaRequestHandler((_request, callback) => { try { callback(null); } catch { /* the frame is gone */ } });
  ses.setSpellCheckerEnabled(false);
  ses.on('will-download', (e) => e.preventDefault());
  await ses.setProxy(renderProxyConfig(prefix));
  await ses.closeAllConnections();
}

type ClosableWindow = Pick<BrowserWindow, 'isDestroyed' | 'close' | 'destroy' | 'once'> & { webContents: { debugger: Pick<Debugger, 'isAttached' | 'detach'> } };

function waitClosed(win: ClosableWindow, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    win.once('closed', () => { clearTimeout(timer); resolve(true); });
  });
}

/** Closes a render window and waits for `closed` (never a bare `destroy()`; see the module comment). Never throws. */
export async function closeRenderWindow(win: ClosableWindow, graceMs = CLOSE_GRACE_MS): Promise<void> {
  if (win.isDestroyed()) return;
  try { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); } catch { /* gone */ }
  const closed = waitClosed(win, graceMs);
  try { win.close(); } catch { /* gone */ }
  if (await closed) return;
  if (win.isDestroyed()) return;
  const destroyed = waitClosed(win, CLOSED_WAIT_MS);
  try { win.destroy(); } catch { /* gone */ }
  await destroyed;
}

/** Every render window alive in this app (the quit hook closes them all). */
const liveWindows = new Set<BrowserWindow>();
/** The App Nap blocker, held while any render window is open. */
let napBlocker: number | null = null;

function holdAppAwake(): void {
  if (napBlocker === null) {
    try { napBlocker = powerSaveBlocker.start('prevent-app-suspension'); } catch { napBlocker = null; }
  }
}

function releaseAppIfIdle(): void {
  if (liveWindows.size > 0 || napBlocker === null) return;
  try { powerSaveBlocker.stop(napBlocker); } catch { /* gone */ }
  napBlocker = null;
}

/** Whether the App Nap blocker is held (tests). */
export function appKeptAwake(): boolean { return napBlocker !== null; }

/** Which kind of work a render window serves: a render's pages, or the preview lane (storyboards, the agent's frames). */
export type WindowLane = 'render' | 'preview';

/**
 * The app-wide cap on render windows (every provider). One slot is reserved for the preview lane: a render may hold at
 * most `limit - 1` windows, so storyboards and the agent's `preview_frames` never wait behind a render for its whole
 * length; the preview lane may use the reserved slot or any free one. A page past its share waits for a window to close;
 * the waiting ends with the open's (or its provider's) abort signal.
 */
export class WindowSlots {
  private used = 0;
  private renderUsed = 0;
  private readonly waiters: Array<{ lane: WindowLane; grant: () => void }> = [];
  constructor(private max: number) {}
  get limit(): number { return this.max; }
  get inUse(): number { return this.used; }
  /** The most windows the render lane may hold (`limit - 1`, at least 1). */
  get renderLimit(): number { return Math.max(1, this.max - 1); }
  setLimit(n: number): void { this.max = Math.max(1, Math.floor(n)); this.wake(); }
  private fits(lane: WindowLane): boolean {
    return this.used < this.max && (lane === 'preview' || this.renderUsed < this.renderLimit);
  }
  private wake(): void {
    for (let i = 0; i < this.waiters.length;) {
      const w = this.waiters[i]!;
      if (this.fits(w.lane)) { this.waiters.splice(i, 1); w.grant(); } else i++;
    }
  }
  /** Waits for a slot of `lane`; resolves with its release (idempotent). */
  acquire(signal?: AbortSignal, lane: WindowLane = 'render'): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        this.used++;
        if (lane === 'render') this.renderUsed++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.used--;
          if (lane === 'render') this.renderUsed--;
          this.wake();
        });
      };
      const entry = { lane, grant };
      const onAbort = () => {
        const i = this.waiters.indexOf(entry);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new RenderError('cancelled', 'cancelled'));
      };
      if (signal?.aborted) return onAbort();
      if (this.fits(lane)) return grant();
      this.waiters.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** The app's render window slots (`desktopRenderOptions` sets the limit: the render's pages plus the reserved one). */
export const renderWindowSlots = new WindowSlots(DEFAULT_PARALLEL + 1);

/** How many render windows are open (tests: nothing may outlive a render, a cancel or a quit). */
export function liveRenderWindowCount(): number { return liveWindows.size; }

/** Closes every render window of the app (`before-quit`, and the last word of a test). */
export async function closeAllRenderWindows(): Promise<void> {
  await Promise.all([...liveWindows].map((w) => closeRenderWindow(w)));
}

export interface RenderWindow {
  win: BrowserWindow;
  /** The OS pids of the window's renderers (its main frame's and every frame's), for the watchdog. */
  pids(): number[];
  close(): Promise<void>;
}

/** A fresh, locked, hidden window on `about:blank` (see the module comment), within the app-wide cap. */
export async function createRenderWindow(o: { prefix: string; width: number; height: number; signal?: AbortSignal; lane?: WindowLane; transparent?: boolean; scale?: number }): Promise<RenderWindow> {
  const release = await renderWindowSlots.acquire(o.signal, o.lane ?? 'render');
  let win: BrowserWindow;
  const partition = `${RENDER_PARTITION_PREFIX}${randomUUID()}`;
  const ses = session.fromPartition(partition, { cache: false });
  try {
    await lockRenderSession(ses, o.prefix);
    win = new BrowserWindow(renderWindowOptions(partition, o.width, o.height, { transparent: o.transparent === true, ...(o.scale !== undefined ? { scale: o.scale } : {}) }));
  } catch (e) {
    release();
    throw e;
  }
  liveWindows.add(win);
  holdAppAwake();
  const wc = win.webContents;
  win.once('closed', () => {
    liveWindows.delete(win);
    release();
    releaseAppIfIdle();
    // The partition stays registered in Electron for the app's life (there is no API to drop one): empty it.
    void ses.clearStorageData().catch(() => {});
    void ses.clearCache().catch(() => {});
  });
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const keepIn = (e: { preventDefault(): void }, url: string) => { if (!renderRequestAllowed(url, o.prefix)) e.preventDefault(); };
  wc.on('will-navigate', (e, url) => keepIn(e, url));
  wc.on('will-redirect', (e, url) => keepIn(e, url));
  wc.on('will-frame-navigate', (e) => keepIn(e, e.url));
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // A page may not keep its window open (beforeunload).
  wc.on('will-prevent-unload', (e) => e.preventDefault());
  const close = () => closeRenderWindow(win);
  try {
    await win.loadURL('about:blank');
  } catch (e) {
    await close();
    throw new RenderError('loadFailed', `the render window did not start: ${(e as Error).message}`);
  }
  // Decision 1348: no `paint` events. Nobody listens to them, yet each frame was copied into the main process (at a scale,
  // that many more pixels); the captures (`Page.captureScreenshot` from the surface) and the page's frames do not need them.
  wc.stopPainting();
  return {
    win, close,
    pids() {
      if (win.isDestroyed()) return [];
      const pids = new Set<number>();
      try {
        pids.add(wc.getOSProcessId());
        for (const f of wc.mainFrame.framesInSubtree) pids.add(f.osProcessId);
      } catch { /* closing */ }
      return [...pids].filter((p) => p > 1);
    },
  };
}

interface Pending { reject: (e: Error) => void; sessionId?: string }

/**
 * `webContents.debugger` as a `CdpClient`: every call has a timeout, the session id goes through, events are reported with
 * their session id (none for the window's own target), and a detach ends the client.
 */
export class DebuggerCdpClient implements CdpClient {
  closed: Error | null = null;
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  private readonly closeListeners = new Set<(err: Error) => void>();
  private readonly pending = new Set<Pending>();

  constructor(private readonly dbg: Pick<Debugger, 'attach' | 'detach' | 'isAttached' | 'sendCommand' | 'on'>, private readonly defaultTimeoutMs = 30_000) {}

  attach(): void {
    this.dbg.on('message', (_e, method, params, sessionId) => this.dispatch(method, params, sessionId));
    this.dbg.on('detach', (_e, reason) => this.close(new CdpError(`the debugger detached: ${String(reason)}`, 'closed')));
    this.dbg.attach('1.3');
  }

  private dispatch(method: string, params: unknown, sessionId: string): void {
    if (this.closed) return;
    const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
    if (method === 'Target.detachedFromTarget' && typeof p.sessionId === 'string') {
      for (const x of [...this.pending]) if (x.sessionId === p.sessionId) x.reject(new CdpError('the target was detached', 'closed'));
    }
    const e: CdpEvent = { method, params: p, ...(sessionId ? { sessionId } : {}) };
    for (const l of [...this.listeners]) {
      try { l(e); } catch { /* a listener bug must not break the client */ }
    }
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}, o: CdpSendOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError(`${method}: ${this.closed.message}`, 'closed'));
    const timeoutMs = o.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { ...(o.sessionId ? { sessionId: o.sessionId } : {}), reject: (e) => finish(() => reject(new CdpError(`${method}: ${e.message}`, (e as CdpError).code ?? 'closed'))) };
      let done = false;
      const timer = setTimeout(() => finish(() => reject(new CdpError(`${method} timed out after ${timeoutMs} ms`, 'timeout'))), timeoutMs);
      const finish = (f: () => void) => { if (done) return; done = true; clearTimeout(timer); this.pending.delete(entry); f(); };
      this.pending.add(entry);
      let sent: Promise<unknown>;
      try {
        sent = this.dbg.sendCommand(method, params as Record<string, unknown>, o.sessionId);
      } catch (e) {
        sent = Promise.reject(e as Error);
      }
      sent.then(
        (r) => finish(() => resolve((typeof r === 'object' && r !== null ? r : {}) as T)),
        (e: unknown) => finish(() => reject(this.closed ? new CdpError(`${method}: ${this.closed.message}`, 'closed') : new CdpError(`${method}: ${e instanceof Error ? e.message : String(e)}`, 'remote'))),
      );
    });
  }

  onEvent(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onClose(listener: (err: Error) => void): () => void {
    if (this.closed) { listener(this.closed); return () => {}; }
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  /** Ends the client (pending calls fail) and detaches the debugger. Idempotent. */
  close(err: Error = new CdpError('connection closed', 'closed')): void {
    if (this.closed) return;
    this.closed = err;
    for (const p of [...this.pending]) p.reject(err);
    this.listeners.clear();
    for (const l of [...this.closeListeners]) { try { l(err); } catch { /* ignore */ } }
    this.closeListeners.clear();
    try { if (this.dbg.isAttached()) this.dbg.detach(); } catch { /* gone */ }
  }
}

/**
 * Report 53: whether a page's frames can be read raw (`capturePage`). `Page.captureScreenshot` encodes each frame (PNG about
 * 96 ms at 2560 × 1440, JPEG about 25 ms) on the browser process's UI thread, the app's own: while an export ran, the UI
 * stalled. `capturePage` hands over the surface's bitmap: no encode, the same pixels. Only where the window's own scale is
 * the page's (1, or a scale above 1 given to the window, decision 1341): below 1 the page's override shrinks what CDP
 * captures, not the window's surface. Never for a transparent page (the bitmap's alpha is premultiplied).
 */
export function rawFrames(o: Pick<OpenPageOptions, 'deviceScaleFactor' | 'transparentBackground'>): boolean {
  const scale = pageScale(o);
  return !o.transparentBackground && (scale === 1 || layersAtScale(scale));
}

/**
 * A raw capture checked like the CDP one (`capture` refuses a page whose isolation failed): `failure` before the capture,
 * and after it, so a frame captured while a request broke the isolation is never encoded.
 */
export async function guardedRawCapture(read: () => Promise<RawFrame>, failure: () => RenderError | null): Promise<RawFrame> {
  { const f = failure(); if (f) throw f; }
  const frame = await read();
  { const f = failure(); if (f) throw f; }
  return frame;
}

/** A raw frame against a PNG of the same state decoded to BGRA: bytes that differ, the largest difference, and whether every pixel of the raw one is opaque. */
export interface RawCheck { same: boolean; differing: number; max: number; opaque: boolean; width: number; height: number }

/** Compares a raw BGRA frame with a PNG's pixels (BGRA, the same size): `same` only when every byte matches and the frame is opaque. */
export function compareRawFrame(raw: RawFrame, png: { data: Buffer; width: number; height: number }): RawCheck {
  const sized = raw.width === png.width && raw.height === png.height && raw.data.length === png.data.length;
  let differing = sized ? 0 : Math.max(raw.data.length, png.data.length), max = sized ? 0 : 255, opaque = true;
  const n = Math.min(raw.data.length, png.data.length);
  for (let k = 0; k < n; k++) {
    const d = Math.abs(raw.data[k]! - png.data[k]!);
    if (d) { differing++; if (d > max) max = d; }
    if ((k & 3) === 3 && raw.data[k] !== 255) opaque = false;
  }
  return { same: sized && differing === 0 && opaque, differing, max, opaque, width: raw.width, height: raw.height };
}

/**
 * The pattern the check paints over the page: hues, greys, saturated and half-transparent colours, at device pixels. It
 * runs in an isolated world of the check's own (`checkRawFrames`): the canvas is held on that world's `window`, out of the
 * page's reach (never looked up by an id the page could also use), and its two animation frames are native ones (the
 * page's own `requestAnimationFrame` is the render clock's).
 */
const RAW_CHECK_PAINT = `new Promise((resolve) => {
  const c = document.createElement('canvas');
  window.__msRawCheck = c;
  const k = window.devicePixelRatio || 1, w = Math.max(1, Math.round(innerWidth * k)), h = Math.max(1, Math.round(innerHeight * k));
  c.width = w; c.height = h;
  c.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none';
  const g = c.getContext('2d');
  const hues = g.createLinearGradient(0, 0, w, 0);
  ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'].forEach((s, i) => hues.addColorStop(i / 6, s));
  g.fillStyle = hues; g.fillRect(0, 0, w, h / 2);
  const greys = g.createLinearGradient(0, 0, w, 0);
  greys.addColorStop(0, '#000000'); greys.addColorStop(1, '#ffffff');
  g.fillStyle = greys; g.fillRect(0, h / 2, w, h / 2);
  ['rgba(255,64,0,0.5)', 'rgba(0,128,255,0.35)', 'rgba(32,200,90,0.7)'].forEach((s, i) => { g.fillStyle = s; g.fillRect(0, (h * (i + 1)) / 4 - h / 16, w, h / 8); });
  document.documentElement.appendChild(c);
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
})`;
/** Takes the pattern away; true only when it is really out of the document. */
const RAW_CHECK_REMOVE = `(() => { const c = window.__msRawCheck; if (c) c.remove(); window.__msRawCheck = null; return !c || !c.isConnected; })()`;

/** The pattern of a raw frame check could not be taken away: that page would render it, so it must not be used. */
export class RawCheckCleanupError extends Error {
  constructor(why: string) { super(`the raw frame check could not remove its pattern: ${why}`); this.name = 'RawCheckCleanupError'; }
}

/** One `Runtime.evaluate` (`send` with its parameters): the value, or an error for an exception in the page or no value. */
export async function evaluateValue(send: (params: Record<string, unknown>) => Promise<unknown>, expression: string): Promise<unknown> {
  const r = await send({ expression, returnByValue: true, awaitPromise: true }) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
  if (r?.exceptionDetails) throw new Error(`evaluate threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'an exception'}`);
  return r?.result?.value;
}

/**
 * Report 56: whether this machine's raw frames (`capturePage`) are the pixels of a PNG (`Page.captureScreenshot`) of the
 * same state. Before the page's first seek, a pattern (`RAW_CHECK_PAINT`) is shown over it for two native frames, captured
 * as PNG first (its forced redraw) and then raw, and taken away; the composition is not sought for it (no seek of its own
 * at open: the render's first seek paints the page). Measured on the developer's Mac: the same bytes under a forced
 * Display P3 or generic RGB profile, software compositing and a starved GPU process, so a difference here (a colour
 * transform, an order of channels, alpha) is a machine where raw frames would change the video: its renders keep the
 * PNG/JPEG frames. An empty PNG is an error, not a difference. A pattern that cannot be taken away (the removal throws,
 * times out or finds it still there) rejects with `RawCheckCleanupError`, whatever the comparison gave.
 */
export async function checkRawFrames(page: Pick<RenderPage, 'capture'>, evaluate: (expression: string) => Promise<unknown>, read: () => Promise<RawFrame>): Promise<RawCheck> {
  let result: RawCheck | undefined;
  let error: unknown;
  try {
    if (await evaluate(RAW_CHECK_PAINT) !== true) throw new Error('the check pattern was not painted');
    const img = nativeImage.createFromBuffer(await page.capture('png'));
    const size = img.getSize();
    if (img.isEmpty() || size.width < 1 || size.height < 1) throw new Error('the check\'s PNG is empty');
    result = compareRawFrame(await read(), { data: img.toBitmap(), ...size });
  } catch (e) {
    error = e;
  }
  let gone: unknown;
  try { gone = await evaluate(RAW_CHECK_REMOVE); } catch (e) { throw new RawCheckCleanupError(e instanceof Error ? e.message : String(e)); }
  if (gone !== true) throw new RawCheckCleanupError('it is still in the page');
  if (error !== undefined) throw error;
  return result!;
}

/**
 * The checks made, by page scale, for the app's life: the first page of each scale that would read raw makes it, the
 * others wait for it; a check that fails (an error, not a difference) is forgotten, its pages keep the PNG/JPEG frames.
 */
const rawChecks = new Map<number, Promise<RawCheck>>();

/** Whether the pages at `scale` read raw frames: `run` checks once (see `rawChecks`); a difference is logged once. */
export async function rawFramesChecked(scale: number, run: () => Promise<RawCheck>): Promise<boolean> {
  let check = rawChecks.get(scale);
  if (!check) {
    check = run().then((r) => {
      if (!r.same) console.warn(`Motion Studio: raw frames differ from PNG frames at scale ${scale} (${r.differing} bytes, max ${r.max}, opaque ${String(r.opaque)}, ${r.width}×${r.height}): renders keep PNG/JPEG frames`);
      return r;
    });
    rawChecks.set(scale, check);
    check.catch(() => { if (rawChecks.get(scale) === check) rawChecks.delete(scale); });
  }
  return check.then((r) => r.same, () => false);
}

/**
 * Whether a page reads raw frames: only when the caller asked for them (`rawFrames`: a video render, not a still or a
 * storyboard), the window's scale allows them (`rawFrames()`), and this machine's check at that scale passed. A check
 * that fails leaves the page on PNG/JPEG frames, except a `RawCheckCleanupError` of this page's own check, which rejects:
 * the page shows the pattern and must not be used.
 */
export async function pageRawFrames(o: Pick<OpenPageOptions, 'deviceScaleFactor' | 'transparentBackground' | 'rawFrames'>, check: () => Promise<RawCheck>): Promise<boolean> {
  if (o.rawFrames !== true || !rawFrames(o)) return false;
  let dirty: RawCheckCleanupError | null = null;
  const raw = await rawFramesChecked(pageScale(o), () => check().catch((e: unknown) => { if (e instanceof RawCheckCleanupError) dirty = e; throw e; }));
  if (dirty) throw new RenderError('loadFailed', (dirty as RawCheckCleanupError).message);
  return raw;
}

/** The raw frame checks made so far, by scale (tests, diagnostics). */
export async function rawFrameChecks(): Promise<Record<string, RawCheck | null>> {
  const out: Record<string, RawCheck | null> = {};
  for (const [k, p] of rawChecks) out[String(k)] = await p.catch(() => null);
  return out;
}

/** Tests: forgets every check. */
export function resetRawFrameChecks(): void { rawChecks.clear(); }

/** The window's surface as BGRA pixels (`toBitmap`: Skia's N32 order, BGRA on every platform the app ships on). */
export async function captureWindowFrame(win: Pick<BrowserWindow, 'isDestroyed' | 'webContents'>, timeoutMs: number): Promise<RawFrame> {
  if (win.isDestroyed()) throw new RenderError('crashed', 'the render window is gone');
  let timer: NodeJS.Timeout | undefined;
  try {
    // `stayHidden`: the capture must not make the hidden window visible (Electron counts it as a capturer otherwise).
    const img = await Promise.race([
      win.webContents.capturePage(undefined, { stayHidden: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CdpError(`capturePage timed out after ${timeoutMs} ms`, 'timeout')), timeoutMs); }),
    ]);
    const { width, height } = img.getSize();
    if (img.isEmpty()) throw new RenderError('badFrame', 'empty capture');
    return { data: img.toBitmap(), width, height };
  } finally {
    clearTimeout(timer);
  }
}

export interface ElectronProviderOptions {
  /** Windows (pages) open at once; default `DEFAULT_PARALLEL` (the render's `parallel` setting). */
  maxWindows?: number;
  /** Watchdog limits; `timeLimitMs` is the whole render's. Memory limits default to `scaledMemoryLimits`. */
  limits: WatchdogLimits;
  timeouts?: PageTimeouts;
  /** Tests: replaces `createRenderWindow`. */
  createWindow?: (o: { prefix: string; width: number; height: number; signal?: AbortSignal; lane?: WindowLane; transparent?: boolean; scale?: number }) => Promise<RenderWindow>;
  /** Tests: the memory reading of the windows' pids (default: the core's sampler with `app.getAppMetrics()`). */
  sample?: (pids: number[]) => ReturnType<typeof samplePidsMemory>;
}

/** Electron's working set of `pids` (bytes), from `app.getAppMetrics()`. */
function appMetricsBytes(): Map<number, number> {
  const m = new Map<number, number>();
  try {
    for (const p of app.getAppMetrics()) m.set(p.pid, (p.memory?.workingSetSize ?? 0) * 1024);
  } catch { /* not ready */ }
  return m;
}

/** The `ChromiumProvider` of kind `electron`: one provider per render, one fresh window per page (see the module comment). */
export class ElectronProvider implements ChromiumProvider {
  readonly kind = 'electron' as const;
  failure: RenderFailure | null = null;
  private readonly windows = new Set<RenderWindow>();
  private opening = 0;
  /** Fired by close(): ends a wait for an app-wide slot. */
  private readonly closeCtl = new AbortController();
  /** Windows being created: `close()` waits for them. */
  private readonly creating = new Set<Promise<unknown>>();
  private closing = false;
  private closed: Promise<void> | null = null;
  private origin: string | null = null;
  private watchdog: Watchdog | null = null;
  private pixels: { width: number; height: number } | null = null;
  private readonly maxWindows: number;

  constructor(private readonly o: ElectronProviderOptions) {
    this.maxWindows = Math.max(1, Math.min(16, Math.floor(o.maxWindows ?? DEFAULT_PARALLEL)));
  }

  /** The watchdog's peak memory (MB) so far. */
  get peakMemory() { return this.watchdog?.peak ?? null; }
  /** The render windows of this provider still open. */
  get openWindows(): number { return this.windows.size; }

  private fail(f: RenderFailure): void {
    if (this.failure || this.closing) return;
    this.failure = f;
    this.watchdog?.stop();
    for (const w of this.windows) void w.close();
  }

  private failureError(): RenderError | null {
    const f = this.failure as RenderFailure | null;
    return f ? new RenderError(f.code, f.message) : null;
  }

  private startWatchdog(): void {
    if (this.watchdog) return;
    const scaled = () => scaledMemoryLimits(this.pixels?.width ?? 1080, this.pixels?.height ?? 1920, Math.max(1, this.windows.size));
    const sample = this.o.sample ?? ((pids: number[]) => samplePidsMemory(pids, appMetricsBytes()));
    this.watchdog = startWatchdog({
      pgid: 0, // unused: the sampler reads the windows' pids
      sample: () => sample([...this.windows].flatMap((w) => w.pids())),
      limits: {
        ...this.o.limits,
        maxProcessMB: this.o.limits.maxProcessMB ?? (() => scaled().maxProcessMB),
        maxGroupMB: this.o.limits.maxGroupMB ?? (() => scaled().maxGroupMB),
      },
      onTrip: (trip) => this.fail(trip.reason === 'memory'
        ? { code: 'memoryLimit', message: `memory limit: ${trip.memoryMB} MB > ${trip.limitMB} MB` }
        : { code: 'timeLimit', message: `time limit: ${Math.round(trip.limitMs / 1000)} s` }),
    });
  }

  async open(o: OpenPageOptions): Promise<RenderPage> {
    if (this.closing) throw new RenderError('cancelled', 'the render windows are closed');
    if (o.signal.aborted) throw new RenderError('cancelled', 'cancelled');
    { const f = this.failureError(); if (f) throw f; }
    const prefix = allowedPrefix(o.url);
    const origin = new URL(o.url).origin;
    if (this.origin !== null && this.origin !== origin) throw new Error('render: one provider serves one composition server');
    if (this.windows.size + this.opening >= this.maxWindows) throw new RenderError('loadFailed', `render: at most ${this.maxWindows} render windows at once`);
    this.origin = origin;
    // A page rasterised at another scale (decision 974) holds that many more pixels: the memory limits follow them.
    this.pixels ??= pagePixels(o);
    this.opening++;
    let rw: RenderWindow;
    // The open's signal, or this provider closing: a wait for an app-wide slot never outlives close().
    const signal = AbortSignal.any([o.signal, this.closeCtl.signal]);
    const lane: WindowLane = o.purpose === 'frames' ? 'preview' : 'render';
    const scale = pageScale(o);
    const creating = (this.o.createWindow ?? createRenderWindow)({ prefix, width: o.width, height: o.height, signal, lane, ...(o.transparentBackground ? { transparent: true } : {}), ...(layersAtScale(scale) ? { scale } : {}) });
    this.creating.add(creating);
    try {
      rw = await creating;
    } finally {
      this.opening--;
      this.creating.delete(creating);
    }
    this.windows.add(rw);
    rw.win.once('closed', () => this.windows.delete(rw));
    if (this.closing || this.failure || o.signal.aborted) {
      await rw.close();
      throw this.failureError() ?? new RenderError('cancelled', 'cancelled');
    }
    this.startWatchdog();
    return this.drive(rw, o);
  }

  private async drive(rw: RenderWindow, o: OpenPageOptions): Promise<RenderPage> {
    const t = { callMs: 30_000, ...this.o.timeouts };
    const wc = rw.win.webContents;
    // Set once we close the window ourselves: its renderer going away then is no crash.
    let ending = false;
    const end = () => { ending = true; return rw.close(); };
    wc.on('render-process-gone', (_e, d) => {
      if (!ending) this.fail({ code: 'crashed', message: `a render window's renderer is gone (${d.reason}, ${d.exitCode})` });
    });
    const cdp = new DebuggerCdpClient(wc.debugger, t.callMs);
    const onAbort = () => { void end(); };
    o.signal.addEventListener('abort', onAbort, { once: true });
    try {
      cdp.attach();
      const { targetInfo } = await cdp.send<{ targetInfo: { targetId: string } }>('Target.getTargetInfo', {}, { timeoutMs: t.callMs });
      // A real flat session for the page: the interception matches every event by its session id.
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true }, { timeoutMs: t.callMs });
      const page = await openCdpRenderPage(cdp, {
        ...o, sessionId, ...(this.o.timeouts ? { timeouts: this.o.timeouts } : {}),
        closeTarget: async () => { ending = true; cdp.close(); await end(); },
        afterSecure: () => cdp.send('Inspector.enable', {}, { sessionId, timeoutMs: t.callMs }).then(() => {}, () => {}),
        onIsolationFailure: (e) => this.fail({ code: 'isolation', message: e.message }),
      });
      cdp.onEvent((e) => { if (e.method === 'Inspector.targetCrashed') this.fail({ code: 'crashed', message: 'a renderer crashed (inspector)' }); });
      const close = page.close;
      const captureRaw = () => guardedRawCapture(() => captureWindowFrame(rw.win, this.o.timeouts?.captureMs ?? CAPTURE_MS),
        () => (page.interception.failure ? new RenderError('isolation', page.interception.failure.message) : this.failureError()));
      // Report 56: the check runs in an isolated world of its own (its canvas and native frames out of the page's reach).
      const raw = await pageRawFrames(o, async () => {
        const { frameTree } = await cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, { sessionId, timeoutMs: t.callMs });
        const { executionContextId } = await cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'ms-raw-check' }, { sessionId, timeoutMs: t.callMs });
        const send = (params: Record<string, unknown>) => cdp.send('Runtime.evaluate', { ...params, contextId: executionContextId }, { sessionId, timeoutMs: t.callMs });
        return checkRawFrames(page, (expression) => evaluateValue(send, expression), captureRaw);
      });
      return { ...page, ...(raw ? { captureRaw } : {}), close: async () => { o.signal.removeEventListener('abort', onAbort); await close(); } };
    } catch (e) {
      o.signal.removeEventListener('abort', onAbort);
      ending = true;
      cdp.close();
      await end();
      { const f = this.failureError(); if (f) throw f; }
      if (o.signal.aborted) throw new RenderError('cancelled', 'cancelled');
      throw e instanceof CdpError && e.code === 'timeout' ? new RenderError('loadFailed', e.message) : e;
    }
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closing = true;
      this.closeCtl.abort(new RenderError('cancelled', 'the render windows are closed'));
      this.watchdog?.stop();
      this.closed = (async () => {
        // Windows still being created first: each joins `windows` as soon as it exists (and closes itself in `open`).
        await Promise.allSettled([...this.creating]);
        await Promise.all([...this.windows].map((w) => w.close()));
      })();
    }
    return this.closed;
  }
}

/** The desktop's provider factory: a fresh `ElectronProvider` per render. */
export function electronRenderProvider(o: Omit<ElectronProviderOptions, 'createWindow' | 'sample'>): ChromiumProviderFactory {
  // `kind`: the core's engine reports `electron` (System check), not `injected`.
  return Object.assign(async () => new ElectronProvider(o), { kind: 'electron' as const });
}

/** The pages (windows) of one desktop render: the core's default, until a user setting exists (Task 8). */
export const DESKTOP_RENDER_PARALLEL = DEFAULT_PARALLEL;

/**
 * What the desktop passes to `startServer`: the Electron provider (the default in the app) and the render settings. One
 * value drives both the render's `parallel` and the provider's window cap, so a render never asks for more windows than
 * the provider opens.
 */
export function desktopRenderOptions(runtimeDir: string, parallel = DESKTOP_RENDER_PARALLEL) {
  // A render's pages, plus the slot reserved for the preview lane.
  renderWindowSlots.setLimit(parallel + 1);
  return {
    renderProvider: electronRenderProvider({ maxWindows: parallel, limits: { timeLimitMs: 4 * 60 * 60 * 1000 } }),
    renderOptions: { distDir: runtimeDir, parallel },
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * What the app does on quit (`before-quit`), in this order:
 * 1. `closeServer` (the in-process core's `close()`): it cancels every job first; a cancelled render closes its windows,
 *    kills its ffmpeg and removes its temp output and work folder before it settles, and the core waits for the queue to
 *    be idle. Bounded by `serverMs`;
 * 2. every render window still open is closed (the backstop for a render that did not settle in time);
 * 3. a last short wait for the server, so a render that was cut off by step 2 can still remove its temp files.
 */
export async function shutdownForQuit(o: { closeServer: () => Promise<void>; serverMs?: number; windowsMs?: number; graceMs?: number }): Promise<void> {
  const server = o.closeServer().catch(() => {});
  await Promise.race([server, delay(o.serverMs ?? 10_000)]);
  await Promise.race([closeAllRenderWindows(), delay(o.windowsMs ?? 8_000)]);
  await Promise.race([server, delay(o.graceMs ?? 3_000)]);
}

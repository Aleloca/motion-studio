import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { makeOwnedTempDirSync } from './owner.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { CdpError, CdpPipe, waitForEvent, type CdpClient, type CdpEvent } from './cdp-pipe.ts';
import { allowedPrefix, BASE_FLAGS, interceptRequests, networkLockdownFlags, TargetGate, type Interception } from './isolation.ts';
import { nativeLauncher } from './arch.ts';
import { RenderError, type RenderFailure } from './errors.ts';

export { RenderError, type RenderErrorCode, type RenderFailure, type RenderFailureCode } from './errors.ts';
export { nativeLauncher } from './arch.ts';
import { killGroup, killGroupIfMarked, scaledMemoryLimits, startWatchdog, sweepByMarker, trackGroup, waitGroupGone, type Watchdog, type WatchdogLimits } from './watchdog.ts';

/**
 * Where the render browser comes from (spec §5.3) and the page it drives.
 *
 * **Provider injection (Task 7).** The core never decides alone which Chromium renders. A `ChromiumProviderFactory` is
 * injected (`startServer({ renderProvider })`, `createRenderEngine({ provider })`, or straight into
 * `renderComposition({ provider })`); without one the core falls back to system Chrome, then an installed Chrome for
 * Testing. The desktop app injects its Electron provider (kind `electron`), which drives a hidden offscreen window through
 * `webContents.debugger`: it wraps that debugger as a `CdpClient` and calls `openCdpRenderPage`, so the page logic, the
 * request interception and the timeouts are the same code as for Chrome. A provider instance serves ONE render:
 * `renderComposition` always calls `close()` at the end, on success or failure.
 *
 * The Electron provider (apps/desktop/src/render-window.ts, Task 7) does this:
 * - **A real flat session id.** `webContents.debugger` reports its own target's events with an empty session id, and the
 *   interception matches every event by session. Attach to the page target with
 *   `Target.attachToTarget({ targetId, flatten: true })` (target id from `Target.getTargets`) and pass THAT session id to
 *   `openCdpRenderPage`; send every page command on it.
 * - **Layer 3 per session, never app-wide.** No command-line proxy or resolver switches (they would cut the UI off too):
 *   give the render window its own non-persistent partition and call `session.setProxy({ proxyRules: 'http://127.0.0.1:9',
 *   proxyBypassRules: '<-loopback>;127.0.0.1:<port>' })` on it, plus `session.webRequest` allowing only the composition
 *   server (it also sees WebSockets, which CDP Fetch does not), and the WebRTC policy `disable_non_proxied_udp`.
 * - **Workers and popups.** CDP has no browser-level `TargetGate` there: deny `setWindowOpenHandler`, and let
 *   `session.webRequest` refuse every service or shared worker script (they are not composition files).
 * - **Processes.** No process group: every window is closed on cancel, failure, close and app quit, and the watchdog
 *   samples the windows' renderer pids (`samplePidsMemory`, with `app.getAppMetrics()` as another reading).
 */

export interface RuntimeErrorInfo { code: string; message: string; clipId?: string }
/** What `window.__ms.ready()` resolves to (composition-runtime README §2). */
export interface ReadyInfo { duration: number; fps: number; width: number; height: number; frames: number; errors: RuntimeErrorInfo[] }

export type CaptureFormat = 'jpeg' | 'png' | 'webp';

export interface RenderPage {
  /** From `__ms.ready()`. */
  readonly info: ReadyInfo;
  /** Shows composition time `t`; rejects when the runtime cannot (e.g. `frameTimeout`) or the call times out. */
  seek(t: number): Promise<void>;
  /**
   * The viewport as an image. `scale` (0 < scale ≤ 1, default 1) shrinks it in the browser (`clip.scale`): the image is
   * about `width × scale` by `height × scale` (storyboards and agent previews, Task 5b).
   */
  capture(format: CaptureFormat, quality?: number, scale?: number): Promise<Buffer>;
  /**
   * The viewport as raw pixels, without encoding them (report 53): offered only by a provider that can read them cheaply at
   * the page's own size (the desktop's render windows, where an encode runs on the app's UI thread). A render's video frames
   * then go to ffmpeg as they are; stills and storyboards still use `capture`.
   */
  captureRaw?(): Promise<RawFrame>;
  /**
   * Decision 1752: whether a canvas of the page lost its GPU context (`__ms.canvasLosses` changed) since the last seek
   * began (decision 1755: a loss during the seek counts too, e.g. a layer's canvas lost after the layer's own seek ended),
   * so that what was captured since may show a box black. The capture helpers then seek and capture again.
   */
  canvasLost?(): Promise<boolean>;
  /** The page's `__ms.canvasLosses` as `canvasLost()` last read it, or null (diagnostics and tests; no CDP call). */
  canvasLossesSeen?(): number | null;
  /** Every runtime error so far (`__ms.errors`). */
  errors(): Promise<RuntimeErrorInfo[]>;
  close(): Promise<void>;
}

/** An opaque frame as 32-bit BGRA pixels (8 bits each, row after row, no padding): `width × height × 4` bytes. */
export interface RawFrame { data: Buffer; width: number; height: number }

export interface OpenPageOptions {
  width: number;
  height: number;
  /** The render page URL minted by the composition server (`…/<token>/runtime/index.html?mode=render`). */
  url: string;
  signal: AbortSignal;
  /** The runtime's `clock.js`, added to every new document of every frame (belt and braces; README "Clock bypasses"). */
  clockSource?: string;
  /**
   * What the page is for: a render's segment, or a few frames (storyboards, the agent's `preview_frames`). A provider with
   * a shared window budget (the desktop's) keeps a slot for `frames`, so they never wait behind a render.
   */
  purpose?: 'render' | 'frames';
  /**
   * Report 56: the caller reads raw frames (`RenderPage.captureRaw`) when the page offers them: a video render. A provider
   * that checks raw frames before offering them (the desktop's) skips the check for any other page (a still, frames).
   */
  rawFrames?: boolean;
  /**
   * The page's default background is fully transparent instead of white (Phase 14: the identity sets' PNGs keep their
   * alpha), with `Emulation.setDefaultBackgroundColorOverride`. A PNG capture then has the alpha the composition leaves.
   */
  transparentBackground?: boolean;
  /**
   * The page is rasterised at this scale (decision 974: a render at another resolution): the layout stays at `width` x
   * `height` CSS pixels, a capture is about `width × scale` by `height × scale`, sharp. Default 1. A provider also gives the
   * scale to the out-of-process html layers, which the page's override does not reach (report 51): Chrome is launched at it
   * (`scaleFlags`), the desktop's render window renders offscreen at it.
   */
  deviceScaleFactor?: number;
}

/** A page's raster scale: `deviceScaleFactor` when it is a finite positive number, else 1. */
export function pageScale(o: Pick<OpenPageOptions, 'deviceScaleFactor'>): number {
  return o.deviceScaleFactor !== undefined && Number.isFinite(o.deviceScaleFactor) && o.deviceScaleFactor > 0 ? o.deviceScaleFactor : 1;
}

/** The physical pixels of a page (its CSS size at its raster scale): what its memory follows. */
export function pagePixels(o: Pick<OpenPageOptions, 'width' | 'height' | 'deviceScaleFactor'>): { width: number; height: number } {
  const k = pageScale(o);
  return { width: Math.round(o.width * k), height: Math.round(o.height * k) };
}

/**
 * Whether the html layers get the page's raster scale (report 51, decisions 1340, 1346): only above 1. Below 1 (a 720p
 * export of a 1080p composition) they keep drawing at 1x and the page shrinks them, as before.
 */
export function layersAtScale(scale: number): boolean {
  return Number.isFinite(scale) && scale > 1;
}

/**
 * The launch flag of a browser whose pages are rasterised at `scale` (report 51, decision 1340): the html layers are
 * sandboxed iframes in their own processes, and `Emulation.setDeviceMetricsOverride` reaches the top-level page only (the
 * iframe's own session refuses it: "only top-level targets"), so at another scale the layer drew at 1x and the page
 * stretched it. `--force-device-scale-factor` is the screen's scale, which every frame of every process gets. Only above 1
 * (`layersAtScale`).
 */
export function scaleFlags(scale: number): string[] {
  return layersAtScale(scale) ? [`--force-device-scale-factor=${scale}`] : [];
}

export interface ChromiumProvider {
  readonly kind: 'electron' | 'system' | 'cft';
  open(o: OpenPageOptions): Promise<RenderPage>;
  /** Set once the browser failed on its own (watchdog, crash, an isolation failure): the render reports this reason. */
  readonly failure?: RenderFailure | null;
  /** Ends every page and the browser, leaving no process behind. Idempotent. */
  close(): Promise<void>;
}

/**
 * Makes a provider for one render. `kind`, when set, is what the engine reports for an injected factory (the desktop's
 * Electron provider says `electron`); without it the engine reports `injected`.
 */
export type ChromiumProviderFactory = (() => Promise<ChromiumProvider>) & { readonly kind?: ChromiumProvider['kind'] };

export interface PageTimeouts {
  /** Navigation until `load`. Default 180 s (the machine may be very busy). */
  loadMs?: number;
  /** `__ms.ready()`. Default 180 s (the runtime's own load limit is 120 s). */
  readyMs?: number;
  /** One `__ms.seek(t)`, page side and CDP side. Default 90 s (the runtime's video and layer limits are 60 s). */
  frameMs?: number;
  /** One screenshot. Default 90 s. */
  captureMs?: number;
  /** Any other CDP call. Default 30 s. */
  callMs?: number;
}

const DEFAULT_TIMEOUTS: Required<PageTimeouts> = { loadMs: 180_000, readyMs: 180_000, frameMs: 90_000, captureMs: 90_000, callMs: 30_000 };

interface EvalResult { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }

/**
 * The page side of `RenderPage.seek(t)`: `__ms.seek(t)`, resolving to `__ms.canvasLosses` as it was *before* the seek
 * (decision 1755), so that `canvasLost()` sees any loss from the seek's start to the capture's end.
 */
export function seekExpression(t: number): string {
  return `(() => { const before = window.__ms.canvasLosses; return window.__ms.seek(${JSON.stringify(t)}).then(() => before); })()`;
}

/** Evaluates `expression` (awaiting a promise) with a page-side timeout and a slightly longer CDP-side one. */
export async function evaluate(client: CdpClient, sessionId: string | undefined, expression: string, timeoutMs: number): Promise<unknown> {
  const r = await client.send<EvalResult>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs }, { sessionId, timeoutMs: timeoutMs + 5_000 });
  if (r.exceptionDetails) {
    const text = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'exception';
    // A seek the runtime failed fast on a video frame (`videoSeekTimeout`) is a runtime error of the composition.
    if (/videoSeekTimeout/.test(text)) throw new RenderError('runtimeErrors', `the composition has errors: videoSeekTimeout`, [{ code: 'videoSeekTimeout', message: text.slice(0, 500) }]);
    throw new RenderError(/frameTimeout/.test(text) ? 'frameTimeout' : 'loadFailed', `page: ${text.slice(0, 500)}`);
  }
  return r.result?.value;
}

function readyInfo(v: unknown): ReadyInfo | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? o[k] as number : null);
  const duration = num('duration'), fps = num('fps'), width = num('width'), height = num('height'), frames = num('frames');
  if (duration === null || fps === null || width === null || height === null || frames === null || !Array.isArray(o.errors)) return null;
  const errors = (o.errors as unknown[]).slice(0, 100).flatMap((e) => {
    if (typeof e !== 'object' || e === null) return [];
    const x = e as Record<string, unknown>;
    return typeof x.code === 'string' ? [{ code: x.code.slice(0, 64), message: String(x.message ?? '').slice(0, 500), ...(typeof x.clipId === 'string' ? { clipId: x.clipId.slice(0, 64) } : {}) }] : [];
  });
  return { duration, fps, width, height, frames, errors };
}

/**
 * Opens the render page on a fresh, paused `about:blank` target session of any CDP transport (Chrome pipe or Electron's
 * `webContents.debugger`; `sessionId` must be a real flat session id, see the module comment): request interception on it and every child (isolation.ts), viewport, navigation, then
 * `__ms.ready()`. `resume` resumes the target first (a fresh about:blank auto-attached with
 * `waitForDebuggerOnStart`: nothing loads before `Page.navigate`). `closeTarget` ends it.
 */
export async function openCdpRenderPage(client: CdpClient, o: OpenPageOptions & {
  sessionId: string; timeouts?: PageTimeouts; resume?: () => Promise<void>; closeTarget: () => Promise<void>;
  /** Called once the page is intercepted and running, before navigation (e.g. `Inspector.enable` for crash events). */
  afterSecure?: () => Promise<void>;
  onIsolationFailure?: (e: Error) => void;
}): Promise<RenderPage & { interception: Interception }> {
  const t = { ...DEFAULT_TIMEOUTS, ...o.timeouts };
  const sid = o.sessionId;
  const prefix = allowedPrefix(o.url);
  const interception = await interceptRequests(client, sid, prefix, { clockSource: o.clockSource, timeoutMs: t.callMs, onFailure: o.onIsolationFailure, resume: o.resume });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    interception.dispose();
    await o.closeTarget().catch(() => {});
  };
  try {
    await o.afterSecure?.();
    const dsf = pageScale(o);
    await client.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: dsf, mobile: false }, { sessionId: sid, timeoutMs: t.callMs });
    if (o.transparentBackground) await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, { sessionId: sid, timeoutMs: t.callMs });
    const loaded = waitForEvent(client, 'Page.loadEventFired', { sessionId: sid, timeoutMs: t.loadMs, signal: o.signal });
    loaded.catch(() => {});
    const nav = await client.send<{ errorText?: string }>('Page.navigate', { url: o.url }, { sessionId: sid, timeoutMs: t.loadMs });
    if (nav.errorText) throw new RenderError('loadFailed', `navigation failed: ${nav.errorText}`);
    await loaded;
    if (interception.failure) throw new RenderError('isolation', interception.failure.message);
    const info = readyInfo(await evaluate(client, sid, 'window.__ms.ready()', t.readyMs));
    if (!info) throw new RenderError('loadFailed', 'the runtime did not report ready');
    if (info.width !== o.width || info.height !== o.height) {
      throw new RenderError('compositionMismatch', `the composition is ${info.width}×${info.height}, the page ${o.width}×${o.height}`);
    }
    /** `__ms.canvasLosses` when the last seek began (null: a runtime without it). */
    let lossesAtSeek: number | null = null;
    let lastLosses: number | null = null;
    const losses = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      info, interception,
      async seek(time: number) {
        if (!Number.isFinite(time)) throw new RenderError('badFrame', 'bad time');
        if (interception.failure) throw new RenderError('isolation', interception.failure.message);
        lossesAtSeek = losses(await evaluate(client, sid, seekExpression(time), t.frameMs));
      },
      async canvasLost() {
        if (lossesAtSeek === null) return false;
        lastLosses = losses(await evaluate(client, sid, 'window.__ms.canvasLosses', t.callMs));
        return lastLosses !== lossesAtSeek;
      },
      canvasLossesSeen: () => lastLosses,
      async capture(format: CaptureFormat, quality?: number, scale?: number) {
        if (interception.failure) throw new RenderError('isolation', interception.failure.message);
        const scaled = scale !== undefined && Number.isFinite(scale) && scale > 0 && scale < 1;
        const r = await client.send<{ data?: string }>('Page.captureScreenshot', {
          format, ...(format !== 'png' && quality !== undefined ? { quality } : {}), optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false,
          ...(scaled ? { clip: { x: 0, y: 0, width: o.width, height: o.height, scale } } : {}),
        }, { sessionId: sid, timeoutMs: t.captureMs });
        if (typeof r.data !== 'string') throw new RenderError('badFrame', 'empty screenshot');
        return Buffer.from(r.data, 'base64');
      },
      async errors() {
        const v = await evaluate(client, sid, 'JSON.parse(JSON.stringify(window.__ms.errors || []))', t.callMs);
        return readyInfo({ duration: 0, fps: 0, width: 0, height: 0, frames: 0, errors: Array.isArray(v) ? v : [] })!.errors;
      },
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

export interface ChromeProviderOptions {
  exe: string;
  kind: 'system' | 'cft';
  /** Watchdog limits; `timeLimitMs` is the whole render's. */
  limits: WatchdogLimits;
  timeouts?: PageTimeouts;
  /** V8 heap limit per renderer, MB. Default 512. */
  heapMB?: number;
  /** Extra flags, from `ALLOWED_EXTRA_FLAG_RE` only (GPU and logging): the network lockdown and the sandbox cannot be touched. */
  extraFlags?: string[];
  /** Where the temporary profile goes; default the OS temp folder. */
  tempDir?: string;
}

interface Launched {
  proc: ChildProcess;
  cdp: CdpPipe;
  profile: string;
  origin: string;
  watchdog: Watchdog;
  untrack: () => void;
  exited: Promise<void>;
  /** When Chromium was started (ms): the marker sweep takes only orphans started since (final wave B5). */
  launchedAt: number;
}

/**
 * The only extra flags a caller may add (rendering and diagnostics). An allowlist: Chromium also accepts single-dash and
 * many network or sandbox switches a denylist would miss (`-no-sandbox`, `--no-proxy-server`, `--proxy-pac-url`, …).
 */
export const ALLOWED_EXTRA_FLAG_RE = /^--(?:disable-gpu|enable-gpu|use-angle=(?:default|metal|swiftshader|gl|vulkan)|use-gl=(?:angle|swiftshader|egl)|enable-logging(?:=stderr)?|v=[0-3]|force-color-profile=srgb|disable-lcd-text)$/;

/**
 * System Chrome (`--headless=new`) or chrome-headless-shell (Chrome for Testing, headless by itself). One browser per
 * render, launched on the first `open` with the network locked to that page's composition server:
 * - its own process group (`detached`), registered for the exit hook; killed as a group and swept by profile path on
 *   `close()`, on a watchdog trip and after a crash; `close()` resolves once the whole group is gone (bounded, 5 s);
 * - a temporary `--user-data-dir` under the OS temp folder, removed on close;
 * - CDP over the pipe only; every new page target is auto-attached paused, and anything that is not one of our pages
 *   (a popup) is closed before it runs.
 */
export class ChromeProvider implements ChromiumProvider {
  readonly kind: 'system' | 'cft';
  failure: RenderFailure | null = null;
  /**
   * Set by `close()` when the browser's process group still had a member after the bounded wait (diagnostics; the render's
   * outcome does not change: every member was already sent SIGKILL).
   */
  closeLeftover: { pgid: number; waitedMs: number } | null = null;
  private launched: Launched | null = null;
  private launching: Promise<Launched> | null = null;
  private closing = false;
  private closed: Promise<void> | null = null;
  private gate: TargetGate | null = null;
  private openPages = 0;
  private pixels: { width: number; height: number } | null = null;
  /** The raster scale the browser was launched with (its first page's). */
  private scale = 1;
  private readonly stderrTail: string[] = [];

  constructor(private readonly o: ChromeProviderOptions) {
    this.kind = o.kind;
    for (const f of o.extraFlags ?? []) if (!ALLOWED_EXTRA_FLAG_RE.test(f)) throw new Error(`render: flag not allowed: ${f}`);
  }

  /** The browser's process group id, once launched (tests check it with `ps`). */
  get pgid(): number | null { return this.launched?.proc.pid ?? null; }
  /** The temporary profile folder, once launched. */
  get profileDir(): string | null { return this.launched?.profile ?? null; }
  /** The watchdog's peak memory (MB). */
  get peakMemory() { return this.launched?.watchdog.peak ?? null; }
  /** The last lines Chrome wrote to stderr (diagnostics). */
  get stderr(): string { return this.stderrTail.join(''); }

  /** The failure as an error, when the browser failed. */
  private failureError(): RenderError | null {
    const f = this.failure as RenderFailure | null;
    return f ? new RenderError(f.code, f.message) : null;
  }

  private fail(f: RenderFailure): void {
    if (this.failure || this.closing) return;
    this.failure = f;
    if (this.launched) {
      this.killBrowser(this.launched);
      this.launched.cdp.close(new CdpError(f.message, 'closed'));
    }
  }

  /** Kills the browser's group: directly while its leader runs, else only if `ps` shows our profile in it (pid reuse). */
  private killBrowser(l: Launched): Promise<unknown> {
    const alive = l.proc.exitCode === null && l.proc.signalCode === null;
    if (alive) { killGroup(l.proc.pid!); return Promise.resolve(); }
    return killGroupIfMarked(l.proc.pid!, l.profile).catch(() => false);
  }

  private async launch(origin: string, scale: number): Promise<Launched> {
    const profile = makeOwnedTempDirSync(join(this.o.tempDir ?? tmpdir(), 'ms-render-chrome-'));
    const args = [
      ...BASE_FLAGS, ...networkLockdownFlags(origin),
      `--user-data-dir=${profile}`, '--remote-debugging-pipe', `--js-flags=--max-old-space-size=${this.o.heapMB ?? 512}`,
      ...(this.o.kind === 'system' ? ['--headless=new'] : []),
      ...(process.platform === 'linux' ? ['--disable-dev-shm-usage'] : []),
      ...scaleFlags(scale),
      ...(this.o.extraFlags ?? []),
      'about:blank',
    ];
    let proc: ChildProcess;
    const launchedAt = Date.now();
    try {
      // On Apple Silicon a universal Chrome started by a process that runs under Rosetta (a terminal, an x64 Node) gets its
      // x86_64 slice ("neither tested nor maintained", and it crashed renderers here): ask for the native one. `arch` execs
      // Chrome in place, so the pid and process group stay the same.
      const native = await nativeLauncher(this.o.exe);
      proc = spawn(native ? '/usr/bin/arch' : this.o.exe, native ? ['-arm64', this.o.exe, ...args] : args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      rmSync(profile, { recursive: true, force: true });
      throw new RenderError('noBrowser', `could not start Chromium: ${(e as Error).message}`);
    }
    const untrack = proc.pid ? trackGroup(proc.pid) : () => {};
    proc.stderr!.on('data', (d: Buffer) => {
      this.stderrTail.push(d.toString('utf8'));
      while (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    const exited = new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) resolve();
      else proc.once('exit', () => resolve());
    });
    proc.once('error', () => { /* reported through the pipe closing */ });
    const cdp = new CdpPipe(proc.stdio[3] as Writable, proc.stdio[4] as Readable, { defaultTimeoutMs: this.o.timeouts?.callMs ?? DEFAULT_TIMEOUTS.callMs });
    void exited.then(() => {
      untrack(); // the leader is gone: never kill this group id blindly again
      cdp.close(new CdpError('the browser exited', 'closed'));
      if (!this.closing) this.fail({ code: 'crashed', message: 'the browser exited during the render' });
    });
    // Unless given, the memory limits follow the page size and the pages open (scaledMemoryLimits).
    const scaled = () => scaledMemoryLimits(this.pixels?.width ?? 1080, this.pixels?.height ?? 1920, this.openPages);
    const watchdog = startWatchdog({
      pgid: proc.pid!,
      limits: {
        ...this.o.limits,
        maxProcessMB: this.o.limits.maxProcessMB ?? (() => scaled().maxProcessMB),
        maxGroupMB: this.o.limits.maxGroupMB ?? (() => scaled().maxGroupMB),
      },
      onTrip: (trip) => this.fail(trip.reason === 'memory'
        ? { code: 'memoryLimit', message: `memory limit: ${trip.memoryMB} MB > ${trip.limitMB} MB` }
        : { code: 'timeLimit', message: `time limit: ${Math.round(trip.limitMs / 1000)} s` }),
    });
    const l: Launched = { proc, cdp, profile, origin, watchdog, untrack, exited, launchedAt };
    this.launched = l;
    try {
      if (!proc.pid) throw new RenderError('noBrowser', 'could not start Chromium');
      await cdp.send('Browser.getVersion', {}, { timeoutMs: this.o.timeouts?.loadMs ?? DEFAULT_TIMEOUTS.loadMs });
      cdp.onEvent((e) => this.onBrowserEvent(e));
      this.gate = new TargetGate(cdp, this.o.timeouts?.callMs ?? DEFAULT_TIMEOUTS.callMs, (e) => this.fail({ code: 'isolation', message: e.message }));
      await this.gate.start();
    } catch (e) {
      await this.close();
      throw e instanceof RenderError ? e : new RenderError('noBrowser', `Chromium did not start: ${(e as Error).message}. ${this.stderr.slice(-500)}`);
    }
    return l;
  }

  private onBrowserEvent(e: CdpEvent): void {
    if (e.sessionId !== undefined) {
      if (e.method === 'Inspector.targetCrashed') this.fail({ code: 'crashed', message: 'a renderer crashed (inspector)' });
      return;
    }
    if (e.method === 'Target.targetCrashed') {
      this.fail({ code: 'crashed', message: `a renderer crashed (${String(e.params.status ?? '')} ${String(e.params.errorCode ?? '')})` });
      return;
    }
  }

  async open(o: OpenPageOptions): Promise<RenderPage> {
    if (this.closing) throw new RenderError('cancelled', 'the browser is closed');
    if (o.signal.aborted) throw new RenderError('cancelled', 'cancelled');
    const origin = new URL(o.url).origin;
    // A page rasterised at another scale (decision 974, review #8) holds that many more pixels: the memory limits follow them.
    this.pixels ??= pagePixels(o);
    this.openPages++; // counted from the start: a page loading already uses memory
    try {
      return await this.openCounted(o, origin);
    } catch (e) {
      this.openPages--;
      throw e;
    }
  }

  private async openCounted(o: OpenPageOptions, origin: string): Promise<RenderPage> {
    // The browser's scale is its first page's (report 51): every page of a render has the same one.
    if (!this.launching) { this.scale = pageScale(o); this.launching = this.launch(origin, this.scale); }
    const l = await this.launching;
    if (l.origin !== origin) throw new Error('render: one provider serves one composition server');
    if (pageScale(o) !== this.scale) throw new Error('render: one provider serves one scale');
    { const f = this.failureError(); if (f) throw f; }
    const t = { ...DEFAULT_TIMEOUTS, ...this.o.timeouts };
    let created: { targetId: string; sessionId: string; release: () => void };
    try {
      created = await this.gate!.createPage();
    } catch (e) {
      throw this.failureError() ?? e;
    }
    const { targetId, sessionId, release } = created;
    const onAbort = () => { void l.cdp.send('Target.closeTarget', { targetId }).catch(() => {}); };
    o.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const page = await openCdpRenderPage(l.cdp, {
        ...o, sessionId, timeouts: this.o.timeouts,
        resume: () => l.cdp.send('Runtime.runIfWaitingForDebugger', {}, { sessionId, timeoutMs: t.callMs }).then(() => {}),
        closeTarget: () => l.cdp.send('Target.closeTarget', { targetId }, { timeoutMs: t.callMs }).then(() => {}),
        afterSecure: () => { release(); return l.cdp.send('Inspector.enable', {}, { sessionId, timeoutMs: t.callMs }).then(() => {}, () => {}); },
        onIsolationFailure: (e) => this.fail({ code: 'isolation', message: e.message }),
      });
      const close = page.close;
      let counted = true;
      return { ...page, close: async () => { if (counted) { counted = false; this.openPages--; } o.signal.removeEventListener('abort', onAbort); await close(); } };
    } catch (e) {
      release();
      o.signal.removeEventListener('abort', onAbort);
      { const f = this.failureError(); if (f) throw f; }
      if (o.signal.aborted) throw new RenderError('cancelled', 'cancelled');
      throw e instanceof CdpError && e.code === 'timeout' ? new RenderError('loadFailed', e.message) : e;
    }
  }

  close(): Promise<void> {
    if (!this.closed) { this.closing = true; this.closed = this.shutdown(); }
    return this.closed;
  }

  private async shutdown(): Promise<void> {
    const l = this.launched ?? (this.launching ? await this.launching.catch(() => null) : null);
    if (!l) return;
    l.watchdog.stop();
    if (!l.cdp.closed) await l.cdp.send('Browser.close', {}, { timeoutMs: 5_000 }).catch(() => {});
    await this.killBrowser(l);
    await Promise.race([l.exited, new Promise((r) => setTimeout(r, 10_000))]);
    await this.killBrowser(l); // helpers still in the group (checked by marker: the leader is reaped by now)
    await sweepByMarker(l.profile, { rootPid: l.proc.pid!, since: l.launchedAt }).catch(() => 0);
    // The whole group, not only the leader (CI hotfix, decisions log 789): a helper still exiting (or a zombie not yet reaped
    // by init, a subreaper or Chromium's PID-namespace init) keeps the group present. Wait for it, bounded; once at 2.5 s, the
    // same guarded kill as above (a dead leader: only while ps shows our profile in the group). Never throws.
    const t0 = Date.now();
    if (!(await waitGroupGone(l.proc.pid!, { kill: () => this.killBrowser(l) }))) {
      this.closeLeftover = { pgid: l.proc.pid!, waitedMs: Date.now() - t0 };
      const note = `render: process group ${l.proc.pid} still present ${this.closeLeftover.waitedMs} ms after close\n`;
      this.stderrTail.push(note);
      if (process.env.MS_RENDER_DEBUG) console.warn(note.trim());
    }
    l.cdp.close();
    l.untrack();
    rmSync(l.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

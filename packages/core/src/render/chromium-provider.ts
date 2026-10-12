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
import { killGroup, killGroupIfMarked, scaledMemoryLimits, startWatchdog, sweepByMarker, trackGroup, type Watchdog, type WatchdogLimits } from './watchdog.ts';

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
 * What Task 7 must do (Electron):
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
  /** Every runtime error so far (`__ms.errors`). */
  errors(): Promise<RuntimeErrorInfo[]>;
  close(): Promise<void>;
}

export interface OpenPageOptions {
  width: number;
  height: number;
  /** The render page URL minted by the composition server (`…/<token>/runtime/index.html?mode=render`). */
  url: string;
  signal: AbortSignal;
  /** The runtime's `clock.js`, added to every new document of every frame (belt and braces; README "Clock bypasses"). */
  clockSource?: string;
}

export interface ChromiumProvider {
  readonly kind: 'electron' | 'system' | 'cft';
  open(o: OpenPageOptions): Promise<RenderPage>;
  /** Set once the browser failed on its own (watchdog, crash, an isolation failure): the render reports this reason. */
  readonly failure?: RenderFailure | null;
  /** Ends every page and the browser, leaving no process behind. Idempotent. */
  close(): Promise<void>;
}

/** Makes a provider for one render. */
export type ChromiumProviderFactory = () => Promise<ChromiumProvider>;

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
    await client.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: 1, mobile: false }, { sessionId: sid, timeoutMs: t.callMs });
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
    return {
      info, interception,
      async seek(time: number) {
        if (!Number.isFinite(time)) throw new RenderError('badFrame', 'bad time');
        if (interception.failure) throw new RenderError('isolation', interception.failure.message);
        await evaluate(client, sid, `window.__ms.seek(${JSON.stringify(time)}).then(() => true)`, t.frameMs);
      },
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
 *   `close()`, on a watchdog trip and after a crash;
 * - a temporary `--user-data-dir` under the OS temp folder, removed on close;
 * - CDP over the pipe only; every new page target is auto-attached paused, and anything that is not one of our pages
 *   (a popup) is closed before it runs.
 */
export class ChromeProvider implements ChromiumProvider {
  readonly kind: 'system' | 'cft';
  failure: RenderFailure | null = null;
  private launched: Launched | null = null;
  private launching: Promise<Launched> | null = null;
  private closing = false;
  private closed: Promise<void> | null = null;
  private gate: TargetGate | null = null;
  private openPages = 0;
  private pixels: { width: number; height: number } | null = null;
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

  private async launch(origin: string): Promise<Launched> {
    const profile = makeOwnedTempDirSync(join(this.o.tempDir ?? tmpdir(), 'ms-render-chrome-'));
    const args = [
      ...BASE_FLAGS, ...networkLockdownFlags(origin),
      `--user-data-dir=${profile}`, '--remote-debugging-pipe', `--js-flags=--max-old-space-size=${this.o.heapMB ?? 512}`,
      ...(this.o.kind === 'system' ? ['--headless=new'] : []),
      ...(process.platform === 'linux' ? ['--disable-dev-shm-usage'] : []),
      ...(this.o.extraFlags ?? []),
      'about:blank',
    ];
    let proc: ChildProcess;
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
    const l: Launched = { proc, cdp, profile, origin, watchdog, untrack, exited };
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
    this.pixels ??= { width: o.width, height: o.height };
    this.openPages++; // counted from the start: a page loading already uses memory
    try {
      return await this.openCounted(o, origin);
    } catch (e) {
      this.openPages--;
      throw e;
    }
  }

  private async openCounted(o: OpenPageOptions, origin: string): Promise<RenderPage> {
    if (!this.launching) this.launching = this.launch(origin);
    const l = await this.launching;
    if (l.origin !== origin) throw new Error('render: one provider serves one composition server');
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
    await sweepByMarker(l.profile).catch(() => 0);
    l.cdp.close();
    l.untrack();
    rmSync(l.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { CdpError, CdpPipe, waitForEvent, type CdpClient, type CdpEvent } from './cdp-pipe.ts';
import { allowedPrefix, BASE_FLAGS, interceptRequests, networkLockdownFlags, type Interception } from './isolation.ts';
import { binaryArch, hostArch } from './encode.ts';
import { killGroup, startWatchdog, sweepByMarker, trackGroup, type Watchdog, type WatchdogLimits } from './watchdog.ts';

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
  /** The viewport as an image. */
  capture(format: CaptureFormat, quality?: number): Promise<Buffer>;
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

export type RenderFailureCode = 'memoryLimit' | 'timeLimit' | 'crashed' | 'isolation';
export interface RenderFailure { code: RenderFailureCode; message: string }

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

export type RenderErrorCode =
  | 'cancelled' | 'noBrowser' | 'noFfmpeg' | 'loadFailed' | 'runtimeErrors' | 'frameTimeout' | 'badFrame' | 'ffmpegFailed'
  | 'unsupportedOutput' | 'compositionMismatch' | RenderFailureCode;

export class RenderError extends Error {
  constructor(readonly code: RenderErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'RenderError';
  }
}

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
 * `webContents.debugger`): request interception on it and every child (isolation.ts), viewport, navigation, then
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
      async capture(format: CaptureFormat, quality?: number) {
        if (interception.failure) throw new RenderError('isolation', interception.failure.message);
        const r = await client.send<{ data?: string }>('Page.captureScreenshot', {
          format, ...(format !== 'png' && quality !== undefined ? { quality } : {}), optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false,
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
  /** Extra flags (tests only). The network lockdown and the sandbox cannot be turned off. */
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

/** Whether `exe` must be started through `arch -arm64` (macOS on Apple Silicon, an arm64 or universal binary). */
export async function nativeLauncher(exe: string): Promise<boolean> {
  if (process.platform !== 'darwin' || (await hostArch()) !== 'arm64') return false;
  const a = await binaryArch(exe);
  return (a === 'universal' || a === 'arm64') && existsSync('/usr/bin/arch');
}

const FORBIDDEN_FLAG_RE = /^--(no-sandbox|disable-setuid-sandbox|remote-debugging-port|proxy-server|proxy-bypass-list|host-resolver-rules|user-data-dir|disable-web-security|single-process|no-zygote)/;

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
  private ownTargets = new Set<string>();
  private pending = new Map<string, (sessionId: string) => void>();
  private unclaimed = new Map<string, string>();
  private creating = 0;
  private creationChain: Promise<void> = Promise.resolve();
  private readonly stderrTail: string[] = [];

  constructor(private readonly o: ChromeProviderOptions) {
    this.kind = o.kind;
    for (const f of o.extraFlags ?? []) if (FORBIDDEN_FLAG_RE.test(f)) throw new Error(`render: flag not allowed: ${f}`);
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
      killGroup(this.launched.proc.pid!);
      this.launched.cdp.close(new CdpError(f.message, 'closed'));
    }
  }

  private async launch(origin: string): Promise<Launched> {
    const profile = mkdtempSync(join(this.o.tempDir ?? tmpdir(), 'ms-render-chrome-'));
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
      cdp.close(new CdpError('the browser exited', 'closed'));
      if (!this.closing) this.fail({ code: 'crashed', message: 'the browser exited during the render' });
    });
    const watchdog = startWatchdog({
      pgid: proc.pid!, limits: this.o.limits,
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
      const callMs = this.o.timeouts?.callMs ?? DEFAULT_TIMEOUTS.callMs;
      await cdp.send('Target.setDiscoverTargets', { discover: true }, { timeoutMs: callMs });
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, { timeoutMs: callMs });
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
    if (e.method === 'Target.attachedToTarget') {
      const info = e.params.targetInfo as { targetId?: string; type?: string } | undefined;
      const sid = e.params.sessionId as string;
      const id = info?.targetId ?? '';
      const waiter = this.pending.get(id);
      if (waiter) { this.pending.delete(id); waiter(sid); return; }
      if (this.ownTargets.has(id)) return;
      // Not ours (a popup, a target opened by the page): it stays paused and is closed, so it never runs. While one of
      // our pages is being created, it may be that page whose createTarget has not answered yet: hold it briefly.
      const closeIt = () => { void this.launched?.cdp.send('Target.closeTarget', { targetId: id }).catch(() => {}); };
      if (this.creating > 0) {
        this.unclaimed.set(id, sid);
        setTimeout(() => { if (this.unclaimed.delete(id)) closeIt(); }, 30_000).unref();
      } else closeIt();
    }
  }

  async open(o: OpenPageOptions): Promise<RenderPage> {
    if (this.closing) throw new RenderError('cancelled', 'the browser is closed');
    if (o.signal.aborted) throw new RenderError('cancelled', 'cancelled');
    const origin = new URL(o.url).origin;
    if (!this.launching) this.launching = this.launch(origin);
    const l = await this.launching;
    if (l.origin !== origin) throw new Error('render: one provider serves one composition server');
    { const f = this.failureError(); if (f) throw f; }
    const t = { ...DEFAULT_TIMEOUTS, ...this.o.timeouts };
    // Pages are created one at a time, up to the moment they run under interception: several pages paused at start
    // (waitForDebuggerOnStart) deadlocked each other in Chrome 154 (even runIfWaitingForDebugger never answered).
    // Navigation and capture are parallel.
    let release!: () => void;
    const previous = this.creationChain;
    this.creationChain = new Promise<void>((r) => { release = r; });
    await previous;
    try {
      return await this.openOne(l, o, t, release);
    } finally {
      release();
    }
  }

  private async openOne(l: Launched, o: OpenPageOptions, t: Required<PageTimeouts>, release: () => void): Promise<RenderPage> {
    // The target is auto-attached paused (setAutoAttach above); its session arrives as an event, possibly before
    // createTarget answers, so attachments seen while a creation is in flight are held, not closed.
    this.creating++;
    let targetId: string;
    try {
      // Its own window: a background tab produces no frames (resizes and screenshots would wait forever).
      ({ targetId } = await l.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', newWindow: true }, { timeoutMs: t.callMs }));
    } catch (e) {
      throw this.failureError() ?? e;
    } finally {
      this.creating--;
    }
    this.ownTargets.add(targetId);
    let sessionId = this.unclaimed.get(targetId);
    if (sessionId !== undefined) this.unclaimed.delete(targetId);
    else {
      sessionId = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          // No auto-attach (an older browser): attach explicitly.
          this.pending.delete(targetId);
          l.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }, { timeoutMs: t.callMs }).then((r) => resolve(r.sessionId), reject);
        }, 10_000);
        this.pending.set(targetId, (sid) => { clearTimeout(timer); resolve(sid); });
      });
    }
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
      return { ...page, close: async () => { o.signal.removeEventListener('abort', onAbort); await close(); } };
    } catch (e) {
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
    killGroup(l.proc.pid!);
    await Promise.race([l.exited, new Promise((r) => setTimeout(r, 10_000))]);
    killGroup(l.proc.pid!); // helpers still in the group
    await sweepByMarker(l.profile).catch(() => 0);
    l.cdp.close();
    l.untrack();
    rmSync(l.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

import type { CdpClient, CdpEvent } from './cdp-pipe.ts';

/**
 * Isolation of the render browser (spec §5.2; spike §4). A composition is agent-written code running outside the agent
 * sandbox, so four independent layers keep it in:
 * 1. the composition server (Task 3): token-prefixed, confined, strict CSP;
 * 2. **request interception** (here): CDP `Fetch` on the page and on every child target (out-of-process layer iframes,
 *    auto-attached paused before they run) lets through only `http://127.0.0.1:<port>/<token>/…` and fails everything else,
 *    navigations included (`location.replace`, `open(url, '_self')`, a delayed `location.href`, a meta refresh…);
 * 3. **dead network** (here, launch flags): a proxy on a port nobody listens on, with the implicit loopback bypass removed
 *    (`<-loopback>`), so the only direct destination is the composition server's exact host and port; and a host resolver
 *    that fails every name. This also stops WebSockets, which `Fetch` does not see, to any host and any other loopback port;
 * 4. the **watchdog** (watchdog.ts): memory, time, and a timeout on every `Runtime.evaluate`.
 *
 * Chromium's own sandbox stays on: never `--no-sandbox`.
 */

/** A discard port on loopback: nothing listens there, so every proxied connection fails at once. */
export const DEAD_PROXY = 'http://127.0.0.1:9';

/** Flags shared by every Chromium the renderer launches (no network flags; see `networkLockdownFlags`). */
export const BASE_FLAGS: readonly string[] = [
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
  '--disable-component-update', '--disable-default-apps', '--disable-domain-reliability', '--disable-client-side-phishing-detection',
  '--disable-breakpad', '--disable-component-extensions-with-background-pages', '--disable-crash-reporter', '--no-service-autorun', '--disable-notifications', '--deny-permission-prompts',
  '--metrics-recording-only', '--no-pings', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--hide-scrollbars',
  '--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text', '--use-mock-keychain', '--password-store=basic',
  '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions',
];

/**
 * The network lockdown for a browser that may reach only `serverOrigin` (`http://127.0.0.1:<port>`):
 * - `--proxy-server` to `DEAD_PROXY`, with `--proxy-bypass-list=<-loopback>;127.0.0.1:<port>`: `<-loopback>` removes
 *   Chromium's implicit direct access to loopback, so another local service (the core API, a dev server) is proxied too and
 *   fails; only the composition server's host:port is direct;
 * - `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`: no name resolves;
 * - WebRTC may not gather host candidates nor use UDP outside the (dead) proxy.
 */
export function networkLockdownFlags(serverOrigin: string): string[] {
  const u = new URL(serverOrigin);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.origin !== serverOrigin) {
    throw new Error(`render isolation: the composition server must be http://127.0.0.1:<port>, got ${serverOrigin}`);
  }
  return [
    `--proxy-server=${DEAD_PROXY}`,
    `--proxy-bypass-list=<-loopback>;127.0.0.1:${u.port}`,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];
}

/**
 * The only URL prefix a render page may request: `<origin>/<token>/` of the page URL the composition server minted
 * (`http://127.0.0.1:<port>/<token>/runtime/index.html?mode=render`).
 */
export function allowedPrefix(pageUrl: string): string {
  const u = new URL(pageUrl);
  const token = u.pathname.split('/')[1] ?? '';
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || !/^[A-Za-z0-9_-]{16,}$/.test(token)) {
    throw new Error('render isolation: not a composition server page URL');
  }
  return `${u.origin}/${token}/`;
}

/**
 * Whether a request URL is inside `prefix`. The URL is parsed (Chromium hands over canonical URLs), and must be plain
 * `http:` on exactly the prefix's host and port, with no credentials, and a path under the token.
 */
export function isAllowedRequest(url: string, prefix: string): boolean {
  let u: URL, p: URL;
  try { u = new URL(url); p = new URL(prefix); } catch { return false; }
  return u.protocol === 'http:' && u.host === p.host && u.username === '' && u.password === '' && u.pathname.startsWith(p.pathname);
}

/** Target types whose requests are intercepted in their own session (`Fetch.enable`). */
const FETCH_TARGETS = new Set(['page', 'iframe']);
/**
 * Child target types that may run once secured: pages and frames (their own Fetch), and dedicated workers, whose requests
 * go through the Fetch of the frame that owns them (measured in Chrome 154; Fetch has no worker support of its own).
 * Anything else (`service_worker`, `shared_worker`, …) has requests no Fetch session of ours sees: it is never resumed,
 * it is closed while still paused.
 */
const RESUMABLE_TARGETS = new Set(['page', 'iframe', 'worker']);
const MAX_BLOCKED_LOG = 200;

/** Chromium's answer to `Target.closeTarget` for a target that no longer exists. */
const TARGET_GONE_RE = /No target with given id found/i;

/**
 * Added before any page script of every page and frame (with the clock, when given): WebRTC and WebTransport are not
 * HTTP, so neither the CSP (for WebRTC) nor Fetch interception sees them. The network flags are what stops them; this is a
 * second layer, never the only one (a worker still has WebTransport).
 * It evaluates to true only when every one of those APIs is gone afterwards (checked where it is evaluated directly).
 */
export const NETWORK_API_GUARD = "(() => { const ks = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport', 'RTCRtpSender', 'RTCRtpReceiver', 'WebTransport']; for (const k of ks) { try { Object.defineProperty(globalThis, k, { value: undefined, writable: false, configurable: false }); } catch (e) {} } return ks.every((k) => globalThis[k] === undefined); })();";

export interface Interception {
  /** URLs refused so far (the first 200), with their resource type: diagnostics and tests. */
  readonly blocked: ReadonlyArray<{ url: string; type: string }>;
  /** Child targets closed before they ran (types that cannot be intercepted, or that failed to be secured). */
  readonly refused: ReadonlyArray<{ type: string; url: string }>;
  /** Set when a frame could not be put under interception, or a refused target could not be closed: the render fails. */
  readonly failure: Error | null;
  /** Stops listening (the browser is about to close). */
  dispose(): void;
}

/**
 * Puts the page session `sessionId` and every target it creates under request interception, before anything loads:
 * - `Fetch.enable` on every page and iframe target;
 * - `Target.setAutoAttach` with `waitForDebuggerOnStart`, recursively, so a child (an out-of-process layer iframe, a worker)
 *   stays paused until it is secured. Only pages, frames and dedicated workers are then resumed; any other child
 *   (service or shared worker), and any child that could not be secured, is closed without ever running (fail closed);
 * - `resume`, when given, resumes the page target itself first (a target auto-attached paused): it is a fresh
 *   `about:blank` that loads nothing before `Page.navigate`;
 * - `NETWORK_API_GUARD`, plus `clockSource` when given, is added to every new document of every page and frame
 *   (`Page.addScriptToEvaluateOnNewDocument`, before a child runs): the clock also covers nested `srcdoc`/`about:blank`
 *   frames of a layer (runtime README, "Clock bypasses");
 * - JavaScript dialogs are dismissed at once (an `alert()` would otherwise block the frame).
 * Call it on a fresh `about:blank` target, before `Page.navigate`.
 *
 * Every event is matched by its `sessionId`: a transport must report a real flat session id for the page (Electron's
 * `webContents.debugger` reports its own target with an empty one: attach with `Target.attachToTarget({ flatten: true })`
 * and pass that session id).
 */
export async function interceptRequests(client: CdpClient, sessionId: string, prefix: string, o: { clockSource?: string; timeoutMs?: number; onFailure?: (e: Error) => void; resume?: () => Promise<void> } = {}): Promise<Interception> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  const blocked: Array<{ url: string; type: string }> = [];
  const refused: Array<{ type: string; url: string }> = [];
  const sessions = new Set<string>([sessionId]);
  let failure: Error | null = null;
  const fail = (e: Error) => { if (!failure) { failure = e; o.onFailure?.(e); } };
  const injected = o.clockSource ? `${NETWORK_API_GUARD}\n${o.clockSource}` : NETWORK_API_GUARD;

  // While a target is paused only commands that do not need it to run: Fetch.enable, setAutoAttach and the new-document
  // script. Page.enable can hang until a page runs (measured with pages created paused), so it follows the resume.
  const secure = async (sid: string, type: string) => {
    if (FETCH_TARGETS.has(type)) {
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, { sessionId: sid, timeoutMs });
      // A paused frame (not our page, which runs first) needs the Page domain for the script to reach its first document.
      if (type === 'iframe') await client.send('Page.enable', {}, { sessionId: sid, timeoutMs });
      await client.send('Page.addScriptToEvaluateOnNewDocument', { source: injected, runImmediately: true }, { sessionId: sid, timeoutMs });
    }
    if (type === 'worker') {
      // A dedicated worker has WebTransport too and gets no new-document script: install the guard in its global scope
      // while it is still paused, before any of its code runs.
      // It returns true only when every API is gone afterwards: a failure its own try/catch swallowed closes the worker too.
      const r = await client.send<{ exceptionDetails?: unknown; result?: { value?: unknown } }>('Runtime.evaluate', { expression: NETWORK_API_GUARD, returnByValue: true }, { sessionId: sid, timeoutMs });
      if (r.exceptionDetails || r.result?.value !== true) throw new Error('the guard did not run in the worker');
    }
    await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, { sessionId: sid, timeoutMs });
  };
  const extras = async (sid: string, type: string) => {
    if (FETCH_TARGETS.has(type)) await client.send('Page.enable', {}, { sessionId: sid, timeoutMs });
  };
  /** Closes a paused child that must not run; failing that, the render fails. */
  const refuse = (targetId: string, type: string, url: string, why: string) => {
    refused.push({ type, url: url.slice(0, 300) });
    void client.send('Target.closeTarget', { targetId }, { timeoutMs }).catch((err: Error) => {
      if (TARGET_GONE_RE.test(err.message)) return; // already gone (it ended, or its owner closed): that is closed
      fail(new Error(`render isolation: a ${type} target (${why}) could not be closed: ${err.message}`));
    });
  };

  const onEvent = (e: CdpEvent) => {
    if (e.sessionId === undefined || !sessions.has(e.sessionId)) return;
    if (e.method === 'Fetch.requestPaused') {
      const request = e.params.request as { url?: unknown } | undefined;
      const url = typeof request?.url === 'string' ? request.url : '';
      const requestId = e.params.requestId;
      if (isAllowedRequest(url, prefix)) {
        void client.send('Fetch.continueRequest', { requestId }, { sessionId: e.sessionId, timeoutMs }).catch(() => {});
      } else {
        if (blocked.length < MAX_BLOCKED_LOG) blocked.push({ url: url.slice(0, 500), type: String(e.params.resourceType ?? '') });
        void client.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, { sessionId: e.sessionId, timeoutMs }).catch(() => {});
      }
      return;
    }
    if (e.method === 'Page.javascriptDialogOpening') {
      void client.send('Page.handleJavaScriptDialog', { accept: false }, { sessionId: e.sessionId, timeoutMs }).catch(() => {});
      return;
    }
    if (e.method === 'Target.attachedToTarget') {
      const child = e.params.sessionId;
      const info = e.params.targetInfo as { type?: unknown; targetId?: unknown; url?: unknown } | undefined;
      if (typeof child !== 'string') return;
      const type = typeof info?.type === 'string' ? info.type : '';
      const targetId = typeof info?.targetId === 'string' ? info.targetId : '';
      const url = typeof info?.url === 'string' ? info.url : '';
      sessions.add(child);
      if (!RESUMABLE_TARGETS.has(type)) { refuse(targetId, type, url, 'not interceptable'); return; }
      void (async () => {
        try {
          await secure(child, type);
        } catch (err) {
          // Never resumed. A frame that cannot be intercepted also fails the render; the caller closes the browser.
          if (FETCH_TARGETS.has(type)) fail(new Error(`render isolation: could not intercept a ${type} target: ${(err as Error).message}`));
          refuse(targetId, type, url, 'not secured');
          return;
        }
        await client.send('Runtime.runIfWaitingForDebugger', {}, { sessionId: child, timeoutMs }).catch(() => {});
        await extras(child, type).catch(() => {});
      })();
      return;
    }
    if (e.method === 'Target.detachedFromTarget' && typeof e.params.sessionId === 'string') sessions.delete(e.params.sessionId);
  };
  const off = client.onEvent(onEvent);
  try {
    // The page itself is a fresh about:blank that loads nothing before our Page.navigate: it may run first.
    await o.resume?.();
    await secure(sessionId, 'page');
    await extras(sessionId, 'page');
  } catch (err) {
    off();
    throw err;
  }
  return {
    blocked, refused,
    get failure() { return failure; },
    dispose: off,
  };
}

/**
 * The browser-level half of interception: every new target of the browser (a page, a popup, a service or shared worker,
 * which no page session sees) is auto-attached paused (`waitForDebuggerOnStart`). Our own pages, created through
 * `createPage`, are handed over; anything else is closed without ever running.
 *
 * Pages are created one at a time, up to the moment they run under interception (`release`): several pages paused at
 * start deadlocked each other in Chrome 154 (even `runIfWaitingForDebugger` never answered). Each one gets its own window:
 * a background tab produces no frames (resizes and screenshots would wait forever).
 */
export class TargetGate {
  private readonly own = new Set<string>();
  private readonly pending = new Map<string, (sessionId: string) => void>();
  private readonly unclaimed = new Map<string, string>();
  private creating = 0;
  private chain: Promise<void> = Promise.resolve();
  /** Targets closed before they ran (diagnostics and tests). */
  readonly refused: Array<{ type: string; url: string }> = [];

  /** `onFailure`: a target that must not run could not be closed; the render fails (as in `interceptRequests`). */
  constructor(private readonly client: CdpClient, private readonly timeoutMs = 30_000, private readonly onFailure?: (e: Error) => void) {}

  /** Starts gating: call once, right after the browser answers. */
  async start(): Promise<void> {
    this.client.onEvent((e) => this.onEvent(e));
    await this.client.send('Target.setDiscoverTargets', { discover: true }, { timeoutMs: this.timeoutMs });
    await this.client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, { timeoutMs: this.timeoutMs });
  }

  private onEvent(e: CdpEvent): void {
    if (e.sessionId !== undefined || e.method !== 'Target.attachedToTarget') return;
    const info = e.params.targetInfo as { targetId?: unknown; type?: unknown; url?: unknown } | undefined;
    const sid = e.params.sessionId;
    const id = typeof info?.targetId === 'string' ? info.targetId : '';
    if (typeof sid !== 'string' || !id) return;
    const waiter = this.pending.get(id);
    if (waiter) { this.pending.delete(id); waiter(sid); return; }
    if (this.own.has(id)) return;
    const closeIt = () => {
      this.refused.push({ type: String(info?.type ?? ''), url: String(info?.url ?? '').slice(0, 300) });
      const type = String(info?.type ?? '');
      void this.client.send('Target.closeTarget', { targetId: id }, { timeoutMs: this.timeoutMs }).catch((err: Error) => {
        // Already gone (it ended or the browser closed it): that is closed. Anything else fails the render.
        if (TARGET_GONE_RE.test(err.message)) return;
        this.onFailure?.(new Error(`render isolation: a ${type} target that is not ours could not be closed: ${err.message}`));
      });
    };
    // While one of our pages is being created, this may be that page (its createTarget has not answered yet): hold it.
    if (this.creating > 0) {
      this.unclaimed.set(id, sid);
      setTimeout(() => { if (this.unclaimed.delete(id)) closeIt(); }, 30_000).unref();
    } else closeIt();
  }

  /**
   * Creates one of our pages (`about:blank`, its own window), still paused. Call `release` once it runs under
   * interception (or on failure) so the next page can be created.
   */
  async createPage(): Promise<{ targetId: string; sessionId: string; release: () => void }> {
    let release!: () => void;
    const previous = this.chain;
    this.chain = new Promise<void>((r) => { release = r; });
    await previous;
    try {
      this.creating++;
      let targetId: string;
      try {
        ({ targetId } = await this.client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', newWindow: true }, { timeoutMs: this.timeoutMs }));
      } finally {
        this.creating--;
      }
      this.own.add(targetId);
      let sessionId = this.unclaimed.get(targetId);
      if (sessionId !== undefined) this.unclaimed.delete(targetId);
      else {
        sessionId = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            // No auto-attach event (an older browser): attach explicitly.
            this.pending.delete(targetId);
            this.client.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }, { timeoutMs: this.timeoutMs }).then((r) => resolve(r.sessionId), reject);
          }, 10_000);
          this.pending.set(targetId, (sid) => { clearTimeout(timer); resolve(sid); });
        });
      }
      return { targetId, sessionId, release };
    } catch (e) {
      release();
      throw e;
    }
  }
}

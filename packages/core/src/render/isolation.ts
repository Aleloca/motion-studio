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

/** Target types whose requests are intercepted in their own session; workers are covered by the frame that owns them. */
const FETCH_TARGETS = new Set(['page', 'iframe']);
const MAX_BLOCKED_LOG = 200;

export interface Interception {
  /** URLs refused so far (the first 200), with their resource type: diagnostics and tests. */
  readonly blocked: ReadonlyArray<{ url: string; type: string }>;
  /** Set when a child target could not be put under interception: the render must fail (fail closed). */
  readonly failure: Error | null;
  /** Stops listening (the browser is about to close). */
  dispose(): void;
}

/**
 * Puts the page session `sessionId` and every target it creates under request interception, before anything loads:
 * - `Fetch.enable` on every page and iframe target (Fetch has no worker support; a dedicated worker's requests are
 *   intercepted through its frame, measured in Chrome 154);
 * - `Target.setAutoAttach` with `waitForDebuggerOnStart`, recursively, so a child (an out-of-process layer iframe, a worker)
 *   stays paused until it is intercepted, then resumes;
 * - `resume`, when given, resumes the page target itself first (a target auto-attached paused): it is a fresh
 *   `about:blank` that loads nothing before `Page.navigate`;
 * - `clockSource`, when given, is added to every new document of every target (`Page.addScriptToEvaluateOnNewDocument`):
 *   it also covers nested `srcdoc`/`about:blank` frames of a layer (runtime README, "Clock bypasses");
 * - JavaScript dialogs are dismissed at once (an `alert()` would otherwise block the frame).
 * Call it on a fresh `about:blank` target, before `Page.navigate`.
 */
export async function interceptRequests(client: CdpClient, sessionId: string, prefix: string, o: { clockSource?: string; timeoutMs?: number; onFailure?: (e: Error) => void; resume?: () => Promise<void> } = {}): Promise<Interception> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  const blocked: Array<{ url: string; type: string }> = [];
  const sessions = new Set<string>([sessionId]);
  let failure: Error | null = null;
  const fail = (e: Error) => { if (!failure) { failure = e; o.onFailure?.(e); } };

  // Only browser-side commands while a target is paused (Fetch.enable, setAutoAttach): renderer-side ones such as
  // Page.enable can hang until it runs (measured with pages created paused). The rest follows the resume.
  const secure = async (sid: string, type: string) => {
    if (FETCH_TARGETS.has(type)) await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, { sessionId: sid, timeoutMs });
    await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, { sessionId: sid, timeoutMs });
  };
  const extras = async (sid: string, type: string) => {
    if (!FETCH_TARGETS.has(type)) return;
    await client.send('Page.enable', {}, { sessionId: sid, timeoutMs });
    if (o.clockSource) await client.send('Page.addScriptToEvaluateOnNewDocument', { source: o.clockSource, runImmediately: true }, { sessionId: sid, timeoutMs });
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
      const info = e.params.targetInfo as { type?: unknown } | undefined;
      if (typeof child !== 'string') return;
      const type = typeof info?.type === 'string' ? info.type : '';
      sessions.add(child);
      void (async () => {
        try {
          await secure(child, type);
        } catch (err) {
          // A frame that cannot be intercepted must never run: fail the render; the browser is closed by the caller.
          if (FETCH_TARGETS.has(type)) { fail(new Error(`render isolation: could not intercept a ${type} target: ${(err as Error).message}`)); return; }
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
    blocked,
    get failure() { return failure; },
    dispose: off,
  };
}

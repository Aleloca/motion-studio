import type { Session, WebContents } from 'electron';

/**
 * The UI window's preview filter (spec §5.2; phase 10a Task 7, orchestrator decision). The live preview is the composition
 * server's runtime page in a sandboxed iframe of the UI, and its html layers are agent-written code. The runtime page's
 * CSP keeps its layers in, but a layer URL framed directly by a page without that CSP (Task 3's known residual) could
 * navigate itself, or fetch, anywhere. This filter does not depend on the CSP:
 *
 * - every request of the UI window's session is attributed to a **source**: the nearest frame, walking up from the
 *   requesting frame (`details.frame`, then its parents), whose URL is not on the app's origin. Only `about:blank`,
 *   `about:srcdoc` and a frame still loading are skipped (a nested frame of a layer counts as the layer); a frame on
 *   `data:`, an opaque `blob:`, an error page or any other non-web URL is an **opaque** source, and a `blob:` URL counts
 *   by its inner origin. An opaque (`'null'`) initiator is opaque too, whatever the frame chain says (the UI is never
 *   opaque). When the frame is gone (or for workers, which have none), the referrer, then the initiator origin, decide;
 * - the active composition server's exact origin is read live (`FilterContext.compositionOrigin`): a request from it may
 *   go only to it (http or ws); an opaque source, or any other foreign one, is cancelled outright;
 * - a frame of the UI itself may show only that composition server (never the core's own port, never another port);
 * - navigations count (a layer's `location.href`, meta refresh, anchor, `location.replace`, `open(url, '_self')`, a nested
 *   iframe, a self-navigation to `data:` or `blob:`); the main frame is excluded (the window's `will-navigate` guard keeps
 *   it on the app).
 *
 * `subframeNavigationBlocked` is the same rule for `will-frame-navigate`; there a navigation to a non-web URL other than
 * `about:blank`/`about:srcdoc` is refused outright.
 *
 * Not HTTP, so not seen by the filter (measured with the hostile layers framed directly): WebRTC (STUN/TURN over UDP) and
 * WebTransport (QUIC). The UI uses neither:
 * - `hardenUiWindow` sets the WebRTC policy `disable_non_proxied_udp` on the UI window (no proxy, so no UDP at all);
 * - WebTransport is subject to CSP `connect-src`, and every file of the composition server carries `connect-src 'none'`:
 *   measured, a real layer framed directly sends nothing. Content without that CSP (which the composition server never
 *   serves) still could: `disableBlinkFeatures: 'WebTransport'` does not remove the API in Electron 44 (measured), and the
 *   UI session has no proxy. Documented residual.
 */

/** The UI window's WebRTC lockdown (see the module comment). */
export function hardenUiWindow(wc: Pick<WebContents, 'setWebRTCIPHandlingPolicy'>): void {
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
}

export interface PreviewRequest {
  url: string;
  resourceType: string;
  /** The requesting frame's URL, then its parents' up to the top (empty when unknown). */
  frameUrls: string[];
  referrer?: string;
  initiatorOrigin?: string;
}

/**
 * What the filter knows: the app's origin (the core server, which serves the UI) and the **active** composition server's
 * exact origin, read at every decision (it starts lazily and may restart on another port); null while there is none.
 */
export interface FilterContext {
  appOrigin: string;
  compositionOrigin: () => string | null;
}

type UrlKind = { kind: 'inherit' } | { kind: 'web'; origin: string } | { kind: 'opaque' };

/**
 * How a URL counts as a source or a target:
 * - http(s) and ws(s): their origin (a WebSocket's written as http(s));
 * - `blob:`: its inner origin (`blob:http://h:p/…` is `http://h:p`; `blob:null/…` is opaque);
 * - empty, `about:blank`, `about:srcdoc`: inherit (a frame not loaded yet, or a local document of its parent);
 * - anything else (`data:`, `file:`, `javascript:`, an error page…): opaque. A frame that navigated itself to `data:` or
 *   to a `blob:` it minted from an opaque origin is never charged to its parent.
 */
function classify(url: string | undefined): UrlKind {
  if (!url || /^about:(blank|srcdoc)([?#].*)?$/.test(url)) return { kind: 'inherit' };
  let u: URL;
  try { u = new URL(url); } catch { return { kind: 'opaque' }; }
  if (u.protocol === 'blob:') {
    const inner = u.origin;
    return inner && inner !== 'null' ? classify(inner) : { kind: 'opaque' };
  }
  const scheme = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
  if (scheme !== 'http:' && scheme !== 'https:') return { kind: 'opaque' };
  return { kind: 'web', origin: `${scheme}//${u.host}` };
}

const webOrigin = (url: string | undefined): string | null => { const c = classify(url); return c.kind === 'web' ? c.origin : null; };

/** Where a request comes from, when not from the app itself: a foreign origin, `'null'` (opaque), or null (the app). */
export function requestSource(r: Pick<PreviewRequest, 'frameUrls' | 'referrer' | 'initiatorOrigin'>, appOrigin: string): string | null {
  const app = new URL(appOrigin).origin;
  // The UI itself is never opaque: an opaque initiator is a sandboxed preview frame, whatever the frame chain says.
  const opaqueInitiator = r.initiatorOrigin === 'null';
  let sawFrame = false;
  for (const url of r.frameUrls) {
    const c = classify(url);
    if (c.kind === 'inherit') continue; // its parent tells
    if (c.kind === 'opaque') return 'null';
    sawFrame = true;
    if (c.origin !== app) return c.origin;
  }
  if (opaqueInitiator) return 'null';
  if (sawFrame) return null;
  const ref = classify(r.referrer);
  if (ref.kind === 'opaque') return 'null';
  if (ref.kind === 'web') return ref.origin === app ? null : ref.origin;
  if (r.initiatorOrigin !== undefined && r.initiatorOrigin !== '') {
    const o = classify(r.initiatorOrigin);
    if (o.kind === 'opaque') return 'null';
    return o.kind !== 'web' || o.origin === app ? null : o.origin;
  }
  return null;
}

/**
 * Whether the UI window's session must cancel this request (see the module comment):
 * - the main frame: never (the window's `will-navigate` guard keeps it on the app);
 * - from the app: anything, except a frame (`subFrame`), which may show only the active composition server;
 * - from the composition server: only the composition server;
 * - from anything else (an opaque or another foreign source): nothing.
 */
export function previewRequestBlocked(r: PreviewRequest, ctx: FilterContext): boolean {
  if (r.resourceType === 'mainFrame') return false;
  const comp = ctx.compositionOrigin();
  const target = webOrigin(r.url);
  const source = requestSource(r, ctx.appOrigin);
  if (source === null) return r.resourceType === 'subFrame' && (comp === null || target !== comp);
  return comp === null || source !== comp || target !== comp;
}

/** `will-frame-navigate` of a subframe (`frameUrls`: the navigating frame's current URL, then its parents'). */
export function subframeNavigationBlocked(n: { url: string; frameUrls: string[] }, ctx: FilterContext): boolean {
  if (classify(n.url).kind === 'inherit') return requestSource({ frameUrls: n.frameUrls }, ctx.appOrigin) === 'null';
  if (webOrigin(n.url) === null) return true; // data:, file:, javascript:, blob:null…
  return previewRequestBlocked({ url: n.url, resourceType: 'subFrame', frameUrls: n.frameUrls }, ctx);
}

/** Only a loopback composition server origin is accepted from the core (`http://127.0.0.1:<port>`). */
export function compositionOriginOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port !== '' && u.origin === v ? v : null;
  } catch { return null; }
}

/**
 * The composition origin of a core in another process (attached window): asked at once and then every `intervalMs`
 * (asking starts the core's composition server, so it is known before the UI frames a preview); a failed answer keeps
 * the last known origin until the next one.
 */
export function pollCompositionOrigin(o: { fetchOrigin: () => Promise<unknown>; intervalMs?: number }): { get(): string | null; refresh(): Promise<void>; stop(): void } {
  let current: string | null = null;
  let stopped = false;
  const refresh = async () => {
    const v = await o.fetchOrigin().catch(() => undefined);
    if (stopped || v === undefined) return;
    current = compositionOriginOf(v);
  };
  void refresh();
  const timer = setInterval(() => { void refresh(); }, o.intervalMs ?? 5_000);
  timer.unref?.();
  return { get: () => current, refresh, stop: () => { stopped = true; clearInterval(timer); } };
}

interface FrameLike { url: string; parent: FrameLike | null }

/** The URLs of `frame` and its parents (a destroyed frame throws on access: then what was read so far). */
export function frameChain(frame: FrameLike | null | undefined): string[] {
  const urls: string[] = [];
  try {
    for (let f = frame ?? null, n = 0; f && n < 64; f = f.parent, n++) urls.push(f.url);
  } catch { /* the frame navigated away or was destroyed */ }
  return urls;
}

/** Installs the filter on the UI window's session (its only `onBeforeRequest` listener: Electron keeps one per session). */
export function installPreviewFilter(ses: Pick<Session, 'webRequest'>, ctx: FilterContext): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    let blocked: boolean;
    try {
      blocked = previewRequestBlocked({
        url: details.url, resourceType: details.resourceType, frameUrls: frameChain(details.frame as FrameLike | null | undefined),
        referrer: details.referrer, ...(details.initiatorOrigin !== undefined ? { initiatorOrigin: details.initiatorOrigin } : {}),
      }, ctx);
    } catch {
      blocked = true; // fail closed
    }
    callback({ cancel: blocked });
  });
}

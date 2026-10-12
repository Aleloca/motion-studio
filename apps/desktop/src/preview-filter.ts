import type { Session, WebContents } from 'electron';

/**
 * The UI window's preview filter (spec §5.2; phase 10a Task 7, orchestrator decision). The live preview is the composition
 * server's runtime page in a sandboxed iframe of the UI, and its html layers are agent-written code. The runtime page's
 * CSP keeps its layers in, but a layer URL framed directly by a page without that CSP (Task 3's known residual) could
 * navigate itself, or fetch, anywhere. This filter does not depend on the CSP:
 *
 * - every request of the UI window's session is attributed to a **source**: the nearest frame, walking up from the
 *   requesting frame (`details.frame`, then its parents), whose URL is not on the app's origin. A frame with no URL of its
 *   own (`about:blank`, `about:srcdoc`, a frame still loading) is skipped, so a nested frame of a layer counts as the layer.
 *   When the frame is gone (or for workers, which have none), the referrer, then the initiator origin, decide;
 * - the UI frames no other site than the composition server, so a source that is not the app is the composition server
 *   (or an opaque `null` origin, which only the sandboxed preview frames have): such a request may only go to that same
 *   origin (http or ws), and a `null` source is cancelled outright (nothing tells where it may go);
 * - navigations count (a layer's `location.href`, meta refresh, anchor, `location.replace`, `open(url, '_self')`, a nested
 *   iframe); the main frame is excluded (the window's `will-navigate` guard keeps it on the app).
 *
 * `subframeNavigationBlocked` is the same rule for `will-frame-navigate`, plus: a frame of the UI itself may show only the
 * app or a loopback http server (the composition server).
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

/** The origin of an http(s) or ws(s) URL, written as http(s) (a WebSocket's origin is its server's); null otherwise. */
function webOrigin(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const scheme = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
  if (scheme !== 'http:' && scheme !== 'https:') return null;
  return `${scheme}//${u.host}`;
}

/** Where a request comes from, when not from the app itself: a foreign origin, `'null'` (opaque), or null (the app). */
export function requestSource(r: Pick<PreviewRequest, 'frameUrls' | 'referrer' | 'initiatorOrigin'>, appOrigin: string): string | null {
  const app = new URL(appOrigin).origin;
  let sawFrame = false;
  for (const url of r.frameUrls) {
    const o = webOrigin(url);
    if (o === null) continue; // about:blank, about:srcdoc, a frame not loaded yet: its parent tells
    sawFrame = true;
    if (o !== app) return o;
  }
  if (sawFrame) return null;
  const ref = webOrigin(r.referrer);
  if (ref !== null) return ref === app ? null : ref;
  if (r.initiatorOrigin !== undefined && r.initiatorOrigin !== '') {
    if (r.initiatorOrigin === 'null') return 'null';
    const o = webOrigin(r.initiatorOrigin);
    return o === null || o === app ? null : o;
  }
  return null;
}

/** Whether the UI window's session must cancel this request (see the module comment). */
export function previewRequestBlocked(r: PreviewRequest, appOrigin: string): boolean {
  if (r.resourceType === 'mainFrame') return false;
  const source = requestSource(r, appOrigin);
  if (source === null) return false;
  if (source === 'null') return true;
  return webOrigin(r.url) !== source;
}

/** `will-frame-navigate` of a subframe (`frameUrls`: the navigating frame's current URL, then its parents'). */
export function subframeNavigationBlocked(n: { url: string; frameUrls: string[] }, appOrigin: string): boolean {
  if (previewRequestBlocked({ url: n.url, resourceType: 'subFrame', frameUrls: n.frameUrls }, appOrigin)) return true;
  const target = webOrigin(n.url);
  if (target === null) return !/^about:(blank|srcdoc)$/.test(n.url);
  if (target === new URL(appOrigin).origin) return false;
  const u = new URL(n.url);
  return !(u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port !== '');
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
export function installPreviewFilter(ses: Pick<Session, 'webRequest'>, appOrigin: string): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    let blocked: boolean;
    try {
      blocked = previewRequestBlocked({
        url: details.url, resourceType: details.resourceType, frameUrls: frameChain(details.frame as FrameLike | null | undefined),
        referrer: details.referrer, ...(details.initiatorOrigin !== undefined ? { initiatorOrigin: details.initiatorOrigin } : {}),
      }, appOrigin);
    } catch {
      blocked = true; // fail closed
    }
    callback({ cancel: blocked });
  });
}

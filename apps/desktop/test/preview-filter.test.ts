// @vitest-environment node
/**
 * The UI window's preview filter (phase 10a Task 7): a frame of the composition server (the live preview and its layers)
 * may reach only the composition server. The real-Electron check with the hostile layers is in
 * render-window.electron.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { compositionOriginOf, hardenUiWindow, installPreviewFilter, pollCompositionOrigin, previewRequestBlocked, requestSource, subframeNavigationBlocked, type FilterContext, type PreviewRequest } from '../src/preview-filter.ts';

const APP = 'http://127.0.0.1:4318';
const COMP = 'http://127.0.0.1:50001';
const LAYER = `${COMP}/tok0123456789abcdef/layers/a.html`;

const CTX: FilterContext = { appOrigin: APP, compositionOrigin: () => COMP };
const req = (o: Partial<PreviewRequest>): PreviewRequest => ({ url: `${COMP}/x`, resourceType: 'xhr', frameUrls: [], ...o });

describe('preview request source', () => {
  it('is the nearest frame (or ancestor) not on the app origin', () => {
    expect(requestSource(req({ frameUrls: [LAYER, `${COMP}/tok/runtime/index.html`, `${APP}/`] }), APP)).toBe(COMP);
    // A nested about:blank / srcdoc frame of a layer: its parent tells.
    expect(requestSource(req({ frameUrls: ['about:blank', LAYER, `${APP}/`] }), APP)).toBe(COMP);
    expect(requestSource(req({ frameUrls: ['about:srcdoc', LAYER, `${APP}/`] }), APP)).toBe(COMP);
    expect(requestSource(req({ frameUrls: [`${APP}/#/p/x`] }), APP)).toBeNull();
  });

  it('falls back to the referrer, then the initiator, when the frame is gone', () => {
    expect(requestSource(req({ referrer: `${LAYER}` }), APP)).toBe(COMP);
    expect(requestSource(req({ initiatorOrigin: COMP }), APP)).toBe(COMP);
    // A sandboxed layer is an opaque origin: "null" with no frame and no referrer is foreign too.
    expect(requestSource(req({ initiatorOrigin: 'null' }), APP)).toBe('null');
    expect(requestSource(req({ initiatorOrigin: APP, referrer: `${APP}/` }), APP)).toBeNull();
    expect(requestSource(req({}), APP)).toBeNull();
  });

  it('a frame on data:, an opaque blob:, or any non-web URL is opaque, never charged to its parent (I1)', () => {
    expect(requestSource(req({ frameUrls: ['data:text/html,<script>fetch(1)</script>', `${APP}/`] }), APP)).toBe('null');
    expect(requestSource(req({ frameUrls: ['blob:null/3f2a', `${APP}/`] }), APP)).toBe('null');
    expect(requestSource(req({ frameUrls: ['chrome-error://chromewebdata/', `${APP}/`] }), APP)).toBe('null');
    expect(requestSource(req({ frameUrls: ['javascript:1', `${APP}/`] }), APP)).toBe('null');
    // blob: counts by its inner origin.
    expect(requestSource(req({ frameUrls: [`blob:${COMP}/3f2a`, `${APP}/`] }), APP)).toBe(COMP);
    expect(requestSource(req({ frameUrls: [`blob:${APP}/3f2a`] }), APP)).toBeNull();
    // An opaque initiator is foreign even when the frame chain resolves to the app (the UI is never opaque).
    expect(requestSource(req({ frameUrls: ['', `${APP}/`], initiatorOrigin: 'null' }), APP)).toBe('null');
    expect(requestSource(req({ frameUrls: [`${APP}/`], initiatorOrigin: 'null' }), APP)).toBe('null');
    expect(requestSource(req({ referrer: 'data:text/html,x' }), APP)).toBe('null');
  });

  it('an about:blank/srcdoc frame under the app with a foreign web initiator is charged to that initiator (N4)', () => {
    // A non-opaque foreign document navigated a frame of the UI to about:blank (it inherits that document's origin).
    expect(requestSource(req({ frameUrls: ['about:blank', `${APP}/`], initiatorOrigin: 'http://127.0.0.1:7777' }), APP)).toBe('http://127.0.0.1:7777');
    expect(requestSource(req({ frameUrls: ['about:srcdoc', `${APP}/`], initiatorOrigin: COMP }), APP)).toBe(COMP);
    expect(previewRequestBlocked(req({ frameUrls: ['about:blank', `${APP}/`], initiatorOrigin: 'http://127.0.0.1:7777', url: 'http://127.0.0.1:9999/x' }), CTX)).toBe(true);
    // The app's own about:blank frames and the app's initiator stay the app's.
    expect(requestSource(req({ frameUrls: ['about:blank', `${APP}/`], initiatorOrigin: APP }), APP)).toBeNull();
    expect(requestSource(req({ frameUrls: ['about:blank', `${APP}/`] }), APP)).toBeNull();
    // A UI frame being created (no URL yet) to show the composition server, initiated by the app: allowed.
    expect(previewRequestBlocked(req({ frameUrls: ['', `${APP}/`], initiatorOrigin: APP, url: `${COMP}/tok/runtime/index.html`, resourceType: 'subFrame' }), CTX)).toBe(false);
  });
});

describe('preview filter decision', () => {
  it.each<[string, Partial<PreviewRequest>, boolean]>([
    ['a layer fetching the composition server', { frameUrls: [LAYER, APP + '/'], url: `${COMP}/tok0123456789abcdef/assets/a.png` }, false],
    ['a layer fetching the core API (canary)', { frameUrls: [LAYER, APP + '/'], url: `${APP}/api/health` }, true],
    ['a layer fetching the internet', { frameUrls: [LAYER, APP + '/'], url: 'https://example.com/' }, true],
    ['a layer opening a WebSocket elsewhere', { frameUrls: [LAYER, APP + '/'], url: 'ws://127.0.0.1:4318/api/events', resourceType: 'webSocket' }, true],
    ['a WebSocket to the composition server itself', { frameUrls: [LAYER, APP + '/'], url: 'ws://127.0.0.1:50001/x', resourceType: 'webSocket' }, false],
    ['a layer navigating itself out (href, meta, anchor, replace, open _self)', { frameUrls: [LAYER, APP + '/'], url: 'http://127.0.0.1:4318/selfnav-href', resourceType: 'subFrame' }, true],
    ['a nested iframe of a layer', { frameUrls: ['about:blank', LAYER, APP + '/'], url: 'http://127.0.0.1:9999/selfnav-iframe', resourceType: 'subFrame' }, true],
    ['a worker of a layer (no frame, referrer)', { referrer: LAYER, url: 'http://127.0.0.1:9999/worker-fetch', resourceType: 'other' }, true],
    ['an opaque initiator with nothing else', { initiatorOrigin: 'null', url: `${COMP}/x` }, true],
    ['a data: document (self-navigated) fetching the canary', { frameUrls: ['data:text/html,x', APP + '/'], url: 'http://127.0.0.1:9999/data-fetch' }, true],
    ['a data: document fetching the composition server', { frameUrls: ['data:text/html,x', APP + '/'], url: `${COMP}/x` }, true],
    ['an opaque blob: document fetching the canary', { frameUrls: ['blob:null/1', APP + '/'], url: 'http://127.0.0.1:9999/blob-fetch' }, true],
    ['a composition blob: document fetching the canary', { frameUrls: [`blob:${COMP}/1`, APP + '/'], url: 'http://127.0.0.1:9999/blob-fetch' }, true],
    ['a composition blob: document fetching its server', { frameUrls: [`blob:${COMP}/1`, APP + '/'], url: `${COMP}/a.png` }, false],
    ['an opaque initiator under an app frame chain', { frameUrls: ['', APP + '/'], initiatorOrigin: 'null', url: 'http://127.0.0.1:9999/x', resourceType: 'subFrame' }, true],
    ['another foreign origin (not the composition server) fetching itself', { frameUrls: ['http://127.0.0.1:7777/a.html', APP + '/'], url: 'http://127.0.0.1:7777/b' }, true],
    ['the UI framing the core port (its own origin)', { frameUrls: ['', `${APP}/`], initiatorOrigin: APP, url: `${APP}/api/health`, resourceType: 'subFrame' }, true],
    ['the UI framing another loopback port', { frameUrls: ['', `${APP}/`], initiatorOrigin: APP, url: 'http://127.0.0.1:9999/', resourceType: 'subFrame' }, true],
    ['the UI itself calling its API', { frameUrls: [`${APP}/#/p/x`], url: `${APP}/api/projects` }, false],
    ['the UI framing the preview', { frameUrls: ['', `${APP}/`], initiatorOrigin: APP, url: `${COMP}/tok/runtime/index.html`, resourceType: 'subFrame' }, false],
    ['the UI loading an external font', { frameUrls: [`${APP}/`], url: 'https://fonts.gstatic.com/x.woff2' }, false],
    ['a main-frame navigation (guarded by will-navigate)', { frameUrls: [LAYER], url: 'https://example.com/', resourceType: 'mainFrame' }, false],
  ])('%s', (_n, r, blocked) => {
    expect(previewRequestBlocked(req(r), CTX)).toBe(blocked);
  });

  it('reads the composition origin live: none yet refuses composition frames and UI frames alike; a restart on a new port moves the allowance', () => {
    let comp: string | null = null;
    const ctx: FilterContext = { appOrigin: APP, compositionOrigin: () => comp };
    const frame = req({ frameUrls: ['', `${APP}/`], initiatorOrigin: APP, url: `${COMP}/tok/runtime/index.html`, resourceType: 'subFrame' });
    expect(previewRequestBlocked(frame, ctx)).toBe(true);
    expect(previewRequestBlocked(req({ frameUrls: [LAYER, APP + '/'], url: `${COMP}/a.png` }), ctx)).toBe(true);
    comp = COMP;
    expect(previewRequestBlocked(frame, ctx)).toBe(false);
    comp = 'http://127.0.0.1:50002';
    expect(previewRequestBlocked(frame, ctx)).toBe(true);
    // The UI's own requests are never affected.
    expect(previewRequestBlocked(req({ frameUrls: [`${APP}/`], url: `${APP}/api/projects` }), ctx)).toBe(false);
  });
});

describe('subframe navigation guard (will-frame-navigate)', () => {
  it('a UI frame may show only the active composition server: never the core port, never another port (I2)', () => {
    const ui = ['', `${APP}/`];
    expect(subframeNavigationBlocked({ url: `${COMP}/tok/runtime/index.html`, frameUrls: ui }, CTX)).toBe(false);
    expect(subframeNavigationBlocked({ url: `${APP}/#/x`, frameUrls: ui }, CTX)).toBe(true); // the core's port
    expect(subframeNavigationBlocked({ url: 'http://127.0.0.1:9999/', frameUrls: ui }, CTX)).toBe(true); // a random port
    expect(subframeNavigationBlocked({ url: 'http://localhost:50001/', frameUrls: ui }, CTX)).toBe(true);
    expect(subframeNavigationBlocked({ url: 'https://example.com/', frameUrls: ui }, CTX)).toBe(true);
    expect(subframeNavigationBlocked({ url: 'file:///etc/hosts', frameUrls: ui }, CTX)).toBe(true);
    expect(subframeNavigationBlocked({ url: 'about:blank', frameUrls: ui }, CTX)).toBe(false);
    expect(subframeNavigationBlocked({ url: `${COMP}/tok/runtime/index.html`, frameUrls: ui }, { appOrigin: APP, compositionOrigin: () => null })).toBe(true);
  });

  it('a composition frame stays on its server, and never goes to data: or an opaque blob:', () => {
    expect(subframeNavigationBlocked({ url: `${APP}/selfnav-href`, frameUrls: [LAYER, `${APP}/`] }, CTX)).toBe(true);
    expect(subframeNavigationBlocked({ url: `${COMP}/tok0123456789abcdef/layers/b.html`, frameUrls: [LAYER, `${APP}/`] }, CTX)).toBe(false);
    expect(subframeNavigationBlocked({ url: 'data:text/html,x', frameUrls: [LAYER, `${APP}/`] }, CTX)).toBe(true);
    expect(subframeNavigationBlocked({ url: 'blob:null/1', frameUrls: [LAYER, `${APP}/`] }, CTX)).toBe(true);
    expect(subframeNavigationBlocked({ url: 'about:blank', frameUrls: ['data:text/html,x', `${APP}/`] }, CTX)).toBe(true);
  });
});

describe('composition origin of an attached core', () => {
  it('accepts only http://127.0.0.1:<port>, keeps the last good answer on a failure, and follows a restart', async () => {
    expect(compositionOriginOf('http://127.0.0.1:50001')).toBe('http://127.0.0.1:50001');
    for (const bad of ['http://localhost:50001', 'https://127.0.0.1:50001', 'http://127.0.0.1', 'http://127.0.0.1:50001/x', 5, null]) expect(compositionOriginOf(bad)).toBeNull();
    const answers: Array<() => unknown> = [() => 'http://127.0.0.1:50001', () => { throw new Error('down'); }, () => 'http://127.0.0.1:50002'];
    const poll = pollCompositionOrigin({ fetchOrigin: async () => answers.shift()!(), intervalMs: 60_000 });
    await new Promise((r) => setTimeout(r, 0));
    expect(poll.get()).toBe('http://127.0.0.1:50001');
    await poll.refresh();
    expect(poll.get()).toBe('http://127.0.0.1:50001');
    await poll.refresh();
    expect(poll.get()).toBe('http://127.0.0.1:50002');
    poll.stop();
  });
});

describe('UI window hardening', () => {
  it('no non-proxied UDP for WebRTC (no proxy: none at all)', () => {
    const wc = { setWebRTCIPHandlingPolicy: vi.fn() };
    hardenUiWindow(wc);
    expect(wc.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');
  });
});

describe('installPreviewFilter', () => {
  it('reads the frame chain from Electron details (frame, parents) and cancels', async () => {
    let handler!: (d: unknown, cb: (r: { cancel: boolean }) => void) => void;
    const ses = { webRequest: { onBeforeRequest: vi.fn((f: typeof handler) => { handler = f; }) } };
    installPreviewFilter(ses as never, CTX);
    const top = { url: `${APP}/`, parent: null };
    const runtime = { url: `${COMP}/tok/runtime/index.html`, parent: top };
    const layer = { url: LAYER, parent: runtime };
    const decide = (d: object) => new Promise<{ cancel: boolean }>((r) => handler({ resourceType: 'xhr', referrer: '', ...d }, r));
    expect(await decide({ url: `${APP}/api/health`, frame: layer })).toEqual({ cancel: true });
    expect(await decide({ url: `${COMP}/tok/a.png`, frame: layer })).toEqual({ cancel: false });
    expect(await decide({ url: `${APP}/api/health`, frame: top })).toEqual({ cancel: false });
    // A frame object that throws (destroyed) falls back to the referrer.
    const gone = { get url(): string { throw new Error('destroyed'); }, parent: null };
    expect(await decide({ url: `${APP}/api/health`, frame: gone, referrer: LAYER })).toEqual({ cancel: true });
  });
});

// @vitest-environment node
/**
 * The UI window's preview filter (phase 10a Task 7): a frame of the composition server (the live preview and its layers)
 * may reach only the composition server. The real-Electron check with the hostile layers is in
 * render-window.electron.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { hardenUiWindow, installPreviewFilter, previewRequestBlocked, requestSource, subframeNavigationBlocked, type PreviewRequest } from '../src/preview-filter.ts';

const APP = 'http://127.0.0.1:4318';
const COMP = 'http://127.0.0.1:50001';
const LAYER = `${COMP}/tok0123456789abcdef/layers/a.html`;

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
    ['the UI itself calling its API', { frameUrls: [`${APP}/#/p/x`], url: `${APP}/api/projects` }, false],
    ['the UI framing the preview', { frameUrls: ['', `${APP}/`], initiatorOrigin: APP, url: `${COMP}/tok/runtime/index.html`, resourceType: 'subFrame' }, false],
    ['the UI loading an external font', { frameUrls: [`${APP}/`], url: 'https://fonts.gstatic.com/x.woff2' }, false],
    ['a main-frame navigation (guarded by will-navigate)', { frameUrls: [LAYER], url: 'https://example.com/', resourceType: 'mainFrame' }, false],
  ])('%s', (_n, r, blocked) => {
    expect(previewRequestBlocked(req(r), APP)).toBe(blocked);
  });
});

describe('subframe navigation guard (will-frame-navigate)', () => {
  it('a UI frame may show the app or a loopback server (the preview); a composition frame stays on its server', () => {
    expect(subframeNavigationBlocked({ url: `${COMP}/tok/runtime/index.html`, frameUrls: ['', `${APP}/`] }, APP)).toBe(false);
    expect(subframeNavigationBlocked({ url: `${APP}/#/x`, frameUrls: ['', `${APP}/`] }, APP)).toBe(false);
    expect(subframeNavigationBlocked({ url: 'https://example.com/', frameUrls: ['', `${APP}/`] }, APP)).toBe(true);
    expect(subframeNavigationBlocked({ url: 'file:///etc/hosts', frameUrls: ['', `${APP}/`] }, APP)).toBe(true);
    expect(subframeNavigationBlocked({ url: `${APP}/selfnav-href`, frameUrls: [LAYER, `${APP}/`] }, APP)).toBe(true);
    expect(subframeNavigationBlocked({ url: `${COMP}/tok0123456789abcdef/layers/b.html`, frameUrls: [LAYER, `${APP}/`] }, APP)).toBe(false);
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
    installPreviewFilter(ses as never, APP);
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

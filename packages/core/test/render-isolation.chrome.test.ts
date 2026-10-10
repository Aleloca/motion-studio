// @vitest-environment node
/**
 * Isolation of the render browser (plan Review Focus 1; spec §5.2), in real headless Chrome. A canary server on loopback
 * stands in for the core API; a hit on it is a leak.
 *
 * A. **All layers** (the real composition server with its CSP, the provider's request interception and network flags): the
 *    hostile layer (fetch, WebSocket, EventSource, beacon, Worker, import(), script, stylesheet, image, file://, form,
 *    popup, top navigation, top/parent access, cross-origin pushState) and the seven self-navigating layers
 *    (`location.href`, meta refresh, anchor click, nested iframe, `location.replace`, `open(url, '_self')`, a delayed
 *    `location.href`) reach nothing, while frames are seeked past the delayed one.
 * B. **Interception alone** (the browser-level `TargetGate` plus `interceptRequests`, as the provider uses them), on a page
 *    and layers served WITHOUT any CSP and a browser WITHOUT the network flags: the same
 *    layers, the direct-framing residual of Task 3. A positive control without interception reaches the canary; with it,
 *    nothing does except a WebSocket (CDP Fetch does not see WebSockets, measured in the spike; C and A stop it).
 * C. **Network flags alone** (dead proxy with `<-loopback>`, NOTFOUND resolver, WebRTC policy), no interception, no CSP:
 *    nothing at all reaches the canaries on other loopback ports: WebSocket, workers, WebRTC STUN/TURN and WebTransport to
 *    a UDP canary included.
 * Workers: in A the layers are opaque origins, so every worker attempt fails; B and C start real ones from a same-origin
 * top-level page (service worker, SharedWorker, a same-origin and a blob dedicated worker), all fetching the canary, and
 * a dedicated worker opening WebTransport to the UDP canary (the control sees its QUIC packets, on a page of its own too; B none: the guard is
 * installed in the paused worker; C none: the flags).
 * Skipped without Chrome, unless MS_REQUIRE_CHROME=1 (CI).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Composition } from '@motion-studio/shared';
import { CdpPipe, waitForEvent } from '../src/render/cdp-pipe.ts';
import { ChromeProvider, nativeLauncher } from '../src/render/chromium-provider.ts';
import { BASE_FLAGS, interceptRequests, networkLockdownFlags, TargetGate } from '../src/render/isolation.ts';
import { killGroup, sweepByMarker } from '../src/render/watchdog.ts';
import { startCompositionServer } from '../src/compositions/composition-server.ts';
import { hostileLayer, hostileTrack, hostileWorkerScripts, workerTransportProbe, OWN_FRAME_NAVIGATION_CASES, SELF_NAVIGATION_CASES, selfNavigationLayer, selfNavigationPath, selfNavigationTrack, writeHostileLayers } from './helpers/hostile-layers.ts';
import { buildRuntime, leftovers, renderTools, startCanary, startUdpCanary, type Canary, type UdpCanary } from './helpers/render-env.ts';

const tools = await renderTools('renderer isolation tests');
const W = 320, H = 180;
const TOKEN = 'naked-token-0123456789abcdef';

/** A Chrome without our provider (flags chosen by the test), with its own profile and process group. */
async function rawChrome(exe: string, flags: string[]) {
  const profile = mkdtempSync(join(tmpdir(), 'ms-render-iso-'));
  const args = [...BASE_FLAGS, ...flags, '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', 'about:blank'];
  const native = await nativeLauncher(exe);
  const proc = spawn(native ? '/usr/bin/arch' : exe, native ? ['-arm64', exe, ...args] : args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: true });
  const cdp = new CdpPipe(proc.stdio[3] as Writable, proc.stdio[4] as Readable, { defaultTimeoutMs: 120_000 });
  await cdp.send('Browser.getVersion');
  return {
    cdp, pgid: proc.pid!, profile,
    async page() {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', newWindow: true });
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      return sessionId;
    },
    async navigate(sessionId: string, url: string) {
      await cdp.send('Page.enable', {}, { sessionId });
      const loaded = waitForEvent(cdp, 'Page.loadEventFired', { sessionId, timeoutMs: 120_000 });
      await cdp.send('Page.navigate', { url }, { sessionId });
      await loaded;
    },
    async close() {
      await cdp.send('Browser.close', {}, { timeoutMs: 5_000 }).catch(() => {});
      killGroup(proc.pid!);
      await new Promise((r) => setTimeout(r, 500));
      killGroup(proc.pid!);
      await sweepByMarker(profile);
      cdp.close();
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/**
 * A server WITHOUT any CSP that mimics the token layout: a top-level page (same origin as the token) that registers a
 * service worker, starts a SharedWorker, a same-origin worker and a blob worker (each fetching the canary), and frames
 * every hostile and self-navigating layer.
 */
async function nakedServer(canary: string, udpPort: number): Promise<{ origin: string; close(): Promise<void> }> {
  const layers: Record<string, string> = { hostile: hostileLayer(canary, udpPort) };
  for (const c of SELF_NAVIGATION_CASES) layers[`selfnav-${c}`] = selfNavigationLayer(canary, c);
  const scripts = hostileWorkerScripts(canary);
  const page = `<!doctype html><html><body>${Object.keys(layers).map((k) => `<iframe sandbox="allow-scripts" src="/${TOKEN}/layers/${k}.html"></iframe>`).join('')}
<script>
fetch(${JSON.stringify(`${canary}/top-fetch`)}).catch(() => {});
try { navigator.serviceWorker.register('/${TOKEN}/sw.js').catch(() => {}); } catch (e) {}
try { new SharedWorker('/${TOKEN}/shared.js'); } catch (e) {}
try { new Worker('/${TOKEN}/worker.js'); } catch (e) {}
try { new Worker(URL.createObjectURL(new Blob([${JSON.stringify(`fetch('${canary}/blob-worker-fetch').catch(() => {});`)}], { type: 'text/javascript' }))); } catch (e) {}
try { new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerTransportProbe(udpPort))}], { type: 'text/javascript' }))); } catch (e) {}
</script></body></html>`;
  // Only the dedicated worker's WebTransport probe: the control proves this probe alone sends UDP.
  const workerOnly = `<!doctype html><html><body><script>
try { new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerTransportProbe(udpPort))}], { type: 'text/javascript' }))); } catch (e) {}
</script></body></html>`;
  const pages: Record<string, string> = { [`/${TOKEN}/page.html`]: page, [`/${TOKEN}/worker-only.html`]: workerOnly };
  const s: Server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0]!;
    const html = new RegExp(`^/${TOKEN}/layers/([\\w-]+)\\.html$`).exec(url);
    const js = new RegExp(`^/${TOKEN}/(?:layers/)?([\\w-]+\\.js)$`).exec(url);
    if (pages[url] || (html && layers[html[1]!])) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pages[url] ?? layers[html![1]!]);
    } else if (js && scripts[js[1]!]) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(scripts[js[1]!]);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { origin: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!tools.chrome)('render isolation in headless Chrome', () => {
  let work: string;
  let dist: string;
  let canary: Canary;
  let udp: UdpCanary;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ms-render-isolation-'));
    dist = join(work, 'dist');
    await buildRuntime(dist);
    canary = await startCanary();
    udp = await startUdpCanary();
  }, 600_000);

  afterAll(async () => {
    await canary?.close();
    await udp?.close();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('A. all layers: the hostile and self-navigating layers reach nothing while the render seeks', async () => {
    const creative = join(work, 'creative');
    const compDir = join(creative, 'outputs', 'v1', 'compositions', 'iso');
    mkdirSync(join(compDir, 'layers'), { recursive: true });
    writeHostileLayers(compDir, canary.origin, udp.port);
    const composition = {
      $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: 2, background: '#000000', fonts: [],
      scenes: [{ id: 'all', start: 0, duration: 2 }], tracks: [selfNavigationTrack(2), hostileTrack(2)],
    } as unknown as Composition;
    const server = await startCompositionServer({ uiOrigins: [], distDir: dist });
    const provider = new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 20 * 60_000 } });
    const before = canary.hits.length;
    const udpBefore = udp.packets.length;
    try {
      const session = await server.mintSession({ creativeDir: creative, versionDir: 'outputs/v1', format: 'iso', composition, mode: 'render' });
      let t0 = Date.now();
      const page = await provider.open({ width: W, height: H, url: session.url, signal: new AbortController().signal });
      const timings = [`ready ${Date.now() - t0} ms ${JSON.stringify(page.info.errors.map((e) => `${e.code}:${e.clipId ?? ''}`))}`];
      // Seek past the delayed navigation (1.5 s of the frozen clock, fired by the pump while the layer seeks).
      for (const t of [0, 1, 1.6, 1.9]) {
        t0 = Date.now();
        const r = await page.seek(t).then(() => 'ok', (e: Error) => e.message.slice(0, 80));
        timings.push(`seek ${t}: ${Date.now() - t0} ms ${r}`);
      }
      if (process.env.MS_RENDER_DEBUG) console.info(`[render] A: ${timings.join('; ')}`);
      await settle(3000);
      expect(canary.hits.slice(before)).toEqual([]);
      expect(udp.packets.slice(udpBefore)).toEqual([]); // WebRTC STUN/TURN and WebTransport
      expect(provider.failure).toBeNull();
    } finally {
      await provider.close();
      await server.close();
    }
    expect(await leftovers({ pgids: [provider.pgid!], markers: [provider.profileDir!] })).toEqual([]);
  }, 900_000);

  it('B. interception alone (no CSP anywhere, no network flags): a control without it leaks; with it nothing but a WebSocket gets out', async () => {
    const naked = await nakedServer(canary.origin, udp.port);
    try {
      // Positive control: the same browser set-up without interception reaches the canary through every layer.
      const control = await rawChrome(tools.chrome!.exe, []);
      try {
        // The dedicated worker's probe alone (a page with nothing else): its QUIC Initial reaches the UDP canary.
        const workerUdpBefore = udp.packets.length;
        await control.navigate(await control.page(), `${naked.origin}/${TOKEN}/worker-only.html`);
        await settle(3000);
        const workerSizes = udp.packets.slice(workerUdpBefore).map((x) => x.bytes);
        expect(workerSizes.some((b) => b >= 1200), `worker QUIC Initial in ${workerSizes.join(',')}`).toBe(true);
        expect(workerSizes.every((b) => b >= 1200), `only QUIC from the worker page: ${workerSizes.join(',')}`).toBe(true);
        const before = canary.hits.length;
        const udpBefore = udp.packets.length;
        await control.navigate(await control.page(), `${naked.origin}/${TOKEN}/page.html`);
        await settle(5000);
        const hits = canary.hits.slice(before);
        for (const c of OWN_FRAME_NAVIGATION_CASES) expect(hits, c).toContain(selfNavigationPath(c));
        for (const p of ['/top-fetch', '/fetch', '/worker-fetch', '/blob-worker-fetch', '/shared-fetch', '/sw-fetch']) expect(hits, p).toContain(p);
        // Both probes really fire: WebRTC's STUN/TURN (small, 20–28 B here) and WebTransport's QUIC Initial (≥ 1200 B).
        const sizes = udp.packets.slice(udpBefore).map((x) => x.bytes);
        expect(sizes.some((b) => b < 100), `STUN/TURN in ${sizes.join(',')}`).toBe(true);
        expect(sizes.some((b) => b >= 1200), `QUIC Initial in ${sizes.join(',')}`).toBe(true);
      } finally { await control.close(); }

      const chrome = await rawChrome(tools.chrome!.exe, []);
      try {
        const before = canary.hits.length;
        // The production interception layer: the browser-level gate (new targets paused; workers and popups closed)
        // plus Fetch interception of the page and its children.
        const gate = new TargetGate(chrome.cdp);
        await gate.start();
        const { sessionId, release } = await gate.createPage();
        const udpBefore = udp.packets.length;
        const ic = await interceptRequests(chrome.cdp, sessionId, `${naked.origin}/${TOKEN}/`, {
          resume: () => chrome.cdp.send('Runtime.runIfWaitingForDebugger', {}, { sessionId }).then(() => {}),
        });
        release();
        await chrome.navigate(sessionId, `${naked.origin}/${TOKEN}/page.html`);
        await settle(5000);
        expect(canary.hits.slice(before)).toEqual(['upgrade /ws']);
        // No flags here: the guard alone keeps WebRTC and WebTransport from every page, frame and dedicated worker (it is
        // evaluated in a worker while it is still paused). Recorded here; the flags are what A and C rely on.
        expect(udp.packets.slice(udpBefore)).toEqual([]);
        const blocked = ic.blocked.map((b) => b.url);
        // The dedicated workers (same-origin and blob) ran and their fetches were intercepted; the service and shared
        // workers were closed before they ran.
        for (const p of ['/worker-fetch', '/blob-worker-fetch']) expect(blocked, p).toContain(`${canary.origin}${p}`);
        expect([...ic.refused, ...gate.refused].map((r) => r.type)).toEqual(expect.arrayContaining(['service_worker', 'shared_worker']));
        // The injected guard (defence in depth) took WebRTC and WebTransport away from the page.
        expect(await chrome.cdp.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'typeof RTCPeerConnection + typeof WebTransport', returnByValue: true }, { sessionId }).then((r) => r.result.value)).toBe('undefinedundefined');
        for (const c of OWN_FRAME_NAVIGATION_CASES) expect(blocked, c).toContain(`${canary.origin}${selfNavigationPath(c)}`);
        expect(ic.blocked.filter((b) => b.url.includes('/selfnav-')).every((b) => b.type === 'Document')).toBe(true);
      } finally { await chrome.close(); }
    } finally {
      await naked.close();
    }
  }, 900_000);

  it('C. network flags alone (no interception, no CSP): nothing reaches a service on another loopback port, WebSocket, workers, WebRTC and WebTransport included', async () => {
    const naked = await nakedServer(canary.origin, udp.port);
    const chrome = await rawChrome(tools.chrome!.exe, networkLockdownFlags(naked.origin));
    try {
      const before = canary.hits.length;
      const udpBefore = udp.packets.length;
      await chrome.navigate(await chrome.page(), `${naked.origin}/${TOKEN}/page.html`);
      await settle(5000);
      expect(canary.hits.slice(before)).toEqual([]);
      expect(udp.packets.slice(udpBefore)).toEqual([]); // WebRTC STUN/TURN and WebTransport: no injected guard here
    } finally {
      await chrome.close();
      await naked.close();
    }
  }, 900_000);
});

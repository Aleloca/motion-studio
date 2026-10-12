// @vitest-environment node
/**
 * The composition server in a real headless Chrome (system Chrome or CHROME_PATH; never downloaded), with its exact
 * headers: the render page loads top-level; the preview loads in a `sandbox="allow-scripts"` iframe of a stub UI page on
 * another origin; the runtime, fonts (CORS from opaque origins) and layers (Sec-Fetch-Dest: iframe) all work; a page on a
 * foreign origin cannot frame the preview (frame-ancestors). A hostile layer tries to reach a canary server standing in for
 * the core API (fetch, WebSocket, EventSource, beacon, Worker, import(), script, stylesheet, image, form, popup, top
 * navigation) and to touch the parent documents: the canary must see nothing, and the page must stay intact.
 * Skipped with a message when no Chrome is found, unless MS_REQUIRE_CHROME=1 (CI), which turns the skip into a failure.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runtimeBuildOptions } from '../../composition-runtime/tsup.config.ts';
import { findChrome, launchChrome, type Browser, type Page } from '../../composition-runtime/test/support/chrome.ts';
import { COMP_PATH, findFfmpeg, H, LAYER, VIDEO, W, writeFixture } from '../../composition-runtime/test/support/fixture.ts';
import { decodePng, meanGrey, type Image } from '../../composition-runtime/test/support/png.ts';
import { sourceFrameIndex, videoSourceTime } from '../../composition-runtime/src/timing.ts';
import { HOSTILE_BOX as HOSTILE, hostileTrack, OWN_FRAME_NAVIGATION_CASES, SELF_NAVIGATION_CASES, selfNavigationPath, selfNavigationTrack, writeHostileLayers } from './helpers/hostile-layers.ts';
import { startCompositionServer, type CompositionServer } from '../src/compositions/composition-server.ts';

const chrome = findChrome();
const ffmpeg = findFfmpeg();
const required = process.env.MS_REQUIRE_CHROME === '1';
const RUNTIME_PKG = join(import.meta.dirname, '../../composition-runtime');
const FONT = join(RUNTIME_PKG, 'test/fixtures/fonts/jetbrains-mono-latin-400-normal.woff2');

if (!chrome) {
  if (required) {
    it('Chrome is required (MS_REQUIRE_CHROME=1) but none was found: set CHROME_PATH', () => { throw new Error('no Chrome found'); });
  } else {
    console.warn('[core] composition server Chrome tests SKIPPED: no system Chrome found (set CHROME_PATH). They are required on CI (MS_REQUIRE_CHROME=1).');
  }
}
if (chrome && !ffmpeg) {
  if (required) it('ffmpeg is required for the video checks (MS_REQUIRE_CHROME=1): set FFMPEG_PATH', () => { throw new Error('no ffmpeg found'); });
  else console.warn('[core] composition server Chrome tests: no ffmpeg, the video checks are SKIPPED.');
}

describe.skipIf(!chrome)('composition server in headless Chrome', () => {
  let work: string;
  let dist: string;
  let site: string;
  let browser: Browser;
  let canary: Server;
  let canaryOrigin: string;
  const canaryHits: string[] = [];
  let composition: Record<string, unknown>;
  const stubs: Array<{ close(): Promise<void> }> = [];

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ms-core-comp-it-'));
    dist = join(work, 'dist');
    // tsup lives in the runtime package; resolve it from there.
    const { build } = await import(pathToFileURL(createRequire(join(RUNTIME_PKG, 'package.json')).resolve('tsup')).href) as { build(o: unknown): Promise<void> };
    await build({ ...runtimeBuildOptions(dist), config: false });
    site = join(work, 'site');
    writeFixture(site, FONT, ffmpeg);
    canary = createServer((req, res) => { canaryHits.push(req.url ?? ''); res.writeHead(204); res.end(); });
    canary.on('upgrade', (req, socket) => { canaryHits.push(`upgrade ${req.url ?? ''}`); socket.destroy(); });
    await new Promise<void>((r) => canary.listen(0, '127.0.0.1', () => r()));
    canaryOrigin = `http://127.0.0.1:${(canary.address() as { port: number }).port}`;
    writeHostileLayers(join(site, COMP_PATH), canaryOrigin);
    composition = JSON.parse(readFileSync(join(site, COMP_PATH, 'composition.json'), 'utf8')) as Record<string, unknown>;
    (composition.tracks as unknown[]).push(hostileTrack());
    browser = await launchChrome(chrome!);
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    for (const s of stubs) await s.close();
    await new Promise<void>((r) => (canary ? (canary.closeAllConnections(), canary.close(() => r())) : r()));
    if (work) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  const [versionDir, , format] = COMP_PATH.split('/') as [string, string, string];
  const px = (img: Image, x: number, y: number) => img.px(x, y);
  const isGreen = ([r, g, b]: readonly number[]) => r! < 60 && g! > 200 && b! < 60;
  /** Width of the probe layer's msSeek bar: red pixels from the left of its first row (as in the runtime test). */
  const barWidth = (img: Image) => {
    let x = 0;
    while (x < W && (() => { const [r, g, b] = img.px(LAYER.x + x, LAYER.y + 10); return r > 128 && g < 100 && b < 100; })()) x++;
    return x;
  };
  /** The source frame number the fixture video codes in two grey blocks (as in the runtime test). */
  const videoFrame = (img: Image) => {
    const digit = (x: number) => Math.round((meanGrey(img, x, VIDEO.y + VIDEO.height / 2) * 219) / 255 / 20);
    return digit(VIDEO.x + (VIDEO.width * 3) / 4) * 10 + digit(VIDEO.x + VIDEO.width / 4);
  };
  const expectedFrame = (t: number) => sourceFrameIndex(videoSourceTime(VIDEO, t), VIDEO.sourceFps);
  const log: Array<{ method: string; path: string; status: number }> = [];
  const onResponse = (e: { method: string; path: string; status: number }) => { log.push(e); };
  const poll = (page: Page, expr: string) => page.eval(`new Promise((res, rej) => { const t0 = Date.now(); (function poll() {
    const v = (${expr}); if (v) return res(v); if (Date.now() - t0 > 180000) return rej(new Error('timeout')); setTimeout(poll, 50); })(); })`, 200_000);
  /** A stub UI page on its own origin, embedding a sandboxed iframe and recording the messages from it. */
  async function stubUi(): Promise<string> {
    const html = '<!doctype html><html><body style="margin:0;background:#000">'
      + `<iframe id="f" sandbox="allow-scripts" allow="autoplay" style="border:0;width:${W}px;height:${H}px;display:block"></iframe>`
      + '<script>window.msgs=[];const f=document.getElementById("f");'
      + 'addEventListener("message",(e)=>{if(e.source===f.contentWindow)window.msgs.push(e.data);});</script></body></html>';
    const s = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    stubs.push({ close: () => new Promise<void>((c) => { s.closeAllConnections(); s.close(() => c()); }) });
    return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  }

  it('render: the page loads top-level, fonts and layers work, the hostile layer reaches nothing', async () => {
    const server: CompositionServer = await startCompositionServer({ uiOrigins: [], distDir: dist, onResponse });
    const page = await browser.newPage(W, H);
    try {
      const s = await server.mintSession({ creativeDir: site, versionDir, format, composition, mode: 'render' });
      await page.goto(s.url);
      const info = await page.eval<{ errors: unknown[]; duration: number }>('window.__ms.ready()', 200_000);
      expect(info.errors).toEqual([]);
      expect(info.duration).toBe(4);
      await page.eval('window.__ms.seek(1.5)', 200_000);
      const img = decodePng(await page.screenshot());
      expect(barWidth(img)).toBe(75);
      expect(isGreen(px(img, HOSTILE.x + 20, HOSTILE.y + 20))).toBe(true);
      if (ffmpeg) {
        expect(videoFrame(img)).toBe(expectedFrame(1.5));
        // Chrome fetched the video with byte ranges and got 206 (video seeking needs them).
        expect(log.some((e) => e.path.endsWith('/assets/frames24.mp4') && e.status === 206)).toBe(true);
      }
      expect(await page.eval('location.href')).toBe(s.url);
    } finally {
      await page.close();
      await server.close();
    }
  }, 300_000);

  it('preview: a sandboxed iframe of the UI origin gets ready with fonts and layers; a foreign origin cannot frame it', async () => {
    const ui = await stubUi();
    const foreign = await stubUi();
    const server = await startCompositionServer({ uiOrigins: () => [ui], distDir: dist, onResponse });
    try {
      const s = await server.mintSession({ creativeDir: site, versionDir, format, composition, mode: 'preview', parentOrigin: ui });
      const page = await browser.newPage(W, H);
      await page.goto(`${ui}/`);
      await page.eval(`document.getElementById('f').src = ${JSON.stringify(s.url)}; true`);
      const ready = await poll(page, "window.msgs.find((m) => m.type === 'ready')") as { errors: unknown[]; duration: number };
      expect(ready.errors).toEqual([]);
      expect(ready.duration).toBe(4);
      expect(await page.eval("window.msgs.filter((m) => m.type === 'error')")).toEqual([]);
      await page.eval("window.msgs.length = 0; document.getElementById('f').contentWindow.postMessage({ type: 'seek', t: 1.5 }, '*'); true");
      expect(await poll(page, "window.msgs.find((m) => m.type === 'time')")).toEqual({ type: 'time', t: 1.5, playing: false });
      const img = decodePng(await page.screenshot());
      expect(barWidth(img)).toBe(75);
      expect(isGreen(px(img, HOSTILE.x + 20, HOSTILE.y + 20))).toBe(true);
      if (ffmpeg) expect(videoFrame(img)).toBe(expectedFrame(1.5));
      expect(await page.eval('location.href')).toBe(`${ui}/`);
      await page.close();

      // The same session framed by a page on another origin that names itself as the parent: only frame-ancestors (the
      // session's parent) stops the runtime from loading and posting to it.
      const other = await browser.newPage(W, H);
      await other.goto(`${foreign}/`);
      const hijack = s.url.replace(encodeURIComponent(ui), encodeURIComponent(foreign));
      expect(hijack).not.toBe(s.url);
      await other.eval(`document.getElementById('f').src = ${JSON.stringify(hijack)}; new Promise((r) => setTimeout(r, 5000))`, 30_000);
      expect(await other.eval('window.msgs')).toEqual([]);
      await other.close();
    } finally {
      await server.close();
    }
  }, 300_000);

  it('the canary saw no request from any composition page, though it is reachable', async () => {
    expect(canaryHits).toEqual([]);
    const page = await browser.newPage(W, H);
    try {
      // Positive control: a page without our CSP reaches the canary, so the silence above is the headers' doing.
      await page.goto(`${await stubUi()}/`);
      await page.eval(`fetch(${JSON.stringify(`${canaryOrigin}/control`)}, { mode: 'no-cors' }).then(() => true, () => false)`);
      expect(canaryHits).toEqual(['/control']);
    } finally { await page.close(); }
  }, 120_000);

  /*
   * Self-navigation (Task 3 review). A layer can navigate ITS OWN frame: location.href, a meta refresh, an anchor click, or
   * a nested iframe. Neither the layer's CSP nor the iframe sandbox stops a frame from navigating itself. What does stop it
   * is the CSP of the EMBEDDING document: the runtime page's `default-src 'self'` is its `frame-src`, and Chrome checks
   * every navigation of a child frame against it, including one the child starts itself. The nested iframe is also
   * refused by the layer's own `frame-src`. So through the runtime page, in render and in preview, nothing reaches the
   * canary. This test pins that, so a later `frame-src` relaxation fails here.
   * Defence in depth (orchestrator decision): Task 4 adds CDP request interception in render and Task 7 a webRequest
   * filter in the desktop preview. Both reuse helpers/hostile-layers.ts and assert the same silence.
   */
  it('self-navigation of a layer is blocked by the runtime page (frame-src), in preview and in render', async () => {
    const ui = await stubUi();
    const served: Array<{ path: string; status: number }> = [];
    const server = await startCompositionServer({ uiOrigins: [ui], distDir: dist, onResponse: (e) => { served.push({ path: e.path, status: e.status }); } });
    const selfnav = { ...composition, tracks: [selfNavigationTrack()] };
    const before = canaryHits.length;
    try {
      const prev = await server.mintSession({ creativeDir: site, versionDir, format, composition: selfnav, mode: 'preview', parentOrigin: ui });
      const page = await browser.newPage(W, H);
      await page.goto(`${ui}/`);
      await page.eval(`document.getElementById('f').src = ${JSON.stringify(prev.url)}; true`);
      const render = await server.mintSession({ creativeDir: site, versionDir, format, composition: selfnav, mode: 'render' });
      const top = await browser.newPage(W, H);
      await top.goto(render.url);
      // The layers load at once and each one navigates within a second (meta refresh 0, a script, a click).
      await new Promise((r) => setTimeout(r, 6000));
      expect(canaryHits.slice(before)).toEqual([]);
      // The silence means something only if the hostile layers were really loaded (C9): every one was served, in both modes.
      for (const c of SELF_NAVIGATION_CASES) {
        const hits = served.filter((e) => e.path.endsWith(`/layers/selfnav-${c}.html`) && e.status === 200);
        expect(hits.length, `selfnav-${c} served`).toBeGreaterThanOrEqual(2);
      }
      expect(await page.eval('location.href')).toBe(`${ui}/`);
      expect(await top.eval('location.href')).toBe(render.url);
      await page.close();
      await top.close();
    } finally {
      await server.close();
    }
  }, 120_000);

  /*
   * KNOWN RESIDUAL. A layer URL framed DIRECTLY by a page without our CSP, not through the runtime page, can navigate
   * itself to the canary with location.href, a meta refresh, an anchor click, location.replace, open(url, '_self') or a
   * delayed location.href. Its nested iframe stays blocked by the
   * layer's own CSP. Such a page needs the session token, and the UI never frames a layer directly. The headers alone
   * cannot close this. Task 4 (CDP interception) and Task 7 (webRequest filter) close it where they own the browser. The
   * web preview in the user's browser keeps it (documented; layers load only when the user starts the preview). If this
   * starts failing because the canary is no longer reached, flip it.
   */
  it('KNOWN RESIDUAL: a layer framed directly by a page without our CSP navigates itself to the canary (closed in Tasks 4 and 7)', async () => {
    const ui = await stubUi();
    const server = await startCompositionServer({ uiOrigins: [ui], distDir: dist });
    const page = await browser.newPage(W, H);
    try {
      const s = await server.mintSession({ creativeDir: site, versionDir, format, composition, mode: 'preview', parentOrigin: ui });
      const frames = SELF_NAVIGATION_CASES.map((c) => `${server.origin}/${s.token}/${versionDir}/compositions/${format}/layers/selfnav-${c}.html`);
      await page.goto(`${ui}/`);
      await page.eval(`for (const src of ${JSON.stringify(frames)}) { const f = document.createElement('iframe'); f.sandbox = 'allow-scripts'; f.src = src; document.body.appendChild(f); } true`);
      // Every case that navigates the layer's own frame gets out (the delayed one after 1.5 s of real time: a layer framed
      // directly has no runtime, so nothing freezes or pumps its clock beyond layer.js's own).
      const reached = OWN_FRAME_NAVIGATION_CASES.map((c) => selfNavigationPath(c));
      const t0 = Date.now();
      while (!reached.every((p) => canaryHits.includes(p)) && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 1000));
      expect(canaryHits.filter((p) => p.startsWith('/selfnav-')).sort()).toEqual([...reached].sort());
      expect(canaryHits).not.toContain(selfNavigationPath('iframe'));
      expect(await page.eval('location.href')).toBe(`${ui}/`);
    } finally {
      await page.close();
      await server.close();
    }
  }, 120_000);
});

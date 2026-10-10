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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runtimeBuildOptions } from '../../composition-runtime/tsup.config.ts';
import { findChrome, launchChrome, type Browser, type Page } from '../../composition-runtime/test/support/chrome.ts';
import { COMP_PATH, findFfmpeg, H, LAYER, W, writeFixture } from '../../composition-runtime/test/support/fixture.ts';
import { decodePng, type Image } from '../../composition-runtime/test/support/png.ts';
import { startCompositionServer, type CompositionServer } from '../src/compositions/composition-server.ts';

const chrome = findChrome();
const required = process.env.MS_REQUIRE_CHROME === '1';
const RUNTIME_PKG = join(import.meta.dirname, '../../composition-runtime');
const FONT = join(RUNTIME_PKG, 'test/fixtures/fonts/jetbrains-mono-latin-400-normal.woff2');
/** The hostile clip's box, on top of everything. */
const HOSTILE = { x: 280, y: 140, width: 40, height: 40 };

if (!chrome) {
  if (required) {
    it('Chrome is required (MS_REQUIRE_CHROME=1) but none was found: set CHROME_PATH', () => { throw new Error('no Chrome found'); });
  } else {
    console.warn('[core] composition server Chrome tests SKIPPED: no system Chrome found (set CHROME_PATH). They are required on CI (MS_REQUIRE_CHROME=1).');
  }
}

/** A layer that tries every way out it can think of. It paints itself red when a synchronous attempt did not throw. */
const hostileLayer = (canary: string) => `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;background:#00ff00;overflow:hidden}img,form{position:absolute;left:-1000px;top:0}</style>
<link rel="stylesheet" href="${canary}/css">
</head><body>
<img src="${canary}/img"><img src="file:///etc/hosts">
<form id="f" action="${canary}/form" method="post"><input name="a" value="b"></form>
<script>
  const C = ${JSON.stringify(canary)};
  let escaped = false;
  const attempt = (f) => { try { f(); escaped = true; } catch (e) { /* refused */ } };
  attempt(() => { if (!window.top.document.body) throw 0; });
  attempt(() => { if (!window.parent.document.body) throw 0; });
  attempt(() => { if (typeof window.top.location.href !== 'string') throw 0; });
  attempt(() => history.pushState({}, '', C + '/push'));
  attempt(() => { if (!window.open(C + '/popup')) throw 0; });
  fetch(C + '/fetch').catch(() => {});
  fetch(C + '/fetch-no-cors', { mode: 'no-cors' }).catch(() => {});
  try { new WebSocket(C.replace('http:', 'ws:') + '/ws'); } catch (e) {}
  try { new EventSource(C + '/es'); } catch (e) {}
  try { navigator.sendBeacon(C + '/beacon', 'x'); } catch (e) {}
  try { new Worker(C + '/worker.js'); } catch (e) {}
  import(C + '/mod.js').catch(() => {});
  const s = document.createElement('script'); s.src = C + '/script.js'; document.head.appendChild(s);
  try { document.getElementById('f').submit(); } catch (e) {}
  try { window.top.location = C + '/nav'; } catch (e) {}
  if (escaped) document.body.style.background = '#ff0000';
  window.msReady = Promise.resolve();
</script></body></html>`;

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
    writeFixture(site, FONT, findFfmpeg());
    canary = createServer((req, res) => { canaryHits.push(req.url ?? ''); res.writeHead(204); res.end(); });
    canary.on('upgrade', (req, socket) => { canaryHits.push(`upgrade ${req.url ?? ''}`); socket.destroy(); });
    await new Promise<void>((r) => canary.listen(0, '127.0.0.1', () => r()));
    canaryOrigin = `http://127.0.0.1:${(canary.address() as { port: number }).port}`;
    writeFileSync(join(site, COMP_PATH, 'layers', 'hostile.html'), hostileLayer(canaryOrigin));
    composition = JSON.parse(readFileSync(join(site, COMP_PATH, 'composition.json'), 'utf8')) as Record<string, unknown>;
    (composition.tracks as unknown[]).push({ id: 'hostile', kind: 'visual', clips: [
      { id: 'hostile', type: 'html', src: 'layers/hostile.html', start: 0, duration: 4, props: HOSTILE },
    ] });
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
    const server: CompositionServer = await startCompositionServer({ uiOrigins: [], distDir: dist });
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
      expect(await page.eval('location.href')).toBe(s.url);
    } finally {
      await page.close();
      await server.close();
    }
  }, 300_000);

  it('preview: a sandboxed iframe of the UI origin gets ready with fonts and layers; a foreign origin cannot frame it', async () => {
    const ui = await stubUi();
    const foreign = await stubUi();
    const server = await startCompositionServer({ uiOrigins: () => [ui], distDir: dist });
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
});

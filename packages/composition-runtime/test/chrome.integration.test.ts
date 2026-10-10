// @vitest-environment node
/**
 * The runtime in a real headless Chrome (system Chrome or CHROME_PATH; never downloaded). Skipped with a message when
 * no Chrome is found, unless MS_REQUIRE_CHROME=1 (CI), which turns the skip into a failure. No wall-clock assertions.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runtimeBuildOptions } from '../tsup.config.ts';
import { sourceFrameIndex, videoSourceTime } from '../src/timing.ts';
import { findChrome, launchChrome, type Browser, type Page } from './support/chrome.ts';
import { COMP_PATH, findFfmpeg, H, LAYER, VIDEO, W, writeFixture } from './support/fixture.ts';
import { decodePng, diffRatio, meanGrey, type Image } from './support/png.ts';
import { startCompositionServer, startUiServer, type TestServer } from './support/server.ts';

const chrome = findChrome();
const ffmpeg = findFfmpeg();
const required = process.env.MS_REQUIRE_CHROME === '1';
const FONT = join(import.meta.dirname, '../../web/node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2');

if (!chrome) {
  if (required) {
    it('Chrome is required (MS_REQUIRE_CHROME=1) but none was found: set CHROME_PATH', () => { throw new Error('no Chrome found'); });
  } else {
    console.warn('[composition-runtime] Chrome integration tests SKIPPED: no system Chrome found (set CHROME_PATH). They are required on CI (MS_REQUIRE_CHROME=1).');
  }
}
if (chrome && !ffmpeg && required) {
  it('ffmpeg is required for the video test on CI', () => { throw new Error('no ffmpeg found'); });
}

describe.skipIf(!chrome)('runtime in headless Chrome', () => {
  let work: string;
  let server: TestServer;
  let browser: Browser;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ms-runtime-it-'));
    const dist = join(work, 'dist');
    await build({ ...runtimeBuildOptions(dist), config: false } as Parameters<typeof build>[0]);
    writeFixture(join(work, 'site'), FONT, ffmpeg);
    server = await startCompositionServer({ distDir: dist, root: join(work, 'site'), compPath: COMP_PATH });
    browser = await launchChrome(chrome!);
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (work) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  /** Opens a render page, runs `fn`, and always closes the page (a page left open is a background window). */
  async function withRender(fn: (page: Page) => Promise<void>): Promise<void> {
    const page = await openRender();
    try { await fn(page); } finally { await page.close(); }
  }
  async function openRender(): Promise<Page> {
    const page = await browser.newPage(W, H);
    await page.goto(server.pageUrl('mode=render'));
    const info = await page.eval<{ duration: number; fps: number; frames: number; errors: unknown[] }>('window.__ms.ready()');
    expect(info.errors).toEqual([]);
    expect(info).toMatchObject({ duration: 4, fps: 30, frames: 120 });
    return page;
  }
  const shot = async (page: Page, t: number): Promise<Image> => {
    await page.eval(`window.__ms.seek(${t})`);
    return decodePng(await page.screenshot());
  };
  /** Width of the msSeek bar: red pixels from the left edge of the layer's first row. */
  const barWidth = (img: Image, ox = 0, oy = 0) => {
    let x = 0;
    while (x < W && (() => { const [r, g, b] = img.px(ox + LAYER.x + x, oy + LAYER.y + 10); return r > 128 && g < 100 && b < 100; })()) x++;
    return x;
  };
  /** The x of the first white pixel in a canvas row of the layer (rAF + clock driven rectangles). */
  const rectX = (img: Image, row: number) => {
    for (let x = 0; x < W; x++) { const [r, g, b] = img.px(x, LAYER.y + 30 + row); if (r > 200 && g > 200 && b > 200) return x; }
    return -1;
  };

  it('exposes the render API and loads with no errors (fonts, svg, layer, video)', async () => {
    await withRender(async (page) => {
      expect(await page.eval('[window.__ms.mode, window.__ms.duration, window.__ms.fps, typeof window.__ms.seek]')).toEqual(['render', 4, 30, 'function']);
      // No network API was used: every request went to the token-prefixed paths of the composition server.
      expect(server.requests.filter((p) => p !== '/favicon.ico').every((p) => p.startsWith(`/${server.token}/`))).toBe(true);
    });
  }, 240_000);

  it('two seeks to the same t give the same frame (within tolerance)', async () => {
    await withRender(async (page) => {
      const a = await shot(page, 1.5);
      await shot(page, 2.7);
      await shot(page, 0.2);
      const b = await shot(page, 1.5);
      expect(diffRatio(a, b)).toBeLessThan(0.002);
    });
  }, 240_000);

  it("calls the html layer's msSeek with the layer's local time, after msReady, and passes msParams", async () => {
    await withRender(async (page) => {
      for (const t of [0.5, 1.5, 3.2]) {
        const img = await shot(page, t);
        expect(barWidth(img)).toBe(Math.round((t - LAYER.start) * 50));
      }
    });
  }, 240_000);

  it.skipIf(!ffmpeg)('lands the video on the expected source frame (24 fps source, trimStart, 30 fps composition)', async () => {
    await withRender(async (page) => {
      const decode = (img: Image) => {
        const digit = (x: number) => Math.round((meanGrey(img, x, VIDEO.y + VIDEO.height / 2) * 219) / 255 / 20);
        return digit(VIDEO.x + (VIDEO.width * 3) / 4) * 10 + digit(VIDEO.x + VIDEO.width / 4);
      };
      for (const k of [30, 31, 32, 37, 45, 59, 74, 88, 104]) {
        const t = k / 30;
        const expected = sourceFrameIndex(videoSourceTime(VIDEO, t), VIDEO.sourceFps);
        expect(expected).toBe(Math.floor((VIDEO.trimStart + (t - VIDEO.start)) * 24 + 1e-6));
        expect({ t, frame: decode(await shot(page, t)) }).toEqual({ t, frame: expected });
      }
    });
  }, 240_000);

  it('the virtual clock makes a canvas driven by rAF, performance.now, Date and timers identical across two renders', async () => {
    const times = [0.5, 1.25, 2, 3.5];
    const a = new Map<number, Image>();
    await withRender(async (page) => { for (const t of times) a.set(t, await shot(page, t)); });
    const b = new Map<number, Image>();
    // Another seek history, still forward in time like a render segment (the probe's 1 s timer sets state that stays set,
    // as any stateful layer code would: only the time-pure parts may be compared across arbitrary histories).
    await withRender(async (page) => {
      for (const extra of [0.1, 0.3, 0.45]) await page.eval(`window.__ms.seek(${extra})`);
      for (const t of times) b.set(t, await shot(page, t));
    });
    for (const t of times) {
      const x = Math.round(t * 40);
      expect({ t, perf: rectX(a.get(t)!, 5), date: rectX(a.get(t)!, 23) }).toEqual({ t, perf: x, date: x });
      expect(diffRatio(a.get(t)!, b.get(t)!)).toBeLessThan(0.002);
    }
    // The 1 s timer fired before 1.25 s, in both renders.
    expect(rectX(a.get(1.25)!, 42)).toBe(0);
    expect(rectX(a.get(0.5)!, 42)).toBe(-1);
  }, 240_000);

  it('preview: a sandboxed iframe on another origin gets ready, time and clipBounds; foreign origins are ignored', async () => {
    const ui = await startUiServer(() => '<!doctype html><html><body style="margin:0;background:#000">'
      + `<iframe id="f" sandbox="allow-scripts" allow="autoplay" style="border:0;width:${W}px;height:${H}px;display:block"></iframe>`
      + '<script>window.msgs=[];const f=document.getElementById("f");'
      + 'addEventListener("message",(e)=>{if(e.source===f.contentWindow)window.msgs.push(e.data);});</script></body></html>');
    const prev = await startCompositionServer({ distDir: join(work, 'dist'), root: join(work, 'site'), compPath: COMP_PATH, frameAncestors: ui.origin });
    try {
      const page = await browser.newPage(W, H);
      await page.goto(`${ui.origin}/`);
      await page.eval(`document.getElementById('f').src = ${JSON.stringify(prev.pageUrl(`mode=preview&parentOrigin=${encodeURIComponent(ui.origin)}`))}; true`);
      const wait = (expr: string) => page.eval(`new Promise((res, rej) => { const t0 = Date.now(); (function poll() {
        const v = (${expr}); if (v) return res(v); if (Date.now() - t0 > 180000) return rej(new Error('timeout')); setTimeout(poll, 50); })(); })`, 200_000);
      const ready = await wait("window.msgs.find((m) => m.type === 'ready')") as { duration: number; errors: unknown[]; width: number };
      expect(ready).toMatchObject({ duration: 4, width: W, height: H, fps: 30, version: 1 });
      expect(ready.errors).toEqual([]);
      expect(await page.eval("window.msgs.filter((m) => m.type === 'error')")).toEqual([]);

      await page.eval("window.msgs.length = 0; document.getElementById('f').contentWindow.postMessage({ type: 'seek', t: 1.5 }, '*'); true");
      expect(await wait("window.msgs.find((m) => m.type === 'time')")).toEqual({ type: 'time', t: 1.5, playing: false });
      expect(barWidth(decodePng(await page.screenshot()))).toBe(75);

      await page.eval("document.getElementById('f').contentWindow.postMessage({ type: 'select', clipId: 'logo' }, '*'); true");
      const bounds = await wait("window.msgs.find((m) => m.type === 'clipBounds' && m.bounds)") as { bounds: { x: number; width: number }; scale: number };
      expect(bounds.scale).toBe(1);
      expect(bounds.bounds.x).toBeCloseTo(270, 0);
      expect(bounds.bounds.width).toBeCloseTo(40, 0);

      // Unknown commands do nothing; play then pause reports times while playing.
      await page.eval("window.msgs.length = 0; const w = document.getElementById('f').contentWindow; w.postMessage({ type: 'load', composition: {} }, '*'); w.postMessage({ type: 'play', loop: true }, '*'); true");
      await wait("window.msgs.filter((m) => m.type === 'time' && m.playing).length >= 3");
      await page.eval("document.getElementById('f').contentWindow.postMessage({ type: 'pause' }, '*'); true");
      await wait("window.msgs.some((m) => m.type === 'time' && !m.playing)");
      await page.close();

      // The same page with another parent origin: the runtime never answers this parent.
      const other = await browser.newPage(W, H);
      await other.goto(`${ui.origin}/`);
      await other.eval(`document.getElementById('f').src = ${JSON.stringify(prev.pageUrl('mode=preview&parentOrigin=' + encodeURIComponent('http://127.0.0.1:1')))}; true`);
      await other.eval("new Promise((r) => document.getElementById('f').addEventListener('load', () => r(true)))", 200_000);
      await other.eval("document.getElementById('f').contentWindow.postMessage({ type: 'seek', t: 1 }, '*'); new Promise((r) => setTimeout(r, 1500))");
      expect(await other.eval('window.msgs')).toEqual([]);
      await other.close();
    } finally {
      await prev.close();
      await ui.close();
    }
  }, 300_000);
});

// @vitest-environment node
/**
 * The runtime in a real headless Chrome (system Chrome or CHROME_PATH; never downloaded). Skipped with a message when
 * no Chrome is found, unless MS_REQUIRE_CHROME=1 (CI), which turns the skip into a failure. No wall-clock assertions.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runtimeBuildOptions } from '../tsup.config.ts';
import { sourceFrameIndex, videoSourceTime } from '../src/timing.ts';
import { findChrome, launchChrome, Page, type Browser } from './support/chrome.ts';
import { CLOCK_PATH, COMP_PATH, findFfmpeg, H, LAYER, OFFSCREEN_PATH, VIDEO, W, writeClockFixture, writeFixture, writeOffscreenFixture } from './support/fixture.ts';
import { decodePng, diffRatio, meanGrey, type Image } from './support/png.ts';
import { startCompositionServer, startUiServer, type TestServer } from './support/server.ts';

const chrome = findChrome();
const ffmpeg = findFfmpeg();
const required = process.env.MS_REQUIRE_CHROME === '1';
// A vendored OFL font (JetBrains Mono, latin 400; licence in test/fixtures/fonts/OFL.txt).
const FONT = join(import.meta.dirname, 'fixtures/fonts/jetbrains-mono-latin-400-normal.woff2');

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
      // A render page never loads the draft parser (zod): that script is the preview's only.
      expect(server.requests.some((p) => p.endsWith('/runtime/preview.js'))).toBe(false);
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

  /** The fixture's composition, as written to disk (a fresh copy). */
  const fixtureComposition = () => JSON.parse(readFileSync(join(work, 'site', COMP_PATH, 'composition.json'), 'utf8')) as {
    tracks: Array<{ id: string; clips: Array<{ id: string; hidden?: boolean; props: Record<string, unknown> }> }>;
  };
  const clipOf = (c: ReturnType<typeof fixtureComposition>, id: string) => c.tracks.flatMap((t) => t.clips).find((x) => x.id === id)!;
  /** The logo's teal (#2dd4bf) at (x, y). */
  const teal = (img: Image, x: number, y: number) => { const [r, g, b] = img.px(x, y); return r < 120 && g > 150 && b > 140; };

  /**
   * A UI page on its own origin with the runtime in a sandboxed preview frame. `messages` are the frame's, in order;
   * `inFrame` evaluates in the runtime frame's own document (CDP execution context), for counting what it holds.
   */
  async function openPreview() {
    const ui = await startUiServer(() => '<!doctype html><html><body style="margin:0;background:#000">'
      + `<iframe id="f" sandbox="allow-scripts" allow="autoplay" style="border:0;width:${W}px;height:${H}px;display:block"></iframe>`
      + '<script>window.msgs=[];const f=document.getElementById("f");'
      + 'addEventListener("message",(e)=>{if(e.source===f.contentWindow)window.msgs.push(e.data);});'
      + 'window.send=(m)=>{f.contentWindow.postMessage(m,"*");return true;};'
      + 'window.waitFor=(pred)=>new Promise((res,rej)=>{const t0=Date.now();(function poll(){const v=window.msgs.find(pred);if(v)return res(v);'
      + 'if(Date.now()-t0>180000)return rej(new Error("timeout"));setTimeout(poll,5);})();});</script></body></html>');
    const prev = await startCompositionServer({ distDir: join(work, 'dist'), root: join(work, 'site'), compPath: COMP_PATH, frameAncestors: ui.origin });
    const page = await browser.newPage(W, H);
    // The sandboxed runtime frame runs out of process: it is reached as its own target (auto-attached, flat session).
    const frames: Array<{ sessionId: string; targetId: string }> = [];
    page.on('Target.attachedToTarget', (p) => {
      const info = p.targetInfo as { type: string; targetId: string };
      if (info.type === 'iframe') frames.push({ sessionId: p.sessionId as string, targetId: info.targetId });
    });
    await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await page.goto(`${ui.origin}/`);
    await page.eval(`document.getElementById('f').src = ${JSON.stringify(prev.pageUrl(`mode=preview&parentOrigin=${encodeURIComponent(ui.origin)}`))}; true`);
    const ready = await page.eval<{ errors: unknown[] }>("window.waitFor((m) => m.type === 'ready')", 200_000);
    expect(ready.errors).toEqual([]);
    const infos = ((await browser.send('Target.getTargets')) as { targetInfos: Array<{ targetId: string; url: string }> }).targetInfos;
    const target = frames.find((f) => infos.some((i) => i.targetId === f.targetId && i.url.includes('/runtime/index.html')));
    const frame = target ? new Page(browser, target.sessionId) : null;
    /** Live frame targets of the whole browser (an out-of-process layer frame is one). */
    const frameTargets = async () => ((await browser.send('Target.getTargets')) as { targetInfos: Array<{ type: string }> }).targetInfos.filter((t) => t.type === 'iframe').length;
    const setComposition = async (composition: unknown, seq: number, keepTime = true) => {
      await page.eval(`window.msgs.length = 0; window.send(${JSON.stringify({ type: 'setComposition', composition, keepTime, seq })})`);
      return page.eval<{ seq: number; errors: unknown[] }>(`window.waitFor((m) => m.type === 'compositionApplied' && m.seq === ${seq})`, 200_000);
    };
    return {
      page, setComposition, frameTargets,
      // Same process (no separate target): the UI page's own context of the frame cannot be told apart, so this fails loudly.
      inFrame: <T>(expr: string) => { if (!frame) throw new Error('the runtime frame is not a separate target'); return frame.eval<T>(expr); },
      close: async () => { await page.close(); await prev.close(); await ui.close(); },
    };
  }

  /**
   * A screenshot taken once the page has painted what `ready` looks for (bounded, 20 s): under machine load the compositor
   * can lag the applied message by a few frames. The assertions on the returned image stay exactly as strict.
   */
  async function paintedShot(page: Page, ready: (img: Image) => boolean): Promise<Image> {
    const deadline = Date.now() + 20_000;
    let img = decodePng(await page.screenshot());
    while (!ready(img) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      img = decodePng(await page.screenshot());
    }
    return img;
  }

  it('preview setComposition: the frame changes at the same t, the selection is kept, a hidden clip is not drawn', async () => {
    const p = await openPreview();
    try {
      await p.page.eval("window.msgs.length = 0; window.send({ type: 'seek', t: 1.5 }); window.send({ type: 'select', clipId: 'logo' })");
      await p.page.eval("window.waitFor((m) => m.type === 'clipBounds' && m.clipId === 'logo' && m.bounds)");
      const before = await paintedShot(p.page, (i) => teal(i, 290, 30) && barWidth(i) === 75);
      expect(teal(before, 290, 30)).toBe(true);
      expect(barWidth(before)).toBe(75);

      // zod runs jitless in the runtime: loading the parser (zod builds the schema then) and validating a draft raise no CSP
      // violation (no `new Function`, M2). preview.js is loaded once more under a listener to see its load (its second
      // definition of the parser throws, harmlessly).
      await p.inFrame("window.__violations = []; document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`)); "
        + "new Promise((r) => { const s = document.createElement('script'); s.src = 'preview.js'; s.onload = s.onerror = () => r(true); document.head.appendChild(s); })");
      const moved = fixtureComposition();
      Object.assign(clipOf(moved, 'logo').props, { x: 200, y: 55 });
      const applied = await p.setComposition(moved, 1);
      expect(applied.errors).toEqual([]);
      expect(await p.inFrame('window.__violations')).toEqual([]);
      const msgs = await p.page.eval<Array<{ type: string; t?: number; clipId?: string; bounds?: { x: number; y: number } | null }>>('window.msgs');
      expect(msgs.filter((m) => m.type === 'time').at(-1)).toMatchObject({ t: 1.5, playing: false });
      const bounds = msgs.filter((m) => m.type === 'clipBounds').at(-1)!;
      expect(bounds.clipId).toBe('logo');
      expect(bounds.bounds!.x).toBeCloseTo(200, 0);
      expect(bounds.bounds!.y).toBeCloseTo(55, 0);
      const after = await paintedShot(p.page, (i) => !teal(i, 290, 30) && teal(i, 220, 75) && barWidth(i) === 75);
      expect(teal(after, 290, 30)).toBe(false);
      expect(teal(after, 220, 75)).toBe(true);
      expect(barWidth(after)).toBe(75); // the html layer was re-mounted and seeked to the same t

      const hidden = fixtureComposition();
      Object.assign(clipOf(hidden, 'logo'), { hidden: true });
      await p.setComposition(hidden, 2);
      const shot = await paintedShot(p.page, (i) => !teal(i, 290, 30) && !teal(i, 220, 75));
      expect(teal(shot, 290, 30)).toBe(false);
      expect(teal(shot, 220, 75)).toBe(false);
      const last = (await p.page.eval<Array<{ type: string; clipId?: string; bounds?: unknown }>>('window.msgs')).filter((m) => m.type === 'clipBounds').at(-1)!;
      expect(last).toMatchObject({ clipId: 'logo', bounds: null }); // still selected (the clip exists), not drawn
      expect(await p.inFrame<number>("document.querySelectorAll('[data-clip-id=\"logo\"]').length")).toBe(0);
    } finally {
      await p.close();
    }
  }, 300_000);

  it('preview: 200 consecutive setComposition keep the media elements, layer frames, fonts and animations constant', async () => {
    const p = await openPreview();
    try {
      const counts = () => p.inFrame<number[]>("[document.querySelectorAll('video, audio').length, document.querySelectorAll('iframe').length, "
        + "document.querySelectorAll('.ms-stage').length, document.fonts.size, document.getAnimations().length]");
      const first = fixtureComposition();
      await p.setComposition(first, 1);
      const base = await counts();
      const targetsBase = await p.frameTargets();
      expect(base[1]).toBe(1); // the layer frame
      expect(base[2]).toBe(1);
      const c = fixtureComposition();
      // In the page: post the next draft once the previous one is applied, 200 times.
      await p.page.eval(`(async () => {
        const c = ${JSON.stringify(c)};
        for (let i = 2; i <= 201; i++) {
          c.tracks.find((t) => t.id === 'text').clips[0].props.text = 'Hi ' + i;
          window.msgs.length = 0;
          window.send({ type: 'setComposition', composition: c, keepTime: true, seq: i });
          const a = await window.waitFor((m) => m.type === 'compositionApplied' && m.seq === i);
          if (a.errors.length) throw new Error(JSON.stringify(a.errors));
        }
        return true;
      })()`, 280_000);
      expect(await counts()).toEqual(base);
      // No frame of an old mount lives on as a target either.
      expect(await p.frameTargets()).toBe(targetsBase);
    } finally {
      await p.close();
    }
  }, 320_000);

  it('render mode ignores setComposition: the captured frame is unchanged', async () => {
    await withRender(async (page) => {
      const a = await shot(page, 1.5);
      expect(teal(a, 290, 30)).toBe(true);
      const hidden = fixtureComposition();
      Object.assign(clipOf(hidden, 'logo'), { hidden: true });
      await page.eval(`window.postMessage(${JSON.stringify({ type: 'setComposition', composition: hidden, seq: 1 })}, '*'); true`);
      await new Promise((r) => setTimeout(r, 500)); // the page's own timers run on the frozen virtual clock
      const b = await shot(page, 1.5);
      expect(teal(b, 290, 30)).toBe(true);
      expect(diffRatio(a, b)).toBeLessThan(0.002);
    });
  }, 240_000);

  it('render mode does not draw a hidden clip', async () => {
    const hidden = fixtureComposition();
    Object.assign(clipOf(hidden, 'logo'), { hidden: true });
    const site = join(work, 'site-hidden');
    writeFixture(site, FONT, null);
    writeFileSync(join(site, COMP_PATH, 'composition.json'), JSON.stringify({ ...hidden, tracks: hidden.tracks.filter((t) => t.id !== 'bg') }));
    const srv = await startCompositionServer({ distDir: join(work, 'dist'), root: site, compPath: COMP_PATH });
    const page = await browser.newPage(W, H);
    try {
      await page.goto(srv.pageUrl('mode=render'));
      await page.eval('window.__ms.ready()');
      await page.eval('window.__ms.seek(1.5)');
      expect(teal(decodePng(await page.screenshot()), 290, 30)).toBe(false);
    } finally {
      await page.close();
      await srv.close();
    }
  }, 240_000);

  // Phase 14, task 0 (UX 1 follow-up 3, decision 740): a throttled offscreen layer got no animation frames and failed its
  // seek after the 30 s frame timeout. The test timeout is below it, so waiting it out fails the test.
  it('render: html layers outside the frame (parked, slid out, scaled to 0) do not hold the seek; they paint once in view', async () => {
    const site = join(work, 'site-offscreen');
    writeOffscreenFixture(site);
    const srv = await startCompositionServer({ distDir: join(work, 'dist'), root: site, compPath: OFFSCREEN_PATH });
    const page = await browser.newPage(W, H);
    const rgb = (img: Image, x: number, y: number) => { const [r, g, b] = img.px(x, y); return [r > 128 ? 1 : 0, g > 128 ? 1 : 0, b > 128 ? 1 : 0].join(''); };
    try {
      await page.goto(srv.pageUrl('mode=render'));
      const info = await page.eval<{ errors: unknown[] }>('window.__ms.ready()');
      expect(info.errors).toEqual([]);
      const at = async (t: number) => { await page.eval(`window.__ms.seek(${t})`); const img = decodePng(await page.screenshot()); return [rgb(img, 80, 90), rgb(img, 240, 90)]; };
      expect(await at(0.5)).toEqual(['000', '000']); // both out of the frame: black background
      expect(await at(1.5)).toEqual(['000', '110']); // slide still parked at x -2500; shrunk at full size (yellow)
      expect(await at(2.5)).toEqual(['010', '110']); // slide in view, seeked to t 2.5 (green)
      expect(await at(0.2)).toEqual(['000', '000']); // and out again
      expect(await page.eval('window.__ms.errors')).toEqual([]);
    } finally {
      await page.close();
      await srv.close();
    }
  }, 25_000);

  // UX feedback 1, task 2b (decision 709): before, each such layer held the render until the 60 s layer timeout (63 s
  // measured for a storyboard). The test timeout is below that timeout, so waiting it out fails the test.
  it('render: a layer whose msReady or msSeek waits on a timer fails fast with layerStalled and a diagnostic, not on the 60 s layer timeout', async () => {
    const site = join(work, 'site-clock');
    writeClockFixture(site);
    const srv = await startCompositionServer({ distDir: join(work, 'dist'), root: site, compPath: CLOCK_PATH });
    const page = await browser.newPage(W, H);
    try {
      await page.goto(srv.pageUrl('mode=render'));
      const info = await page.eval<{ errors: Array<{ code: string; clipId?: string; message: string }> }>('window.__ms.ready()');
      const readyErr = info.errors.filter((e) => e.clipId === 'ready-clock');
      expect(readyErr.map((e) => e.code)).toEqual(['layerStalled']);
      expect(readyErr[0]!.message).toMatch(/msReady waited .* for a timer .* render clock never fires: .*setTimeout, setInterval, Date or performance\.now/);
      // Ruling AF: a perpetual requestAnimationFrame loop (a ticker) does not keep the watchdog off. The stall diagnostic, not
      // the runtime's 60 s layer timeout message, proves it failed on the 5 s watchdog (the test's own limit is 40 s).
      const rafErr = info.errors.filter((e) => e.clipId === 'raf-clock');
      expect(rafErr.map((e) => e.code)).toEqual(['layerStalled']);
      expect(rafErr[0]!.message).toMatch(/msReady waited 5 s for a timer \(due in 300 ms\) that the render clock never fires/);
      for (const t of [0.5, 1]) await page.eval(`window.__ms.seek(${t})`);
      const errors = await page.eval<Array<{ code: string; clipId?: string; message: string }>>('window.__ms.errors');
      // ready() shows t = 0, so the seek-clock layer is seeked three times: the first waits, the others fail at once.
      const seeks = errors.filter((e) => e.clipId === 'seek-clock');
      expect(seeks.map((e) => e.code)).toEqual(['layerStalled', 'layerStalled', 'layerStalled']);
      expect(seeks[0]!.message).toMatch(/msSeek waited .* for a timer .* render clock never fires/);
      for (const e of seeks.slice(1)) expect(e.message).toMatch(/msSeek not called again: msSeek waited/);
      // The layers whose msReady failed still answer their seeks: only the seek-clock layer reports seek errors.
      expect(errors.filter((e) => e.clipId === 'ready-clock')).toHaveLength(1);
      expect(errors.filter((e) => e.clipId === 'raf-clock')).toHaveLength(1);
    } finally {
      await page.close();
      await srv.close();
    }
  }, 40_000);
});

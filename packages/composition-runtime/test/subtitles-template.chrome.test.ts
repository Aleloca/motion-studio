// @vitest-environment node
/**
 * A subtitles template in a real headless Chrome (Task 17): the template is an html layer (sandboxed frame, `layer.js`
 * bootstrap) that paints from `window.msActiveCue` in its `msSeek`. The set is the largest allowed (2000 cues of 200
 * characters), so its configuration in the frame's `name` is about half a megabyte. Skipped without Chrome, unless
 * MS_REQUIRE_CHROME=1. In the preview, `setSubtitles` opens the template again with the new set and swaps it in.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runtimeBuildOptions } from '../tsup.config.ts';
import type { RuntimeSubtitles } from '../src/subtitles.ts';
import { findChrome, launchChrome, type Browser } from './support/chrome.ts';
import { decodePng } from './support/png.ts';
import { startCompositionServer, startUiServer, type TestServer } from './support/server.ts';

const chrome = findChrome();
if (!chrome && process.env.MS_REQUIRE_CHROME === '1') it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('no Chrome found'); });
const COMP = 'v1/compositions/reel';
const W = 540;
const H = 960;
const SUBS: RuntimeSubtitles = {
  lang: 'it',
  cues: [
    { start: 1000, end: 3500, text: 'Ciao a tutti' },
    ...Array.from({ length: 1999 }, (_, i) => ({ start: 10_000 + i * 1000, end: 10_500 + i * 1000, text: 'x'.repeat(200) })),
  ],
};
/** A red bar as wide as the line's progress, only when the whole set arrived (else a full green bar). */
const TEMPLATE = `<!doctype html><html><body style="margin:0;background:transparent">
<div id="bar" style="position:absolute;left:0;top:0;height:40px;width:0;background:#ff0000"></div>
<script>
window.msSeek = (t) => {
  const bar = document.getElementById('bar');
  if (window.msSubtitles.cues.length !== 2000) { bar.style.width = '${W}px'; bar.style.background = '#00ff00'; return; }
  const c = window.msActiveCue(t * 1000);
  bar.style.width = c ? Math.round(c.progress * ${W}) + 'px' : '0px';
};
</script></body></html>`;

describe.skipIf(!chrome)('a subtitles template in Chrome', () => {
  let work: string;
  let server: TestServer;
  let browser: Browser;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ms-runtime-subs-tpl-'));
    const dist = join(work, 'dist');
    await build({ ...runtimeBuildOptions(dist), config: false } as Parameters<typeof build>[0]);
    const dir = join(work, 'site', COMP);
    mkdirSync(join(dir, 'layers'), { recursive: true });
    writeFileSync(join(dir, 'layers', 'subs.html'), TEMPLATE);
    writeFileSync(join(dir, 'composition.json'), JSON.stringify({
      $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: 4, background: '#1e3a5f',
      fonts: [], scenes: [{ id: 'all', start: 0, duration: 4 }],
      tracks: [{ id: 'subs', kind: 'subtitles', clips: [{ id: 'subs', type: 'subtitles', start: 0, duration: 4, template: 'layers/subs.html',
        props: { fontSize: 40, color: '#ffffff', position: 'bottom', margin: 40, maxWidth: 0.8 } }] }],
    }));
    server = await startCompositionServer({ distDir: dist, root: join(work, 'site'), compPath: COMP, data: { subtitles: SUBS } });
    browser = await launchChrome(chrome!);
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (work) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('the template paints the active line from msActiveCue at each seek; no built-in box', async () => {
    const page = await browser.newPage(W, H);
    try {
      await page.goto(server.pageUrl('mode=render'));
      const info = await page.eval<{ errors: unknown[] }>('window.__ms.ready()');
      expect(info.errors).toEqual([]);
      expect(await page.eval('document.querySelectorAll(".ms-subs, .ms-subs-box").length')).toBe(0);
      const red = (img: ReturnType<typeof decodePng>, x: number) => { const [r, g, b] = img.px(x, 20); return r > 200 && g < 60 && b < 60; };
      await page.eval('window.__ms.seek(2)'); // 40% through the 1000–3500 cue: a bar 216 px wide
      const at2 = decodePng(await page.screenshot());
      expect(red(at2, 200)).toBe(true);
      expect(red(at2, 232)).toBe(false);
      await page.eval('window.__ms.seek(3)'); // 80%: 432 px
      const at3 = decodePng(await page.screenshot());
      expect(red(at3, 420)).toBe(true);
      expect(red(at3, 450)).toBe(false);
      await page.eval('window.__ms.seek(3.8)'); // no line
      const after = decodePng(await page.screenshot());
      expect(red(after, 10)).toBe(false);
      const [, g] = after.px(10, 20);
      expect(g).toBeLessThan(200); // not the green bar of a set that did not arrive whole
    } finally {
      await page.close();
    }
  }, 120_000);

  it('preview: setSubtitles swaps in a template opened with the new set, at the time shown', async () => {
    const ui = await startUiServer(() => '<!doctype html><html><body style="margin:0;background:#000">'
      + `<iframe id="f" sandbox="allow-scripts" style="border:0;width:${W}px;height:${H}px;display:block"></iframe>`
      + '<script>window.msgs=[];const f=document.getElementById("f");'
      + 'addEventListener("message",(e)=>{if(e.source===f.contentWindow)window.msgs.push(e.data);});'
      + 'window.send=(m)=>{f.contentWindow.postMessage(m,"*");return true;};</script></body></html>');
    const prev = await startCompositionServer({ distDir: join(work, 'dist'), root: join(work, 'site'), compPath: COMP, frameAncestors: ui.origin, data: { subtitles: SUBS } });
    const page = await browser.newPage(W, H);
    try {
      await page.goto(`${ui.origin}/`);
      await page.eval(`document.getElementById('f').src = ${JSON.stringify(prev.pageUrl(`mode=preview&parentOrigin=${encodeURIComponent(ui.origin)}`))}; true`);
      const wait = (expr: string) => page.eval(`new Promise((res, rej) => { const t0 = Date.now(); (function poll() {
        const v = (${expr}); if (v) return res(v); if (Date.now() - t0 > 60000) return rej(new Error('timeout')); setTimeout(poll, 20); })(); })`, 90_000);
      const ready = await wait("window.msgs.find((m) => m.type === 'ready')") as { errors: unknown[] };
      expect(ready.errors).toEqual([]);
      await page.eval("window.msgs.length = 0; window.send({ type: 'seek', t: 2 })");
      await wait("window.msgs.find((m) => m.type === 'time')");
      const red = (img: ReturnType<typeof decodePng>, x: number) => { const [r, g, b] = img.px(x, 20); return r > 200 && g < 60 && b < 60; };
      const before = decodePng(await page.screenshot());
      expect([red(before, 200), red(before, 232)]).toEqual([true, false]); // 40%: 216 px
      // 2000 cues again (the template checks it), the first now 0–4000: at 2 s, half way, 270 px.
      const next = { lang: 'it', cues: [{ start: 0, end: 4000, text: 'Corretto' }, ...SUBS.cues.slice(1)] };
      await page.eval(`window.send({ type: 'setSubtitles', subtitles: ${JSON.stringify(next)} })`);
      // The old layer stays until the new one is ready and sought: never a blank line in between.
      let swapped = false;
      for (let i = 0; i < 200 && !swapped; i++) {
        const img = decodePng(await page.screenshot());
        expect(red(img, 200)).toBe(true);
        swapped = red(img, 260);
        if (!swapped) await new Promise((r) => setTimeout(r, 50));
      }
      expect(swapped).toBe(true);
      const after = decodePng(await page.screenshot());
      expect([red(after, 260), red(after, 285)]).toEqual([true, false]);
      expect(await page.eval("window.msgs.filter((m) => m.type === 'error')")).toEqual([]);
    } finally {
      await page.close();
      await prev.close();
      await ui.close();
    }
  }, 180_000);
});

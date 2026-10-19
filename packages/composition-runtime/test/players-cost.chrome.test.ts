// @vitest-environment node
/**
 * Report 41: the cost of many live preview players on one page (a store pack's 19 boards), measured before choosing how the
 * canvas shows a format while a turn is still writing it. A UI page on its own origin holds N sandboxed preview frames of the
 * fixture composition (an html layer drawing every frame, a video clip when ffmpeg is there), at a canvas board's size; for
 * each case the page's frame times (rAF intervals) and the browser's CPU time (all processes, SystemInfo.getProcessInfo) are
 * taken over a few seconds. Opt-in only (MS_MEASURE_PLAYERS=1, with Chrome): it measures, it asserts nothing about time.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runtimeBuildOptions } from '../tsup.config.ts';
import { findChrome, launchChrome, type Browser } from './support/chrome.ts';
import { COMP_PATH, findFfmpeg, writeFixture } from './support/fixture.ts';
import { startCompositionServer, startUiServer, type TestServer } from './support/server.ts';

const chrome = process.env.MS_MEASURE_PLAYERS === '1' ? findChrome() : null;
const FONT = join(import.meta.dirname, 'fixtures/fonts/jetbrains-mono-latin-400-normal.woff2');
const SECONDS = 4;

describe.skipIf(!chrome)('report 41: cost of N live players', () => {
  let work: string;
  let ui: { origin: string; close(): Promise<void> };
  let prev: TestServer;
  let browser: Browser;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ms-players-cost-'));
    const dist = join(work, 'dist');
    await build({ ...runtimeBuildOptions(dist), config: false } as Parameters<typeof build>[0]);
    writeFixture(join(work, 'site'), FONT, findFfmpeg());
    // A canvas board at the store pack's opening zoom is ~125×270 px; a 1440 px window fits a bit more.
    ui = await startUiServer(() => '<!doctype html><html><body style="margin:0;background:#111;display:flex;flex-wrap:wrap;gap:8px">'
      + '<script>window.msgs=[];window.frames2=[];addEventListener("message",(e)=>{window.msgs.push(e.data);});'
      + 'window.add=(n,src)=>{for(let i=0;i<n;i++){const f=document.createElement("iframe");f.sandbox="allow-scripts";f.allow="autoplay";'
      + 'f.style.cssText="border:0;width:125px;height:270px;display:block";f.src=src;document.body.appendChild(f);window.frames2.push(f);}return true;};'
      + 'window.all=(m)=>{for(const f of window.frames2)f.contentWindow.postMessage(m,"*");return true;};'
      + 'window.sample=(ms)=>new Promise((res)=>{const d=[];let last=performance.now();const t0=last;'
      + '(function tick(now){d.push(now-last);last=now;if(now-t0<ms)requestAnimationFrame(tick);else{d.shift();d.sort((a,b)=>a-b);'
      + 'res({frames:d.length,mean:d.reduce((a,b)=>a+b,0)/d.length,p95:d[Math.floor(d.length*0.95)],max:d[d.length-1],long:d.filter((x)=>x>50).length});}})(last);});'
      + '</script></body></html>');
    prev = await startCompositionServer({ distDir: dist, root: join(work, 'site'), compPath: COMP_PATH, frameAncestors: ui.origin });
    browser = await launchChrome(chrome!);
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await prev?.close();
    await ui?.close();
    if (work) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  const cpu = async () => {
    const info = await browser.send('SystemInfo.getProcessInfo') as { processInfo: Array<{ type: string; cpuTime: number }> };
    return { total: info.processInfo.reduce((s, p) => s + p.cpuTime, 0), processes: info.processInfo.length };
  };

  it('measures 0, 19 paused and 19 playing players', async () => {
    const results: Record<string, unknown> = {};
    for (const [name, n, play] of [['none', 0, false], ['19 paused', 19, false], ['19 playing', 19, true], ['4 playing', 4, true]] as const) {
      const page = await browser.newPage(1440, 900);
      try {
        await page.goto(`${ui.origin}/`);
        const src = prev.pageUrl(`mode=preview&parentOrigin=${encodeURIComponent(ui.origin)}`);
        await page.eval(`window.add(${n}, ${JSON.stringify(src)})`);
        if (n) await page.eval(`new Promise((res) => { (function poll() { if (window.msgs.filter((m) => m.type === 'ready').length >= ${n}) return res(true); setTimeout(poll, 50); })(); })`, 200_000);
        await page.eval(play ? "window.all({ type: 'play', loop: true })" : "window.all({ type: 'seek', t: 1 })");
        await new Promise((r) => setTimeout(r, 3000));
        const c0 = await cpu();
        const frames = await page.eval<Record<string, number>>(`window.sample(${SECONDS * 1000})`, 60_000);
        const c1 = await cpu();
        results[name] = { ...frames, cpuPct: Math.round(((c1.total - c0.total) / SECONDS) * 1000) / 10, processes: c1.processes };
      } finally { await page.close(); }
    }
    console.log('[players-cost]', JSON.stringify(results, null, 1));
    expect(Object.keys(results)).toHaveLength(4);
  }, 600_000);
});

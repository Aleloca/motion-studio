// @vitest-environment node
/**
 * The cost of the layer agent's unfreezer (report 38, decision 1240) in a real headless Chrome, on a layer of 10 000
 * elements: the camera rig's frame (only its `style` changed), a frame with nothing changed, and a frame after a class
 * change (a full scan, its style recalculation included). Logged, not asserted (no wall-clock assertions here); the
 * result is checked. Skipped without Chrome, unless MS_REQUIRE_CHROME=1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUnfreezer } from '../src/layer-agent.ts';
import { findChrome, launchChrome, type Browser } from './support/chrome.ts';

const chrome = findChrome();
if (!chrome && process.env.MS_REQUIRE_CHROME === '1') it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('no Chrome found'); });

describe.skipIf(!chrome)('unfreezer cost in Chrome (decision 1240)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); }, 60_000);

  it('10 000 elements: per-frame cost of the rig frame, an unchanged frame and a full scan', async () => {
    const page = await browser.newPage(800, 600);
    try {
      const r = await page.eval<{ rig: number; idle: number; full: number; recalc: number; world: string; dot: string; plain: string }>(`(() => {
        document.head.innerHTML = '<style>#world{position:absolute;will-change:transform}.dot{will-change:opacity, transform}.alt .dot{color:red}</style>';
        const world = document.createElement('div'); world.id = 'world'; document.body.append(world);
        for (let i = 0; i < 100; i++) { const g = document.createElement('div'); for (let j = 0; j < 99; j++) { const d = document.createElement('span'); d.className = j === 0 ? 'dot' : ''; d.textContent = 'x'; g.append(d); } world.append(g); }
        const u = (${createUnfreezer.toString()})(document);
        u.run();
        const time = (n, frame) => { let sum = 0; for (let i = 0; i < n; i++) { frame(i); const t0 = performance.now(); u.run(); sum += performance.now() - t0; document.body.offsetWidth; } return sum / n; };
        const rig = time(60, (i) => { world.style.transform = 'scale(' + (1 + i / 60) + ') rotate(' + i + 'deg)'; });
        const idle = time(60, () => {});
        const full = time(20, () => { document.body.classList.toggle('alt'); });
        // The style recalculation the class change costs anyway (the frame's paint would do it): one forced read.
        let recalc = 0;
        for (let i = 0; i < 20; i++) { document.body.classList.toggle('alt'); const t0 = performance.now(); getComputedStyle(world).willChange; recalc += performance.now() - t0; }
        recalc /= 20;
        return { rig, idle, full, recalc, world: world.style.getPropertyValue('will-change'), dot: document.querySelector('.dot').style.getPropertyValue('will-change'),
          plain: getComputedStyle(document.querySelector('span:not(.dot)')).willChange, count: document.querySelectorAll('*').length };
      })()`);
      console.info(`[unfreezer] ms per frame on 10k elements: rig ${r.rig.toFixed(3)}, unchanged ${r.idle.toFixed(3)}, full scan ${r.full.toFixed(3)} (of which the style recalculation alone ${r.recalc.toFixed(3)})`);
      expect([r.world, r.dot, r.plain]).toEqual(['filter', 'opacity, filter', 'auto']);
    } finally {
      await page.close();
    }
  }, 120_000);
});

// @vitest-environment node
/**
 * Drawn subtitles in a real headless Chrome (Task 16): a 9:16 composition whose format leaves the bottom 300 px to the
 * platform's UI. The line sits inside the safe zone, `margin` above its edge, in the brand font. The screenshot at
 * t = 2 s is saved for a look (`MS_SUBS_SHOT_DIR`, else the OS temp folder). Skipped without Chrome, unless
 * MS_REQUIRE_CHROME=1.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runtimeBuildOptions } from '../tsup.config.ts';
import type { RuntimeSubtitles } from '../src/subtitles.ts';
import { findChrome, launchChrome, type Browser } from './support/chrome.ts';
import { decodePng } from './support/png.ts';
import { startCompositionServer, type TestServer } from './support/server.ts';

const chrome = findChrome();
if (!chrome && process.env.MS_REQUIRE_CHROME === '1') it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('no Chrome found'); });
const FONT = join(import.meta.dirname, 'fixtures/fonts/jetbrains-mono-latin-400-normal.woff2');
const COMP = 'v1/compositions/reel';
const W = 1080;
const H = 1920;
const SAFE = { top: 220, bottom: 300, left: 60, right: 120 };
const MARGIN = 120;
const SUBS: RuntimeSubtitles = {
  lang: 'it',
  cues: [{ start: 1000, end: 3500, text: 'Motion Studio disegna\ni sottotitoli', words: [
    { start: 1000, end: 1400, text: 'Motion' }, { start: 1400, end: 1800, text: 'Studio' }, { start: 1900, end: 2400, text: 'disegna' },
    { start: 2500, end: 2700, text: 'i' }, { start: 2700, end: 3400, text: 'sottotitoli' },
  ] },
  // Taller than the lane (17 lines of 64 px): it may give up the margin, never cross the top safe edge.
  { start: 3600, end: 4000, text: Array.from({ length: 17 }, () => 'ab').join('\n') }],
};

describe.skipIf(!chrome)('drawn subtitles in Chrome', () => {
  let work: string;
  let server: TestServer;
  let browser: Browser;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ms-runtime-subs-'));
    const dist = join(work, 'dist');
    await build({ ...runtimeBuildOptions(dist), config: false } as Parameters<typeof build>[0]);
    const dir = join(work, 'site', COMP);
    mkdirSync(join(dir, 'assets'), { recursive: true });
    copyFileSync(FONT, join(dir, 'assets', 'mono.woff2'));
    writeFileSync(join(dir, 'composition.json'), JSON.stringify({
      $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration: 4, background: '#1e3a5f',
      fonts: [{ family: 'Mono', src: 'assets/mono.woff2' }], scenes: [{ id: 'all', start: 0, duration: 4 }],
      tracks: [{ id: 'subs', kind: 'subtitles', clips: [{ id: 'subs', type: 'subtitles', start: 0, duration: 4, props: {
        fontSize: 64, fontWeight: 'bold', color: '#ffffff', position: 'bottom', margin: MARGIN, maxWidth: 0.86, align: 'center',
        background: '#000000b3', boxPadding: 20, boxRadius: 16, outlineColor: '#000000', outlineWidth: 2, shadow: true,
        entrance: 'pop', entranceSec: 0.2, highlight: { color: '#ffd400' },
      } }] }],
    }));
    server = await startCompositionServer({ distDir: dist, root: join(work, 'site'), compPath: COMP, data: { safeZone: SAFE, subtitles: SUBS } });
    browser = await launchChrome(chrome!);
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (work) rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it('the line sits margin px above the safe zone, in the brand font, and the word spoken is highlighted', async () => {
    const page = await browser.newPage(W, H);
    try {
      await page.goto(server.pageUrl('mode=render'));
      const info = await page.eval<{ errors: unknown[] }>('window.__ms.ready()');
      expect(info.errors).toEqual([]);
      expect(await page.eval('document.querySelector(".ms-subs").style.display')).toBe('none'); // t = 0: no cue
      await page.eval('window.__ms.seek(2)');
      const r = await page.eval<{ top: number; bottom: number; left: number; right: number; width: number; widest: number; text: string; on: string[]; font: boolean }>(`(() => {
        const b = document.querySelector('.ms-subs-box').getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(document.querySelector('.ms-subs-box'));
        const lines = new Map(); for (const q of range.getClientRects()) { if (!q.width) continue; const k = Math.round(q.top + q.height / 2); const l = [...lines.keys()].find((m) => Math.abs(m - k) < q.height / 2) ?? k; const v = lines.get(l) ?? [Infinity, -Infinity]; lines.set(l, [Math.min(v[0], q.left), Math.max(v[1], q.right)]); }
        const widest = Math.max(...[...lines.values()].map(([a, z]) => z - a));
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, widest, text: document.querySelector('.ms-subs').textContent,
          on: [...document.querySelectorAll('[data-ms-word][data-on="true"]')].map((s) => s.textContent), font: document.fonts.check('bold 64px Mono') };
      })()`);
      expect(r.text).toBe('Motion Studio disegna\ni sottotitoli');
      expect(r.on).toEqual(['disegna']);
      expect(r.font).toBe(true);
      expect(r.bottom).toBeLessThanOrEqual(H - SAFE.bottom - MARGIN + 0.5);
      expect(r.bottom).toBeGreaterThan(H - SAFE.bottom - MARGIN - 2); // on the edge, not floating
      expect(r.top).toBeGreaterThanOrEqual(SAFE.top);
      expect(r.left).toBeGreaterThanOrEqual(SAFE.left);
      expect(r.right).toBeLessThanOrEqual(W - SAFE.right);
      // The box hugs its widest line (plus its padding), also when the text wraps.
      expect(r.width).toBeLessThanOrEqual(r.widest + 2 * 20 + 1);
      expect(r.widest).toBeLessThan(840 - 2 * 20 - 50); // it did wrap short of the lane
      // Centred on the frame, though the safe zone is not (Reels-like insets 60 / 120).
      expect(Math.abs((r.left + r.right) / 2 - W / 2)).toBeLessThanOrEqual(1);
      const png = await page.screenshot();
      const img = decodePng(png);
      // The box's dark background is drawn over the blue frame, inside its rectangle.
      const [cr, cg, cb] = img.px(Math.round(r.left + 24), Math.round(r.bottom - 8));
      expect(cb).toBeLessThan(80);
      expect(cr + cg).toBeLessThan(80);
      const out = process.env.MS_SUBS_SHOT_DIR ?? tmpdir();
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'subs-runtime-9x16-t2.png'), png);
      // Past the cue: nothing.
      await page.eval('window.__ms.seek(3.55)');
      expect(await page.eval('document.querySelector(".ms-subs").style.display')).toBe('none');
      // A box taller than the lane: kept inside the safe zone, eating into the margin.
      await page.eval('window.__ms.seek(3.8)');
      const tall = await page.eval<{ top: number; bottom: number }>('(() => { const b = document.querySelector(".ms-subs-box").getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; })()');
      expect(tall.bottom - tall.top).toBeGreaterThan(H - SAFE.top - SAFE.bottom - MARGIN);
      expect(tall.top).toBeGreaterThanOrEqual(SAFE.top - 0.5);
      expect(tall.bottom).toBeLessThanOrEqual(H - SAFE.bottom + 0.5);
    } finally {
      await page.close();
    }
  }, 120_000);
});

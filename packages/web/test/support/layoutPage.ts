/**
 * The video analysis layout tests (Phase 3): markup rendered in jsdom, measured in real Chrome with the app's stylesheets and
 * fonts, light or dark, with motion and transparency emulated explicitly. Without Chrome the suites are skipped
 * (MS_REQUIRE_CHROME=1 makes a missing browser a failure); MS_LAYOUT_SHOTS=<folder> saves a screenshot of each case there.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, launchChrome, type Browser } from '../../../composition-runtime/test/support/chrome.ts';
import { ALL_CSS, FONTS } from './layoutAssets.ts';

export const chromeRequired = process.env.MS_REQUIRE_CHROME === '1';
export const chromePath = chromeRequired || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const shots = process.env.MS_LAYOUT_SHOTS ?? null;

export interface Case { name: string; width: number; height: number; theme: 'light' | 'dark'; reduce?: boolean; opaque?: boolean }

/** Common page checks, run in the page: overflow sideways, elements cut or outside a box, the longest transition. */
export const MEASURE_HELPERS = `
const within = (a, b) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
const cutIn = (root, sel) => [...root.querySelectorAll(sel)].filter((el) => el.getClientRects().length && (el.scrollWidth > el.clientWidth + 1)).map((el) => (el.textContent || el.tagName).slice(0, 40));
const outside = (root, sel, box) => [...root.querySelectorAll(sel)].filter((el) => el.getClientRects().length && !within(el.getBoundingClientRect(), box)).map((el) => (el.textContent || el.tagName).slice(0, 40));
const maxTransition = () => Math.max(0, ...[...document.querySelectorAll('*')].flatMap((el) => getComputedStyle(el).transitionDuration.split(',').map((x) => parseFloat(x) * 1000)));
`;

export class LayoutRig {
  private dir = '';
  private browser: Browser | null = null;
  private css = '';
  async start() {
    this.dir = mkdtempSync(join(tmpdir(), 'ms-va-layout-'));
    this.css = `${FONTS()}\n${ALL_CSS()}`;
    this.browser = await launchChrome(chromePath!);
  }
  async stop() {
    await this.browser?.close();
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
  /** Loads `body` (inside the app's shell classes unless `bare`) and evaluates `measure` (an expression). */
  async measure<T>(body: string, measure: string, c: Case, shotName: string): Promise<T> {
    const page = `<!doctype html><html lang="it" data-theme="${c.theme}"><head><meta charset="utf-8"><style>${this.css}
      html,body{height:100%;margin:0}</style></head><body>${body}</body></html>`;
    const file = join(this.dir, `${c.name}-${c.theme}-${c.width}.html`);
    writeFileSync(file, page);
    const tab = await this.browser!.newPage(c.width, c.height);
    try {
      await tab.send('Emulation.setEmulatedMedia', { features: [
        { name: 'prefers-reduced-motion', value: c.reduce ? 'reduce' : 'no-preference' },
        { name: 'prefers-reduced-transparency', value: c.opaque ? 'reduce' : 'no-preference' },
      ] });
      await tab.goto(`file://${file}`);
      await tab.eval('document.fonts.ready.then(() => true)', 30_000);
      const r = await tab.eval<T>(`(() => { ${MEASURE_HELPERS}\n return (${measure}); })()`, 30_000);
      if (shots) writeFileSync(join(shots, `${shotName}-${c.theme}-${c.width}x${c.height}${c.reduce ? '-reduced' : ''}${c.opaque ? '-opaque' : ''}.png`), await tab.screenshot());
      return r;
    } finally { await tab.close(); }
  }
}

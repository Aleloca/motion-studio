/**
 * Report 61: three variants of 17 image formats, the variant cards side by side. Zooming in made the cards wider and their formats
 * reflow into more columns (2 → 4 → 9 a row) while each thumbnail stayed about 130 px wide. Now the zoom enlarges the thumbnails
 * and a card's columns never grow (`cardCells`). The canvas is rendered in jsdom at its opening zoom and pinched to 200%, the
 * markup given the real stylesheets and measured in Chrome: the thumbnails twice as wide, no more columns, nothing scrolling
 * sideways. Without Chrome the measuring test is skipped (MS_REQUIRE_CHROME=1 makes a missing browser a failure;
 * MS_LAYOUT_CHROME=1 turns it on); the markup test always runs. MS_LAYOUT_SHOTS=<folder> also saves a screenshot of each case.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, render, waitFor } from '@testing-library/react';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';
import { ALL_CSS, FONTS } from './support/layoutAssets.ts';
import { at, detailFor, groupOf, HOST, version } from './support/variants.ts';
import { settled } from './support/settle.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// 17 image formats, each a different preset, mostly landscape.
const FORMATS = ['youtube-16x9', 'youtube-4k-16x9', 'youtube-thumbnail', 'linkedin-16x9', 'x-16x9', 'web-hero-16x9', 'og-image-1200x630', 'facebook-cover',
  'linkedin-banner', 'web-banner-728x90', 'web-banner-300x250', 'instagram-post-1x1', 'instagram-image-1x1', 'facebook-feed-1x1', 'linkedin-1x1', 'x-1x1', 'facebook-feed-4x5'];
const group = groupOf(['a', 'b', 'c']);
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => detailFor(c, [version(1, 'Dal brief', [])], group, { formats: FORMATS })),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: true, interrupt: true, checkedAt: at })),
  getPinFrames: vi.fn(async () => ({ n: 1, expiresAt: at, frames: [] })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');

const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const shots = process.env.MS_LAYOUT_SHOTS ?? null;
const PAGE = 2000;
const PAGE_H = 1150;
const BARS = 120;
const canvasWidth = (page: number) => page - (page > 1180 ? 252 + 368 : page > 980 ? 200 + 340 : 340);

/** The cards' markup at the opening zoom, or pinched in to `to` (200%: the canvas's highest). */
async function markup(to: number | null): Promise<{ html: string; zoom: number; cells: string[] }> {
  const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
  const size = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? canvasWidth(PAGE) : 0; });
  const high = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? PAGE_H - BARS : 0; });
  const shell = {
    route: { name: 'creative', slug: 'acme', creative: HOST }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  const { container, unmount } = render(
    <I18nProvider locale="it"><ShellContext.Provider value={shell}><header className="ms-topbar"><TopBar /></header><CreativeCanvas slug="acme" creative={HOST} live={live} /></ShellContext.Provider></I18nProvider>);
  const zoomNow = () => parseFloat((container.querySelector('.ms-cv-world') as HTMLElement).style.getPropertyValue('--cv-z'));
  try {
    await waitFor(() => expect(container.querySelectorAll('.ms-vcard .ms-cv-board').length).toBe(3 * FORMATS.length));
    await settled(() => container.innerHTML);
    for (let i = 0; to !== null && zoomNow() < to - 1e-6 && i < 20; i++) {
      const viewport = container.querySelector('.ms-cv-viewport')!;
      act(() => { viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true })); });
      await settled(() => container.innerHTML);
    }
    for (const el of container.querySelectorAll<HTMLElement>('.ms-cv-frame')) if (el.style.zoom) el.setAttribute('style', `${el.getAttribute('style') ?? ''}; zoom: ${el.style.zoom}`);
    const cells = [...container.querySelectorAll<HTMLElement>('.ms-vcard[data-variant="a"] .ms-vcard-cell')].map((c) => c.style.width);
    return { html: (container.querySelector('.ms-cv') as HTMLElement).outerHTML, zoom: zoomNow(), cells };
  } finally { unmount(); size.mockRestore(); high.mockRestore(); }
}

describe('variant cards: zoom (markup)', () => {
  it('pinching in to 200% doubles the thumbnails\' columns\' width', async () => {
    const open = await markup(null);
    const max = await markup(2);
    expect(max.zoom).toBe(2);
    const w = (cells: string[]) => parseFloat(cells[0]!);
    expect(w(max.cells) / w(open.cells)).toBeCloseTo(max.zoom / open.zoom, 1);
  });
});

/** Per card: its columns (distinct lefts of its cells) and its first frame's width; sideways scrolling. */
const MEASURE = `(() => {
const problems = [];
const viewport = document.querySelector('.ms-cv-viewport');
if (viewport.scrollWidth > viewport.clientWidth + 1) problems.push('the canvas scrolls sideways: ' + viewport.scrollWidth + '/' + viewport.clientWidth);
const cards = [...document.querySelectorAll('.ms-vcard')].map((card) => {
  const cells = [...card.querySelectorAll('.ms-vcard-cell')];
  const cols = new Set(cells.map((c) => Math.round(c.getBoundingClientRect().left))).size;
  const frame = card.querySelector('[data-board$="youtube-16x9"] .ms-cv-frame-wrap') ?? card.querySelector('.ms-cv-frame-wrap');
  const r = card.getBoundingClientRect();
  if (r.right > viewport.getBoundingClientRect().right + .5) problems.push('card past the canvas: ' + card.dataset.variant);
  return { cols, frameW: Math.round(frame.getBoundingClientRect().width) };
});
return { problems, cards };
})()`;

const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('variant cards: zoom in real Chrome', () => {
  let dir = '';
  let browser: Browser;
  const css = ALL_CSS() + FONTS();
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-variants-zoom-')); browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  async function measure(to: number | null, shot: string) {
    const { html, zoom } = await markup(to);
    const doc = `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>${css}
      html,body{margin:0;height:100%} #w{width:${PAGE}px;height:${PAGE_H}px;box-sizing:border-box}</style></head><body><div id="w">${html}</div></body></html>`;
    const file = join(dir, `${shot}.html`);
    writeFileSync(file, doc);
    const tab = await browser.newPage(PAGE, PAGE_H);
    try {
      await tab.goto(`file://${file}`);
      if (shots) writeFileSync(join(shots, `${shot}.png`), await tab.screenshot());
      return { ...(await tab.eval<{ problems: string[]; cards: Array<{ cols: number; frameW: number }> }>(MEASURE, 30_000)), zoom };
    } finally { await tab.close(); }
  }

  it('3 × 17 at a 2000 px window: readable thumbnails at the opening zoom; at 200% twice as wide, never more columns', async () => {
    const open = await measure(null, 'variants-zoom-open');
    const max = await measure(2, 'variants-zoom-max');
    console.log('[variants zoom]', JSON.stringify({ open, max }));
    expect(open.problems).toEqual([]);
    expect(max.problems).toEqual([]);
    expect(max.zoom).toBe(2);
    for (const [i, c] of open.cards.entries()) {
      expect(c.frameW).toBeGreaterThanOrEqual(150);
      expect(max.cards[i]!.cols).toBeLessThanOrEqual(c.cols);
      expect(max.cards[i]!.frameW / c.frameW).toBeGreaterThan(0.9 * (max.zoom / open.zoom));
    }
  }, 120_000);
});

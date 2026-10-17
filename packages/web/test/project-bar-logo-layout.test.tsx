/**
 * The project bar's logo (user test 2026-10-17, items 3 and 4): "Motion Studio" on one line next to the mark where there is
 * room (1280 px and up), the mark alone below that. The real TopBar is rendered in jsdom, in Italian, and its markup is
 * measured in real Chrome with the app's stylesheets and fonts at 1024 and 1280 px, in the browser and in the macOS desktop
 * title bar: nothing leaves the bar, nothing overlaps, and exactly one of the two logos shows. Chrome only on request
 * (MS_LAYOUT_CHROME=1 or MS_REQUIRE_CHROME=1), through the repo's driver (mock keychain, basic password store).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';
import { ALL_CSS, FONTS } from './support/layoutAssets.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');

const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
const shell = {
  route: { name: 'project', slug: 'acme', tab: 'creatives' }, live,
  catalog: { projects: [{ slug: 'acme', name: 'Acme Studio Milano' }], creatives: {}, refresh: () => {} },
  activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} },
  openPalette: () => {},
} as unknown as Shell;

function barMarkup(): string {
  location.hash = '#/p/acme';
  const { container } = render(<I18nProvider locale="it"><ShellContext.Provider value={shell}><TopBar /></ShellContext.Provider></I18nProvider>);
  const html = (container.querySelector('.ms-topbar') as HTMLElement).outerHTML;
  cleanup();
  return html;
}

const MEASURE = `(async () => {
await document.fonts.ready;
const bar = document.querySelector('.ms-topbar');
const br = bar.getBoundingClientRect();
const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const problems = [];
if (document.documentElement.scrollWidth > innerWidth) problems.push('page overflows');
if (bar.scrollWidth > bar.clientWidth + 1) problems.push('bar overflows by ' + (bar.scrollWidth - bar.clientWidth));
const items = [...bar.children].filter(vis);
for (const el of items) { const r = el.getBoundingClientRect(); if (r.left < br.left - 0.5 || r.right > br.right + 0.5) problems.push('outside the bar: ' + el.className); }
for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
  const a = items[i].getBoundingClientRect(), b = items[j].getBoundingClientRect();
  if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom && a.bottom > b.top) problems.push('overlap: ' + items[i].className + ' / ' + items[j].className);
}
const full = bar.querySelector('.ms-logo-full'), mark = bar.querySelector('.ms-logo-mark');
return { problems, full: vis(full), mark: vis(mark), fullW: Math.round(full.getBoundingClientRect().width), slack: bar.clientWidth - bar.scrollWidth };
})()`;

const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

describe('project bar logo: markup', () => {
  it('carries the horizontal logo and the mark, both decorative, in a link named Home', () => {
    const html = barMarkup();
    expect(html).toContain('class="ms-logo-link"');
    expect(html).toMatch(/aria-label="Home di Motion Studio"/);
    // Vite may inline a small SVG as a data URI: the classes and the empty alt are what identify the two images.
    expect(html).toMatch(/<img class="ms-logo-full"[^>]* alt=""/);
    expect(html).toMatch(/<img class="ms-logo-mark"[^>]* alt=""/);
    expect(html).toMatch(/ms-logo-full[^>]*(logo-horizontal\.svg|viewBox='-11%20-11%201720)/);
  });
});

run('project bar logo: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-projbar-')); browser = await launchChrome(chrome!); });
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); });

  for (const desktop of [false, true]) it(`${desktop ? 'desktop title bar' : 'browser'}: the logo fits at 1024 (mark) and 1280, 1440 (whole)`, async () => {
    const html = barMarkup();
    const header = desktop ? html.replace('class="ms-topbar"', 'class="ms-topbar ms-titlebar ms-tb-mac"') : html;
    const failures: string[] = [];
    for (const width of [1024, 1279, 1280, 1440]) {
      const file = join(dir, `bar-${desktop}-${width}.html`);
      writeFileSync(file, `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>${FONTS()}\n${ALL_CSS()}\nbody{margin:0;background:var(--bg)}</style></head><body>${header}</body></html>`);
      const tab = await browser.newPage(width, 300);
      try {
        await tab.goto(`file://${file}`);
        const r = await tab.eval<{ problems: string[]; full: boolean; mark: boolean; fullW: number; slack: number }>(MEASURE, 30_000);
        console.info(`[projbar] ${desktop ? 'desktop' : 'web'} @${width}: ${JSON.stringify(r)}`);
        for (const p of r.problems) failures.push(`@${width}: ${p}`);
        if (r.full === r.mark) failures.push(`@${width}: both or neither logo shows`);
        if ((width >= 1280) !== r.full) failures.push(`@${width}: wrong logo (full=${r.full})`);
      } finally { await tab.close(); }
    }
    expect(failures).toEqual([]);
  });
});

/**
 * The other bars of the bar system (user reports 17 and 23), in real Chrome: the creative page's (a single creative, where
 * Esporta is the one filled action, and a variant group, where "Selezione finale" in the page's toolbar is and the bar's
 * Esporta is an outline control), the new-creative page's, the project's and the global one. Each is rendered in jsdom in
 * Italian with long names and measured with the app's stylesheets and fonts at 1024, 1280 and 1440 px, light and dark, in
 * the browser and in the macOS desktop title bar: nothing leaves the bar, nothing overlaps, nothing wraps, every button is
 * 32 px tall, at most one filled action, and the app's controls sit after the separator. The format page's bar has its own
 * test (topbar-render-layout.test.tsx). Chrome only on request (MS_LAYOUT_CHROME=1 or MS_REQUIRE_CHROME=1);
 * MS_LAYOUT_SHOTS=<folder> saves a screenshot of each case.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_FORMATS, type VariantGroup } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';
import { ALL_CSS, FONTS } from './support/layoutAssets.ts';
import { at, detailFor, groupOf, HOST, version } from './support/variants.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const LONG_TITLE = 'Create a 60-second 16:9 launch video for Motion Studio, the local motion graphics app for macOS';
const PROJECT = 'Acme Studio Milano, campagne 2026';
let group: VariantGroup | null = null;
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => {
    const d = detailFor(c, [version(1, 'Dal brief'), version(2, 'Più chiaro')], group, { title: LONG_TITLE });
    return { ...d, creative: { ...d.creative, brief: { ...d.creative.brief, locales: { primary: 'it', extra: ['en'] } } } };
  }),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: true, interrupt: true, checkedAt: at })),
  getPinFrames: vi.fn(async () => ({ n: 1, expiresAt: at, frames: [] })),
  exportGroupPlan: vi.fn(async () => ({ items: [], formats: [] })),
  listProjects: vi.fn(async () => []),
  listCreatives: vi.fn(async () => []),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');

const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
const shellFor = (route: Route) => ({
  route, live,
  catalog: { projects: [{ slug: 'acme', name: PROJECT }], creatives: {}, refresh: () => {} },
  activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
} as unknown as Shell);

type Case = 'creative' | 'group' | 'new-creative' | 'project' | 'global';
/** The bar's markup for `kind`, and how many filled actions it should have. */
async function barMarkup(kind: Case): Promise<string> {
  location.hash = '#/';
  const route: Route = kind === 'creative' || kind === 'group' ? { name: 'creative', slug: 'acme', creative: HOST }
    : kind === 'new-creative' ? { name: 'new-creative', slug: 'acme' } : kind === 'project' ? { name: 'project', slug: 'acme', tab: 'creatives' } : { name: 'projects' };
  group = kind === 'group' ? groupOf(['a', 'b', 'c']) : null;
  const page = kind === 'creative' || kind === 'group';
  const { container } = render(
    <I18nProvider locale="it"><ShellContext.Provider value={shellFor(route)}>
      <TopBar />
      {page ? <CreativeCanvas slug="acme" creative={HOST} live={live} /> : null}
    </ShellContext.Provider></I18nProvider>);
  try {
    const bar = () => container.querySelector('header.ms-topbar') as HTMLElement;
    if (page) {
      await waitFor(() => expect(bar().querySelector('.ms-cv-export')).not.toBeNull());
      await waitFor(() => expect(bar().querySelector('.ms-cv-languages')).not.toBeNull());
      if (kind === 'group') await screen.findByRole('toolbar', { name: /Variant/ });
    }
    return bar().outerHTML;
  } finally { cleanup(); }
}

describe('the other bars: what they carry', () => {
  it('a single creative: Esporta is the bar\'s one filled action; no "Versioni" button (decision 972)', async () => {
    const html = await barMarkup('creative');
    expect(html.match(/class="ms-btn ms-(ink|accent)/g)).toHaveLength(1);
    expect(html).toMatch(/class="ms-btn ms-ink ms-cv-export/);
    expect(html).not.toContain('ms-cv-vbtn');
    expect(html).toContain('ms-bar-sep');
  });
  it('a variant group: "Selezione finale" is the page\'s primary, so the bar\'s Esporta is an outline control', async () => {
    const html = await barMarkup('group');
    expect(html).toMatch(/class="ms-btn ms-outline ms-cv-export/);
    expect(html).not.toMatch(/class="ms-btn ms-(ink|accent)/);
  });
  it('new creative, project, global: no back button; the project is a link in the new-creative bar', async () => {
    const html = await barMarkup('new-creative');
    expect(html).toMatch(/<a class="ms-crumb-link" href="#\/p\/acme"/);
    expect(html).not.toContain('ms-back');
  });
});

const MEASURE = `(async () => {
await document.fonts.ready;
const bar = document.querySelector('.ms-topbar');
const br = bar.getBoundingClientRect();
const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.ms-sr');
const problems = [];
if (document.documentElement.scrollWidth > innerWidth) problems.push('page overflows');
if (bar.scrollWidth > bar.clientWidth + 1) problems.push('bar overflows by ' + (bar.scrollWidth - bar.clientWidth));
const controls = [...bar.querySelectorAll('button, a, .ms-pill')].filter(vis).filter((el) => !el.parentElement.closest('button, .ms-pill'));
for (const el of controls) {
  const r = el.getBoundingClientRect();
  if (r.left < br.left - 0.5 || r.right > br.right + 0.5 || r.top < br.top || r.bottom > br.bottom) problems.push('outside the bar: ' + (el.getAttribute('aria-label') || el.textContent));
}
for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
  if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
  const a = controls[i].getBoundingClientRect(), b = controls[j].getBoundingClientRect();
  if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom && a.bottom > b.top) problems.push('overlap: ' + (controls[i].textContent || controls[i].getAttribute('aria-label')) + ' / ' + (controls[j].textContent || controls[j].getAttribute('aria-label')));
}
for (const b of [...bar.querySelectorAll('button, a.ms-crumb-link')].filter(vis)) {
  if (b.classList.contains('ms-avatar') || b.classList.contains('ms-pill')) continue;
  const h = Math.round(b.getBoundingClientRect().height);
  if (h !== 32) problems.push('height ' + h + ': ' + (b.getAttribute('aria-label') || b.textContent));
}
for (const t of bar.querySelectorAll('.ms-crumb-text, .ms-crumb > b, .ms-cv-title b')) if (vis(t) && t.scrollWidth > t.clientWidth + 1 && !t.closest('[title]')) problems.push('cut without a tooltip: ' + t.textContent);
const end = bar.querySelector('.ms-topbar-end'), sep = bar.querySelector('.ms-bar-sep');
if (sep && end && sep.getBoundingClientRect().right > end.getBoundingClientRect().left) problems.push('the separator is not before the app controls');
return { problems, slack: bar.clientWidth - bar.scrollWidth };
})()`;

const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('the other bars: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-bars-')); browser = await launchChrome(chrome!); });
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); });
  const shots = process.env.MS_LAYOUT_SHOTS;
  for (const kind of ['creative', 'group', 'new-creative', 'project', 'global'] as const) {
    it(`${kind}: 1024, 1280, 1440 px, browser and desktop, light and dark: everything fits on one line`, async () => {
      const html = await barMarkup(kind);
      const failures: string[] = [];
      for (const desktop of [false, true]) {
        const header = desktop ? html.replace(/class="ms-topbar( [^"]*)?"/, 'class="ms-topbar$1 ms-titlebar ms-tb-mac"') : html;
        for (const width of [1024, 1280, 1440]) for (const theme of ['light', 'dark'] as const) {
          const file = join(dir, `${kind}-${desktop}-${width}-${theme}.html`);
          writeFileSync(file, `<!doctype html><html lang="it" data-theme="${theme}"><head><meta charset="utf-8"><style>${FONTS()}\n${ALL_CSS()}\nbody{margin:0;background:var(--bg)}</style></head><body>${header}</body></html>`);
          const tab = await browser.newPage(width, 120);
          try {
            await tab.goto(`file://${file}`);
            const r = await tab.eval<{ problems: string[]; slack: number }>(MEASURE, 30_000);
            if (shots) writeFileSync(join(shots, `${kind}-bar-${desktop ? 'desktop' : 'web'}-${width}-${theme}.png`), await tab.screenshot());
            for (const p of r.problems) failures.push(`${desktop ? 'desktop' : 'web'} @${width} ${theme}: ${p}`);
          } finally { await tab.close(); }
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

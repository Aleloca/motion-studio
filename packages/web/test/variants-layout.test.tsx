/**
 * Phase 15, Task 5: layout of the variant canvas in real Chrome. The grouped canvas is rendered in jsdom (no layout there), its markup
 * is given the real stylesheets and measured in Chrome, in both groupings (by variant, by format), at the two widths that matter
 * (1280 and 1024, where the formats column is 252/200 px and the chat panel 368/340 px) and in Italian and English: nothing
 * overflows the page, no control of the variant bar, the row headers or the board headers sticks out of its box or is clipped, the
 * format names stay whole, and the chat selector fits the panel. Without Chrome the measuring tests are skipped (MS_REQUIRE_CHROME=1
 * makes a missing browser a failure; MS_LAYOUT_CHROME=1 turns it on); the CSS-rule tests always run.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type JobSummary, type VariantGroup, type VersionEntry } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';
import { at, detailFor, groupOf, HOST, version } from './support/variants.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const LONG = 'Direzione molto lunga: tipografia grande, molto spazio bianco, colori caldi e un tono ironico che non copia le altre varianti del gruppo';
let group: VariantGroup = groupOf(['a', 'b', 'c', 'd', 'e'], {}, { b: { direction: LONG }, d: { status: 'discarded' } });
const versionsBy: Record<string, VersionEntry[]> = Object.fromEntries(['', '~b', '~c', '~d', '~e'].map((s) => [`${HOST}${s}`, [version(1, 'Dal brief'), version(2, 'Più chiaro')]]));
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => detailFor(c, versionsBy[c] ?? [], group, { missing: ['e'] })),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: true, interrupt: true, checkedAt: at })),
  getPinFrames: vi.fn(async () => ({ n: 1, expiresAt: at, frames: [] })),
  setVariantLayout: vi.fn(async (_s: string, _c: string, layout: 'variant' | 'format') => { group = { ...group, layout }; return detailFor(HOST, versionsBy[HOST]!, group); }),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');

const src = (p: string) => readFileSync(join(import.meta.dirname, '../src', p), 'utf8');
const CSS = ['theme.css', 'ui/ui.css', 'screens/common.css', 'screens/canvas.css', 'screens/format.css', 'screens/variants/variants.css', 'components/conversation.css', 'components/services.css', 'components/brief.css']
  .map(src).join('\n');
const required = process.env.MS_REQUIRE_CHROME === '1';
// Real Chrome only on request (MS_REQUIRE_CHROME=1 or MS_LAYOUT_CHROME=1): a launch can raise OS dialogs.
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;

describe('variant canvas: CSS rules', () => {
  const css = src('screens/variants/variants.css');
  it('the variant bar wraps instead of overflowing, and the row header wraps its pieces', () => {
    expect(css).toMatch(/\.ms-vbar\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.ms-vrow-head\s*\{[^}]*flex-wrap:\s*wrap/);
  });
  it('a long direction ellipsizes in the header; discarded rows are grey and inert', () => {
    expect(css).toMatch(/\.ms-vrow-dir\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.ms-discarded[^{]*\{[^}]*filter:\s*grayscale/);
    expect(css).toMatch(/\.ms-discarded[^{]*\{[^}]*pointer-events:\s*none/);
  });
  it('uses theme tokens only (no literal colours)', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});

const emptyJobs = (): Record<string, JobSummary> => ({
  a: { id: 'a', key: `creative:/w:acme:${HOST}`, kind: 'creative', label: 'Lancio', state: 'running', createdAt: at },
  b: { id: 'b', key: `creative:/w:acme:${HOST}~b`, kind: 'creative', label: 'Lancio', state: 'queued', createdAt: at, waitReason: 'variant-slot' },
  c: { id: 'c', key: `creative:/w:acme:${HOST}~c`, kind: 'creative', label: 'Lancio', state: 'queued', createdAt: at, waitReason: 'variant-directions' },
});

/** The markup of the grouped canvas, with the viewport width the app would have at `page` px (the zoom fits it). */
async function markup(layout: 'variant' | 'format', locale: 'en' | 'it', page: number): Promise<string> {
  group = { ...groupOf(['a', 'b', 'c', 'd', 'e'], {}, { b: { direction: LONG }, d: { status: 'discarded' } }), layout };
  const live = { approvals: {}, jobs: emptyJobs(), events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
  const viewportWidth = page - (page >= 1180 ? 252 + 368 : 200 + 340);
  const size = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? viewportWidth : 0; });
  const high = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? 600 : 0; });
  const shell = {
    route: { name: 'creative', slug: 'acme', creative: HOST }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  const { container, unmount } = render(
    <I18nProvider locale={locale}><ShellContext.Provider value={shell}><header className="ms-topbar"><TopBar /></header><CreativeCanvas slug="acme" creative={HOST} live={live} /></ShellContext.Provider></I18nProvider>);
  try {
    await screen.findByRole('toolbar', { name: /Variant/ });
    await waitFor(() => expect(container.querySelectorAll('.ms-cv-board').length).toBeGreaterThanOrEqual(layout === 'variant' ? 6 : 6));
    // The discarded variant shown too (the widest case), and the chat selector with "Tutte" on.
    await userEvent.click(within(container).getByRole('switch', { name: /Mostra scartate|Show discarded/ }));
    await waitFor(() => expect(container.querySelectorAll('.ms-cv-board').length).toBeGreaterThanOrEqual(8));
    await userEvent.click(within(container).getByRole('radio', { name: /^(Tutte|All)$/ }));
    await new Promise((r) => setTimeout(r, 100));
    return (container.querySelector('.ms-cv') as HTMLElement).outerHTML;
  } finally { unmount(); size.mockRestore(); high.mockRestore(); }
}

const MEASURE = `(() => {
const problems = [];
const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const box = (el) => el.getBoundingClientRect();
const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.className).toString().slice(0, 40);
const inside = (el, host, what) => { const r = box(el), h = box(host); if (r.right > h.right + .5 || r.left < h.left - .5 || r.bottom > h.bottom + .5 || r.top < h.top - .5) problems.push(what + ' outside its box: ' + name(el)); };
if (document.documentElement.scrollWidth > innerWidth) problems.push('page overflows');
const cv = document.querySelector('.ms-cv');
const counts = { bar: 0, heads: 0, boards: 0, stars: 0, fmts: 0 };
const bar = cv.querySelector('.ms-vbar');
counts.bar = bar ? bar.querySelectorAll('button, [role=radio], [role=switch]').length : 0;
if (bar) {
  inside(bar, cv.querySelector('.ms-cv-main'), 'bar');
  for (const el of bar.querySelectorAll('button, [role=radio], [role=switch], .ms-vbar-lbl, .ms-seg')) {
    if (!vis(el)) continue;
    inside(el, bar, 'bar item');
    if (el.children.length === 0 && el.textContent && el.scrollWidth > el.clientWidth + 1) problems.push('clipped in the bar: ' + name(el));
  }
}
const panel = cv.querySelector('.ms-cv-panel');
const sel = cv.querySelector('.ms-vsel .ms-seg');
if (sel) { inside(sel, panel, 'chat selector'); for (const r of sel.querySelectorAll('[role=radio]')) { inside(r, panel, 'selector option'); if (r.scrollWidth > r.clientWidth + 1) problems.push('selector option clipped: ' + name(r)); } }
else problems.push('no chat selector');
for (const head of cv.querySelectorAll('.ms-vrow-head')) {
  counts.heads++;
  for (const el of head.querySelectorAll('button, .ms-pill, .ms-vrow-dir, .ms-grow')) {
    if (!vis(el) || el.classList.contains('ms-grow')) continue;
    inside(el, head, 'row header');
  }
  const pill = head.querySelector('.ms-pill');
  if (pill && pill.scrollWidth > pill.clientWidth + 1) problems.push('state clipped: ' + name(pill));
  const dir = head.querySelector('.ms-vrow-dir');
  if (dir && dir.scrollWidth > dir.clientWidth + 1 && dir.getBoundingClientRect().width < 120) problems.push('direction squeezed to ' + Math.round(dir.getBoundingClientRect().width) + 'px');
}
for (const line of cv.querySelectorAll('.ms-cv-board-line:not(.ms-cv-board-sub)')) {
  counts.boards++;
  for (const el of line.children) { if (vis(el) && el.getClientRects().length) inside(el, line, 'board header'); }
  const nm = line.querySelector('.ms-cv-board-name');
  if (nm && nm.scrollWidth > nm.clientWidth + 1) problems.push('format name cut: ' + nm.textContent + ' (' + nm.clientWidth + '/' + nm.scrollWidth + ')');
  const star = line.querySelector('.ms-vstar');
  if (star) { counts.stars++; const r = box(star); if (r.width < 18 || r.height < 18) problems.push('star too small'); }
}
const col = cv.querySelector('.ms-cv-formats');
if (col && vis(col)) {
  if (col.scrollWidth > col.clientWidth + 1) problems.push('formats column overflows horizontally');
  for (const b of col.querySelectorAll('.ms-cv-fmt')) { counts.fmts++; inside(b, col, 'format item'); }
}
for (const w of cv.querySelectorAll('.ms-cv-board')) { if (box(w).width < 40) problems.push('board collapsed'); }
return { problems, counts, formatsColumn: !!col && vis(col) };
})()`;

const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('variant canvas: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-variants-layout-')); browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  async function measure(html: string, width: number, name: string) {
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${CSS}
      html,body{margin:0;height:100%} #w{width:${width}px;height:760px;box-sizing:border-box}</style></head><body><div id="w">${html}</div></body></html>`;
    const file = join(dir, `${name}-${width}.html`);
    writeFileSync(file, page);
    const tab = await browser.newPage(width, 800);
    try {
      await tab.goto(`file://${file}`);
      return await tab.eval<{ problems: string[]; counts: Record<string, number>; formatsColumn: boolean }>(MEASURE, 30_000);
    } finally { await tab.close(); }
  }

  for (const locale of ['it', 'en'] as const) {
    for (const layout of ['variant', 'format'] as const) {
      it(`${locale} grouped by ${layout}: nothing overflows or is clipped at 1280 and 1024`, async () => {
        for (const width of [1280, 1024]) {
          const html = await markup(layout, locale, width);
          const r = await measure(html, width, `${locale}-${layout}`);
          expect(r.problems, `${locale} ${layout} @${width}`).toEqual([]);
          // Never vacuous: the bar, the headers, the boards, the ★ and the formats column were all measured.
          expect(r.counts.bar, 'bar controls').toBeGreaterThanOrEqual(5);
          expect(r.counts.boards, 'boards').toBeGreaterThanOrEqual(8);
          expect(r.counts.stars, 'group stars').toBeGreaterThanOrEqual(8);
          expect(r.counts.heads, 'row headers').toBeGreaterThanOrEqual(5);
          expect(r.formatsColumn, 'formats column shown').toBe(true);
          expect(r.counts.fmts, 'format items').toBeGreaterThan(0);
        }
      }, 180_000);
    }
  }
});

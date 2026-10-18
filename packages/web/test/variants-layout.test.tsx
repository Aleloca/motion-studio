/**
 * Phase 15, Task 5: layout of the variant canvas in real Chrome. The grouped canvas is rendered in jsdom (no layout there), its markup
 * is given the real stylesheets and measured in Chrome, at the two widths that matter (1280 and 1024, where the formats column is
 * 252/200 px and the chat panel 368/340 px) and in Italian and English: nothing overflows the page, no control of the variant bar,
 * the cards' headers or the board headers sticks out of its box or is clipped, the format names stay whole, the cards wrap inside
 * the canvas (decision 973: no sideways scrolling) with their thumbnails inside them, and the chat selector fits the panel. Without Chrome the measuring tests are skipped (MS_REQUIRE_CHROME=1
 * makes a missing browser a failure; MS_LAYOUT_CHROME=1 turns it on); the CSS-rule tests always run.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type ConversationEntry, type JobSummary, type VariantGroup, type VersionEntry } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';
import { at, detailFor, groupOf, HOST, out, version } from './support/variants.ts';
import { settled } from './support/settle.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const LONG = 'Direzione molto lunga: tipografia grande, molto spazio bianco, colori caldi e un tono ironico che non copia le altre varianti del gruppo';
// The live check's case (D1): a full-sentence direction that used to wrap over the format rows of the formats column.
const FOTO = 'Foto calda e materica: chicchi e tostatura in primo piano, luce dorata da finestra, atmosfera artigianale';
let group: VariantGroup = groupOf(['a', 'b', 'c', 'd', 'e'], {}, { b: { direction: LONG }, c: { direction: FOTO }, d: { status: 'discarded' } });
const GROUP_CHAT: ConversationEntry[] = [
  ...(['a', 'b', 'c', 'e'] as const).map((variant, i) => ({ type: 'user' as const, at: at.replace(':00.000Z', `:0${i}.000Z`), text: 'Titoli più grandi e un logo più visibile in ogni formato', pins: [], attachments: [], variant })),
  { type: 'agent', at, jobId: 'jb', event: { kind: 'text', text: 'Ho ingrandito i titoli della variante B e spostato il logo in alto a destra.' }, variant: 'b' },
  { type: 'version', at, n: 2, status: 'complete', variant: 'b' },
  { type: 'system', at, level: 'warning', text: 'Il formato Banner non segue più il Post: la sua composizione è cambiata.', variant: 'c' },
  { type: 'version', at, n: 2, status: 'incomplete', variant: 'a' },
];
/** Decision 1056: three variants of one 16:9 video, the case the comparison is measured on. */
let compare = false;
const versionsBy: Record<string, VersionEntry[]> = Object.fromEntries(['', '~b', '~c', '~d', '~e'].map((s) => [`${HOST}${s}`, [version(1, 'Dal brief'), version(2, 'Più chiaro')]]));
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => (compare
    ? detailFor(c, [version(1, 'Dal brief', [out('youtube-16x9', 'video.mp4', '.previews/video.mp4.jpg')])], group, { formats: ['youtube-16x9'] })
    : detailFor(c, versionsBy[c] ?? [], group, { missing: ['e'] }))),
  // Decision 980 (phase 2): the group's one chat, each entry with its variant's chip.
  getConversation: vi.fn(async () => GROUP_CHAT),
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
  it('the variant bar wraps instead of overflowing, the cards wrap, a card\'s header keeps its menu on the name\'s line and its state line wraps', () => {
    expect(css).toMatch(/\.ms-vbar\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.ms-cv-world\.ms-cv-vworld\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.ms-vcard-head\s*\{[^}]*flex-wrap:\s*nowrap/);
    expect(css).toMatch(/\.ms-vcard-status\s*\{[^}]*flex-wrap:\s*wrap/);
  });
  it('the full direction takes two lines at most; the name never keeps a focus outline after a click', () => {
    expect(css).toMatch(/\.ms-vcard-dir\s*\{[^}]*-webkit-line-clamp:\s*2/);
    expect(css).toMatch(/\.ms-vrow-title\s*\{[^}]*outline:\s*none/);
    expect(css).toMatch(/\.ms-vrow-title:focus-visible\s*\{/);
    expect(css).not.toMatch(/\.ms-vrow-title\.ms-on\s*\{/);
  });
  it('a long direction ellipsizes in the header; discarded rows are grey and inert', () => {
    expect(css).toMatch(/\.ms-vrow-dir\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.ms-discarded[^{]*\{[^}]*filter:\s*grayscale/);
    expect(css).toMatch(/\.ms-discarded[^{]*\{[^}]*pointer-events:\s*none/);
  });
  it('the formats column\'s variant header clamps the direction to two lines and grows with it (no fixed height)', () => {
    expect(css).toMatch(/\.ms-cv-group-head\.ms-vcol-head\s*\{[^}]*height:\s*auto/);
    expect(css).toMatch(/\.ms-vcol-dir\s*\{[^}]*-webkit-line-clamp:\s*2/);
    expect(css).toMatch(/\.ms-vcol-dir\s*\{[^}]*overflow:\s*hidden/);
    expect(src('screens/CreativeCanvas.tsx')).toMatch(/ms-vcol-head" title=/);
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
  // Decision 973: the stored layout no longer changes the page (one card per variant); both are measured all the same.
  group = { ...groupOf(['a', 'b', 'c', 'd', 'e'], {}, { b: { direction: LONG }, c: { direction: FOTO }, d: { status: 'discarded' } }), layout };
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
    await settled(() => container.innerHTML);
    // jsdom keeps CSS `zoom` (the frames' scale) out of the style attribute: written back, so Chrome lays the frames out as the app does.
    for (const el of container.querySelectorAll<HTMLElement>('.ms-cv-frame')) if (el.style.zoom) el.setAttribute('style', `${el.getAttribute('style') ?? ''}; zoom: ${el.style.zoom}`);
    return (container.querySelector('.ms-cv') as HTMLElement).outerHTML;
  } finally { unmount(); size.mockRestore(); high.mockRestore(); }
}

/** The canvas between the formats column and the chat panel at a window `page` px wide (canvas.css). */
const canvasWidth = (page: number) => page - (page > 1180 ? 252 + 368 : page > 980 ? 200 + 340 : 340);

/** Decision 1056: the markup of three variants of one 16:9 video, everything ready, at a window `page` px wide. */
async function compareMarkup(page: number): Promise<string> {
  compare = true;
  group = groupOf(['a', 'b', 'c'], {}, { a: { direction: 'Minimal Apple-style keynote: white space' }, b: { direction: LONG }, c: { direction: FOTO } });
  const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
  const size = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? canvasWidth(page) : 0; });
  const high = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? 700 : 0; });
  const shell = {
    route: { name: 'creative', slug: 'acme', creative: HOST }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  const { container, unmount } = render(
    <I18nProvider locale="it"><ShellContext.Provider value={shell}><header className="ms-topbar"><TopBar /></header><CreativeCanvas slug="acme" creative={HOST} live={live} /></ShellContext.Provider></I18nProvider>);
  try {
    await screen.findByRole('toolbar', { name: /Variant/ });
    await waitFor(() => expect(container.querySelectorAll('.ms-vcard .ms-cv-board').length).toBe(3));
    await settled(() => container.innerHTML);
    for (const el of container.querySelectorAll<HTMLElement>('.ms-cv-frame')) if (el.style.zoom) el.setAttribute('style', `${el.getAttribute('style') ?? ''}; zoom: ${el.style.zoom}`);
    return (container.querySelector('.ms-cv') as HTMLElement).outerHTML;
  } finally { unmount(); size.mockRestore(); high.mockRestore(); compare = false; }
}

const MEASURE = `(() => {
const problems = [];
const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const box = (el) => el.getBoundingClientRect();
const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.className).toString().slice(0, 40);
const inside = (el, host, what) => { const r = box(el), h = box(host); if (r.right > h.right + .5 || r.left < h.left - .5 || r.bottom > h.bottom + .5 || r.top < h.top - .5) problems.push(what + ' outside its box: ' + name(el)); };
if (document.documentElement.scrollWidth > innerWidth) problems.push('page overflows');
const cv = document.querySelector('.ms-cv');
const counts = { bar: 0, heads: 0, boards: 0, stars: 0, fmts: 0, cards: 0, canvas: 0, perLine: 0, chips: 0, versions: 0 };
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
const hint = cv.querySelector('.ms-vsel-hint');
if (hint) inside(hint, panel, 'selector hint');
// Decision 980: the variant chips of the group's one chat, and the version cards (another variant's opens it).
for (const chip of cv.querySelectorAll('.ms-convo .ms-vchip')) { counts.chips++; inside(chip, panel, 'variant chip'); if (chip.scrollWidth > chip.clientWidth + 1) problems.push('chip clipped'); }
for (const v of cv.querySelectorAll('.ms-convo-version')) { counts.versions++; for (const el of v.querySelectorAll('button, .ms-pill, .ms-vchip')) inside(el, v, 'version card item'); }
for (const m of cv.querySelectorAll('.ms-msg-meta')) inside(m, panel, 'message header');
const viewport = cv.querySelector('.ms-cv-viewport');
counts.canvas = Math.round(viewport.clientWidth);
const cardTops = [...cv.querySelectorAll('.ms-vcard')].map((c) => Math.round(box(c).top));
counts.perLine = cardTops.filter((t) => t === cardTops[0]).length;
if (viewport.scrollWidth > viewport.clientWidth + 1) problems.push('the canvas scrolls sideways: ' + viewport.scrollWidth + '/' + viewport.clientWidth);
for (const card of cv.querySelectorAll('.ms-vcard')) {
  counts.cards++;
  // Sideways only: the cards grow downward and the canvas scrolls.
  { const r = box(card), v = box(viewport); if (r.left < v.left - .5 || r.right > v.left + viewport.clientWidth + .5) problems.push('card sticks out sideways: ' + name(card)); }
  for (const el of card.querySelectorAll('.ms-cv-frame-wrap, .ms-cv-board-head')) inside(el, card, 'card content');
  const dir = card.querySelector('.ms-vcard-dir');
  if (dir) { const lh = parseFloat(getComputedStyle(dir).lineHeight) || 16; if (box(dir).height > lh * 2 + 1) problems.push('direction taller than 2 lines'); }
}
for (const head of cv.querySelectorAll('.ms-vcard-head')) {
  const title = head.querySelector('.ms-vrow-title'), end = head.querySelector('.ms-vrow-more, .ms-vrow-restore');
  if (title && end && Math.abs(box(end).top + box(end).height / 2 - (box(title).top + box(title).height / 2)) > 4) problems.push('menu off the name line: ' + name(head));
  counts.heads++;
  for (const el of head.querySelectorAll('button, .ms-pill, .ms-vrow-dir, .ms-grow')) {
    if (!vis(el) || el.classList.contains('ms-grow')) continue;
    inside(el, head, 'row header');
  }
  const pill = head.querySelector('.ms-pill');
  if (pill && pill.scrollWidth > pill.clientWidth + 1) problems.push('state clipped: ' + name(pill));
  const dir = head.querySelector('.ms-vrow-dir');
  if (dir && dir.scrollWidth > dir.clientWidth + 1 && dir.getBoundingClientRect().width < 96) problems.push('name squeezed to ' + Math.round(dir.getBoundingClientRect().width) + 'px');
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
counts.colHeads = 0;
if (col && vis(col)) {
  // D1: a variant header of the column never reaches the row below it, and shows at most two lines.
  for (const head of col.querySelectorAll('.ms-vcol-head')) {
    counts.colHeads++;
    const dir = head.querySelector('.ms-vcol-dir'), hr = box(head);
    const lh = parseFloat(getComputedStyle(dir).lineHeight) || 16;
    if (box(dir).height > lh * 2 + 1) problems.push('column header taller than 2 lines: ' + name(head));
    if (box(dir).bottom > hr.bottom + .5) problems.push('column header text sticks out: ' + name(head));
    const next = head.nextElementSibling;
    if (next) { const nr = box(next); if (nr.top < hr.bottom - .5) problems.push('column header overlaps the row below: ' + name(head)); }
  }
  const items = [...col.querySelectorAll('.ms-cv-fmt')].filter(vis).map(box).sort((x, y) => x.top - y.top);
  for (let i = 1; i < items.length; i++) if (items[i].top < items[i - 1].bottom - .5) problems.push('format rows overlap');
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
      // Opt-in: a screenshot of each measured page, for a look (MS_LAYOUT_SHOTS=<folder>).
      if (process.env.MS_LAYOUT_SHOTS) {
        writeFileSync(join(process.env.MS_LAYOUT_SHOTS, `${name}-${width}.png`), await tab.screenshot());
        writeFileSync(join(process.env.MS_LAYOUT_SHOTS, `${name}-${width}.html`), page);
      }
      return await tab.eval<{ problems: string[]; counts: Record<string, number>; formatsColumn: boolean }>(MEASURE, 30_000);
    } finally { await tab.close(); }
  }

  // Decision 1056: comparing is the page's job. Three variants of a 16:9 video with the chat panel open: two side by side at
  // 1024 and 1280 px windows, three from 1440; nothing sticks out sideways.
  it('three 16:9 variants: 2 side by side at 1024 and 1280, 3 at 1440, 1512 and 1728', async () => {
    const lines: Record<number, number> = {};
    for (const width of [1024, 1280, 1440, 1512, 1728]) {
      const r = await measure(await compareMarkup(width), width, 'compare');
      expect(r.problems, `compare @${width}`).toEqual([]);
      expect(r.counts.canvas, `canvas width @${width}`).toBe(canvasWidth(width));
      lines[width] = r.counts.perLine!;
    }
    expect(lines).toEqual({ 1024: 2, 1280: 2, 1440: 3, 1512: 3, 1728: 3 });
  }, 180_000);

  for (const locale of ['it', 'en'] as const) {
    for (const layout of ['variant', 'format'] as const) {
      it(`${locale} grouped by ${layout}: nothing overflows or is clipped at 1280 and 1024`, async () => {
        for (const width of [1280, 1024]) {
          const html = await markup(layout, locale, width);
          const r = await measure(html, width, `${locale}-${layout}`);
          expect(r.problems, `${locale} ${layout} @${width}`).toEqual([]);
          // Never vacuous: the bar, the headers, the boards, the ★ and the formats column were all measured.
          expect(r.counts.bar, 'bar controls').toBeGreaterThanOrEqual(3);
          expect(r.counts.cards, 'cards').toBeGreaterThanOrEqual(5);
          expect(r.counts.boards, 'boards').toBeGreaterThanOrEqual(8);
          expect(r.counts.stars, 'group stars').toBeGreaterThanOrEqual(8);
          expect(r.counts.heads, 'card headers').toBeGreaterThanOrEqual(5);
          expect(r.formatsColumn, 'formats column shown').toBe(true);
          expect(r.counts.fmts, 'format items').toBeGreaterThan(0);
          if (layout === 'variant') expect(r.counts.colHeads, 'variant headers of the column').toBeGreaterThanOrEqual(3);
          expect(r.counts.chips, 'variant chips in the chat').toBeGreaterThanOrEqual(7);
          expect(r.counts.versions, 'version cards').toBe(2);
        }
      }, 180_000);
    }
  }
});

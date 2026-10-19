/**
 * Report 52: the "Scelte" view of a variant group in real Chrome, at a 1440×900 window with the chat panel open. No card: the
 * chosen boards are laid out as the plain canvas lays out a creative's (`chosenSections`: the canvas's groups and lines, fitted to
 * the viewport), "Scelte" and "Senza scelta" are headings one above the other. Two cases: one chosen 16:9 (it opens at the zoom the
 * plain canvas gives a lone 16:9), and a store pack chosen whole with two formats left to the default rule. Measured: every board in
 * view, none overlapping, no sideways scroll, each heading above its boards, the variant's line, the format's name and the ★ in each
 * board's header visible.
 * Without Chrome the test is skipped (MS_REQUIRE_CHROME=1 makes a missing browser a failure; MS_LAYOUT_CHROME=1 turns it on);
 * MS_LAYOUT_SHOTS=<folder> saves a screenshot of each page.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_FORMATS, storePackFormats, type StorePack, type VariantGroup, type VariantId, type VersionEntry } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';
import { ALL_CSS, FONTS } from './support/layoutAssets.ts';
import { settled } from './support/settle.ts';
import { at, detailFor, groupOf, HOST, out, version } from './support/variants.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const pack: StorePack = {
  app: { name: 'Tasky', tagline: '' }, stores: ['appstore', 'playstore'], devices: { appstore: ['iphone-69'], playstore: ['phone', 'feature'] },
  screenshots: Array.from({ length: 3 }, (_, i) => ({ caption: `Schermata ${i + 1}`, screen: null })), preview: false,
};
const packFormats = storePackFormats(pack);

interface Case { formats: string[]; labels?: Record<string, string>; storePack?: StorePack; picks: Record<string, VariantId>; defaults: string[] }
const CASES: Record<'single' | 'pack', Case> = {
  // One chosen 16:9 video (the user's case).
  single: { formats: ['youtube-16x9'], picks: { 'youtube-16x9': 'b' }, defaults: [] },
  // The store pack chosen whole, from three variants; a 16:9 and a 9:16 without a choice.
  pack: {
    formats: [...packFormats.formats, 'youtube-16x9', 'tiktok-9x16'], labels: packFormats.formatLabels, storePack: pack,
    picks: Object.fromEntries(packFormats.formats.map((f, i) => [f, (['a', 'b', 'c'] as const)[i % 3]!])), defaults: ['youtube-16x9', 'tiktok-9x16'],
  },
};
let current: Case = CASES.single;
let group: VariantGroup = groupOf(['a', 'b', 'c']);
const slugOf = (l: VariantId) => (l === 'a' ? HOST : `${HOST}~${l}`);
const outputs = () => current.formats.map((f) => (/9x16|16x9|preview|promo/.test(f) ? out(f, `${f}.mp4`, `.previews/${f}.mp4.jpg`) : out(f, `${f}.png`)));
const detail = (slug: string) => {
  const d = detailFor(slug, [version(1, 'Dal brief', outputs()), version(2, 'Più chiaro', outputs())], group, { formats: current.formats });
  return { ...d, creative: { ...d.creative, brief: { ...d.creative.brief, ...(current.labels ? { formatLabels: current.labels } : {}), ...(current.storePack ? { storePack: current.storePack } : {}) } } };
};
const plan = () => current.formats.map((format) => {
  const letter = current.picks[format] ?? 'a';
  return { format, slug: slugOf(letter), letter, version: 2, source: current.picks[format] ? 'pick' as const : 'default' as const, file: `${format}.png`, width: 1080, height: 1080, state: 'ready' as const };
});
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => detail(c)),
  groupExportPlan: vi.fn(async () => ({ items: plan(), formats: current.formats })),
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
const { fitBoards, canvasGroups, FIT_MIN } = await import('../src/screens/canvasModel.ts');
const { presetFor } = await import('../src/instances.ts');

const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const WINDOW = { width: 1440, height: 900 };
/** A neutral picture for every output (the files are not served here). */
const PICTURE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b6cf0"/><stop offset="1" stop-color="#e86a92"/></linearGradient></defs><rect width="16" height="9" fill="url(#g)"/></svg>')}`;

/** The page's markup at a canvas viewport of `view` px (the zoom fits it). */
async function markup(c: Case, view: { width: number; height: number }): Promise<{ html: string; zoom: number }> {
  current = c;
  group = groupOf(['a', 'b', 'c'], { picks: Object.fromEntries(Object.entries(c.picks).map(([f, l]) => [f, { slug: slugOf(l), version: 2 }])) });
  const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
  const size = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? view.width : 0; });
  const high = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? view.height : 0; });
  const shell = {
    route: { name: 'creative', slug: 'acme', creative: HOST }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  const { container, unmount } = render(
    <I18nProvider locale="it"><ShellContext.Provider value={shell}><header className="ms-topbar"><TopBar /></header><CreativeCanvas slug="acme" creative={HOST} live={live} /></ShellContext.Provider></I18nProvider>);
  try {
    const chosen = await screen.findByRole('region', { name: 'Scelte' });
    await waitFor(() => expect(chosen.querySelectorAll('.ms-cv-board img').length).toBe(Object.keys(c.picks).length));
    if (c.defaults.length) await waitFor(() => expect(screen.getByRole('region', { name: 'Senza scelta' }).querySelectorAll('.ms-cv-board img').length).toBe(c.defaults.length));
    await settled(() => container.innerHTML);
    for (const el of container.querySelectorAll<HTMLElement>('.ms-cv-frame')) if (el.style.zoom) el.setAttribute('style', `${el.getAttribute('style') ?? ''}; zoom: ${el.style.zoom}`);
    const zoom = parseFloat((container.querySelector('.ms-cv-world') as HTMLElement).style.getPropertyValue('--cv-z'));
    const html = (container.querySelector('.ms-topbar') as HTMLElement).outerHTML + (container.querySelector('.ms-cv') as HTMLElement).outerHTML;
    return { html: html.replace(/src="\/f\/[^"]*"/g, `src="${PICTURE}"`), zoom };
  } finally { unmount(); size.mockRestore(); high.mockRestore(); }
}

const MEASURE = `(() => {
const problems = [];
const box = (el) => el.getBoundingClientRect();
const viewport = document.querySelector('.ms-cv-viewport');
const v = box(viewport);
if (viewport.scrollWidth > viewport.clientWidth + 1) problems.push('the canvas scrolls sideways: ' + viewport.scrollWidth + '/' + viewport.clientWidth);
if (document.querySelector('.ms-vcard')) problems.push('a card in the view');
const sections = [...document.querySelectorAll('section.ms-vchosen')].map((s) => ({
  name: s.getAttribute('aria-label'), head: box(s.querySelector('.ms-vchosen-head')), boards: [...s.querySelectorAll('.ms-cv-board')].map((b) => ({ id: b.dataset.board, r: box(b), el: b })),
}));
const all = sections.flatMap((s) => s.boards);
for (const { id, r, el } of all) {
  if (r.right > v.right + .5 || r.bottom > v.bottom + .5 || r.left < v.left - .5 || r.top < v.top - .5) problems.push('out of view: ' + id);
  const from = el.querySelector('.ms-cv-board-from');
  if (!from) problems.push('no variant line: ' + id);
  else if (from.scrollWidth > from.clientWidth + 1 && !from.querySelector('.ms-vchosen-name')) problems.push('variant line clipped: ' + id);
  const star = el.querySelector('.ms-vstar');
  if (!star) problems.push('no star: ' + id);
  else if (box(star).right > box(star.closest('.ms-cv-board-line')).right + .5 || box(star).width < 12) problems.push('star clipped: ' + id);
  const fmt = el.querySelector('.ms-cv-board-name');
  // A screenshot's number whole; a longer name may ellipsize, never vanish.
  if (!fmt || fmt.clientWidth < 4 || (fmt.textContent.length <= 2 && fmt.scrollWidth > fmt.clientWidth + .5)) problems.push('format name squeezed: ' + id + ' ' + (fmt && fmt.clientWidth));
  const name = el.querySelector('.ms-vchosen-name');
  if (name && name.clientWidth < 24) problems.push('variant name squeezed: ' + id);
}
for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
  const a = all[i].r, b = all[j].r;
  if (a.left < b.right - .5 && b.left < a.right - .5 && a.top < b.bottom - .5 && b.top < a.bottom - .5) problems.push('overlap: ' + all[i].id + ' / ' + all[j].id);
}
for (let i = 0; i < sections.length; i++) {
  const s = sections[i];
  for (const b of s.boards) if (b.r.top < s.head.bottom - .5) problems.push(s.name + ': a board above its heading');
  if (i > 0) for (const b of sections[i - 1].boards) if (b.r.bottom > s.head.top + .5) problems.push(s.name + ': heading above a board of ' + sections[i - 1].name);
}
const frames = all.map(({ id, el }) => ({ id, w: Math.round(box(el.querySelector('.ms-cv-frame-wrap')).width), h: Math.round(box(el.querySelector('.ms-cv-frame-wrap')).height) }));
return { problems, view: { width: viewport.clientWidth, height: viewport.clientHeight }, sections: sections.map((s) => [s.name, s.boards.length]), frames };
})()`;

const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('"Scelte" in real Chrome (report 52)', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-chosen-layout-')); browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  type Measure = { problems: string[]; view: { width: number; height: number }; sections: Array<[string, number]>; frames: Array<{ id: string; w: number; h: number }> };
  async function load(html: string, name: string, shot: boolean): Promise<Measure> {
    const page = `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>${FONTS()}${ALL_CSS()}
      html,body{margin:0;height:100%} body{display:flex;flex-direction:column;width:${WINDOW.width}px;height:${WINDOW.height}px} .ms-cv{flex:1;min-height:0}</style></head><body>${html}</body></html>`;
    const file = join(dir, `${name}.html`);
    writeFileSync(file, page);
    const tab = await browser.newPage(WINDOW.width, WINDOW.height);
    try {
      await tab.goto(`file://${file}`);
      await tab.eval('document.fonts.ready.then(() => true)');
      if (shot && process.env.MS_LAYOUT_SHOTS) writeFileSync(join(process.env.MS_LAYOUT_SHOTS, `chosen-${name}-${WINDOW.width}.png`), await tab.screenshot());
      return await tab.eval<Measure>(MEASURE, 30_000);
    } finally { await tab.close(); }
  }
  /** Twice: the first load measures the canvas viewport the window really gives, the second is fitted to it. */
  async function measure(c: Case, name: string) {
    const first = await load((await markup(c, { width: 820, height: 700 })).html, `${name}-probe`, false);
    const { html, zoom } = await markup(c, first.view);
    const r = await load(html, name, true);
    console.log(`[chosen ${name}]`, JSON.stringify({ zoom, view: r.view, frames: r.frames.slice(0, 4) }));
    return { ...r, zoom };
  }

  it('one chosen 16:9: no card, the board at the zoom the plain canvas gives a lone 16:9', async () => {
    const r = await measure(CASES.single, 'single');
    expect(r.problems).toEqual([]);
    expect(r.sections).toEqual([['Scelte', 1]]);
    const plain = fitBoards(canvasGroups([{ id: 'youtube-16x9', preset: presetFor(DEFAULT_FORMATS, 'youtube-16x9'), out: null }], new Set()), r.view, FIT_MIN)!;
    expect(r.zoom).toBe(plain);
    expect(r.frames[0]!.w).toBe(Math.round(420 * plain));
  }, 180_000);

  it('a store pack chosen whole and two formats without a choice: the stores on lines of their own, "Senza scelta" under "Scelte"', async () => {
    const r = await measure(CASES.pack, 'pack');
    expect(r.problems).toEqual([]);
    expect(r.sections).toEqual([['Scelte', packFormats.formats.length], ['Senza scelta', 2]]);
  }, 180_000);
});

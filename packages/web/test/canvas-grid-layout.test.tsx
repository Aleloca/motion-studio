/**
 * Report 60: right after Generate with 17 copies of a 16:9 the canvas showed one column of 17 boards, zoomed out until they were
 * unreadable. The boards other than the tall ones are now in a grid, in reading order, with the columns that let the canvas open
 * largest, and never below the readable floor (READABLE_ZOOM: past it, the canvas scrolls down). The canvas is rendered in jsdom
 * (the lines, the columns and the zoom are the model's), its markup given the real stylesheets and measured in Chrome: boards
 * sharing rows in the order of the brief, none overlapping, nothing scrolling sideways. Without Chrome the measuring tests are
 * skipped (MS_REQUIRE_CHROME=1 makes a missing browser a failure; MS_LAYOUT_CHROME=1 turns it on); the markup tests always run.
 * MS_LAYOUT_SHOTS=<folder> also saves a screenshot of each case there.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, waitFor } from '@testing-library/react';
import { DEFAULT_FORMATS, type CreativeDetail, type VersionEntry } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';
import { ALL_CSS, FONTS } from './support/layoutAssets.ts';
import { settled } from './support/settle.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const at = '2026-10-20T10:00:00.000Z';
const copies = (id: string, n: number) => Array.from({ length: n }, (_, i) => (i ? `${id}@${i + 1}` : id));
// Just generated: a version with no output yet, every board a placeholder at its preset's size.
const version: VersionEntry = { n: 1, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: 'Dal brief', problems: [], tools: [], renderCommand: null, basedOn: null, outputs: [] };
let formats: string[] = [];
const detail = (): CreativeDetail => ({
  slug: 'hero', jobKey: 'creative:/w:acme:hero', versions: [version],
  creative: {
    schemaVersion: 1, title: 'Hero', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'Hero', message: '', durationSec: null, assets: [], notes: '', formats },
  },
});
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async () => detail()),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: true, interrupt: true, checkedAt: at })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
const { READABLE_ZOOM } = await import('../src/screens/canvasModel.ts');

const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const shots = process.env.MS_LAYOUT_SHOTS ?? null;

/** The canvas between the formats column and the chat panel at a window `page` px wide (canvas.css). */
const canvasWidth = (page: number) => page - (page > 1180 ? 252 + 368 : page > 980 ? 200 + 340 : 340);
/** The bars above the canvas: the window less them is the canvas's height. */
const BARS = 120;

/** The canvas markup of a creative with the brief's `ids`, with the viewport the app would have in a `page` × `pageH` window. */
async function markup(ids: string[], page: number, pageH: number): Promise<{ html: string; zoom: number }> {
  formats = ids;
  const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
  const size = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? canvasWidth(page) : 0; });
  const high = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? pageH - BARS : 0; });
  const shell = {
    route: { name: 'creative', slug: 'acme', creative: 'hero' }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  const { container, unmount } = render(
    <I18nProvider locale="it"><ShellContext.Provider value={shell}><header className="ms-topbar"><TopBar /></header><CreativeCanvas slug="acme" creative="hero" live={live} /></ShellContext.Provider></I18nProvider>);
  try {
    await waitFor(() => expect(container.querySelectorAll('.ms-cv-board').length).toBe(ids.length));
    await waitFor(() => expect(container.querySelector('.ms-cv-line')).not.toBeNull());
    await settled(() => container.innerHTML);
    // jsdom drops the frames' `zoom` when it writes the markup out: put it back for Chrome.
    for (const el of container.querySelectorAll<HTMLElement>('.ms-cv-frame')) if (el.style.zoom) el.setAttribute('style', `${el.getAttribute('style') ?? ''}; zoom: ${el.style.zoom}`);
    const zoom = parseFloat((container.querySelector('.ms-cv-world') as HTMLElement).style.getPropertyValue('--cv-z'));
    return { html: (container.querySelector('.ms-cv') as HTMLElement).outerHTML, zoom };
  } finally { unmount(); size.mockRestore(); high.mockRestore(); }
}

const HERO = copies('web-hero-16x9', 17);
const MIX = ['youtube-16x9', 'youtube-shorts-9x16', 'youtube-16x9@2', 'youtube-thumbnail', 'youtube-shorts-9x16@2'];

describe('canvas grid: markup', () => {
  it('17 copies of a 16:9: one grid of several columns, the boards in the brief\'s order, opening at least at the floor', async () => {
    const { html, zoom } = await markup(HERO, 1920, 1170);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const grid = doc.querySelector<HTMLElement>('.ms-cv-stack')!;
    expect(grid.style.gridTemplateColumns).toMatch(/^repeat\((\d+), max-content\)$/);
    expect(Number(/repeat\((\d+)/.exec(grid.style.gridTemplateColumns)![1])).toBeGreaterThan(1);
    expect([...grid.querySelectorAll<HTMLElement>('[data-board]')].map((b) => b.dataset.board)).toEqual(HERO);
    expect(zoom).toBeGreaterThanOrEqual(READABLE_ZOOM);
  });

  it('two landscape boards stay one column, as before', async () => {
    const { html, zoom } = await markup(copies('youtube-16x9', 2), 1920, 1170);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector<HTMLElement>('.ms-cv-stack')!.getAttribute('style')).toBeNull();
    expect(zoom).toBe(1);
  });
});

/** Every board's box, sideways scrolling, overlaps and boards out of the viewport (`w` × `h`), in Chrome. */
const MEASURE = (w: number, h: number) => `(() => {
const problems = [];
const box = (el) => el.getBoundingClientRect();
const viewport = document.querySelector('.ms-cv-viewport');
const v = box(viewport);
if (viewport.scrollWidth > viewport.clientWidth + 1) problems.push('the canvas scrolls sideways: ' + viewport.scrollWidth + '/' + viewport.clientWidth);
const rects = [...document.querySelectorAll('.ms-cv-board')].map((b) => ({ id: b.dataset.board, r: box(b) }));
const out = rects.filter(({ r }) => r.right > v.left + ${w} + .5 || r.bottom > v.top + ${h} + .5).map((x) => x.id);
for (const { id, r } of rects) if (r.width < 40) problems.push('board collapsed: ' + id);
for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
  const a = rects[i].r, b = rects[j].r;
  if (a.left < b.right - .5 && b.left < a.right - .5 && a.top < b.bottom - .5 && b.top < a.bottom - .5) problems.push('overlap: ' + rects[i].id + ' / ' + rects[j].id);
}
const rows = {};
for (const { id, r } of rects) (rows[Math.round(r.top)] ??= []).push({ id, left: r.left });
const reading = Object.keys(rows).map(Number).sort((a, b) => a - b).flatMap((t) => rows[t].sort((a, b) => a.left - b.left).map((x) => x.id));
return { problems, out, perRow: Object.values(rows).map((r) => r.length), reading };
})()`;

const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('canvas grid: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  const css = ALL_CSS() + FONTS();
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-canvas-grid-')); browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  /** The markup of `ids` in a `page` × `pageH` window, measured in Chrome (and its screenshot `shot`, with MS_LAYOUT_SHOTS). */
  async function measure(ids: string[], page: number, pageH: number, shot: string) {
    const { html, zoom } = await markup(ids, page, pageH);
    const doc = `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>${css}
      html,body{margin:0;height:100%} #w{width:${page}px;height:${pageH}px;box-sizing:border-box}</style></head><body><div id="w">${html}</div></body></html>`;
    const file = join(dir, `${shot}.html`);
    writeFileSync(file, doc);
    const tab = await browser.newPage(page, pageH);
    try {
      await tab.goto(`file://${file}`);
      if (shots) writeFileSync(join(shots, `${shot}.png`), await tab.screenshot());
      const r = await tab.eval<{ problems: string[]; out: string[]; perRow: number[]; reading: string[] }>(MEASURE(canvasWidth(page), pageH - BARS), 30_000);
      return { ...r, zoom };
    } finally { await tab.close(); }
  }

  it('17 copies of a 16:9 (1920 and 2000 px windows): rows of several boards in reading order, all in view, none overlapping', async () => {
    for (const [page, pageH] of [[1920, 1170], [2000, 1150]] as const) {
      const r = await measure(HERO, page, pageH, page === 2000 ? 'canvas-grid-17' : `canvas-grid-17-${page}`);
      expect(r.problems, `@${page}`).toEqual([]);
      expect(r.out, `@${page}`).toEqual([]);
      expect(Math.max(...r.perRow)).toBeGreaterThan(1);
      expect(r.reading).toEqual(HERO);
      expect(r.zoom).toBeGreaterThanOrEqual(READABLE_ZOOM);
    }
  }, 120_000);

  it('a mix of 3 landscape and 2 tall boards: the tall ones on the line, the others after them, all in view', async () => {
    const r = await measure(MIX, 2000, 1150, 'canvas-grid-mix');
    expect(r.problems).toEqual([]);
    expect(r.out).toEqual([]);
    expect(r.zoom).toBeGreaterThanOrEqual(READABLE_ZOOM);
  }, 60_000);

  it('60 copies: the floor zoom, the rows filling the width, the canvas scrolling down only', async () => {
    const r = await measure(copies('web-hero-16x9', 60), 2000, 1150, 'canvas-grid-60');
    expect(r.zoom).toBe(READABLE_ZOOM);
    expect(r.problems).toEqual([]);
    expect(r.out.length).toBeGreaterThan(0);
    expect(r.reading).toEqual(copies('web-hero-16x9', 60));
  }, 60_000);
});

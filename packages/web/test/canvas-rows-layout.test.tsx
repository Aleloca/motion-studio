/**
 * Report 40: the canvas of a store pack (19 formats: App Store screenshots 1–8 and App Preview, Play Store screenshots 1–8, the
 * feature graphic and the promo video). The boards are in lines, one or more per group of the formats column, and the canvas opens
 * with all of them in view. The canvas is rendered in jsdom (the lines and the zoom are the model's), its markup is given the real
 * stylesheets and measured in Chrome at two window widths: every board inside the viewport, no two boards overlapping, the App
 * Store's boards all above the Play Store's, nothing scrolling sideways. Without Chrome the measuring test is skipped
 * (MS_REQUIRE_CHROME=1 makes a missing browser a failure; MS_LAYOUT_CHROME=1 turns it on); the markup test always runs.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_FORMATS, storePackFormats, type CreativeDetail, type StorePack, type VersionEntry } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';
import { settled } from './support/settle.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const at = '2026-10-19T10:00:00.000Z';
const pack: StorePack = {
  app: { name: 'Tasky', tagline: '' }, stores: ['appstore', 'playstore'], devices: { appstore: ['iphone-69'], playstore: ['phone', 'feature'] },
  screenshots: Array.from({ length: 8 }, (_, i) => ({ caption: `Schermata ${i + 1}`, screen: null })), preview: true,
};
const packFormats = storePackFormats(pack);
const version: VersionEntry = { n: 1, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: 'Dal brief', problems: [], tools: [], renderCommand: null, basedOn: null, outputs: [] };
const detail: CreativeDetail = {
  slug: 'pack', jobKey: 'creative:/w:acme:pack', versions: [version],
  creative: {
    schemaVersion: 1, title: 'Pacchetto', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'Store', message: '', durationSec: null, assets: [], notes: '', formats: packFormats.formats, formatLabels: packFormats.formatLabels, storePack: pack },
  },
};
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async () => detail),
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

const src = (p: string) => readFileSync(join(import.meta.dirname, '../src', p), 'utf8');
const CSS = ['theme.css', 'ui/ui.css', 'screens/common.css', 'screens/canvas.css', 'screens/format.css', 'components/conversation.css', 'components/services.css', 'components/brief.css']
  .map(src).join('\n');
const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;

/** The canvas between the formats column and the chat panel at a window `page` px wide (canvas.css). */
const canvasWidth = (page: number) => page - (page > 1180 ? 252 + 368 : page > 980 ? 200 + 340 : 340);
const VIEW_H = 640;

/** The canvas markup with the viewport the app would have at a window `page` px wide (the zoom fits it). */
async function markup(page: number): Promise<{ html: string; zoom: number }> {
  const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
  const size = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? canvasWidth(page) : 0; });
  const high = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-cv-viewport') ? VIEW_H : 0; });
  const shell = {
    route: { name: 'creative', slug: 'acme', creative: 'pack' }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  const { container, unmount } = render(
    <I18nProvider locale="it"><ShellContext.Provider value={shell}><header className="ms-topbar"><TopBar /></header><CreativeCanvas slug="acme" creative="pack" live={live} /></ShellContext.Provider></I18nProvider>);
  try {
    await waitFor(() => expect(container.querySelectorAll('.ms-cv-board').length).toBe(19));
    await waitFor(() => expect(container.querySelectorAll('.ms-cv-line').length).toBeGreaterThanOrEqual(2));
    await settled(() => container.innerHTML);
    for (const el of container.querySelectorAll<HTMLElement>('.ms-cv-frame')) if (el.style.zoom) el.setAttribute('style', `${el.getAttribute('style') ?? ''}; zoom: ${el.style.zoom}`);
    const zoom = parseFloat((container.querySelector('.ms-cv-world') as HTMLElement).style.getPropertyValue('--cv-z'));
    return { html: (container.querySelector('.ms-cv') as HTMLElement).outerHTML, zoom };
  } finally { unmount(); size.mockRestore(); high.mockRestore(); }
}

describe('store pack canvas: lines', () => {
  it('puts the App Store and the Play Store on lines of their own, wrapped, and opens below 50% at a 1280 px window', async () => {
    const { html, zoom } = await markup(1280);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const lines = [...doc.querySelectorAll('.ms-cv-line')].map((l) => [...l.querySelectorAll('[data-board]')].map((b) => (b as HTMLElement).dataset.board!));
    const store = (id: string) => (id.startsWith('appstore') ? 'A' : 'P');
    // No line mixes the two stores, and the App Store comes first.
    expect(lines.map((l) => [...new Set(l.map(store))].join(''))).toEqual(lines.map((l) => store(l[0]!)));
    expect(lines.flat().slice(0, 9).every((id) => store(id) === 'A')).toBe(true);
    expect(lines.length).toBeGreaterThan(2);
    expect(zoom).toBeLessThan(0.5);
    expect(screen.queryByText(/Not rendered|Non renderizzato/)).toBeNull();
  });
});

const MEASURE = (w: number, h: number) => `(() => {
const problems = [];
const box = (el) => el.getBoundingClientRect();
const viewport = document.querySelector('.ms-cv-viewport');
const v = box(viewport);
if (viewport.scrollWidth > viewport.clientWidth + 1) problems.push('the canvas scrolls sideways: ' + viewport.scrollWidth + '/' + viewport.clientWidth);
const boards = [...document.querySelectorAll('.ms-cv-board')];
const rects = boards.map((b) => ({ id: b.dataset.board, r: box(b) }));
for (const { id, r } of rects) {
  if (r.right > v.left + ${w} + .5 || r.bottom > v.top + ${h} + .5) problems.push('out of view: ' + id + ' ' + Math.round(r.right - v.left) + '×' + Math.round(r.bottom - v.top));
  if (r.width < 40) problems.push('board collapsed: ' + id);
}
for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
  const a = rects[i].r, b = rects[j].r;
  if (a.left < b.right - .5 && b.left < a.right - .5 && a.top < b.bottom - .5 && b.top < a.bottom - .5) problems.push('overlap: ' + rects[i].id + ' / ' + rects[j].id);
}
const app = rects.filter((x) => x.id.startsWith('appstore')), play = rects.filter((x) => !x.id.startsWith('appstore'));
if (Math.max(...app.map((x) => x.r.bottom)) > Math.min(...play.map((x) => x.r.top)) + .5) problems.push('a Play Store board above an App Store one');
return { problems, boards: rects.length };
})()`;

const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('store pack canvas: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-canvas-rows-')); browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  it('every board of the 19 is in view at the opening zoom, none overlapping, the App Store above the Play Store (1280, 1440, 1728)', async () => {
    for (const width of [1280, 1440, 1728]) {
      const { html } = await markup(width);
      // The window is tall enough for the viewport the markup was fitted to (the top bar and the board labels above it).
      const page = `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>${CSS}
        html,body{margin:0;height:100%} #w{width:${width}px;height:${VIEW_H + 120}px;box-sizing:border-box}</style></head><body><div id="w">${html}</div></body></html>`;
      const file = join(dir, `pack-${width}.html`);
      writeFileSync(file, page);
      const tab = await browser.newPage(width, VIEW_H + 120);
      try {
        await tab.goto(`file://${file}`);
        if (process.env.MS_LAYOUT_SHOTS) writeFileSync(join(process.env.MS_LAYOUT_SHOTS, `store-pack-canvas-${width}.png`), await tab.screenshot());
        const r = await tab.eval<{ problems: string[]; boards: number }>(MEASURE(canvasWidth(width), VIEW_H), 30_000);
        expect(r.problems, `@${width}`).toEqual([]);
        expect(r.boards).toBe(19);
      } finally { await tab.close(); }
    }
  }, 180_000);
});

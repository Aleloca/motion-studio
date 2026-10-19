/**
 * Report 54 (the user's variant A): the store pack export in two panes, measured in real Chrome. The dialog is rendered in jsdom
 * with the 19 files of a full pack (App Store: 8 iPhone screenshots and the App Preview; Google Play: 8 phone screenshots, the
 * feature graphic and the promo video), its markup is given the real stylesheets and opened in a 1440×900 window: the dialog fits
 * without scrolling, the list of stores and items fits its pane, the screenshots are four to a row and the feature graphic
 * alone large, every thumbnail at its file's shape with its name on one line, the footer row in view and unclipped. Without
 * Chrome the measuring test is skipped (MS_REQUIRE_CHROME=1 makes a missing browser a failure; MS_LAYOUT_CHROME=1 turns it on);
 * MS_LAYOUT_SHOTS=<folder> saves a screenshot of each case.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, presetOf, storePackFormats, type StorePack, type VersionEntry } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';
import { ALL_CSS, FONTS } from './support/layoutAssets.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const pack: StorePack = {
  app: { name: 'Tasky', tagline: '' }, stores: ['appstore', 'playstore'], devices: { appstore: ['iphone-69'], playstore: ['phone', 'feature'] },
  screenshots: ['Organizza le attività della giornata', 'Trova tutto subito', 'Condividi con il team', 'Promemoria che arrivano al momento giusto',
    'Statistiche della settimana', 'Funziona anche offline', 'Temi chiari e scuri', 'Sincronizzato su tutti i dispositivi'].map((caption) => ({ caption, screen: null })),
  preview: true,
};
const made = storePackFormats(pack);
const size = (id: string) => DEFAULT_FORMATS.find((p) => p.id === presetOf(id))!;
const HUES = [212, 262, 330, 20, 140, 180, 45, 290];
/** A stand-in render of a format: its shape, a gradient and its number, as an SVG data URL (nothing is read from disk). */
const fake = (id: string) => {
  const { width: w, height: h } = size(id);
  const n = Number(id.split('@')[1] ?? 1);
  const hue = HUES[(n - 1) % HUES.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,62%)"/><stop offset="1" stop-color="hsl(${hue + 40},65%,38%)"/></linearGradient></defs>`
    + `<rect width="${w}" height="${h}" fill="url(#g)"/><rect x="${w * 0.12}" y="${h * 0.3}" width="${w * 0.76}" height="${h * 0.6}" rx="${w * 0.05}" fill="#fff" fill-opacity=".85"/>`
    + `<text x="${w / 2}" y="${h * 0.2}" font-family="sans-serif" font-weight="700" font-size="${Math.min(w, h) * 0.16}" fill="#fff" text-anchor="middle">${n}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};
const api = {
  exportStorePack: vi.fn(), exportStorePackGroup: vi.fn(), groupExportPlan: vi.fn(), storePackGroupFiles: vi.fn(),
  fileUrl: (_s: string, _c: string, rel: string) => fake(rel.replace(/^outputs\/v\d+\/(\.previews\/)?/, '').replace(/\.(png|mp4|jpg)$/g, '').replace(/\.mp4$/, '')),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { StorePackExport } = await import('../src/screens/creative/StorePackExport.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');

const isVideo = (id: string) => /preview|promo/.test(id);
const entry = {
  n: 1, outputs: made.formats.map((f) => ({
    format: f, file: isVideo(f) ? `${f}.mp4` : `${f}.png`, width: size(f).width, height: size(f).height, durationSec: isVideo(f) ? 20 : null,
    verified: true, preview: isVideo(f) ? `.previews/${f}.mp4.jpg` : null,
  })),
} as unknown as VersionEntry;

/** The dialog's markup with `leftOut` (the tiles' names, of the first device) clicked off and the item `show` picked. */
async function markup(leftOut: string[], show?: string): Promise<string> {
  const { unmount } = render(
    <I18nProvider locale="it">
      <StorePackExport open onClose={() => {}} slug="acme" creative="pack" title="Tasky" version={1} formats={made.formats} presets={DEFAULT_FORMATS} labels={made.formatLabels} entry={entry} />
    </I18nProvider>,
  );
  try {
    for (const name of leftOut) await userEvent.click(within(screen.getByRole('group', { name: 'File' })).getByRole('button', { name }));
    const nav = screen.getByRole('navigation', { name: 'Store e dispositivi' });
    if (show) await userEvent.click(within(nav).getByRole('button', { name: new RegExp(`^${show}`) }));
    return (document.querySelector('.ms-modal') as HTMLElement).outerHTML;
  } finally { unmount(); }
}

describe('store pack export (variant A): markup', () => {
  it('19 files: two stores with their items in the list, the first device shown in four columns', async () => {
    const doc = new DOMParser().parseFromString(await markup([]), 'text/html');
    expect([...doc.querySelectorAll('.ms-spx-item-name')].map((n) => n.textContent)).toEqual(['iPhone 6,9″', 'App Preview', 'Telefono', 'Feature graphic', 'Video promo 16:9']);
    expect(doc.querySelectorAll('.ms-spx-grid .ms-spx-tile')).toHaveLength(8);
    expect(doc.querySelector('.ms-spx-total')!.textContent).toBe('19 di 19 file selezionati');
  });
});

const MEASURE = `(() => {
const problems = [];
const box = (el) => el.getBoundingClientRect();
const inside = (el, p, what) => { const a = box(el), b = box(p); if (a.left < b.left - .5 || a.right > b.right + .5 || a.top < b.top - .5 || a.bottom > b.bottom + .5) problems.push(what + ' clipped'); };
const dialog = document.querySelector('.ms-dialog'), nav = document.querySelector('.ms-spx-nav'), grid = document.querySelector('.ms-spx-grid'), foot = document.querySelector('.ms-spx-foot');
const d = box(dialog);
if (d.top < 0 || d.bottom > innerHeight + .5 || d.left < 0 || d.right > innerWidth + .5) problems.push('dialog out of the window: ' + JSON.stringify(d));
if (dialog.scrollHeight > dialog.clientHeight + 1) problems.push('the dialog scrolls: ' + dialog.scrollHeight + '/' + dialog.clientHeight);
if (nav.scrollHeight > nav.clientHeight + 1) problems.push('the list scrolls: ' + nav.scrollHeight + '/' + nav.clientHeight);
if (grid.scrollWidth > grid.clientWidth + 1) problems.push('the grid scrolls sideways');
inside(foot, dialog, 'footer');
for (const el of foot.children) inside(el, foot, 'footer item ' + el.className);
for (const el of nav.querySelectorAll('.ms-spx-item, .ms-spx-storehead, .ms-spx-total')) inside(el, nav, 'list item ' + el.textContent);
const tiles = [...grid.querySelectorAll('.ms-spx-tile')];
const cols = new Set(tiles.map((t) => Math.round(box(t).left))).size;
for (const t of tiles) {
  const th = box(t.querySelector('.ms-spx-thumb')), a = parseFloat(t.style.getPropertyValue('--spx-a'));
  if (Math.abs(th.width - th.height * a) > 1.5) problems.push('wrong shape: ' + t.getAttribute('aria-label'));
  const name = t.querySelector('.ms-spx-file-name');
  if (box(name).height > 20) problems.push('name on two lines: ' + name.textContent);
}
const imgs = [...document.querySelectorAll('.ms-spx-thumb img')];
return { problems, cols, tileW: Math.round(box(tiles[0]).width), dialog: { w: Math.round(d.width), h: Math.round(d.height) }, broken: imgs.filter((i) => !i.complete || i.naturalWidth === 0).length };
})()`;

const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('store pack export (variant A): real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-pack-gallery-')); browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  const OUT = ['iPhone 6,9″ · 3 · Condividi con il team', 'iPhone 6,9″ · 6 · Funziona anche offline'];
  const CASES: Array<{ name: string; leftOut: string[]; show?: string; theme: 'light' | 'dark'; cols: number }> = [
    { name: 'all', leftOut: [], theme: 'light', cols: 4 },
    { name: 'some-left-out', leftOut: OUT, theme: 'light', cols: 4 },
    { name: 'some-left-out', leftOut: OUT, theme: 'dark', cols: 4 },
    { name: 'feature-graphic', leftOut: [], show: 'Feature graphic', theme: 'light', cols: 1 },
  ];
  it('at 1440×900 nothing is clipped: the list fits, four columns of screenshots, the footer in view', async () => {
    for (const c of CASES) {
      const html = await markup(c.leftOut, c.show);
      const page = `<!doctype html><html lang="it" data-theme="${c.theme}"><head><meta charset="utf-8"><style>${FONTS()}\n${ALL_CSS()}
        html,body{margin:0;height:100%}</style></head><body>${html}</body></html>`;
      const file = join(dir, `${c.name}-${c.theme}.html`);
      writeFileSync(file, page);
      const tab = await browser.newPage(1440, 900);
      try {
        await tab.goto(`file://${file}`);
        await tab.eval('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => null))))');
        if (process.env.MS_LAYOUT_SHOTS) writeFileSync(join(process.env.MS_LAYOUT_SHOTS, `store-pack-export-${c.name}-${c.theme}-1440.png`), await tab.screenshot());
        const r = await tab.eval<{ problems: string[]; cols: number; tileW: number; dialog: { w: number; h: number }; broken: number }>(MEASURE, 30_000);
        console.log('[store-pack export]', c.name, c.theme, JSON.stringify({ cols: r.cols, tileW: r.tileW, dialog: r.dialog }));
        expect(r.problems, `${c.name} ${c.theme}`).toEqual([]);
        expect(r.broken).toBe(0);
        expect(r.cols).toBe(c.cols);
        if (c.cols === 4) expect(r.tileW).toBeGreaterThanOrEqual(170);
      } finally { await tab.close(); }
    }
  }, 180_000);
});

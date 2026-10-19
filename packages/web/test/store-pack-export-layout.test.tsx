/**
 * Report 54: the store pack export as a gallery per store, measured in real Chrome. The dialog is rendered in jsdom with the 19
 * files of a full pack (App Store: 8 iPhone screenshots and the App Preview; Google Play: 8 phone screenshots, the feature
 * graphic and the promo video), its markup is given the real stylesheets and opened in a 1440×900 window: the whole dialog fits
 * without scrolling up and down, every thumbnail has the row's height and its file's shape, the names stay on one line, the App
 * Store's row fits and the Play Store's scrolls sideways. Without Chrome the measuring test is skipped (MS_REQUIRE_CHROME=1 makes a
 * missing browser a failure; MS_LAYOUT_CHROME=1 turns it on); MS_LAYOUT_SHOTS=<folder> saves a screenshot of each case.
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

/** A sideways track's width as Chrome lays it out at 1440 (the Play Store's row is wider than the dialog, the App Store's not). */
const TRACK = 1010;
const trackWidth = (el: HTMLElement) => (el.querySelector('.ms-spx-tile[style*="--spx-a: 2"]') ? 1900 : 900);

/** The dialog's markup with `leftOut` (the tiles' names) clicked off. */
async function markup(leftOut: string[]): Promise<string> {
  const cw = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-spx-track') ? TRACK : 0; });
  const sw = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ms-spx-track') ? trackWidth(this) : 0; });
  const { unmount } = render(
    <I18nProvider locale="it">
      <StorePackExport open onClose={() => {}} slug="acme" creative="pack" title="Tasky" version={1} formats={made.formats} presets={DEFAULT_FORMATS} labels={made.formatLabels} entry={entry} />
    </I18nProvider>,
  );
  try {
    const files = screen.getByRole('group', { name: 'File' });
    for (const name of leftOut) await userEvent.click(within(files).getByRole('button', { name }));
    expect(within(files).getAllByRole('button', { pressed: true })).toHaveLength(19 - leftOut.length);
    return (document.querySelector('.ms-modal') as HTMLElement).outerHTML;
  } finally { unmount(); cw.mockRestore(); sw.mockRestore(); }
}

describe('store pack export gallery: markup', () => {
  it('19 files in two stores, a row each, the single files at the end of the row; the Play Store row shows its sideways arrow', async () => {
    const doc = new DOMParser().parseFromString(await markup([]), 'text/html');
    const rows = [...doc.querySelectorAll('.ms-spx-row')];
    expect(rows.map((r) => r.querySelectorAll('.ms-spx-tile').length)).toEqual([9, 10]);
    expect(rows.map((r) => r.querySelector('.ms-spx-head-name')?.textContent)).toEqual(['iPhone 6,9″', 'Telefono']);
    expect(rows.map((r) => Boolean(r.querySelector('.ms-spx-nav.ms-next')))).toEqual([false, true]);
    expect(doc.querySelectorAll('.ms-spx-sep')).toHaveLength(2);
  });
});

const MEASURE = `(() => {
const problems = [];
const box = (el) => el.getBoundingClientRect();
const dialog = document.querySelector('.ms-dialog'), files = document.querySelector('.ms-spx-files');
const d = box(dialog);
if (d.top < 0 || d.bottom > innerHeight + .5 || d.left < 0 || d.right > innerWidth + .5) problems.push('dialog out of the window: ' + JSON.stringify(d));
if (dialog.scrollHeight > dialog.clientHeight + 1) problems.push('the dialog scrolls: ' + dialog.scrollHeight + '/' + dialog.clientHeight);
if (files.scrollHeight > files.clientHeight + 1) problems.push('the files scroll: ' + files.scrollHeight + '/' + files.clientHeight);
if (document.documentElement.scrollWidth > innerWidth) problems.push('the page scrolls sideways');
const thumbs = [...document.querySelectorAll('.ms-spx-thumb')];
const hs = thumbs.map((t) => Math.round(box(t).height));
if (new Set(hs).size !== 1) problems.push('thumbnails of different heights: ' + hs.join(','));
for (const t of thumbs) {
  const tile = t.closest('.ms-spx-tile'), a = parseFloat(tile.style.getPropertyValue('--spx-a'));
  const r = box(t);
  if (Math.abs(r.width - r.height * a) > 1.5) problems.push('wrong shape: ' + tile.getAttribute('aria-label') + ' ' + r.width + '×' + r.height);
  const name = tile.querySelector('.ms-spx-file-name');
  if (box(name).height > 20) problems.push('name on two lines: ' + name.textContent);
  if (box(name).width > r.width + .5) problems.push('name wider than its thumbnail: ' + name.textContent);
}
const tracks = [...document.querySelectorAll('.ms-spx-track')].map((t) => ({ over: t.scrollWidth > t.clientWidth + 1, w: t.clientWidth }));
const imgs = [...document.querySelectorAll('.ms-spx-thumb img')];
return { problems, thumbH: hs[0], tracks, dialog: { w: Math.round(d.width), h: Math.round(d.height) }, broken: imgs.filter((i) => !i.complete || i.naturalWidth === 0).length };
})()`;

const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('store pack export gallery: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-pack-gallery-')); browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  const CASES: Array<{ name: string; leftOut: string[]; theme: 'light' | 'dark' }> = [
    { name: 'all', leftOut: [], theme: 'light' },
    { name: 'some-left-out', leftOut: ['iPhone 6,9″ · 3 · Condividi con il team', 'iPhone 6,9″ · 6 · Funziona anche offline', 'App Preview', 'Feature graphic'], theme: 'light' },
    { name: 'some-left-out', leftOut: ['iPhone 6,9″ · 3 · Condividi con il team', 'iPhone 6,9″ · 6 · Funziona anche offline', 'App Preview', 'Feature graphic'], theme: 'dark' },
  ];
  it('at 1440×900 the whole pack is on one screen: same height, real shapes, one-line names; only the Play Store row scrolls sideways', async () => {
    for (const c of CASES) {
      const html = await markup(c.leftOut);
      const page = `<!doctype html><html lang="it" data-theme="${c.theme}"><head><meta charset="utf-8"><style>${FONTS()}\n${ALL_CSS()}
        html,body{margin:0;height:100%}</style></head><body>${html}</body></html>`;
      const file = join(dir, `${c.name}-${c.theme}.html`);
      writeFileSync(file, page);
      const tab = await browser.newPage(1440, 900);
      try {
        await tab.goto(`file://${file}`);
        await tab.eval('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => null))))');
        if (process.env.MS_LAYOUT_SHOTS) writeFileSync(join(process.env.MS_LAYOUT_SHOTS, `store-pack-gallery-${c.name}-${c.theme}-1440.png`), await tab.screenshot());
        const r = await tab.eval<{ problems: string[]; thumbH: number; tracks: Array<{ over: boolean; w: number }>; dialog: { w: number; h: number }; broken: number }>(MEASURE, 30_000);
        console.log('[store-pack gallery]', c.name, c.theme, JSON.stringify({ thumbH: r.thumbH, tracks: r.tracks, dialog: r.dialog }));
        expect(r.problems, `${c.name} ${c.theme}`).toEqual([]);
        expect(r.broken).toBe(0);
        expect(r.thumbH).toBeGreaterThanOrEqual(180);
        expect(r.tracks.map((t) => t.over)).toEqual([false, true]);
        // The jsdom stand-in for the track's width (the arrows in the markup) is Chrome's.
        expect(Math.abs(r.tracks[0]!.w - TRACK)).toBeLessThan(40);
      } finally { await tab.close(); }
    }
  }, 180_000);
});

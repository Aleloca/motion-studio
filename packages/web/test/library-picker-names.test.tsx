/**
 * Report 69: the library picker of the brief chat (and New creative) shows each file's name under its thumbnail, so two
 * videos that both start black can be told apart. Names: one line, ellipsis, the full name in the tooltip and the accessible
 * name; a video wears a play badge. The markup is rendered in jsdom, given the real stylesheets and measured in real Chrome
 * (light and dark, a narrow and a wide popover); without Chrome the measuring tests are skipped (MS_REQUIRE_CHROME=1 makes a
 * missing browser a failure). MS_LAYOUT_SHOTS=<folder> also saves a screenshot of each case there.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import type { AssetEntry } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';

vi.mock('../src/api.ts', () => ({ api: { projectFileUrl: (_s: string, p: string) => `data:,${p}` }, ApiError: class extends Error {} }));
const { LibraryPicker } = await import('../src/screens/new-creative/LibraryPicker.tsx');

const entry = (file: string, kind: AssetEntry['kind']): AssetEntry => ({ file, kind, description: '', tags: [], origin: 'uploaded' } as unknown as AssetEntry);
const LONG = 'intervista-fondatore-versione-lunga-per-i-social-2026-10-final-v3.mp4';
const items = [entry('intro.mp4', 'video'), entry('intro-2.mp4', 'video'), entry(LONG, 'video'), entry('logo.svg', 'svg'), entry('foto.png', 'image'), entry('voce.mp3', 'audio'), entry('Montserrat.ttf', 'font')];

function renderPicker(chosen: string[] = []) {
  const anchor = { current: document.body };
  return render(
    <I18nProvider locale="it">
      <LibraryPicker slug="acme" projectName="Acme" open onClose={() => {}} anchor={anchor} library={{ value: items, error: null }} onRetry={() => {}} chosen={chosen} onToggle={() => {}} />
    </I18nProvider>,
  );
}

describe('library picker: names under the thumbnails', () => {
  it('shows each file name under its thumbnail, with the full name as tooltip and accessible name', () => {
    renderPicker();
    const dialog = screen.getByRole('dialog', { name: 'Asset di Acme' });
    for (const f of ['intro.mp4', 'intro-2.mp4', LONG, 'logo.svg', 'foto.png']) {
      const tile = within(dialog).getByRole('button', { name: f });
      expect(tile.title).toBe(f);
      const name = tile.querySelector('.ms-nc-pick-name');
      expect(name?.textContent).toBe(f);
    }
    expect(within(dialog).queryByRole('button', { name: 'Montserrat.ttf' }), 'fonts stay out').toBeNull();
  });
  it('a video wears a play badge, an image does not', () => {
    renderPicker();
    expect(screen.getByRole('button', { name: 'intro.mp4' }).querySelector('.ms-nc-face-play')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'foto.png' }).querySelector('.ms-nc-face-play')).toBeNull();
  });
  it('a described asset keeps its description as tooltip', () => {
    const anchor = { current: document.body };
    render(<I18nProvider locale="it"><LibraryPicker slug="acme" projectName="Acme" open onClose={() => {}} anchor={anchor} library={{ value: [{ ...entry('a.mp4', 'video'), description: 'Un video' }], error: null }} onRetry={() => {}} chosen={[]} onToggle={() => {}} /></I18nProvider>);
    expect(screen.getByRole('button', { name: 'a.mp4' }).title).toBe('a.mp4\nUn video');
  });
});

const src = (p: string) => readFileSync(join(import.meta.dirname, '../src', p), 'utf8');
const CSS = ['theme.css', 'ui/ui.css', 'screens/newcreative.css'].map(src).join('\n');
const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const shots = process.env.MS_LAYOUT_SHOTS ?? null;

const MEASURE = `(() => {
const problems = [];
const grid = document.querySelector('.ms-nc-pick-grid');
if (document.documentElement.scrollWidth > innerWidth) problems.push('page overflows');
if (grid.scrollWidth > grid.clientWidth) problems.push('grid scrolls sideways');
const tiles = [...document.querySelectorAll('.ms-nc-pick')];
const heights = new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().height)));
if (heights.size !== 1) problems.push('tiles differ in height: ' + [...heights]);
for (const t of tiles) {
  const r = t.getBoundingClientRect();
  const n = t.querySelector('.ms-nc-pick-name');
  if (!n) continue;
  const nr = n.getBoundingClientRect();
  if (nr.left < r.left - 0.5 || nr.right > r.right + 0.5 || nr.bottom > r.bottom + 0.5) problems.push('name outside its tile: ' + n.textContent);
  if (nr.height > 20) problems.push('name wraps: ' + n.textContent);
  if (getComputedStyle(n).textOverflow !== 'ellipsis') problems.push('no ellipsis');
}
const long = [...document.querySelectorAll('.ms-nc-pick-name')].find((n) => n.textContent.length > 40);
return { problems, tiles: tiles.length, longClipped: !!long && long.scrollWidth > long.clientWidth };
})()`;

const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('library picker names: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-picker-names-')); browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  for (const theme of ['light', 'dark'] as const) {
    for (const width of [260, 360]) {
      it(`${theme} ${width}: names stay inside their tiles, on one line`, async () => {
        const { container, unmount } = renderPicker(['assets/intro-2.mp4']);
        const html = container.ownerDocument.body.querySelector('.ms-nc-picker')!.outerHTML;
        unmount();
        const page = `<!doctype html><html lang="it" data-theme="${theme}"><head><meta charset="utf-8"><style>${CSS}
          body{margin:0;background:var(--bg,#fff);padding:12px} #w{width:${width}px;box-sizing:border-box;background:var(--surface,var(--bg,#fff));border:1px solid var(--line)}</style></head><body><div id="w">${html}</div></body></html>`;
        const file = join(dir, `picker-${theme}-${width}.html`);
        writeFileSync(file, page);
        const tab = await browser.newPage(width + 24, 600);
        try {
          await tab.goto(`file://${file}`);
          const r = await tab.eval<{ problems: string[]; tiles: number; longClipped: boolean }>(MEASURE, 30_000);
          expect(r.problems, `${theme} @${width}`).toEqual([]);
          expect(r.tiles).toBe(6);
          expect(r.longClipped, 'the long name is cut, not wrapped').toBe(true);
          if (shots && width === 360) writeFileSync(join(shots, `picker-names-${theme}.png`), await tab.screenshot());
        } finally { await tab.close(); }
      }, 120_000);
    }
  }
});

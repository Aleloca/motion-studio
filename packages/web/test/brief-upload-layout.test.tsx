/**
 * Report 62: the "Asset da usare" section of New creative with files from the computer, measured in real Chrome, light and
 * dark, at 1440 × 900 and 1024 × 700: a file only for this creative and one saved in Assets (each with its mark under the
 * tile), an upload under way and a failed one. Every mark and tile inside its 72 px column, no text cut sideways, the marks
 * readable (4.5:1), nothing scrolling sideways. The markup is rendered in jsdom with the real stylesheets; without Chrome the
 * tests are skipped (MS_REQUIRE_CHROME=1 makes a missing browser a failure). MS_LAYOUT_SHOTS=<folder> saves a screenshot.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, EMPTY_BRAND_KIT, type AssetEntry } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initialEventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';

const entry = (file: string, over: Partial<AssetEntry> = {}): AssetEntry => ({
  file, kind: 'other', origin: 'upload', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: '2026-10-21T10:00:00.000Z', attribution: null, ...over,
});
let uploads = 0;
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [], creativeReferences: [] })),
  getBrand: vi.fn(async () => ({ kit: EMPTY_BRAND_KIT, kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k' })),
  projectFileUrl: () => 'data:,',
  getFirstGenerations: vi.fn(async () => ({ tokens: [] })),
  getSecrets: vi.fn(async () => []),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: '2026-10-20T10:00:00.000Z' })),
  getBriefSession: vi.fn(async () => null),
  getBriefConversation: vi.fn(async () => []),
  // 1st: two files; 2nd: under way (never answers); 3rd: refused.
  uploadFiles: vi.fn((_s: string, _k: string, files: File[]) => {
    uploads += 1;
    if (uploads === 1) return Promise.resolve({ assets: files.map((f) => ({ ...entry(f.name), referenceFor: [] })) });
    if (uploads === 2) return new Promise(() => {});
    return Promise.reject(new Error('Il file supera i 200 MB consentiti'));
  }),
  setAssetReference: vi.fn(async (_s: string, file: string, reference: boolean) => (reference ? { ...entry(file), referenceFor: [] } : entry(file))),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { NewCreative } = await import('../src/screens/NewCreative.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');

const src = (p: string) => readFileSync(join(import.meta.dirname, '../src', p), 'utf8');
const CSS = ['theme.css', 'ui/ui.css', 'components/conversation.css', 'components/codebase.css', 'components/services.css', 'screens/newcreative.css',
  'screens/new-creative/storepack.css', 'screens/new-creative/briefsession.css', 'shell/shell.css'].map(src).join('\n');
const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const shots = process.env.MS_LAYOUT_SHOTS ?? null;

async function markup(): Promise<string> {
  const shell = { route: { name: 'new-creative', slug: 'acme' }, live: initialEventsState, catalog: { projects: [{ slug: 'acme', name: 'Audin' }], creatives: {}, refresh: () => {} } } as never;
  const { container, unmount } = render(
    <I18nProvider locale="it"><ShellContext.Provider value={shell}><div id="page"><NewCreative slug="acme" live={initialEventsState} /></div></ShellContext.Provider></I18nProvider>,
  );
  await waitFor(() => screen.getByRole('group', { name: 'Instagram' }));
  const input = screen.getByLabelText('File da aggiungere al brief');
  const file = (name: string) => new File(['x'], name);
  await userEvent.upload(input, [file('moodboard-campagna-primavera.pdf'), file('voce-guida.mp3')]);
  await userEvent.click(await screen.findByRole('button', { name: /voce-guida\.mp3 è solo per questa creatività/ }));
  await screen.findByRole('button', { name: /voce-guida\.mp3 è salvato negli Asset/ });
  await userEvent.upload(input, [file('ripresa-drone-4k.mov')]);
  await userEvent.upload(input, [file('video-troppo-grande.mov')]);
  const section = screen.getByRole('list', { name: 'Asset da usare' });
  await screen.findByRole('alert');
  expect(within(section).getAllByRole('listitem')).toHaveLength(5);
  const html = container.querySelector('#page')!.innerHTML;
  unmount();
  return html;
}

const MEASURE = `(() => {
const within = (a, b) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
const sec = document.querySelector('.ms-nc-assetsec');
sec.scrollIntoView({ block: 'center' });
const box = sec.getBoundingClientRect();
const cols = [...sec.querySelectorAll('.ms-nc-asset-col')].map((col) => {
  const c = col.getBoundingClientRect();
  return { width: Math.round(c.width), inside: [...col.children].every((k) => within(k.getBoundingClientRect(), c)) };
});
const marks = [...sec.querySelectorAll('.ms-nc-refmark')].map((m) => ({ text: m.textContent, color: getComputedStyle(m).color, bg: getComputedStyle(m).backgroundColor,
  cut: m.scrollWidth > m.clientWidth + 1, height: Math.round(m.getBoundingClientRect().height) }));
let panel = sec;
while (panel && getComputedStyle(panel).backgroundColor.match(/, 0\\)$|transparent/)) panel = panel.parentElement;
const base = panel ? getComputedStyle(panel).backgroundColor : getComputedStyle(document.body).backgroundColor;
const err = sec.querySelector('.ms-nc-uperr');
const errBox = err.getBoundingClientRect();
const cut = [...sec.querySelectorAll('.ms-nc-lbl, .ms-nc-browse, .ms-nc-small, .ms-nc-uperr')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent);
return { cols, marks, base, cut, inside: [...sec.querySelectorAll('.ms-nc-asset, .ms-nc-browse')].every((el) => within(el.getBoundingClientRect(), box)),
  failed: sec.querySelectorAll('.ms-nc-upfailed').length, errInside: errBox.left >= box.left - 0.5 && errBox.right <= box.right + 0.5, uploading: sec.querySelectorAll('.ms-nc-uploading').length,
  scroll: document.documentElement.scrollWidth, inner: innerWidth };
})()`;
type Measure = {
  cols: Array<{ width: number; inside: boolean }>; marks: Array<{ text: string; color: string; bg: string; cut: boolean; height: number }>;
  base: string; cut: string[]; inside: boolean; failed: number; errInside: boolean; uploading: number; scroll: number; inner: number;
};

type Rgba = [number, number, number, number];
const rgba = (c: string): Rgba => { const n = (c.match(/[\d.]+/g) ?? []).map(Number); return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1]; };
const over = (top: Rgba, base: Rgba): Rgba => [0, 1, 2].map((i) => top[i]! * top[3] + base[i]! * (1 - top[3])).concat(1) as Rgba;
const lum = ([r, g, b]: Rgba) => [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (text: string, bg: string, base: string) => {
  const b = over(rgba(bg), rgba(base)), t = over(rgba(text), b);
  const [hi, lo] = [lum(t), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('brief files from the computer: real Chrome layout (report 62)', () => {
  let dir = '';
  let browser: Browser;
  let html = '';
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ms-brief-upload-layout-'));
    browser = await launchChrome(chrome!);
    html = await markup();
  }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  for (const theme of ['light', 'dark'] as const) {
    for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
      it(`${theme} ${width}: the marks, the upload under way and the failed one stay in their columns, readable`, async () => {
        const page = `<!doctype html><html lang="it" data-theme="${theme}"><head><meta charset="utf-8"><style>${CSS}
          html,body{height:100%;margin:0}</style></head>
          <body><div class="ms-app ms-bare"><div class="ms-main" id="main"><div class="ms-stage"><div class="ms-page">${html}</div></div></div></div></body></html>`;
        const file = join(dir, `brief-upload-${theme}-${width}.html`);
        writeFileSync(file, page);
        const tab = await browser.newPage(width, height);
        let r: Measure;
        try {
          await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
          await tab.goto(`file://${file}`);
          r = await tab.eval<Measure>(MEASURE, 30_000);
          if (shots) writeFileSync(join(shots, `brief-upload-${theme}-${width}x${height}.png`), await tab.screenshot());
        } finally { await tab.close(); }
        expect(r.marks.map((m) => m.text)).toEqual(['Solo per questa creatività', 'Salvato negli Asset']);
        expect(r.uploading).toBe(1);
        expect(r.failed).toBe(1);
        expect(r.cols.length).toBe(4);
        expect(r.cols.filter((c) => c.width !== 72 || !c.inside), 'every tile and mark inside its 72 px column').toEqual([]);
        expect(r.marks.filter((m) => m.cut), 'no mark cut sideways').toEqual([]);
        for (const m of r.marks) expect(contrast(m.color, m.bg, r.base), `"${m.text}" readable`).toBeGreaterThanOrEqual(4.5);
        expect(r.cut, 'the section\'s labels whole').toEqual([]);
        expect(r.inside).toBe(true);
        expect(r.errInside, 'the upload error line inside the section').toBe(true);
        expect(r.scroll).toBeLessThanOrEqual(r.inner);
      }, 120_000);
    }
  }
});

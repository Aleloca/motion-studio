/**
 * SVG inner editor, Task 5: the inspector of a logo with many colours and elements: the layer's "SVG content" section with a
 * colour open (its swatches), and the inspector of one element (its fill and stroke, user test items 12 and 14), rendered in
 * jsdom and measured in real Chrome inside the image editor's grid at 1280 and 1024 px, en and it: the long list of colours
 * scrolls inside the section, and nothing in the inspector overflows its column or the page. Chrome only on request (MS_LAYOUT_CHROME=1 or
 * MS_REQUIRE_CHROME=1), through the repo's driver (mock keychain, basic password store).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { DEFAULT_FORMATS, type Composition, type EditorCompositionView } from '@motion-studio/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';
import { ALL_CSS, FONTS } from './support/layoutAssets.ts';

const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

/** A logo with 40 distinct colours in 60 shapes, in groups, and a long text. */
const hex = (i: number) => `#${(0x102030 + i * 0x050403).toString(16).padStart(6, '0').slice(-6)}`;
const SHAPES = Array.from({ length: 60 }, (_, i) => `<rect x="${i}" y="${i}" width="10" height="10" fill="${hex(i % 40)}"/>`);
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g id="a-group-with-a-rather-long-name-for-the-column">${SHAPES.slice(0, 30).join('')}</g>`
  + `<g>${SHAPES.slice(30).join('')}</g><text x="1" y="90">Acme Corporation International, the long brand line under the mark</text></svg>`;

const api = vi.hoisted(() => ({ getBrand: vi.fn(), listAssets: vi.fn(), getEditorSvg: vi.fn() }));
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { EditorContext } = await import('../src/screens/editor/editorContext.ts');
const { __resetDrafts, draftKey, useDraft } = await import('../src/screens/editor/draftStore.ts');
const { Inspector } = await import('../src/screens/editor/Inspector.tsx');
const { SvgSessions } = await import('../src/screens/editor/svgSessions.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
type EditorState = import('../src/screens/editor/editorContext.ts').EditorState;

const LOGO = 'identity-logo';
const preset = DEFAULT_FORMATS.find((p) => p.id === LOGO)!;
const KEY = draftKey('acme', 'marchio', LOGO);
const svgClip = (id: string, hidden = false) => ({ id, type: 'svg', src: 'assets/logo.svg', start: 0, duration: 0, ...(hidden ? { hidden: true } : {}), props: { fit: 'contain' } });
const comp = (): Composition => ({
  $schema: 'motion-studio/composition@1', width: 1024, height: 1024, fps: 30, duration: 0, background: '#ffffff', fonts: [], scenes: [],
  tracks: [{ id: 't', kind: 'visual', clips: [svgClip('logo'), svgClip('dark', true)] }],
} as unknown as Composition);
const view = (): EditorCompositionView => ({ n: 1, format: LOGO, primaryFormat: LOGO, hash: 'h'.repeat(64), composition: comp(), files: [{ path: 'assets/logo.svg', size: 9000 }], fonts: [] });

function Harness({ children, locale, element }: { children: ReactNode; locale: 'en' | 'it'; element: string | null }) {
  const [draft, actions] = useDraft(KEY);
  const [svgElement, selectSvgElement] = useState<string | null>(element);
  useEffect(() => { actions.open(view(), preset); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!draft) return null;
  const ctx = {
    slug: 'acme', creative: 'marchio', format: LOGO, primary: LOGO, draft, actions, player: null, selection: 'logo', select: () => {},
    snap: false, setSnap: () => {}, token: 'tok', staging: false, stageAsset: async () => null, stageSvg: async () => { throw new Error('not here'); },
    readOnly: null, svgElement, selectSvgElement, controls: { playing: false, ready: true, duration: 0 },
  } as unknown as EditorState;
  return <I18nProvider locale={locale}><EditorContext.Provider value={ctx}><SvgSessions>{children}</SvgSessions></EditorContext.Provider></I18nProvider>;
}

/** The inspector of the logo clip with a colour open, or of one element of it (the fourth rectangle of the first group), as markup. */
async function markup(locale: 'en' | 'it', element: boolean): Promise<string> {
  __resetDrafts();
  api.getBrand.mockResolvedValue({ kit: { colors: [{ id: 'c1', name: 'Ink', hex: '#1B1913', role: 'primary', source: { kind: 'manual', ref: null } }], fonts: [] } });
  api.listAssets.mockResolvedValue({ assets: [], error: null, unregistered: [] });
  api.getEditorSvg.mockResolvedValue({ path: 'assets/logo.svg', content: SVG, warnings: [] });
  const { container } = render(<Harness locale={locale} element={element ? '0/3' : null}><Inspector /></Harness>);
  if (element) await waitFor(() => expect(container.querySelector('[data-section="svg-element"] .ms-paint')).toBeTruthy());
  else {
    const sec = await waitFor(() => container.querySelector<HTMLElement>('[data-section="svg"] .ms-svg-colors')!.closest('section')!);
    fireEvent.click(within(sec).getAllByRole('button', { pressed: false }).find((b) => b.classList.contains('ms-svg-color'))!);
    await waitFor(() => expect(sec.querySelector('.ms-color')).toBeTruthy());
  }
  const html = container.innerHTML;
  cleanup();
  return html;
}

const MEASURE = (lists: string[]) => `(() => {
const problems = [];
const side = document.querySelector('.ms-ed-right');
const sr = side.getBoundingClientRect();
for (const sel of ${JSON.stringify(lists)}) {
  const el = document.querySelector(sel);
  if (!el) { problems.push('missing ' + sel); continue; }
  if (getComputedStyle(el).overflowY !== 'auto') problems.push(sel + ' does not scroll');
  if (!(el.scrollHeight > el.clientHeight + 1)) problems.push(sel + ' is not taller than its box: ' + el.scrollHeight + ' / ' + el.clientHeight);
}
for (const el of side.querySelectorAll('*')) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) continue;
  if (r.left < sr.left - 0.5 || r.right > sr.right + 0.5) problems.push('outside the column: ' + (el.className || el.tagName) + ' ' + JSON.stringify([r.left, r.right]) + ' in ' + JSON.stringify([sr.left, sr.right]));
}
for (const el of [side, document.querySelector('.ms-ed-panel'), ...side.querySelectorAll('.ms-insp-sec, .ms-svg-part, .ms-svg-colors, .ms-paint, .ms-paint-row')]) {
  if (el.scrollWidth > el.clientWidth + 1) problems.push('scrolls sideways: ' + el.className + ' ' + el.scrollWidth + ' > ' + el.clientWidth);
}
if (document.documentElement.scrollWidth > innerWidth) problems.push('page overflows');
return problems.slice(0, 12);
})()`;

run('SVG content section: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-svg-content-')); browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  for (const [locale, element] of [['en', false], ['it', false], ['en', true], ['it', true]] as const) {
    it(`${locale}, ${element ? 'an element' : 'the layer'}: long lists scroll inside the section, nothing overflows the inspector at 1280 and 1024`, async () => {
      const html = await markup(locale, element);
      expect(html).toContain(element ? 'ms-paint' : 'ms-svg-colors');
      for (const [width, height] of [[1280, 800], [1024, 720]] as const) {
        const page = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><style>${FONTS()}\n${ALL_CSS()}
          body{margin:0;background:var(--bg)} .ms-ed{width:${width}px;height:${height}px}</style></head><body>
          <div class="ms-ed ms-ed-image"><aside class="ms-ed-side ms-ed-left"></aside><main></main>
          <aside class="ms-ed-side ms-ed-right"><div id="ms-ed-panel" role="tabpanel" class="ms-ed-panel">${html}</div></aside></div></body></html>`;
        const file = join(dir, `${locale}-${element ? 'el' : 'layer'}-${width}.html`);
        writeFileSync(file, page);
        const tab = await browser.newPage(width, height);
        try {
          await tab.goto(`file://${file}`);
          expect(await tab.eval<string[]>(MEASURE(element ? [] : ['.ms-svg-colors']), 30_000), `${locale} @${width}`).toEqual([]);
        } finally { await tab.close(); }
      }
    }, 120_000);
  }
});

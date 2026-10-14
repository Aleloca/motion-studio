/**
 * The format view's top bar with a ready render (UX feedback batch 1, final wave I2). The real FormatView is rendered in
 * jsdom, in Italian, with everything the bar can carry at once: the version badge and Versions, the render status with a
 * ready video (pill with the size, Scarica / Mostra nel Finder, Rifai il render), Lingue, Duplica, Modifica and Esporta. The
 * bar's markup, given the app's stylesheets and its fonts, is measured in real Chrome at 1024 and 1280 px, in the browser
 * and in the macOS desktop title bar (80 px for the traffic lights): nothing leaves the bar, nothing overlaps, no control's
 * text is clipped and the format's name keeps room. Chrome only on request (MS_LAYOUT_CHROME=1 or MS_REQUIRE_CHROME=1),
 * through the repo's driver (mock keychain, basic password store).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_FORMATS, type CreativeDetail, type OutputFileInfo, type VersionEntry } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
// The repo's proven Chrome driver (CDP over a pipe; it passes --use-mock-keychain and --password-store=basic, as BASE_FLAGS does).
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const at = '2026-10-08T10:00:00.000Z';
const VIDEO = 'tiktok-9x16';
const H = 'b'.repeat(64);
const out = (format: string, file: string, durationSec: number | null = null): OutputFileInfo => ({ format, file, width: 1080, height: 1920, durationSec, verified: true, preview: null });
const version = (n: number, rendered: boolean): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', problems: [], tools: [], renderCommand: null, basedOn: null,
  outputs: rendered ? [{ ...out(VIDEO, 'tiktok.mp4', 8), sha256: 'd'.repeat(64), fromComposition: H }] : [],
  compositions: [{ format: VIDEO, dir: `compositions/${VIDEO}`, hash: H }],
});
const detail: CreativeDetail = {
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions: [version(1, true), version(2, true)],
  creative: {
    schemaVersion: 1, title: 'Lancio estivo', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: 'm', formats: [VIDEO], durationSec: 8, assets: [], notes: '', locales: { primary: 'it', extra: ['en'] } },
  },
} as unknown as CreativeDetail;

const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async () => detail),
  getConversation: vi.fn(async () => []),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  fileBytes: vi.fn(async () => 12_400_000),
  revokePreview: vi.fn(async () => ({ revoked: true })),
  previewSession: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({
    url: `http://127.0.0.1:61234/tok-${format}-v${n}/runtime/index.html?mode=preview&parentOrigin=x`, token: `tok-${format}-v${n}`, origin: 'http://127.0.0.1:61234',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: H, width: 1080, height: 1920, duration: 8, fps: 30,
  })),
  getEditorComposition: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({
    n, format, primaryFormat: format, hash: H, files: [], fonts: [],
    composition: { $schema: 'motion-studio/composition@1', width: 1080, height: 1920, fps: 30, duration: 8, background: '#000000', fonts: [], scenes: [], tracks: [] },
  })),
  getStoryboard: vi.fn(async (_s: string, _c: string, _n: number, format: string) => ({ format, hash: H, width: 270, expiresAt: new Date(Date.now() + 600_000).toISOString(), frames: [] })),
};
class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { FormatView } = await import('../src/screens/FormatView.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');

const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
function Harness() {
  const route: Route = { name: 'format', slug: 'acme', creative: 'lancio', format: VIDEO };
  const shell = {
    route, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} },
    openPalette: () => {},
  } as unknown as Shell;
  return (
    <ShellContext.Provider value={shell}>
      <TopBar />
      <FormatView slug="acme" creative="lancio" format={VIDEO} live={live} />
    </ShellContext.Provider>
  );
}

/** The bar's markup with a ready render, in the browser (Scarica) or in the desktop app (Mostra nel Finder). */
async function barMarkup(desktopApp: boolean): Promise<string> {
  location.hash = `#/p/acme/c/lancio/f/${VIDEO}`;
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  if (desktopApp) (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => null, revealPath: async () => {} };
  try {
    render(<Harness />);
    const bar = () => document.querySelector('.ms-topbar') as HTMLElement;
    await waitFor(() => expect(within(bar()).getAllByText('Video pronto · 12,4 MB').length).toBeGreaterThan(0));
    await waitFor(() => expect(bar().querySelector('.ms-cv-edit')).not.toBeNull());
    for (const name of [/^Rifai il render|Fai il render del video di/, desktopApp ? /Mostra nel Finder/ : /Scarica il video di/, /^Lingue/, /^Duplica/, /^Modifica/, /^Esporta/]) {
      expect(within(bar()).getAllByRole('button', { name }).length, String(name)).toBeGreaterThan(0);
    }
    expect(screen.getAllByText('Rifai il render').length).toBeGreaterThan(0);
    return bar().outerHTML;
  } finally {
    cleanup();
    platform.mockRestore();
    delete (window as unknown as { motionStudio?: unknown }).motionStudio;
  }
}

const src = (p: string) => readFileSync(join(import.meta.dirname, '../src', p), 'utf8');
// The app's stylesheets: the base first, then every other one (the bar shows pieces styled by several of them).
const cssFiles = (dir: string): string[] => readdirSync(join(import.meta.dirname, '../src', dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));
const ALL_CSS = () => {
  const rest = cssFiles('').filter((f) => f !== 'theme.css' && f !== join('ui', 'ui.css')).sort();
  return ['theme.css', join('ui', 'ui.css'), ...rest].map(src).join('\n');
};
/** The app's fonts (fontsource), with their files loaded from disk. */
const FONTS = () => ['schibsted-grotesk/400.css', 'schibsted-grotesk/500.css', 'schibsted-grotesk/600.css', 'schibsted-grotesk/700.css', 'jetbrains-mono/400.css', 'jetbrains-mono/500.css']
  .map((f) => {
    const file = join(import.meta.dirname, '../node_modules/@fontsource', f);
    return readFileSync(file, 'utf8').replaceAll('url(./', `url(file://${dirname(file)}/`);
  }).join('\n');

const MEASURE = `(async () => {
await document.fonts.ready;
const bar = document.querySelector('.ms-topbar');
const br = bar.getBoundingClientRect();
const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.ms-sr');
const problems = [];
if (document.documentElement.scrollWidth > innerWidth) problems.push('page overflows');
if (bar.scrollWidth > bar.clientWidth + 1) problems.push('bar overflows by ' + (bar.scrollWidth - bar.clientWidth));
const controls = [...bar.querySelectorAll('button, .ms-pill, .ms-fv-meta, .ms-fv-badge')].filter(vis).filter((el) => !el.parentElement.closest('button, .ms-pill'));
for (const el of controls) {
  const r = el.getBoundingClientRect();
  if (r.left < br.left - 0.5 || r.right > br.right + 0.5) problems.push('outside the bar: ' + (el.getAttribute('aria-label') || el.textContent));
  for (const leaf of [el, ...el.querySelectorAll('*')]) if (vis(leaf) && leaf.children.length === 0 && leaf.textContent && leaf.scrollWidth > leaf.clientWidth + 1) problems.push('clipped: ' + leaf.textContent);
}
const solid = controls.filter((el) => !el.classList.contains('ms-fv-badge'));
for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
  const a = solid[i].getBoundingClientRect(), b = solid[j].getBoundingClientRect();
  if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom && a.bottom > b.top) problems.push('overlap: ' + (solid[i].textContent || solid[i].getAttribute('aria-label')) + ' / ' + (solid[j].textContent || solid[j].getAttribute('aria-label')));
}
const name = bar.querySelector('.ms-fv-crumb b');
const nameWidth = name ? name.getBoundingClientRect().width : 0;
const iconOnly = [...bar.querySelectorAll('.ms-fv-render button')].filter(vis).map((b) => b.getBoundingClientRect().width);
const unnamed = [...bar.querySelectorAll('button')].filter(vis).filter((b) => !(b.getAttribute('aria-label') || [...b.querySelectorAll('*')].concat([b]).some((n) => vis(n) && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())))).map((b) => b.className);
const widths = [...bar.children].flatMap((c) => c.classList.contains('ms-bar-slot') ? [...c.children] : [c]).filter(vis).map((el) => (el.getAttribute('aria-label') || el.textContent || el.className).slice(0, 18) + '=' + Math.round(el.getBoundingClientRect().width));
return { problems, widths, nameWidth: Math.round(nameWidth), slack: bar.clientWidth - bar.scrollWidth, iconOnly, unnamed };
})()`;

const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

describe('format view bar: CSS rules', () => {
  it('the render actions go icon-only by the width of the bar, keeping their names (aria-label, title)', () => {
    expect(src('shell/shell.css')).toMatch(/\.ms-topbar\s*\{[^}]*container:\s*ms-topbar\s*\/\s*inline-size/);
    const fmt = src('screens/format.css');
    const narrow = fmt.slice(fmt.indexOf('@container ms-topbar'));
    expect(narrow).toMatch(/@container ms-topbar[^{]*\(max-width:\s*\d+px\)/);
    expect(narrow).toMatch(/\.ms-fold-1 > \.ms-bar-label[^{]*\{[^}]*display:\s*none/);
    expect(fmt).not.toMatch(/@media[^{]*(max|min)-width[^{]*\{[^}]*ms-fold/);
  });
});

describe('format view bar: what it carries with a ready render', () => {
  it('in Italian: the version badge, Versions, the ready pill, Scarica, Rifai il render, Lingue, Duplica, Modifica, Esporta', async () => {
    const html = await barMarkup(false);
    expect(html).toContain('ms-fv-render');
    expect(html).toContain('ms-cv-languages');
    expect(html).toContain('ms-fv-duplicate');
  });
});

run('format view bar with a ready render: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-topbar-')); browser = await launchChrome(chrome!); });
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); });

  // 1024 is the desktop window's minimum width (apps/desktop/src/window.ts), 1440 its default; 1129, 1529 and 1789 put the
  // browser bar's content (28 px of padding) just above a folding step (1100, 1500, 1760), where it is at its fullest.
  const WIDTHS = [1024, 1129, 1280, 1440, 1529, 1789, 1920];
  for (const desktopApp of [false, true]) {
    it(`${desktopApp ? 'desktop (macOS title bar)' : 'browser'}: Italian, ${WIDTHS.join(', ')} px, everything fits`, async () => {
      const html = await barMarkup(desktopApp);
      // The desktop title bar classes come from the app's own titleBar.ts; a browser run has none.
      const header = desktopApp && !html.includes('ms-tb-mac') ? html.replace('class="ms-topbar"', 'class="ms-topbar ms-titlebar ms-tb-mac"') : html;
      const failures: string[] = [];
      for (const width of WIDTHS) {
        const page = `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>${FONTS()}\n${ALL_CSS()}
          body{margin:0;background:var(--bg)}</style></head><body>${header}</body></html>`;
        const file = join(dir, `${desktopApp ? 'desktop' : 'web'}-${width}.html`);
        writeFileSync(file, page);
        const tab = await browser.newPage(width, 400);
        try {
          await tab.goto(`file://${file}`);
          const r = await tab.eval<{ problems: string[]; widths: string[]; nameWidth: number; slack: number; iconOnly: number[]; unnamed: string[] }>(MEASURE, 30_000);
          console.info(`[topbar] ${desktopApp ? 'desktop' : 'web'} @${width}: ${JSON.stringify(r)}`);
          const where = `${desktopApp ? 'desktop' : 'web'} @${width}`;
          for (const p of r.problems) failures.push(`${where}: ${p}`);
          for (const u of r.unnamed) failures.push(`${where}: a button without a name: ${u}`);
          if (r.nameWidth < 60) failures.push(`${where}: the format name has ${r.nameWidth} px`);
          // With a bar content of 1760 px or less the render actions are their icons (28 px).
          if (width - 28 <= 1760 && r.iconOnly.some((w) => w > 28.5)) failures.push(`${where}: render actions not folded ${JSON.stringify(r.iconOnly)}`);
        } finally { await tab.close(); }
      }
      expect(failures).toEqual([]);
    });
  }
});

/**
 * The format page's top bar (UX feedback batch 1, final wave I2; decision 974; user reports 17, 19 and 23). The format page is
 * the editor since decision 916: the real EditorScreen is rendered in jsdom, in Italian, with long names and everything the bar
 * can carry at once: the app's mark and the breadcrumb (project, creative by its title, the format), the format's facts, the
 * "Il brief dice 6 s" warning, the version badge, Lingue, Esporta and "…", a separator and the app's controls. There is no
 * Render button and no render status (decision 974): a render or an export in progress shows inside Esporta ("Esportazione
 * 26%"), at the control's one size. The bar's markup, given the app's stylesheets and its fonts, is measured in real Chrome at
 * 1024 to 1920 px, light and dark, in the browser and in the macOS desktop title bar, idle and while an export runs: nothing
 * leaves the bar, nothing overlaps, nothing wraps, no control's text is clipped (the crumbs end with an ellipsis and keep their
 * whole text in the tooltip), every button is 32 px tall, the format's name keeps room, and Esporta is a normal button at rest and
 * widens only while an export runs (report 50). Chrome only on request (MS_LAYOUT_CHROME=1 or MS_REQUIRE_CHROME=1), through the repo's driver
 * (mock keychain, basic password store); MS_LAYOUT_SHOTS=<folder> saves a screenshot of each case.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_FORMATS, type CreativeDetail, type OutputFileInfo, type VersionEntry } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
// The repo's proven Chrome driver (CDP over a pipe; it passes --use-mock-keychain and --password-store=basic, as BASE_FLAGS does).
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';
import { ALL_CSS, FONTS, src } from './support/layoutAssets.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const at = '2026-10-08T10:00:00.000Z';
const VIDEO = 'tiktok-9x16';
const H = 'b'.repeat(64);
const out = (format: string, file: string, durationSec: number | null = null): OutputFileInfo => ({ format, file, width: 1080, height: 1920, durationSec, verified: true, preview: null });
const LONG_TITLE = 'Create a 60-second 16:9 launch video for Motion Studio, the local motion graphics app for macOS';
const version = (n: number, rendered: boolean): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', problems: [], tools: [], renderCommand: null, basedOn: null,
  outputs: rendered ? [{ ...out(VIDEO, 'tiktok.mp4', 8), sha256: 'd'.repeat(64), fromComposition: H }] : [],
  compositions: [{ format: VIDEO, dir: `compositions/${VIDEO}`, hash: H }],
});
/** The shown version's render: the bar is the same either way (decision 974). */
let rendered = true;
const detailOf = (): CreativeDetail => ({
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions: [version(1, rendered), version(2, rendered)],
  creative: {
    schemaVersion: 1, title: LONG_TITLE, status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: 'm', formats: [VIDEO], durationSec: 6, assets: [], notes: '', locales: { primary: 'it', extra: ['en'] } },
  },
} as unknown as CreativeDetail);

const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async () => detailOf()),
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
const { EditorScreen } = await import('../src/screens/editor/EditorScreen.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');

/** `exporting`: an export of this creative runs, at 26 % (decision 974: shown inside Esporta). */
const exportJob = { id: 'e1', key: 'export:/w:acme:lancio:0a1b2c3d', kind: 'export', label: 'Export · Lancio estivo', state: 'running', createdAt: at,
  export: { stage: 'rendering', pct: 26, destination: '/d', renders: ['r1'] } };
let live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
function Harness({ route = { name: 'format', slug: 'acme', creative: 'lancio', format: VIDEO }, page = true }: { route?: Route; page?: boolean }) {
  const shell = {
    route, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme Studio Milano, campagne 2026' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} },
    openPalette: () => {},
  } as unknown as Shell;
  return (
    <ShellContext.Provider value={shell}>
      <TopBar />
      {page ? <EditorScreen slug="acme" creative="lancio" format={VIDEO} live={live} /> : null}
    </ShellContext.Provider>
  );
}

type BarState = 'idle' | 'exporting';
/** The bar's markup, in the browser or in the desktop app, idle or while an export of the creative runs. */
async function barMarkup(desktopApp: boolean, state: BarState = 'idle'): Promise<string> {
  rendered = true;
  live = { approvals: {}, jobs: state === 'exporting' ? { e1: exportJob } : {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
  location.hash = `#/p/acme/c/lancio/f/${VIDEO}`;
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  if (desktopApp) (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => null, revealPath: async () => {} };
  try {
    render(<Harness />);
    const bar = () => document.querySelector('.ms-topbar') as HTMLElement;
    await waitFor(() => expect(bar().querySelector('.ms-bar-more')).not.toBeNull());
    await waitFor(() => expect(bar().querySelector('.ms-crumb-creative .ms-crumb-text')?.textContent).toBe(LONG_TITLE));
    expect(bar().querySelector('.ms-cv-edit')).toBeNull();
    const names = [/^Lingue/, /^Il brief dice 6 s$/, /^Altre azioni$/, state === 'exporting' ? /^Esportazione 26%$/ : /^Esporta$/];
    for (const name of names) expect(within(bar()).getAllByRole('button', { name }).length, String(name)).toBeGreaterThan(0);
    // Decision 974: nothing renders from the bar, and nothing shows a render status beside Esporta.
    expect(within(bar()).queryByRole('button', { name: /render/i })).toBeNull();
    expect(bar().querySelector('.ms-fv-render, .ms-progress')).toBeNull();
    expect(bar().classList.contains('ms-bar-fv')).toBe(true);
    return bar().outerHTML;
  } finally {
    cleanup();
    platform.mockRestore();
    delete (window as unknown as { motionStudio?: unknown }).motionStudio;
  }
}

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
  // The facts may end with an ellipsis (they are also the name's tooltip, and their own).
  for (const leaf of [el, ...el.querySelectorAll('*')]) if (vis(leaf) && leaf.children.length === 0 && leaf.textContent && leaf.scrollWidth > leaf.clientWidth + 1 && !(leaf.classList.contains('ms-fv-meta') && leaf.title)) problems.push('clipped: ' + leaf.textContent);
}
const solid = controls.filter((el) => !el.classList.contains('ms-fv-badge'));
for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
  const a = solid[i].getBoundingClientRect(), b = solid[j].getBoundingClientRect();
  if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom && a.bottom > b.top) problems.push('overlap: ' + (solid[i].textContent || solid[i].getAttribute('aria-label')) + ' / ' + (solid[j].textContent || solid[j].getAttribute('aria-label')));
}
// One size (user report 17): every button of the bar is 32 px tall (the avatar and the status chips are not buttons of the row).
for (const b of [...bar.querySelectorAll('button, a.ms-crumb-link')].filter(vis)) {
  if (b.classList.contains('ms-avatar') || b.classList.contains('ms-pill')) continue;
  const h = Math.round(b.getBoundingClientRect().height);
  if (h !== 32) problems.push('height ' + h + ': ' + (b.getAttribute('aria-label') || b.textContent));
}
// One line: every crumb sits on the bar's middle line, and a cut crumb keeps its whole text in the tooltip.
for (const c of [...bar.querySelectorAll('.ms-crumbs > *')].filter(vis)) {
  const r = c.getBoundingClientRect();
  if (r.top < br.top || r.bottom > br.bottom) problems.push('crumb off the line: ' + c.textContent);
}
for (const t of bar.querySelectorAll('.ms-crumb-text, .ms-crumb > b')) if (vis(t) && t.scrollWidth > t.clientWidth + 1 && !t.closest('[title]')) problems.push('cut without a tooltip: ' + t.textContent);
const name = bar.querySelector('.ms-fv-crumb b');
const nameWidth = name ? name.getBoundingClientRect().width : 0;
const exportWidth = bar.querySelector('.ms-cv-export') ? Math.round(bar.querySelector('.ms-cv-export').getBoundingClientRect().width * 10) / 10 : 0;
const unnamed = [...bar.querySelectorAll('button')].filter(vis).filter((b) => !(b.getAttribute('aria-label') || [...b.querySelectorAll('*')].concat([b]).some((n) => vis(n) && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())))).map((b) => b.className);
const widths = [...bar.children].flatMap((c) => c.classList.contains('ms-bar-slot') ? [...c.children] : [c]).filter(vis).map((el) => (el.getAttribute('aria-label') || el.textContent || el.className).slice(0, 18) + '=' + Math.round(el.getBoundingClientRect().width));
// The current item gives way last (user report 23): a short format name is never cut, the ancestors are.
if (name && name.scrollWidth > name.clientWidth + 1) problems.push('the format name is cut: ' + name.textContent);
return { problems, widths, nameWidth: Math.round(nameWidth), slack: bar.clientWidth - bar.scrollWidth, exportWidth, unnamed };
})()`;

const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

describe('format view bar: CSS rules (scoped to the format view, Ruling AG)', () => {
  const fmt = src('screens/format.css').replace(/\/\*[\s\S]*?\*\//g, '');
  /** Every selector of every rule inside the bar's container queries. */
  const foldSelectors = () => [...fmt.matchAll(/@container ms-topbar[^{]*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)]
    .flatMap((m) => [...m[1]!.matchAll(/([^{}]+)\{[^}]*\}/g)].flatMap((r) => r[1]!.split(',').map((x) => x.trim())));
  it('only the format view\'s bar is a size container: no other bar declares one', () => {
    expect(src('shell/shell.css')).not.toMatch(/container/);
    expect(fmt).toMatch(/\.ms-topbar\.ms-bar-fv\s*\{\s*container:\s*ms-topbar\s*\/\s*inline-size/);
    expect([...fmt.matchAll(/container:\s*ms-topbar/g)]).toHaveLength(1);
  });
  it('every fold rule is under .ms-bar-fv; the versions count, the facts and the secondary labels fold', () => {
    const sels = foldSelectors();
    expect(sels.length).toBeGreaterThan(4);
    for (const sel of sels) expect(sel, sel).toMatch(/^\.ms-bar-fv /);
    expect(sels).toContain('.ms-bar-fv .ms-fold-2 > .ms-bar-label');
    expect(sels).toContain('.ms-bar-fv .ms-fvb-bar > .ms-bar-label');
    expect(sels).toContain('.ms-bar-fv .ms-fv-meta');
    for (const m of fmt.matchAll(/^([^@/\n][^{\n]*ms-fold[^{\n]*)\{/gm)) expect(m[1]!.trim(), m[1]).toMatch(/^\.ms-bar-fv /);
    expect(fmt).not.toMatch(/@media[^{]*(max|min)-width[^{]*\{[^}]*ms-fold/);
  });
});

describe('format view bar: what it carries, and which bars fold', () => {
  it('idle, in Italian: the version badge, Lingue, Esporta, "…"; no Versions, no Duplica in the row, no render control (decisions 972, 974)', async () => {
    const html = await barMarkup(false);
    expect(html).not.toContain('ms-fv-render');
    expect(html).toContain('ms-cv-languages');
    expect(html).toContain('ms-fvb-bar');
    expect(html).not.toContain('ms-cv-vbtn');
    expect(html).not.toContain('ms-fv-duplicate');
  });
  it('while an export runs: "Esportazione 26%" inside Esporta, the same control', async () => {
    const html = await barMarkup(true, 'exporting');
    expect(html).toMatch(/class="ms-btn ms-ink ms-cv-export ms-exp-ctl ms-working"/);
    expect(html).toContain('style="width: 26%;"');
  });
  it('the creative board\'s bar is not the format page\'s: no .ms-bar-fv, so no fold rule reaches it', () => {
    for (const route of [{ name: 'creative', slug: 'acme', creative: 'lancio' }] as Route[]) {
      render(<Harness route={route} page={false} />);
      const bar = document.querySelector('header.ms-topbar') as HTMLElement;
      expect(bar.className, route.name).not.toContain('ms-bar-fv');
      cleanup();
    }
  });
});

run('format view bar: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-topbar-')); browser = await launchChrome(chrome!); });
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); });

  // 1024 is the desktop window's minimum width (apps/desktop/src/window.ts), 1440 its default; 1229 and 1429 put the browser
  // bar's content (28 px of padding) just above a folding step (1200, 1400), 1309 and 1509 the desktop one's (108 px).
  const WIDTHS = [1024, 1229, 1280, 1309, 1429, 1440, 1509, 1920];
  /** Report 50: Esporta at rest, its icon and its word in a 32 px button (it was ~150 px when it kept room for the progress). */
  const IDLE_EXPORT_MAX = 112;
  const shots = process.env.MS_LAYOUT_SHOTS;
  type Measure = { problems: string[]; widths: string[]; nameWidth: number; slack: number; exportWidth: number; unnamed: string[] };
  for (const desktopApp of [false, true]) {
    it(`${desktopApp ? 'desktop (macOS title bar)' : 'browser'}: Italian, ${WIDTHS.join(', ')} px, idle and exporting: everything fits, Esporta widens only while it exports`, async () => {
      const failures: string[] = [];
      const exportWidths: Record<string, number> = {};
      for (const state of ['idle', 'exporting'] as const) {
        const html = await barMarkup(desktopApp, state);
        // The desktop title bar classes come from the app's own titleBar.ts; a browser run has none.
        const header = desktopApp && !html.includes('ms-tb-mac') ? html.replace('class="ms-topbar"', 'class="ms-topbar ms-titlebar ms-tb-mac"') : html;
        for (const width of WIDTHS) for (const theme of ['light', 'dark'] as const) {
          const page = `<!doctype html><html lang="it" data-theme="${theme}"><head><meta charset="utf-8"><style>${FONTS()}\n${ALL_CSS()}
            body{margin:0;background:var(--bg)}</style></head><body>${header}</body></html>`;
          const file = join(dir, `${state}-${desktopApp ? 'desktop' : 'web'}-${width}-${theme}.html`);
          writeFileSync(file, page);
          const tab = await browser.newPage(width, 120);
          try {
            await tab.goto(`file://${file}`);
            const r = await tab.eval<Measure>(MEASURE, 30_000);
            if (shots) writeFileSync(join(shots, `format-bar-${state}-${desktopApp ? 'desktop' : 'web'}-${width}-${theme}.png`), await tab.screenshot());
            if (theme === 'dark') continue;
            console.info(`[topbar] ${state} ${desktopApp ? 'desktop' : 'web'} @${width}: ${JSON.stringify(r)}`);
            const where = `${state} ${desktopApp ? 'desktop' : 'web'} @${width}`;
            for (const p of r.problems) failures.push(`${where}: ${p}`);
            for (const u of r.unnamed) failures.push(`${where}: a button without a name: ${u}`);
            if (r.nameWidth < 60) failures.push(`${where}: the format name has ${r.nameWidth} px`);
            // Report 50: at rest a normal button (its icon and "Esporta"); while it exports it widens to show the progress.
            if (state === 'idle') {
              exportWidths[width] = r.exportWidth;
              if (r.exportWidth > IDLE_EXPORT_MAX) failures.push(`${where}: Esporta is ${r.exportWidth} px at rest (at most ${IDLE_EXPORT_MAX})`);
            } else if (r.exportWidth <= exportWidths[width]! + 10) failures.push(`${where}: Esporta is ${r.exportWidth} px exporting, ${exportWidths[width]} px idle`);
          } finally { await tab.close(); }
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

/**
 * The format view's top bar with a ready render (UX feedback batch 1, final wave I2). The real FormatView is rendered in
 * jsdom, in Italian, with everything the bar can carry at once: the version badge and Versions, the render status with a
 * ready video (pill with the size, Scarica / Mostra nel Finder, Rifai il render), Lingue, Duplica, Modifica and Esporta. The
 * bar's markup, given the app's stylesheets and its fonts, is measured in real Chrome at 1024 and 1280 px, in the browser
 * and in the macOS desktop title bar (80 px for the traffic lights): nothing leaves the bar, nothing overlaps, no control's
 * text is clipped and the format's name keeps room. Chrome only on request (MS_LAYOUT_CHROME=1 or MS_REQUIRE_CHROME=1),
 * through the repo's driver (mock keychain, basic password store).
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
const version = (n: number, rendered: boolean): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', problems: [], tools: [], renderCommand: null, basedOn: null,
  outputs: rendered ? [{ ...out(VIDEO, 'tiktok.mp4', 8), sha256: 'd'.repeat(64), fromComposition: H }] : [],
  compositions: [{ format: VIDEO, dir: `compositions/${VIDEO}`, hash: H }],
});
/** `ready`: the shown version has a current render; `live`: none yet (the live preview, "Render video"). */
let rendered = true;
const detailOf = (): CreativeDetail => ({
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions: [version(1, rendered), version(2, rendered)],
  creative: {
    schemaVersion: 1, title: 'Lancio estivo', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: 'm', formats: [VIDEO], durationSec: 8, assets: [], notes: '', locales: { primary: 'it', extra: ['en'] } },
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
const { FormatView } = await import('../src/screens/FormatView.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');

const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as unknown as EventsState;
function Harness({ route = { name: 'format', slug: 'acme', creative: 'lancio', format: VIDEO }, page = true }: { route?: Route; page?: boolean }) {
  const shell = {
    route, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} },
    openPalette: () => {},
  } as unknown as Shell;
  return (
    <ShellContext.Provider value={shell}>
      <TopBar />
      {page ? <FormatView slug="acme" creative="lancio" format={VIDEO} live={live} /> : null}
    </ShellContext.Provider>
  );
}

/**
 * The bar's markup, in the browser (Scarica) or in the desktop app (Mostra nel Finder): with a ready render (Rifai il render)
 * or on the live preview (Render video).
 */
async function barMarkup(desktopApp: boolean, state: 'ready' | 'live' = 'ready'): Promise<string> {
  rendered = state === 'ready';
  location.hash = `#/p/acme/c/lancio/f/${VIDEO}`;
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  if (desktopApp) (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => null, revealPath: async () => {} };
  try {
    render(<Harness />);
    const bar = () => document.querySelector('.ms-topbar') as HTMLElement;
    await waitFor(() => expect(within(bar()).getAllByText(state === 'ready' ? 'Video pronto · 12,4 MB' : 'Anteprima dal vivo').length).toBeGreaterThan(0));
    await waitFor(() => expect(bar().querySelector('.ms-cv-edit')).not.toBeNull());
    const names = [/Fai il render del video di/, /^Lingue/, /^Duplica/, /^Modifica/, /^Esporta/, ...(state === 'ready' ? [desktopApp ? /Mostra nel Finder/ : /Scarica il video di/] : [])];
    for (const name of names) expect(within(bar()).getAllByRole('button', { name }).length, String(name)).toBeGreaterThan(0);
    expect(screen.getAllByText(state === 'ready' ? 'Rifai il render' : 'Render video').length).toBeGreaterThan(0);
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
  for (const leaf of [el, ...el.querySelectorAll('*')]) if (vis(leaf) && leaf.children.length === 0 && leaf.textContent && leaf.scrollWidth > leaf.clientWidth + 1) problems.push('clipped: ' + leaf.textContent);
}
const solid = controls.filter((el) => !el.classList.contains('ms-fv-badge'));
for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
  const a = solid[i].getBoundingClientRect(), b = solid[j].getBoundingClientRect();
  if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom && a.bottom > b.top) problems.push('overlap: ' + (solid[i].textContent || solid[i].getAttribute('aria-label')) + ' / ' + (solid[j].textContent || solid[j].getAttribute('aria-label')));
}
const name = bar.querySelector('.ms-fv-crumb b');
const nameWidth = name ? name.getBoundingClientRect().width : 0;
const iconOnly = [...bar.querySelectorAll('.ms-fv-render button.ms-fold-1')].filter(vis).map((b) => b.getBoundingClientRect().width);
const renderLabel = [...bar.querySelectorAll('.ms-fv-render button.ms-fold-3 > .ms-bar-label')].some(vis);
const unnamed = [...bar.querySelectorAll('button')].filter(vis).filter((b) => !(b.getAttribute('aria-label') || [...b.querySelectorAll('*')].concat([b]).some((n) => vis(n) && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())))).map((b) => b.className);
const widths = [...bar.children].flatMap((c) => c.classList.contains('ms-bar-slot') ? [...c.children] : [c]).filter(vis).map((el) => (el.getAttribute('aria-label') || el.textContent || el.className).slice(0, 18) + '=' + Math.round(el.getBoundingClientRect().width));
return { problems, widths, nameWidth: Math.round(nameWidth), slack: bar.clientWidth - bar.scrollWidth, iconOnly, renderLabel, unnamed };
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
  it('every fold rule is under .ms-bar-fv, the crumb rule included; the render actions go icon-only', () => {
    const sels = foldSelectors();
    expect(sels.length).toBeGreaterThan(8);
    for (const sel of sels) expect(sel, sel).toMatch(/^\.ms-bar-fv /);
    expect(sels).toContain('.ms-bar-fv .ms-fold-1 > .ms-bar-label');
    expect(sels).toContain('.ms-bar-fv .ms-crumbs > .ms-crumb:not(.ms-last)');
    for (const m of fmt.matchAll(/^([^@/\n][^{\n]*ms-fold[^{\n]*)\{/gm)) expect(m[1]!.trim(), m[1]).toMatch(/^\.ms-bar-fv /);
    expect(fmt).not.toMatch(/@media[^{]*(max|min)-width[^{]*\{[^}]*ms-fold/);
  });
});

describe('format view bar: what it carries, and which bars fold', () => {
  it('ready, in Italian: the version badge, Versions, the ready pill, Scarica, Rifai il render, Lingue, Duplica, Modifica, Esporta', async () => {
    const html = await barMarkup(false);
    expect(html).toContain('ms-fv-render');
    expect(html).toContain('ms-cv-languages');
    expect(html).toContain('ms-fv-duplicate');
  });
  it('"Render video" (live preview, failed) folds only at the last step; Scarica, Mostra nel Finder and Rifai il render at the first', async () => {
    const live = await barMarkup(false, 'live');
    expect(live).toMatch(/<button aria-label="Fai il render del video di[^>]*class="[^"]*ms-fold-3"/);
    expect(live).not.toContain('ms-fold-1');
    const ready = await barMarkup(true);
    expect([...ready.matchAll(/class="ms-btn [^"]*ms-fold-1"/g)]).toHaveLength(2);
  });
  it('the creative board\'s and the editor\'s bars are not the format view\'s: no .ms-bar-fv, so no fold rule reaches them', () => {
    for (const route of [{ name: 'creative', slug: 'acme', creative: 'lancio' }, { name: 'edit', slug: 'acme', creative: 'lancio', format: VIDEO }] as Route[]) {
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

  // 1024 is the desktop window's minimum width (apps/desktop/src/window.ts), 1440 its default; 1129, 1529 and 1789 put the
  // browser bar's content (28 px of padding) just above a folding step (1100, 1500, 1760), where it is at its fullest.
  // The live preview (Render video) at the widths of the round 2 review.
  const CASES = [{ state: 'ready', widths: [1024, 1129, 1280, 1440, 1529, 1789, 1920] }, { state: 'live', widths: [1024, 1280, 1440] }] as const;
  for (const { state, widths: WIDTHS } of CASES) for (const desktopApp of [false, true]) {
    it(`${state}, ${desktopApp ? 'desktop (macOS title bar)' : 'browser'}: Italian, ${WIDTHS.join(', ')} px, everything fits`, async () => {
      const html = await barMarkup(desktopApp, state);
      // The desktop title bar classes come from the app's own titleBar.ts; a browser run has none.
      const header = desktopApp && !html.includes('ms-tb-mac') ? html.replace('class="ms-topbar"', 'class="ms-topbar ms-titlebar ms-tb-mac"') : html;
      const failures: string[] = [];
      for (const width of WIDTHS) {
        const page = `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>${FONTS()}\n${ALL_CSS()}
          body{margin:0;background:var(--bg)}</style></head><body>${header}</body></html>`;
        const file = join(dir, `${state}-${desktopApp ? 'desktop' : 'web'}-${width}.html`);
        writeFileSync(file, page);
        const tab = await browser.newPage(width, 400);
        try {
          await tab.goto(`file://${file}`);
          const r = await tab.eval<{ problems: string[]; widths: string[]; nameWidth: number; slack: number; iconOnly: number[]; renderLabel: boolean; unnamed: string[] }>(MEASURE, 30_000);
          console.info(`[topbar] ${state} ${desktopApp ? 'desktop' : 'web'} @${width}: ${JSON.stringify(r)}`);
          const where = `${state} ${desktopApp ? 'desktop' : 'web'} @${width}`;
          for (const p of r.problems) failures.push(`${where}: ${p}`);
          for (const u of r.unnamed) failures.push(`${where}: a button without a name: ${u}`);
          if (r.nameWidth < 60) failures.push(`${where}: the format name has ${r.nameWidth} px`);
          // With a bar content of 1760 px or less the render actions are their icons (28 px).
          if (width - 28 <= 1760 && r.iconOnly.some((w) => w > 28.5)) failures.push(`${where}: render actions not folded ${JSON.stringify(r.iconOnly)}`);
          // Live preview: "Render video" keeps its label from 1280 px up.
          if (state === 'live' && width >= 1280 && !r.renderLabel) failures.push(`${where}: "Render video" lost its label`);
        } finally { await tab.close(); }
      }
      expect(failures).toEqual([]);
    });
  }
});

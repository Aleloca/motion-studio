/**
 * The whole format view in real Chrome (follow-up batch 2, task 6). The real FormatView and its top bar are rendered in
 * jsdom (the live player replaced by a stand-in that reports itself ready), in English and Italian, in three states: the
 * live preview, a render at 42% and a ready video with its size. The markup, given the app's real stylesheets and fonts
 * in the app's own grid (bar over page), is measured in real Chrome at 1024 and 1280 px, in the desktop title bar: the
 * page does not scroll sideways, no element leaves its panel, no text is clipped mid-word (a deliberate ellipsis is not),
 * and no interactive control of the bar or the transport overlaps another. The Tooltip (hidden at rest) does not count.
 * Chrome only on request (MS_LAYOUT_CHROME=1 or MS_REQUIRE_CHROME=1), through the repo's driver (mock keychain, basic
 * password store).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type CreativeDetail, type JobSummary, type OutputFileInfo, type VersionEntry } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Route } from '../src/routes.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { I18nProvider } from '../src/i18n.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';
import { ALL_CSS, FONTS } from './support/layoutAssets.ts';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const at = '2026-10-08T10:00:00.000Z';
const VIDEO = 'tiktok-9x16';
const H = 'b'.repeat(64);
const out = (format: string, file: string, durationSec: number | null = null): OutputFileInfo => ({ format, file, width: 1080, height: 1920, durationSec, verified: true, preview: null });
const version = (n: number, rendered: boolean): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', problems: [], tools: [], renderCommand: null, basedOn: null,
  outputs: rendered ? [{ ...out(VIDEO, 'tiktok.mp4', 8), sha256: 'd'.repeat(64), fromComposition: H }] : [],
  compositions: [{ format: VIDEO, dir: `compositions/${VIDEO}`, hash: H }],
});
let rendered = true;
const detailOf = (): CreativeDetail => ({
  slug: 'lancio', jobKey: 'creative:/w:acme:lancio', versions: [version(1, rendered), version(2, rendered)],
  creative: {
    schemaVersion: 1, title: 'Lancio estivo', status: 'error', error: 'Una nota lunga dell’ultimo turno: il modello ha interrotto la generazione prima della fine e ha lasciato la scena finale incompleta.',
    createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'g', message: 'm', formats: [VIDEO], durationSec: 8, assets: [], notes: '', locales: { primary: 'it', extra: ['en'] } },
  },
} as unknown as CreativeDetail);

const composition = {
  $schema: 'motion-studio/composition@1', width: 1080, height: 1920, fps: 30, duration: 8, background: '#000000', fonts: [],
  scenes: [
    { id: 's1', name: 'Apertura con il titolo del lancio estivo', start: 0, duration: 3 },
    { id: 's2', name: 'Scena', start: 3, duration: 2.5 },
    { id: 's3', name: 'Chiusura e invito all’azione', start: 5.5, duration: 2.5 },
  ],
  tracks: [{ id: 't1', name: 'Titoli', clips: [{ id: 'c1', name: 'Titolo principale del lancio', type: 'text', start: 0, duration: 8 }] }],
};
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
  getEditorComposition: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({ n, format, primaryFormat: format, hash: H, files: [], fonts: [], composition })),
  getStoryboard: vi.fn(async (_s: string, _c: string, _n: number, format: string) => ({ format, hash: H, width: 270, expiresAt: new Date(Date.now() + 600_000).toISOString(), frames: [] })),
};
class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
// The live player is an iframe on another origin: a stand-in reports a media that is ready (8 s, paused), so the transport,
// the comment hint and the clip and range buttons are all there.
vi.mock('../src/components/CompositionPlayer.tsx', async (orig) => {
  const { useEffect } = await import('react');
  const { CompositionMedia } = await orig<typeof import('../src/components/CompositionPlayer.tsx')>();
  const ready = () => { const m = new CompositionMedia(); (m as unknown as { dur: number }).dur = 8; return m; };
  return {
    ...(await orig<object>()),
    CompositionPlayer: ({ onMedia }: { onMedia?: (m: unknown) => void }) => {
      useEffect(() => { onMedia?.(ready()); }, [onMedia]);
      return <div className="ms-cplayer" style={{ position: 'absolute', inset: 0, background: '#222' }} />;
    },
  };
});
const { FormatView } = await import('../src/screens/FormatView.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');

const renderJob: JobSummary = {
  id: 'r1', key: 'render:/w:acme:lancio:v2', kind: 'render', label: 'render', state: 'running', createdAt: at, startedAt: at,
  progress: { format: VIDEO, phase: 'frames', done: 42, total: 100 },
};
type State = 'idle' | 'rendering' | 'ready';
const liveOf = (state: State) => ({ approvals: {}, jobs: state === 'rendering' ? { r1: renderJob, r2: { ...renderJob, id: 'r2', key: 'render:/w:acme:lancio:v1' } } : {}, events: {}, creativeTicks: {}, projectTicks: {} }) as unknown as EventsState;

function Harness({ live }: { live: EventsState }) {
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
      <main className="ms-main"><FormatView slug="acme" creative="lancio" format={VIDEO} live={live} /></main>
    </ShellContext.Provider>
  );
}

const PILL: Record<'en' | 'it', Record<State, RegExp>> = {
  en: { idle: /Live preview/, rendering: /Rendering 42%/, ready: /Video ready · 12\.4 MB/ },
  it: { idle: /Anteprima dal vivo/, rendering: /Render 42%/, ready: /Video pronto · 12,4 MB/ },
};
/** The app (bar, then page) as the shell lays it out, in the desktop title bar. */
async function appMarkup(locale: 'en' | 'it', state: State): Promise<string> {
  rendered = state === 'ready';
  location.hash = `#/p/acme/c/lancio/f/${VIDEO}`;
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => null, revealPath: async () => {} };
  try {
    const { container } = render(<I18nProvider locale={locale}><div className="ms-app" id="app"><Harness live={liveOf(state)} /></div></I18nProvider>);
    const bar = () => container.querySelector('.ms-topbar') as HTMLElement;
    await waitFor(() => expect(within(bar()).getAllByText(PILL[locale][state]).length).toBeGreaterThan(0));
    await waitFor(() => expect(container.querySelector('.ms-fv-rangebtn')).not.toBeNull());
    await waitFor(() => expect(container.querySelector('.ms-fv-clippick')).not.toBeNull());
    await waitFor(() => expect(container.querySelector('.ms-fv-hint')).not.toBeNull());
    await waitFor(() => expect(container.querySelectorAll('.ms-fv-sb-item').length).toBe(3));
    // The safe zone overlay on, so its bands are measured too.
    const toggle = container.querySelector('.ms-fv-safe-toggle [role="switch"], .ms-fv-safe-toggle button, .ms-fv-safe-toggle input') as HTMLElement | null;
    if (toggle) await userEvent.click(toggle);
    await waitFor(() => expect(container.querySelector('.ms-safe, [class*="safe-band"], [class*="ms-sz"]')).not.toBeNull()).catch(() => {});
    const app = container.querySelector('#app') as HTMLElement;
    if (!app.querySelector('.ms-tb-mac')) bar().className = 'ms-topbar ms-bar-fv ms-titlebar ms-tb-mac';
    return app.outerHTML;
  } finally {
    cleanup();
    platform.mockRestore();
    delete (window as unknown as { motionStudio?: unknown }).motionStudio;
  }
}

const MEASURE = `(async () => {
await document.fonts.ready;
const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.ms-sr, [role="tooltip"]');
const problems = [], notes = [];
const label = (el) => (el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).trim().slice(0, 30);
if (document.documentElement.scrollWidth > innerWidth) problems.push('page overflows by ' + (document.documentElement.scrollWidth - innerWidth));
if (document.body.scrollWidth > innerWidth) problems.push('body overflows');
const panels = [['.ms-topbar', 'bar'], ['.ms-fv-scenes', 'scenes'], ['.ms-fv-main', 'stage'], ['.ms-fv-panel', 'panel']]
  .map(([sel, name]) => [document.querySelector(sel), name]).filter(([el]) => el);
for (const [name, ok] of [['bar', panels.some(([, n]) => n === 'bar')], ['scenes', panels.some(([, n]) => n === 'scenes')], ['stage', panels.some(([, n]) => n === 'stage')], ['panel', panels.some(([, n]) => n === 'panel')]]) if (!ok) problems.push('missing ' + name);
const clipsX = (el, stop) => { for (let p = el.parentElement; p && p !== stop; p = p.parentElement) { const o = getComputedStyle(p); if (o.overflowX !== 'visible') return true; } return false; };
for (const [panel, name] of panels) {
  const pr = panel.getBoundingClientRect();
  if (panel.scrollWidth > panel.clientWidth + 1) problems.push(name + ' scrolls sideways by ' + (panel.scrollWidth - panel.clientWidth));
  for (const el of panel.querySelectorAll('*')) {
    if (!vis(el) || el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if ((r.left < pr.left - 1 || r.right > pr.right + 1) && !clipsX(el, panel)) problems.push(name + ': leaves its panel: ' + label(el) + ' [' + Math.round(r.left - pr.left) + ',' + Math.round(r.right - pr.right) + ']');
    if (r.left < -1 || r.right > innerWidth + 1) { if (!clipsX(el, document.body) && !clipsX(el, panel)) problems.push(name + ': outside the window: ' + label(el)); }
    // Text: a leaf that is wider than its box. A deliberate ellipsis is not a clip.
    if (el.children.length === 0 && el.textContent && el.textContent.trim() && el.scrollWidth > el.clientWidth + 1 && !(el instanceof SVGElement)) {
      (cs.textOverflow === 'ellipsis' ? notes : problems).push((cs.textOverflow === 'ellipsis' ? 'ellipsis: ' : name + ': clipped: ') + label(el) + ' (' + el.scrollWidth + '>' + el.clientWidth + ')');
    }
  }
}
// Interactive controls of the bar and the transport must not overlap each other.
const zone = (root) => root ? [...root.querySelectorAll('button, [role="slider"], [role="switch"], input, select, a[href], .ms-pill')].filter(vis).filter((el) => !el.parentElement.closest('button, .ms-pill')) : [];
const groups = [['bar', zone(document.querySelector('.ms-topbar'))], ['transport', zone(document.querySelector('.ms-fv-transport'))]];
for (const [name, list] of groups) {
  if (list.length < 3) problems.push(name + ': only ' + list.length + ' controls found');
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i].getBoundingClientRect(), b = list[j].getBoundingClientRect();
    if (list[i].contains(list[j]) || list[j].contains(list[i])) continue;
    if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5) problems.push(name + ': overlap: ' + label(list[i]) + ' / ' + label(list[j]));
  }
}
const tip = [...document.querySelectorAll('[role="tooltip"]')].filter((t) => t.getClientRects().length > 0 && getComputedStyle(t).visibility !== 'hidden');
if (tip.length) problems.push('a tooltip is visible at rest');
const seen = { bar: groups[0][1].length, transport: groups[1][1].length, scenes: document.querySelectorAll('.ms-fv-sb-item').length, hint: !!document.querySelector('.ms-fv-hint'), clip: !!document.querySelector('.ms-fv-clippick'), range: !!document.querySelector('.ms-fv-rangebtn'), safe: document.querySelectorAll('.ms-fv-frame [class*="safe"]').length };
return { problems, notes, seen };
})()`;

const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('format view: whole page in real Chrome', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-fv-')); browser = await launchChrome(chrome!); });
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); });

  for (const locale of ['en', 'it'] as const) for (const state of ['idle', 'rendering', 'ready'] as const) {
    it(`${locale}, ${state}: 1024 and 1280 px, nothing overflows, is clipped or overlaps`, async () => {
      const html = await appMarkup(locale, state);
      const failures: string[] = [];
      for (const width of [1024, 1280]) {
        const page = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><style>${FONTS()}\n${ALL_CSS()}
          html,body{margin:0;height:100%;background:var(--bg)}</style></head><body>${html}</body></html>`;
        const file = join(dir, `${locale}-${state}-${width}.html`);
        writeFileSync(file, page);
        const tab = await browser.newPage(width, 800);
        try {
          await tab.goto(`file://${file}`);
          const r = await tab.eval<{ problems: string[]; notes: string[]; seen: Record<string, unknown> }>(MEASURE, 30_000);
          console.info(`[fv-layout] ${locale} ${state} @${width}: ${JSON.stringify(r)}`);
          for (const p of r.problems) failures.push(`${locale} ${state} @${width}: ${p}`);
        } finally { await tab.close(); }
      }
      expect(failures).toEqual([]);
    });
  }
});

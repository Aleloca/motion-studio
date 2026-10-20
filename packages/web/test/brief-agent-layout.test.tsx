/**
 * Decisions 1412–1414 (prototype artboard A): the brief screen measured in real Chrome, light and dark. "Con l'agente": the
 * glass panel inset 12 px (448 wide, radius 20), the form's area from 472 with its card inset 12 (radius 16, brief column 380), the footer
 * card aligned with the panel's bottom, the composer box's padding and gap, the context row 10 px under the composer, no
 * horizontal scroll, every "Agente" mark inside its label row. "Compila tu": the panel out (opacity 0, -32 px, .98), the form
 * card at 12 px with a 480 px brief column. The transitions' delays (the space first, then the panel; the reverse on the way
 * back), instant under reduced motion. At 1024 × 700 the panel is 360 wide and the board keeps 280 px. The markup is rendered in
 * jsdom with the real stylesheets; without Chrome the tests are skipped (MS_REQUIRE_CHROME=1 makes a missing browser a failure).
 * MS_LAYOUT_SHOTS=<folder> also saves a screenshot of each case there.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, EMPTY_BRAND_KIT, type AssetEntry, type BriefSessionView, type ConversationEntry } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initialEventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';

const at = '2026-10-20T10:00:00.000Z';
const asset = (file: string): AssetEntry => ({ file, kind: 'image', origin: 'upload', sourceUrl: null, description: '', tags: [], width: 100, height: 100, addedAt: at, attribution: null });
const GOAL = 'Un video di lancio per Audin Desk: in 30 secondi mostra che email, WhatsApp e chiamate dei clienti arrivano in un’unica casella. Apri sulla casella piena, passa alla scheda cliente, chiudi sul messaggio chiave e sul logo.';
const filled: BriefSessionView = {
  id: 's1', createdAt: at, updatedAt: at, revision: 6, queued: [], jobId: null, userEdited: [],
  context: { codebases: [{ path: '/Users/me/git/audin-desk' }, { path: '/Users/me/git/audin-web' }], assets: ['assets/casella.png', 'assets/scheda-cliente.png', 'assets/logo-audin.svg'] },
  form: {
    goal: GOAL, message: 'Tutti i clienti, una casella.', notes: 'Tono diretto, niente gergo tecnico. Schermate reali di casella e scheda cliente.', durationSec: 30, variants: 1,
    assets: ['assets/casella.png', 'assets/scheda-cliente.png', 'assets/logo-audin.svg'],
    linkedCodebases: [{ path: '/Users/me/git/audin-desk', note: 'Testi e flussi dell’app desktop' }, { path: '/Users/me/git/audin-web', note: 'Claim e prezzi del sito' }],
    formats: ['instagram-post-1x1', 'instagram-reel-9x16', 'tiktok-9x16', 'youtube-16x9'].filter((id) => DEFAULT_FORMATS.some((p) => p.id === id)),
  },
  agentFields: ['goal', 'message', 'durationSec', 'assets', 'linkedCodebases', 'notes', 'formats'],
};
const entries: ConversationEntry[] = [
  { type: 'user', at, text: 'Video di lancio per Audin Desk: la casella unica per tutti i clienti. Per LinkedIn e Instagram, tono diretto.', pins: [], attachments: [],
    context: { codebases: ['/Users/me/git/audin-desk', '/Users/me/git/audin-web'], assets: ['assets/casella.png', 'assets/scheda-cliente.png', 'assets/logo-audin.svg'] }, jobId: 'b1' } as ConversationEntry,
  { type: 'agent', at, jobId: 'b1', event: { kind: 'text', text: 'Ho capito il prodotto. Una sola domanda prima di scrivere: quanto devono durare i video?' } },
  { type: 'system', at, level: 'info', origin: 'agent', text: 'Compilato il brief: testi, durata, 3 asset, 2 codebase, 4 formati' },
  ...Array.from({ length: 6 }, (_, i): ConversationEntry => ({ type: 'agent', at, jobId: 'b1', event: { kind: 'text', text: `Leggo ${['il README', 'i testi delle schermate', 'i prezzi', 'le email di benvenuto', 'il logo', 'la scheda cliente'][i]} per capire il tono e cosa mostrare nel video.` } })),
  { type: 'agent', at, jobId: 'b1', event: { kind: 'result', ok: true, text: 'Il brief è pronto qui a fianco: i campi con "Agente" li ho scritti io. Correggi quello che vuoi o chiedimi una modifica; quando ti convince, premi Genera.' } },
];
let session: BriefSessionView | null = filled;
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  listAssets: vi.fn(async () => ({ assets: [asset('casella.png'), asset('scheda-cliente.png'), asset('logo-audin.svg')], error: null, unregistered: [] })),
  getBrand: vi.fn(async () => ({ kit: EMPTY_BRAND_KIT, kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k' })),
  projectFileUrl: () => 'data:,',
  getFirstGenerations: vi.fn(async () => ({ tokens: [] })),
  getSecrets: vi.fn(async () => []),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: at })),
  getBriefSession: vi.fn(async () => session),
  getBriefConversation: vi.fn(async () => (session ? entries : [])),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { NewCreative } = await import('../src/screens/NewCreative.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');

const src = (p: string) => readFileSync(join(import.meta.dirname, '../src', p), 'utf8');
const CSS = ['theme.css', 'ui/ui.css', 'components/conversation.css', 'components/codebase.css', 'components/services.css', 'screens/newcreative.css',
  'screens/new-creative/storepack.css', 'screens/new-creative/briefsession.css', 'shell/shell.css'].map(src).join('\n');
const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const shots = process.env.MS_LAYOUT_SHOTS ?? null;

/** The page's markup: "Con l'agente" after Riprendi on a filled session, or "Compila tu" with no session. */
/** The bar and the page, rendered together (the page puts "Compila tu / Con l'agente" in the bar's end slot). */
async function markup(agent: boolean): Promise<{ bar: string; page: string }> {
  session = agent ? filled : null;
  const shell = {
    route: { name: 'new-creative', slug: 'acme' }, live: initialEventsState,
    catalog: { projects: [{ slug: 'acme', name: 'Audin' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as never;
  const { container, unmount } = render(
    <I18nProvider locale="it"><ShellContext.Provider value={shell}>
      <div id="bar"><TopBar /></div><div id="page"><NewCreative slug="acme" live={initialEventsState} /></div>
    </ShellContext.Provider></I18nProvider>,
  );
  await waitFor(() => expect(container.querySelector('header.ms-topbar .ms-nc-mode')).toBeTruthy());
  await waitFor(() => screen.getByRole('group', { name: 'Instagram' }));
  if (agent) {
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Riprendi la sessione del brief' }));
    await waitFor(() => expect(container.querySelector('.ms-nc.ms-nc-agent')).toBeTruthy());
    await waitFor(() => expect(container.querySelectorAll('.ms-nc-agentmark').length).toBeGreaterThan(3));
    await waitFor(() => expect(container.querySelector('.ms-brief-ctx')?.textContent).toContain('2 cartelle'));
  }
  const html = { bar: container.querySelector('#bar')!.innerHTML, page: container.querySelector('#page')!.innerHTML };
  unmount();
  return html;
}

const MEASURE = `(() => {
const q = (s) => document.querySelector(s);
const rect = (s) => { const r = q(s).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
const cs = (s) => getComputedStyle(q(s));
const main = rect('#main');
// "Compila tu / Con l'agente" sits in the real top bar, with the page's mode chosen.
const mode = document.querySelector('header.ms-topbar .ms-nc-mode');
const modeShown = !!mode && mode.getBoundingClientRect().width > 0 && mode.getBoundingClientRect().right <= innerWidth;
const modeOn = mode ? [...mode.querySelectorAll('[role=radio]')].find((r) => r.getAttribute('aria-checked') === 'true')?.textContent : null;
// The chat's messages never run under the composer and the context row, scrolled to the end or in the middle.
const list = q('.ms-nc-panel .ms-convo-list');
const dock = q('.ms-nc-panel .ms-convo-dock').getBoundingClientRect();
const under = [];
const scrollable = list.scrollHeight > list.clientHeight + 4;
for (const at of ['end', 'middle']) {
  list.scrollTop = at === 'end' ? list.scrollHeight : (list.scrollHeight - list.clientHeight) / 2;
  const lr = list.getBoundingClientRect();
  for (const li of list.children) {
    const r = li.getBoundingClientRect();
    const top = Math.max(r.top, lr.top), bottom = Math.min(r.bottom, lr.bottom);
    if (bottom - top <= 0.5) continue;
    if (bottom > dock.top + 0.5 && top < dock.bottom - 0.5) under.push(at + ': ' + (li.textContent || '').slice(0, 30));
  }
}
// The board's heading keeps its "Agente" mark on its line.
const title = document.querySelector('.ms-nc-boardtitle h2');
const titleMark = document.querySelector('.ms-nc-boardtitle .ms-nc-agentmark');
const markOnTitle = !titleMark || (() => { const h = title.getBoundingClientRect(), m = titleMark.getBoundingClientRect(); const c = (m.top + m.bottom) / 2; return c >= h.top && c <= h.bottom; })();
const panel = rect('.ms-nc-panel');
const body = rect('.ms-nc-body');
const area = rect('.ms-nc-form');
const foot = rect('.ms-nc-foot');
const form = q('.ms-nc-panel form.ms-composer').getBoundingClientRect();
const ctxBtn = q('.ms-brief-ctx > button').getBoundingClientRect();
const box = cs('.ms-nc-panel .ms-composer-box');
const marks = [...document.querySelectorAll('.ms-nc-agentmark')].map((m) => {
  const row = m.closest('.ms-nc-qrow, .ms-nc-row, .ms-nc-boardhead').getBoundingClientRect();
  const r = m.getBoundingClientRect();
  return r.left >= row.left - 0.5 && r.right <= row.right + 0.5 && r.top >= row.top - 0.5 && r.bottom <= row.bottom + 0.5;
});
const clipped = [...document.querySelectorAll('.ms-nc-len button, .ms-nc-boardhead .ms-seg button')].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent);
const buttons = [...q('.ms-nc-foot').querySelectorAll('button')].map((b) => { const r = b.getBoundingClientRect(); return r.left >= foot.left && r.right <= foot.right + 0.5 && r.right <= innerWidth; });
const delays = (s) => { const c = cs(s); const names = c.transitionProperty.split(',').map((x) => x.trim()); const d = c.transitionDelay.split(',').map((x) => x.trim()); return Object.fromEntries(names.map((n, i) => [n, d[i % d.length]])); };
const durations = [...document.querySelectorAll('*')].flatMap((el) => getComputedStyle(el).transitionDuration.split(',').map((x) => parseFloat(x) * 1000));
return {
  main, panel, body, area, foot, scroll: document.documentElement.scrollWidth, inner: innerWidth,
  panelRadius: cs('.ms-nc-panel').borderTopLeftRadius, bodyRadius: cs('.ms-nc-body').borderTopLeftRadius, footRadius: cs('.ms-nc-foot').borderTopLeftRadius,
  left: q('.ms-nc-left').getBoundingClientRect().width, board: q('.ms-nc-right').getBoundingClientRect().width,
  padding: box.padding, gap: box.rowGap, ctxGap: ctxBtn.top - form.bottom,
  opacity: cs('.ms-nc-panel').opacity, transform: cs('.ms-nc-panel').transform,
  panelDelays: delays('.ms-nc-panel'), formDelays: delays('.ms-nc-form'), bodyDelays: delays('.ms-nc-body'),
  marks, buttons, clipped, modeShown, modeOn, under, scrollable, markOnTitle, maxDuration: Math.max(...durations),
};
})()`;

type Measure = {
  main: DOMRect; panel: DOMRect; body: DOMRect; area: DOMRect; foot: DOMRect; scroll: number; inner: number; panelRadius: string; bodyRadius: string; footRadius: string;
  left: number; board: number; padding: string; gap: string; ctxGap: number; opacity: string; transform: string;
  panelDelays: Record<string, string>; formDelays: Record<string, string>; bodyDelays: Record<string, string>; marks: boolean[]; buttons: boolean[]; clipped: string[]; modeShown: boolean; modeOn: string | null; under: string[]; scrollable: boolean; markOnTitle: boolean; maxDuration: number;
};

const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('the brief with the agent: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  let agentHtml = { bar: '', page: '' };
  let youHtml = { bar: '', page: '' };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ms-brief-layout-'));
    browser = await launchChrome(chrome!);
    agentHtml = await markup(true);
    youHtml = await markup(false);
  }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  async function measure(html: { bar: string; page: string }, o: { name: string; width: number; height: number; theme: 'light' | 'dark'; reduce?: boolean }): Promise<Measure> {
    const page = `<!doctype html><html lang="it" data-theme="${o.theme}"><head><meta charset="utf-8"><style>${CSS}
      html,body{height:100%;margin:0}</style></head>
      <body><div class="ms-app">${html.bar}<div class="ms-main" id="main"><div class="ms-stage"><div class="ms-page">${html.page}</div></div></div></div>
      <script>for (const c of document.querySelectorAll('.ms-convo')) c.style.setProperty('--ms-dock-h', c.querySelector('.ms-convo-dock').offsetHeight + 'px');</script></body></html>`;
    const file = join(dir, `${o.name}-${o.theme}-${o.width}${o.reduce ? '-reduced' : ''}.html`);
    writeFileSync(file, page);
    const tab = await browser.newPage(o.width, o.height);
    try {
      if (o.reduce) await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await tab.goto(`file://${file}`);
      const r = await tab.eval<Measure>(MEASURE, 30_000);
      if (shots) writeFileSync(join(shots, `brief-${o.name}-${o.theme}-${o.width}x${o.height}${o.reduce ? '-reduced' : ''}.png`), await tab.screenshot());
      return r;
    } finally { await tab.close(); }
  }

  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: Con l'agente at 1440 × 900: panel, form card, footer, composer and context row`, async () => {
      const r = await measure(agentHtml, { name: 'agent', width: 1440, height: 900, theme });
      expect(r.panel.left).toBeCloseTo(12, 0);
      expect(r.panel.top - r.main.top).toBeCloseTo(12, 0);
      expect(r.panel.width).toBeCloseTo(448, 0);
      expect(r.panelRadius).toBe('20px');
      // The form's area starts at 472 (12 + 448 + 12) and its card is inset 12 px in it, as in the prototype (decision 1425).
      expect(r.area.left).toBeCloseTo(472, 0);
      expect(r.body.left).toBeCloseTo(484, 0);
      expect(r.bodyRadius).toBe('16px');
      expect(r.left).toBeCloseTo(380, 0);
      expect(r.footRadius).toBe('16px');
      expect(Math.abs(r.panel.bottom - r.foot.bottom)).toBeLessThanOrEqual(1);
      expect(r.foot.left).toBeCloseTo(r.body.left, 0);
      expect(r.foot.height).toBeCloseTo(64, 0);
      expect(r.padding).toBe('12px 10px 10px 14px');
      expect(r.gap).toBe('10px');
      expect(Math.abs(r.ctxGap - 10)).toBeLessThanOrEqual(1);
      expect(r.scroll).toBeLessThanOrEqual(r.inner);
      expect(r.marks.length).toBeGreaterThan(3);
      expect(r.marks.every(Boolean), 'every "Agente" mark inside its label row').toBe(true);
      expect(r.clipped, 'no option of the length or kind controls is cut').toEqual([]);
      expect(r.opacity).toBe('1');
      expect(r.modeShown, 'the mode switch is in the top bar').toBe(true);
      expect(r.modeOn).toContain("Con l'agente");
      expect(r.scrollable, 'the chat scrolls (the check below is not vacuous)').toBe(true);
      expect(r.under, 'no message under the composer or the context row').toEqual([]);
      expect(r.markOnTitle, 'the board heading keeps its mark on its line').toBe(true);
      // Opening: the space at once, the panel after 0.6 × s (120 ms).
      expect(r.panelDelays).toMatchObject({ opacity: '0.12s', transform: '0.12s' });
      expect(r.formDelays.left).toBe('0s');
      expect(r.bodyDelays['grid-template-columns']).toBe('0s');
    }, 120_000);

    it(`${theme}: Compila tu at 1440 × 900: the panel is out, the form card at 12 px with a 480 px brief column`, async () => {
      const r = await measure(youHtml, { name: 'you', width: 1440, height: 900, theme });
      expect(r.opacity).toBe('0');
      expect(r.transform).toBe('matrix(0.98, 0, 0, 0.98, -32, 0)');
      expect(r.body.left).toBeCloseTo(12, 0);
      expect(r.left).toBeCloseTo(480, 0);
      expect(r.scroll).toBeLessThanOrEqual(r.inner);
      // Closing: the panel at once, the space after 0.6 × s.
      expect(r.panelDelays).toMatchObject({ opacity: '0s', transform: '0s' });
      expect(r.formDelays.left).toBe('0.12s');
      expect(r.modeShown, 'the mode switch is in the top bar').toBe(true);
      expect(r.modeOn).toBe('Compila tu');
    }, 120_000);

    it(`${theme}: Con l'agente at 1024 × 700: a 360 px panel, the board keeps room, the footer's buttons show`, async () => {
      const r = await measure(agentHtml, { name: 'agent', width: 1024, height: 700, theme });
      expect(r.panel.width).toBeCloseTo(360, 0);
      expect(r.area.left).toBeCloseTo(384, 0);
      expect(r.body.left).toBeCloseTo(396, 0);
      expect(r.scroll).toBeLessThanOrEqual(r.inner);
      expect(r.board).toBeGreaterThanOrEqual(280);
      expect(r.clipped, 'no option of the length or kind controls is cut').toEqual([]);
      expect(r.modeShown).toBe(true);
      expect(r.scrollable, 'the chat scrolls at this size (the check below is not vacuous)').toBe(true);
      expect(r.under, 'no message under the composer or the context row').toEqual([]);
      expect(r.markOnTitle, 'the board heading keeps its mark on its line').toBe(true);
      expect(r.buttons.length).toBeGreaterThanOrEqual(2);
      expect(r.buttons.every(Boolean), "the footer's buttons are whole").toBe(true);
      expect(Math.abs(r.panel.bottom - r.foot.bottom)).toBeLessThanOrEqual(1);
    }, 120_000);
  }

  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: Compila tu at 1024 × 700: the form card at 12 px, nothing cut, the board keeps room`, async () => {
      const r = await measure(youHtml, { name: 'you', width: 1024, height: 700, theme });
      expect(r.body.left).toBeCloseTo(12, 0);
      expect(r.left).toBeCloseTo(480, 0);
      expect(r.scroll).toBeLessThanOrEqual(r.inner);
      expect(r.board).toBeGreaterThanOrEqual(280);
      expect(r.clipped).toEqual([]);
      expect(r.buttons.every(Boolean), "the footer's buttons are whole").toBe(true);
      expect(r.modeShown).toBe(true);
      expect(r.modeOn).toBe('Compila tu');
    }, 120_000);
  }

  it('reduced motion makes every transition instant', async () => {
    for (const html of [agentHtml, youHtml]) {
      const r = await measure(html, { name: 'reduced', width: 1440, height: 900, theme: 'light', reduce: true });
      expect(r.maxDuration).toBeLessThanOrEqual(0.001);
    }
  }, 120_000);
});

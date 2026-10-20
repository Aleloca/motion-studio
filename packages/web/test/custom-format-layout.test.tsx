/**
 * Report 59: the "Personalizzati" group of New creative and the custom format dialog, measured in real Chrome, light and dark,
 * at 1440 × 900 and 1024 × 700, with motion and transparency emulated explicitly (never the machine's settings). On the board:
 * the "Personalizzato" tile 112 px like the others; a custom tile's edit button inside its tile, a target of 24 px or more, clear
 * of the drawn frame, the tick, the link toggle, the copies counter and the text, also with every tile at its narrowest (118 px).
 * The dialog: inside the viewport, nothing cut or scrolling sideways, the ratio chips and the buttons whole, the error and in-use
 * texts readable (4.5:1). The markup is rendered in jsdom with the real stylesheets; without Chrome the tests are skipped
 * (MS_REQUIRE_CHROME=1 makes a missing browser a failure). MS_LAYOUT_SHOTS=<folder> also saves a screenshot of each case there.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { customPreset, DEFAULT_FORMATS, EMPTY_BRAND_KIT } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initialEventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';

const TOTEM = customPreset({ name: 'Totem', kind: 'video', width: 1080, height: 1920, maxDurationSec: 30 }, 'custom-totem');
const LONG = customPreset({ name: 'Volantino A5 per la fiera di primavera, versione stampa', kind: 'image', width: 1748, height: 2480 }, 'custom-volantino');
const presets = [...DEFAULT_FORMATS, TOTEM, LONG];
const api = {
  getFormats: vi.fn(async () => ({ presets, error: null, path: '/x' })),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })),
  getBrand: vi.fn(async () => ({ kit: EMPTY_BRAND_KIT, kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k' })),
  projectFileUrl: () => 'data:,',
  getFirstGenerations: vi.fn(async () => ({ tokens: [] })),
  getSecrets: vi.fn(async () => []),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: '2026-10-20T10:00:00.000Z' })),
  getBriefSession: vi.fn(async () => null),
  getBriefConversation: vi.fn(async () => []),
  customFormatUsage: vi.fn(async () => ({ creatives: 3 })),
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

type Html = { page: string; modal: string };
/**
 * The board with the Instagram Reel 9:16 and the custom Totem chosen (the Totem can follow the Reel: its tile has the link
 * toggle, three copies and the edit button), and a dialog: the new one with its errors shown, or the edit of the Totem in use.
 */
async function markup(dialog: 'new' | 'edit'): Promise<Html> {
  const shell = { route: { name: 'new-creative', slug: 'acme' }, live: initialEventsState, catalog: { projects: [{ slug: 'acme', name: 'Audin' }], creatives: {}, refresh: () => {} } } as never;
  const { container, unmount } = render(
    <I18nProvider locale="it"><ShellContext.Provider value={shell}><div id="page"><NewCreative slug="acme" live={initialEventsState} /></div></ShellContext.Provider></I18nProvider>,
  );
  await waitFor(() => screen.getByRole('group', { name: 'Personalizzati' }));
  await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /^Story\/Reel 9:16/ }));
  const custom = screen.getByRole('group', { name: 'Personalizzati' });
  await userEvent.click(within(custom).getByRole('button', { name: /^Totem/ }));
  const more = within(within(custom).getByRole('group', { name: /^Copie di/ })).getByRole('button', { name: 'Una copia in più' });
  await userEvent.click(more); await userEvent.click(more);
  expect(container.querySelector('[data-format="custom-totem"] button.ms-nc-link:not(.ms-nc-custom-edit)'), 'the Totem has its link toggle').toBeTruthy();
  if (dialog === 'new') {
    await userEvent.click(within(custom).getByRole('button', { name: 'Nuovo formato personalizzato' }));
    const d = await screen.findByRole('dialog');
    await userEvent.click(within(d).getByRole('radio', { name: 'Video' }));
    const w = within(d).getByLabelText('Larghezza');
    await userEvent.clear(w); await userEvent.type(w, '9');
    await userEvent.type(within(d).getByLabelText('Durata massima'), '0');
    await userEvent.click(within(d).getByRole('button', { name: 'Crea formato' }));
    expect(within(d).getAllByRole('alert')).toHaveLength(3);
  } else {
    await userEvent.click(within(custom).getByRole('button', { name: 'Modifica Personalizzati · Totem' }));
    const d = await screen.findByRole('dialog');
    await waitFor(() => expect(within(d).getByText(/3 creatività usano/)).toBeTruthy());
    await userEvent.click(within(d).getByRole('button', { name: 'Elimina' }));
  }
  const html = { page: container.querySelector('#page')!.innerHTML, modal: document.querySelector('.ms-modal')!.outerHTML };
  unmount();
  return html;
}

const MEASURE = `(() => {
const hit = (a, b) => !!a && !!b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const within = (a, b) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
const edits = () => [...document.querySelectorAll('.ms-nc-is-custom')].map((wrap) => {
  const tile = wrap.querySelector('.ms-nc-tile').getBoundingClientRect();
  const e = wrap.querySelector('.ms-nc-custom-edit').getBoundingClientRect();
  const r = (s) => wrap.querySelector(s)?.getBoundingClientRect();
  const name = wrap.querySelector('.ms-nc-tile-text b');
  return { id: wrap.dataset.format, tile: Math.round(tile.width), height: Math.round(tile.height),
    inside: within(e, tile), small: e.width < 24 || e.height < 24,
    over: ['.ms-nc-frame', '.ms-nc-tick', '.ms-nc-link:not(.ms-nc-custom-edit)', '.ms-nc-copies', '.ms-nc-tile-text b', '.ms-nc-tile-meta'].filter((s) => hit(e, r(s))),
    nameShown: name.getBoundingClientRect().width >= 40 };
});
const add = document.querySelector('.ms-nc-custom-add').getBoundingClientRect();
const group = document.querySelector('.ms-nc-group[aria-label="Personalizzati"]').getBoundingClientRect();
const board = { edits: edits(), add: Math.round(add.height), addInside: within(add, group) };
const narrow = document.createElement('style');
narrow.textContent = '.ms-nc-tiles { grid-template-columns: repeat(auto-fill, 118px) !important; } .ms-nc-groups > .ms-nc-group { flex: 1 1 100% !important; }';
document.head.appendChild(narrow);
const editsNarrow = edits();
narrow.remove();
const dlg = document.querySelector('.ms-dialog');
if (!dlg) return { board, editsNarrow, scroll: document.documentElement.scrollWidth, inner: innerWidth, namesCut: [...document.querySelectorAll('.ms-nc-ghead b')].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent) };
const d = dlg.getBoundingClientRect();
const cut = [...dlg.querySelectorAll('button, input, label, .ms-chip, p, h2')].filter((el) => el.scrollWidth > el.clientWidth + 1 || !within(el.getBoundingClientRect(), d)).map((el) => el.textContent || el.id || el.tagName);
const chips = [...dlg.querySelectorAll('.ms-cfd-ratios .ms-chip')].map((c) => c.getBoundingClientRect());
const bg = getComputedStyle(dlg).backgroundColor;
const colorOf = (s) => [...dlg.querySelectorAll(s)].map((el) => getComputedStyle(el).color);
const durations = [...document.querySelectorAll('*')].flatMap((el) => getComputedStyle(el).transitionDuration.split(',').map((x) => parseFloat(x) * 1000));
return { board, editsNarrow, dialog: { left: d.left, right: d.right, top: d.top, bottom: d.bottom, width: d.width, sideways: dlg.scrollWidth > dlg.clientWidth + 1 },
  cut, chips: chips.length, chipsOneRow: new Set(chips.map((c) => Math.round(c.top))).size === 1, chipsSmall: chips.some((c) => c.height < 24),
  bg, errors: colorOf('.ms-cfd-err'), notes: colorOf('.ms-cfd-note, .ms-cfd-confirm p'), noteBg: [...dlg.querySelectorAll('.ms-cfd-note')].map((el) => getComputedStyle(el).backgroundColor),
  scroll: document.documentElement.scrollWidth, inner: innerWidth, innerH: innerHeight, maxDuration: Math.max(...durations) };
})()`;
type Edit = { id: string; tile: number; height: number; inside: boolean; small: boolean; over: string[]; nameShown: boolean };
type Measure = {
  namesCut?: string[];
  board: { edits: Edit[]; add: number; addInside: boolean }; editsNarrow: Edit[];
  dialog: { left: number; right: number; top: number; bottom: number; width: number; sideways: boolean };
  cut: string[]; chips: number; chipsOneRow: boolean; chipsSmall: boolean; bg: string; errors: string[]; notes: string[]; noteBg: string[];
  scroll: number; inner: number; innerH: number; maxDuration: number;
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

const editsOk = (list: Edit[]) => {
  expect(list.map((e) => e.id).sort()).toEqual(['custom-totem', 'custom-volantino']);
  expect(list.filter((e) => !e.inside || e.small || e.over.length > 0 || !e.nameShown),
    'every edit button inside its tile, 24 px or more, clear of the frame, tick, link, counter and text').toEqual([]);
  expect(list.find((e) => e.id === 'custom-totem')!.height, 'the Totem carries its copies counter').toBe(148);
  expect(list.find((e) => e.id === 'custom-volantino')!.height).toBe(112);
};

const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('custom formats: real Chrome layout (report 59)', () => {
  let dir = '';
  let browser: Browser;
  const html: Record<'new' | 'edit', Html> = { new: { page: '', modal: '' }, edit: { page: '', modal: '' } };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ms-custom-layout-'));
    browser = await launchChrome(chrome!);
    html.new = await markup('new');
    html.edit = await markup('edit');
  }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  async function measure(h: Html, o: { name: string; width: number; height: number; theme: 'light' | 'dark'; reduce?: boolean; opaque?: boolean }): Promise<Measure> {
    const page = `<!doctype html><html lang="it" data-theme="${o.theme}"><head><meta charset="utf-8"><style>${CSS}
      html,body{height:100%;margin:0}</style></head>
      <body><div class="ms-app ms-bare"><div class="ms-main" id="main"><div class="ms-stage"><div class="ms-page">${h.page}</div></div></div></div>${h.modal}</body></html>`;
    const file = join(dir, `${o.name}-${o.theme}-${o.width}${o.reduce ? '-reduced' : ''}${o.opaque ? '-opaque' : ''}.html`);
    writeFileSync(file, page);
    const tab = await browser.newPage(o.width, o.height);
    try {
      await tab.send('Emulation.setEmulatedMedia', { features: [
        { name: 'prefers-reduced-motion', value: o.reduce ? 'reduce' : 'no-preference' },
        { name: 'prefers-reduced-transparency', value: o.opaque ? 'reduce' : 'no-preference' },
      ] });
      await tab.goto(`file://${file}`);
      const r = await tab.eval<Measure>(MEASURE, 30_000);
      if (shots) writeFileSync(join(shots, `custom-${o.name}-${o.theme}-${o.width}x${o.height}${o.reduce ? '-reduced' : ''}${o.opaque ? '-opaque' : ''}.png`), await tab.screenshot());
      return r;
    } finally { await tab.close(); }
  }

  const dialogOk = (r: Measure, width: number) => {
    expect(r.dialog.width).toBeCloseTo(460, 0);
    expect(r.dialog.left).toBeGreaterThanOrEqual(16);
    expect(r.dialog.right).toBeLessThanOrEqual(width - 16);
    expect(r.dialog.top).toBeGreaterThanOrEqual(0);
    expect(r.dialog.bottom).toBeLessThanOrEqual(r.innerH);
    expect(r.dialog.sideways, 'nothing scrolls sideways in the dialog').toBe(false);
    expect(r.cut, 'nothing in the dialog is cut').toEqual([]);
    expect(r.scroll).toBeLessThanOrEqual(r.inner);
  };

  for (const theme of ['light', 'dark'] as const) {
    for (const [width, height] of [[1440, 900], [1024, 700]] as const) {
      it(`${theme} ${width}: the board alone: the Personalizzati group, its tiles and edit buttons`, async () => {
        const r = await measure({ page: html.new.page, modal: '' }, { name: 'board', width, height, theme });
        expect(r.board.add).toBe(112);
        editsOk(r.board.edits);
        editsOk(r.editsNarrow);
        expect(r.namesCut, 'every channel name whole').toEqual([]);
        expect(r.scroll).toBeLessThanOrEqual(r.inner);
      }, 120_000);

      it(`${theme} ${width}: the board's Personalizzati group and the new format dialog with its errors`, async () => {
        const r = await measure(html.new, { name: 'new', width, height, theme });
        expect(r.board.add, 'the "Personalizzato" tile is as tall as the others').toBe(112);
        expect(r.board.addInside).toBe(true);
        editsOk(r.board.edits);
        editsOk(r.editsNarrow);
        expect(Math.min(...r.editsNarrow.map((e) => e.tile))).toBe(118);
        dialogOk(r, width);
        expect(r.chips).toBe(4);
        expect(r.chipsOneRow, 'the four ratios on one row').toBe(true);
        expect(r.chipsSmall).toBe(false);
        expect(r.errors).toHaveLength(3);
        for (const c of r.errors) expect(contrast(c, r.bg, r.bg), 'an error is readable').toBeGreaterThanOrEqual(4.5);
      }, 120_000);

      it(`${theme} ${width}: editing a format in use, its delete question`, async () => {
        const r = await measure(html.edit, { name: 'edit', width, height, theme });
        dialogOk(r, width);
        expect(r.chips, 'no ratios on a format in use').toBe(0);
        expect(r.notes).toHaveLength(2);
        r.notes.forEach((c, i) => expect(contrast(c, r.noteBg[i] ?? r.bg, r.bg), 'the in-use note and the question are readable').toBeGreaterThanOrEqual(4.5));
      }, 120_000);
    }
  }

  it('reduced motion makes every transition instant; reduced transparency changes nothing in the dialog', async () => {
    const r = await measure(html.new, { name: 'new', width: 1440, height: 900, theme: 'light', reduce: true });
    expect(r.maxDuration).toBeLessThanOrEqual(0.001);
    const o = await measure(html.edit, { name: 'edit', width: 1440, height: 900, theme: 'dark', opaque: true });
    dialogOk(o, 1440);
    expect(rgba(o.bg)[3], 'the dialog is opaque').toBe(1);
  }, 120_000);
});

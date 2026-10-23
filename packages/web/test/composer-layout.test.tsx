/**
 * Busy composer layout (UX feedback batch 1, task 1). The component is rendered in jsdom (no layout there), its markup is
 * given the real stylesheets and measured in real Chrome at 320, 360 and 480 px: nothing overflows, nothing is clipped
 * mid-word, the Stop and send buttons have the same height, the Services chip is never cut. Without Chrome the measuring
 * test is skipped (MS_REQUIRE_CHROME=1 makes the missing browser a failure); the CSS-rule tests always run.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentCapabilities, Brief, JobSummary } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
// The repo's proven Chrome driver (CDP over a pipe; it passes --use-mock-keychain and --password-store=basic, as BASE_FLAGS does).
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';

let caps: AgentCapabilities = { cliVersion: null, liveInput: true, interrupt: true, checkedAt: '2026-10-14T10:00:00.000Z' };
const api = {
  sendCreativeTurn: vi.fn(async () => ({ id: 'j9' })), stopJob: vi.fn(async () => ({ status: 'stopping' })),
  getAgentCapabilities: vi.fn(async () => caps), postLiveMessage: vi.fn(), redirectJob: vi.fn(),
  removeQueued: vi.fn(), editQueued: vi.fn(), reorderQueue: vi.fn(), runNext: vi.fn(), decideApproval: vi.fn(),
  uploadFiles: vi.fn(async (_s: string, _k: string, files: File[]) => ({ assets: files.map((f) => ({ file: f.name, kind: 'image' })) })),
  // A picture that loads (round 1: the screenshots show a real thumbnail).
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })), projectFileUrl: (_s: string, _p: string) => THUMB,
};
class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { Conversation } = await import('../src/components/Conversation.tsx');

const THUMB = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7a3d"/><stop offset="1" stop-color="#5b3dff"/></linearGradient></defs><rect width="16" height="16" fill="url(#g)"/><circle cx="8" cy="8" r="3.5" fill="#fff"/></svg>')}`;
const src = (p: string) => readFileSync(join(import.meta.dirname, '../src', p), 'utf8');
const CSS = ['theme.css', 'ui/ui.css', 'components/conversation.css', 'components/services.css', 'screens/new-creative/briefsession.css'].map(src).join('\n');
const running: JobSummary = { id: 'j1', key: 'creative:k', kind: 'creative', label: 'x', state: 'running', createdAt: '2026-10-14T10:00:00.000Z' };
const brief = { services: {} } as unknown as Brief;
const required = process.env.MS_REQUIRE_CHROME === '1';
// Real Chrome only on request (MS_REQUIRE_CHROME=1 or MS_LAYOUT_CHROME=1): a launch can raise OS dialogs.
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;

describe('busy composer: CSS rules', () => {
  const conv = src('components/conversation.css');
  it('the composer is a size container and narrow behaviour comes from its width, not the viewport', () => {
    expect(conv).toMatch(/\.ms-composer\s*\{[^}]*container:[^;}]*inline-size/);
    expect(conv).toMatch(/@container ms-composer[^{]*\(max-width:\s*\d+px\)/);
    expect(conv).not.toMatch(/@media[^{]*(max|min)-width[^{]*\{[^}]*ms-composer/);
  });
  it('the narrow rules go icon-only and drop the hint', () => {
    const narrow = conv.slice(conv.indexOf('@container'));
    expect(narrow).toMatch(/ms-composer-hint\s*\{[^}]*display:\s*none/);
    expect(narrow).toMatch(/ms-composer-text\s*\{[^}]*display:\s*none/);
    expect(narrow).toMatch(/ms-services-chip-label/);
  });
  it('the shortcut is never hidden, and the send button is a pill (report 79)', () => {
    expect(conv).not.toMatch(/ms-composer-keys\s*\{[^}]*display:\s*none/);
    expect(conv).toMatch(/\.ms-composer-send\s*\{[^}]*border-radius:\s*999px/);
  });
});

describe('floating glass composer: CSS rules (user test note 25)', () => {
  const conv = src('components/conversation.css');
  it('the dock floats and the list is padded by its live height', () => {
    expect(conv).toMatch(/\.ms-convo-dock\s*\{[^}]*position:\s*absolute[^}]*bottom:\s*0/);
    expect(conv).toMatch(/\.ms-convo-list\s*\{[^}]*padding:[^;]*var\(--ms-dock-h/);
  });
  it('glass is blur + saturate behind a feature query and a reduced-transparency guard, over an opaque base', () => {
    expect(conv).toMatch(/\.ms-composer\s*\{[^}]*background:\s*var\(--glassSolid\)/);
    const glass = conv.slice(conv.indexOf('@supports'));
    expect(glass).toMatch(/@media not \(prefers-reduced-transparency: reduce\)/);
    expect(glass).toMatch(/backdrop-filter:\s*blur\([^)]*\)\s*saturate\(/);
  });
  it('the glass tokens exist in the light theme and both dark blocks', () => {
    const theme = src('theme.css');
    expect(theme.match(/--glass:/g)?.length).toBe(3);
    expect(theme.match(/--glassSolid:/g)?.length).toBe(3);
  });
});

async function markup(mode: 'live' | 'queue' | 'redirect' | 'idle', locale: 'en' | 'it', mac = false): Promise<string> {
  caps = { ...caps, liveInput: mode !== 'queue' };
  // jsdom is not a Mac: the measures use the wider "Ctrl+↵"; the screenshots show what a Mac shows.
  const platform = mac ? vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel') : null;
  const { container, unmount } = render(
    <I18nProvider locale={locale}><Conversation slug="acme" creative="c1" entries={[]} approvals={[]} pins={[]} job={mode === 'idle' ? undefined : running} onSent={vi.fn()} brief={brief} /></I18nProvider>);
  if (mode === 'idle') {
    // Report 79: the idle composer with one attached file (its chip in the box) and a few words.
    await userEvent.click(screen.getByRole('button', { name: /^(Attach files|Allega file)$/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /^(From computer|Dal computer)/ }));
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['x'], 'brand-logo-final.png', { type: 'image/png' })] } });
    await screen.findByRole('button', { name: /brand-logo-final\.png/ });
    // Round 1: a second chip, a video: its kind icon.
    await userEvent.click(screen.getByRole('button', { name: /^(Attach files|Allega file)$/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /^(From computer|Dal computer)/ }));
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['x'], 'launch-teaser.mp4', { type: 'video/mp4' })] } });
    await screen.findByRole('button', { name: /launch-teaser\.mp4/ });
    await userEvent.type(screen.getByRole('textbox'), 'Use the logo');
    const html = (container.querySelector('form.ms-composer') as HTMLElement).outerHTML;
    unmount();
    platform?.mockRestore();
    return html;
  }
  // The explanation line only exists once the capabilities answered, i.e. the real send action has replaced the neutral one.
  await waitFor(() => { expect(container.querySelector('.ms-composer-note')).toBeTruthy(); });
  if (mode === 'redirect') {
    await userEvent.click(screen.getByRole('button', { name: /^(Stop options|Opzioni)/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /redirect|reindirizz/i }));
  }
  const html = (container.querySelector('form.ms-composer') as HTMLElement).outerHTML;
  unmount();
  return html;
}

const MEASURE = `(() => {
const out = [];
const form = document.querySelector('form.ms-composer');
const foot = form.querySelector('.ms-composer-foot');
const fr = foot.getBoundingClientRect();
const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const problems = [];
if (document.documentElement.scrollWidth > innerWidth) problems.push('page overflows');
if (foot.scrollWidth > foot.clientWidth) problems.push('foot overflows');
for (const el of foot.querySelectorAll('*')) {
  if (!vis(el)) continue;
  const r = el.getBoundingClientRect();
  if (r.right > fr.right + 0.5 || r.left < fr.left - 0.5) problems.push('outside the row: ' + (el.className.baseVal ?? el.className) + ' ' + (el.textContent || '').slice(0, 20));
  if (el.scrollWidth > el.clientWidth + 1 && el.children.length === 0 && el.textContent) problems.push('clipped text: ' + el.textContent);
}
for (const el of form.querySelectorAll('button, .ms-composer-hint, .ms-composer-note, .ms-services-chip')) {
  if (vis(el) && el.scrollWidth > el.clientWidth + 1) problems.push('clipped: ' + (el.getAttribute('aria-label') || el.textContent));
}
const h = (sel) => { const e = foot.querySelector(sel); return e && vis(e) ? e.getBoundingClientRect().height : null; };
const stop = h('.ms-stop');
const send = h('button[type=submit]');
if (stop !== null && send !== null && Math.abs(stop - send) > 0.5) problems.push('heights differ ' + stop + ' vs ' + send);
const chip = foot.querySelector('.ms-services-chip');
const lines = [...form.querySelectorAll('.ms-composer-note')].filter(vis).length;
const keys = [...foot.querySelectorAll('.ms-composer-send .ms-composer-keys, .ms-composer-act .ms-composer-keys')].some(vis);
return ({ keys, problems, hint: !!foot.querySelector('.ms-composer-hint') && vis(foot.querySelector('.ms-composer-hint')), chip: !!chip && vis(chip), chipW: chip && chip.getBoundingClientRect().width, notes: lines, stop, send, label: [...foot.querySelectorAll('.ms-composer-text')].some(vis), sum: [...foot.querySelectorAll('.ms-services-chip-sum')].some(vis) });
})()`;

const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('busy composer: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-composer-layout-')); browser = await launchChrome(chrome!); }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  async function measure(html: string, width: number, name: string, wide = false) {
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${CSS}
      body{margin:0}${wide ? ' #w *{letter-spacing:.07em !important}' : ''} #w{width:${width}px;box-sizing:border-box}</style></head><body><div id="w">${html}</div></body></html>`;
    const file = join(dir, `${name}-${width}${wide ? '-wide' : ''}.html`);
    writeFileSync(file, page);
    const tab = await browser.newPage(width, 900);
    try {
      await tab.goto(`file://${file}`);
      return await tab.eval<{ keys: boolean; problems: string[]; hint: boolean; chip: boolean; chipW: number; notes: number; stop: number | null; send: number | null; label: boolean; sum: boolean }>(MEASURE, 30_000);
    } finally { await tab.close(); }
  }

  // Report 79: the idle composer with an attached file. MS_COMPOSER_SHOTS=<folder> also saves composer-narrow.png and
  // composer-wide.png there (for the report's review).
  for (const locale of ['en', 'it'] as const) {
    it(`${locale} idle: the send pill keeps its shortcut and the "+" and the file chip fit, at every width`, async () => {
      const html = await markup('idle', locale);
      for (const width of [300, 320, 360, 480, 600, 760]) {
        const r = await measure(html, width, `${locale}-idle`);
        expect(r.problems, `${locale} idle @${width}`).toEqual([]);
        expect(r.keys, `shortcut shown @${width}`).toBe(true);
        expect(r.chip, 'the Services chip stays').toBe(true);
        const wide = await measure(html, width, `${locale}-idle`, true);
        expect(wide.problems, `${locale} idle wide @${width}`).toEqual([]);
      }
      const shots = process.env.MS_COMPOSER_SHOTS;
      if (shots && locale === 'en') {
        const mac = await markup('idle', locale, true);
        for (const [width, name, theme] of [[340, 'composer-narrow.png', 'dark'], [760, 'composer-wide.png', 'dark'], [340, 'composer-narrow-light.png', 'light'], [760, 'composer-wide-light.png', 'light']] as const) {
          const file = join(dir, `shot-${width}-${theme}.html`);
          writeFileSync(file, `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><style>${CSS}
            body{margin:0;background:var(--bg)} #w{width:${width}px;box-sizing:border-box;padding-top:12px}</style></head><body><div id="w">${mac}</div></body></html>`);
          const tab = await browser.newPage(width, 200);
          try { await tab.goto(`file://${file}`); writeFileSync(join(shots, name), await tab.screenshot()); } finally { await tab.close(); }
        }
      }
    }, 120_000);
  }

  for (const locale of ['en', 'it'] as const) {
    for (const mode of ['live', 'queue', 'redirect'] as const) {
      it(`${locale} ${mode}: no overflow and no clipped text at 320, 360 and 480`, async () => {
        const html = await markup(mode, locale);
        for (const width of [320, 360, 480]) {
          const r = await measure(html, width, `${locale}-${mode}`);
          expect(r.problems, `${locale} ${mode} @${width}`).toEqual([]);
          expect(r.chip, 'the Services chip stays').toBe(true);
          expect(r.chipW).toBeGreaterThan(20);
          expect(r.notes, 'one explanation line').toBeLessThanOrEqual(1);
          if (width <= 360) expect(r.hint, `hint hidden @${width}`).toBe(false);
          // Report 79: the send actions keep their shortcut in a narrow panel too.
          if (mode !== 'redirect') expect(r.keys, `shortcut shown @${width}`).toBe(true);
          if (mode !== 'redirect') {
            // Never vacuous: the Stop and the send buttons are both there, and as tall as each other (the page checks that).
            expect(r.stop, `Stop present @${width}`).not.toBeNull();
            expect(r.send, `send present @${width}`).not.toBeNull();
          }
        }
      }, 120_000);

      // Linux Chrome falls back to wider fonts (CI #540); letter-spacing reproduces that on any machine. The row must never
      // overflow whatever the text metrics: items wrap to a second line before they leave the row.
      it(`${locale} ${mode}: wide text metrics never push an item out of the row`, async () => {
        const html = await markup(mode, locale);
        for (const width of [320, 360, 480, 540, 600, 640, 760]) {
          const r = await measure(html, width, `${locale}-${mode}`, true);
          expect(r.problems, `${locale} ${mode} wide @${width}`).toEqual([]);
          expect(r.chip, 'the Services chip stays').toBe(true);
        }
      }, 120_000);

      it(`${locale} ${mode}: between the two thresholds the labels show and the hint stays out; wide, hint and summary show`, async () => {
        const html = await markup(mode, locale);
        const mid = await measure(html, 540, `${locale}-${mode}`);
        expect(mid.problems, `${locale} ${mode} @540`).toEqual([]);
        expect(mid.label, 'labels shown @540').toBe(true);
        expect(mid.hint, 'hint hidden @540').toBe(false);
        expect(mid.sum, 'summary hidden @540').toBe(false);
        const wide = await measure(html, 760, `${locale}-${mode}`);
        expect(wide.problems, `${locale} ${mode} @760`).toEqual([]);
        expect(wide.label, 'labels shown @760').toBe(true);
        expect(wide.hint, 'hint shown @760').toBe(true);
        expect(wide.sum, 'summary shown @760').toBe(true);
        if (mode !== 'redirect') { expect(wide.stop).not.toBeNull(); expect(wide.send).not.toBeNull(); }
      }, 120_000);
    }
  }
});

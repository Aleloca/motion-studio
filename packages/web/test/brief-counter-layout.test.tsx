/**
 * Report 93: the bottom row of the brief box in New creative ("Kit del brand", the assets chip, "+", "Fallo compilare
 * all'agente" and the character counter), measured in real Chrome at 1440, 1024 and 600 px wide, with and without the
 * counter: nothing in the row leaves the box, the row wraps instead. The counter is absent while the brief is short.
 * The markup is rendered in jsdom with the real stylesheets; without Chrome the tests are skipped
 * (MS_REQUIRE_CHROME=1 makes a missing browser a failure). MS_LAYOUT_SHOTS=<folder> saves screenshots.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BRIEF_TEXT_MAX, DEFAULT_FORMATS, type AssetEntry, type BrandKit } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initialEventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';

const kit = { colors: [{ id: 'c', name: 'Blu', hex: '#2244aa', role: 'primary' }], fonts: [], logos: [], tone: null, voice: [] } as unknown as BrandKit;
const entry: AssetEntry = { file: 'assets/voce-guida.mp3', kind: 'audio', origin: 'upload', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: '2026-10-21T10:00:00.000Z', attribution: null };
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  listAssets: vi.fn(async () => ({ assets: [entry], error: null, unregistered: [], creativeReferences: [] })),
  getBrand: vi.fn(async () => ({ kit, kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k' })),
  projectFileUrl: () => 'data:,',
  getFirstGenerations: vi.fn(async () => ({ tokens: [] })),
  getSecrets: vi.fn(async () => []),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: '2026-10-20T10:00:00.000Z' })),
  getBriefSession: vi.fn(async () => null),
  getBriefConversation: vi.fn(async () => []),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { NewCreative } = await import('../src/screens/NewCreative.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { requestNewCreativeWithAssets } = await import('../src/shell/intents.ts');

const src = (p: string) => readFileSync(join(import.meta.dirname, '../src', p), 'utf8');
const CSS = ['theme.css', 'ui/ui.css', 'components/conversation.css', 'components/codebase.css', 'components/services.css', 'screens/newcreative.css',
  'screens/new-creative/storepack.css', 'screens/new-creative/briefsession.css', 'shell/shell.css'].map(src).join('\n');
const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const shots = process.env.MS_LAYOUT_SHOTS ?? null;

async function markup(brief: string): Promise<string> {
  requestNewCreativeWithAssets('acme', ['assets/voce-guida.mp3']);
  const shell = { route: { name: 'new-creative', slug: 'acme' }, live: initialEventsState, catalog: { projects: [{ slug: 'acme', name: 'Audin' }], creatives: {}, refresh: () => {} } } as never;
  const { container, unmount } = render(
    <I18nProvider locale="it"><ShellContext.Provider value={shell}><div id="page"><NewCreative slug="acme" live={initialEventsState} /></div></ShellContext.Provider></I18nProvider>,
  );
  await waitFor(() => screen.getByRole('group', { name: 'Instagram' }));
  await screen.findByText('Kit del brand');
  if (brief) fireEvent.change(screen.getByLabelText('Cosa vuoi realizzare?'), { target: { value: brief } });
  const html = container.querySelector('#page')!.innerHTML;
  unmount();
  return html;
}

const MEASURE = `(() => {
const box = document.querySelector('.ms-nc-goalbox');
box.scrollIntoView({ block: 'center' });
const b = box.getBoundingClientRect();
const bar = document.querySelector('.ms-nc-goalbar');
const kids = [...bar.children].map((k) => { const r = k.getBoundingClientRect(); return { cls: k.className, left: r.left, right: r.right, outside: r.left < b.left - 0.5 || r.right > b.right + 0.5 }; });
return { kids, boxWidth: Math.round(b.width), count: document.querySelector('.ms-nc-count')?.textContent ?? null, scroll: document.documentElement.scrollWidth, inner: innerWidth };
})()`;
type Measure = { kids: Array<{ cls: string; outside: boolean }>; boxWidth: number; count: string | null; scroll: number; inner: number };

const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('brief box bottom row: real Chrome layout (report 93)', () => {
  let dir = '';
  let browser: Browser;
  const pages: Record<'empty' | 'full', string> = { empty: '', full: '' };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ms-brief-counter-layout-'));
    browser = await launchChrome(chrome!);
    pages.empty = await markup('');
    pages.full = await markup('a'.repeat(BRIEF_TEXT_MAX - 1));
  }, 120_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  for (const state of ['empty', 'full'] as const) {
    for (const [width, height] of [[1440, 900], [1024, 700], [600, 800], [420, 800]] as const) {
      it(`${state} brief at ${width}: nothing in the row leaves the box`, async () => {
        const page = `<!doctype html><html lang="it" data-theme="light"><head><meta charset="utf-8"><style>${CSS}
          html,body{height:100%;margin:0}</style></head>
          <body><div class="ms-app ms-bare"><div class="ms-main" id="main"><div class="ms-stage"><div class="ms-page">${pages[state]}</div></div></div></div></body></html>`;
        const file = join(dir, `brief-counter-${state}-${width}.html`);
        writeFileSync(file, page);
        const tab = await browser.newPage(width, height);
        let r: Measure;
        try {
          await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
          await tab.goto(`file://${file}`);
          r = await tab.eval<Measure>(MEASURE, 30_000);
          if (shots) writeFileSync(join(shots, `brief-counter-${state}-${width}.png`), await tab.screenshot());
        } finally { await tab.close(); }
        expect(r.kids.length).toBeGreaterThanOrEqual(3);
        expect(r.kids.filter((k) => k.outside), 'every child of the row inside the box').toEqual([]);
        expect(r.scroll).toBeLessThanOrEqual(r.inner);
        if (state === 'empty') expect(r.count).toBeNull(); else expect(r.count).toContain('99.999');
      }, 120_000);
    }
  }
});

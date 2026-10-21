/**
 * Task 19: the library's Analisi section in the detail column, measured in real Chrome at 1024 × 700 and 2000 × 1200, light and
 * dark: the section fits the column with nothing scrolling sideways, a scene with a 300-character on-screen text and a long
 * speech line stays inside its row, the buttons are whole; the inline overwrite question fits too.
 */
import type { AssetEntry, VideoAnalysisView } from '@motion-studio/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initialEventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { chromePath, chromeRequired, LayoutRig } from './support/layoutPage.ts';

const LONG_TEXT = 'Offerta valida fino al 31 dicembre su tutti i modelli della gamma primavera estate, consegna gratuita in tutta Italia '.repeat(3).slice(0, 300);
const BODY = [
  '## Summary', 'Una demo del prodotto su fondo bianco, con il logo e un presentatore che parla in camera.', '', '## Timeline',
  '- [00:00–00:12] Intro: il presentatore entra in campo e saluta',
  `- [00:12–00:18] Logo su bianco con un testo lunghissimo`, `  - On-screen text: "${LONG_TEXT}", "ACME"`, `  - [00:13.2] "${'Benvenuti a tutti, oggi vi mostro come funziona '.repeat(4)}"`,
  ...Array.from({ length: 8 }, (_, i) => `- [00:${String(18 + i * 2).padStart(2, '0')}–00:${String(20 + i * 2).padStart(2, '0')}] Scena ${i + 3}: prodotto ruotato sul tavolo`),
  '', '## Usable moments', '- [00:12–00:18] Logo pulito, ottimo per la chiusura', '', '## Look', '- Colours: #ffffff', '',
  '## Transcript', 'Automatic transcript: names may be wrong.', '- [00:13.2–00:19.9] Benvenuti a tutti, oggi vi mostro come funziona', '', '## Tags', 'demo, logo, prodotto, presentatore', '',
].join('\n');
const view = (over: Partial<VideoAnalysisView> = {}): VideoAnalysisView => ({
  file: 'assets/intro.mp4', state: 'ready', jobId: null, error: null, pending: null, body: BODY,
  header: { format: 'motion-studio-video-analysis/1', asset: 'assets/intro.mp4', sha256: 'a'.repeat(64), bytes: 1000, durationSec: 40, width: 1920, height: 1080, fps: 25, hasAudio: true, transcript: 'whisper-small', language: 'it', generator: 'x', createdAt: '2026-10-21T10:00:00.000Z', edited: true },
  ...over,
});
const asset: AssetEntry = { file: 'intro.mp4', kind: 'video', origin: 'upload', sourceUrl: null, description: 'Demo del prodotto', tags: ['demo'], width: 1920, height: 1080, addedAt: '2026-10-21T10:00:00.000Z', attribution: null, durationSec: 40 };
const api = {
  listVideoAnalyses: vi.fn(async () => [view()]),
  listAssets: vi.fn(async () => ({ error: null, unregistered: [], assets: [asset, { ...asset, file: 'b-roll.mp4' }] })),
  getBrand: vi.fn(async () => ({ jobKey: 'brand:k' })),
  getProject: vi.fn(async () => ({ slug: 'acme', jobKey: 'k', project: { name: 'Acme' } })),
  getBriefSession: vi.fn(async () => null),
  assetWaveform: vi.fn(async () => ({ peaks: [] })),
  projectFileUrl: () => 'data:,',
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { Assets } = await import('../src/screens/Assets.tsx');

async function markup(confirm: boolean): Promise<string> {
  const { container, unmount } = render(<I18nProvider locale="it"><div id="page"><Assets slug="acme" live={initialEventsState} /></div></I18nProvider>);
  await userEvent.click(await screen.findByRole('button', { name: /intro\.mp4/ }));
  await waitFor(() => screen.getByRole('region', { name: 'Analisi' }));
  if (confirm) await userEvent.click(screen.getByRole('button', { name: 'Rianalizza' }));
  const html = container.querySelector('#page')!.innerHTML;
  unmount();
  return html;
}

const MEASURE = `(() => {
  const col = document.querySelector('.ms-adetail').getBoundingClientRect();
  const sec = document.querySelector('.ms-ana');
  const s = sec.getBoundingClientRect();
  const body = document.querySelector('.ms-adetail-body');
  const rows = [...sec.querySelectorAll('.ms-ana-row')];
  return {
    sectionInside: s.left >= col.left - 0.5 && s.right <= col.right + 0.5,
    bodySideways: body.scrollWidth > body.clientWidth + 1,
    rowsOut: rows.filter((r) => { const b = r.getBoundingClientRect(); return b.left < s.left - 0.5 || b.right > s.right + 0.5 || r.scrollWidth > r.clientWidth + 1; }).length,
    rows: rows.length,
    cut: cutIn(sec, 'button, .ms-pill'),
    out: outside(sec, '.ms-ana-head button, .ms-ana-confirm button', s),
    confirm: !!sec.querySelector('.ms-ana-confirm'),
    scroll: document.documentElement.scrollWidth, inner: innerWidth,
  };
})()`;
type M = { sectionInside: boolean; bodySideways: boolean; rowsOut: number; rows: number; cut: string[]; out: string[]; confirm: boolean; scroll: number; inner: number };
const shell = (page: string) => `<div class="ms-app ms-bare"><div class="ms-main" id="main"><div class="ms-stage"><div class="ms-page">${page}</div></div></div></div>`;

const run = chromePath ? describe : describe.skip;
if (!chromePath && chromeRequired) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('the Analisi section: real Chrome layout (Task 19)', () => {
  const rig = new LayoutRig();
  const html = { plain: '', confirm: '' };
  beforeAll(async () => { await rig.start(); html.plain = await markup(false); html.confirm = await markup(true); }, 120_000);
  afterAll(() => rig.stop(), 60_000);

  for (const theme of ['light', 'dark'] as const) {
    for (const [width, height] of [[1024, 700], [2000, 1200]] as const) {
      it(`${theme} ${width}: the section fits the details column; long on-screen text stays in its row`, async () => {
        const r = await rig.measure<M>(shell(html.plain), MEASURE, { name: 'analysis', width, height, theme }, 'va-analysis-section');
        expect(r.rows).toBeGreaterThanOrEqual(10);
        expect(r.sectionInside).toBe(true);
        expect(r.bodySideways, 'nothing scrolls sideways in the details').toBe(false);
        expect(r.rowsOut, 'every timed row inside the section').toBe(0);
        expect(r.cut).toEqual([]);
        expect(r.out).toEqual([]);
        expect(r.scroll).toBeLessThanOrEqual(r.inner);
      }, 120_000);
    }
    it(`${theme} 1024: the overwrite question fits`, async () => {
      const r = await rig.measure<M>(shell(html.confirm), MEASURE, { name: 'analysis-confirm', width: 1024, height: 700, theme }, 'va-analysis-confirm');
      expect(r.confirm).toBe(true);
      expect(r.cut).toEqual([]);
      expect(r.out).toEqual([]);
      expect(r.bodySideways).toBe(false);
    }, 120_000);
  }
});

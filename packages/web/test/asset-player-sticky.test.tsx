/**
 * Report 67: in an analysed video's detail panel the player (picture and controls) stays pinned at the top of the panel's scroll
 * area while the analysis scrolls under it; seeking from a row never scrolls anything. The pinning is measured in real Chrome
 * (landscape and portrait video, light and dark; MS_LAYOUT_SHOTS=<folder> saves the screenshots).
 */
import type { AssetEntry, VideoAnalysisView } from '@motion-studio/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initialEventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { chromePath, chromeRequired, LayoutRig } from './support/layoutPage.ts';

const BODY = [
  '## Summary', 'Una demo del prodotto su fondo bianco, con il logo e un presentatore che parla in camera.', '', '## Timeline',
  ...Array.from({ length: 16 }, (_, i) => `- [00:${String(i * 2).padStart(2, '0')}–00:${String(i * 2 + 2).padStart(2, '0')}] Scena ${i + 1}: prodotto ruotato sul tavolo`),
  '', '## Usable moments', '- [00:12–00:18] Logo pulito, ottimo per la chiusura', '', '## Tags', 'demo, logo', '',
].join('\n');
const view = (): VideoAnalysisView => ({
  file: 'assets/intro.mp4', state: 'ready', jobId: null, error: null, pending: null, body: BODY,
  header: { format: 'motion-studio-video-analysis/1', asset: 'assets/intro.mp4', sha256: 'a'.repeat(64), bytes: 1000, durationSec: 40, width: 1920, height: 1080, fps: 25, hasAudio: true, transcript: 'whisper-small', language: 'it', generator: 'x', createdAt: '2026-10-21T10:00:00.000Z', edited: false },
});
const asset = (width: number, height: number): AssetEntry => ({ file: 'intro.mp4', kind: 'video', origin: 'upload', sourceUrl: null, description: 'Demo', tags: ['demo'], width, height, addedAt: '2026-10-21T10:00:00.000Z', attribution: null, durationSec: 40 });
let current = asset(1920, 1080);
const api = {
  listVideoAnalyses: vi.fn(async () => [view()]),
  listAssets: vi.fn(async () => ({ error: null, unregistered: [], assets: [current] })),
  getBrand: vi.fn(async () => ({ jobKey: 'brand:k' })),
  getProject: vi.fn(async () => ({ slug: 'acme', jobKey: 'k', project: { name: 'Acme' } })),
  getBriefSession: vi.fn(async () => null),
  assetWaveform: vi.fn(async () => ({ peaks: [] })),
  projectFileUrl: () => 'data:,',
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { Assets } = await import('../src/screens/Assets.tsx');

async function markup(a: AssetEntry): Promise<{ html: string; unmount(): void }> {
  current = a;
  const { container, unmount } = render(<I18nProvider locale="it"><div id="page"><Assets slug="acme" live={initialEventsState} /></div></I18nProvider>);
  await userEvent.click(await screen.findByRole('button', { name: /intro\.mp4/ }));
  await waitFor(() => screen.getByRole('region', { name: 'Analisi' }));
  return { html: container.querySelector('#page')!.innerHTML, unmount };
}

describe('the pinned player (report 67)', () => {
  it('the player and its controls sit in a sticky block inside the scrolling body; a row seeks without scrolling', async () => {
    const intoView = vi.fn(); const scrollTo = vi.fn();
    Element.prototype.scrollIntoView = intoView; Element.prototype.scrollTo = scrollTo;
    const { unmount } = await markup(asset(1920, 1080));
    const sticky = document.querySelector('.ms-adetail-body > .ms-adetail-sticky') as HTMLElement;
    expect(sticky).toBeTruthy();
    expect(sticky.querySelector('video, .ms-player-picture')).toBeTruthy();
    expect(sticky.querySelector('.ms-player-controls')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: /Vai a 0:12/ })[0]!);
    expect(intoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
    unmount();
  });
});

const MEASURE = `(() => {
  const body = document.querySelector('.ms-adetail-body');
  const media = document.querySelector('.ms-adetail-sticky');
  const panel = document.querySelector('.ms-adetail').getBoundingClientRect();
  const before = media.getBoundingClientRect().top - body.getBoundingClientRect().top;
  body.scrollTop = 400;
  const m = media.getBoundingClientRect(), b = body.getBoundingClientRect();
  const row = document.querySelector('.ms-ana-row').getBoundingClientRect();
  return { scrolled: body.scrollTop, before, pinnedTop: m.top - b.top, height: m.height, panelHeight: panel.height,
    underneath: row.top < m.bottom, scroll: document.documentElement.scrollWidth, inner: innerWidth };
})()`;
type M = { scrolled: number; before: number; pinnedTop: number; height: number; panelHeight: number; underneath: boolean; scroll: number; inner: number };
const shell = (page: string) => `<div class="ms-app ms-bare"><div class="ms-main" id="main"><div class="ms-stage"><div class="ms-page">${page}</div></div></div></div>`;

const run = chromePath ? describe : describe.skip;
if (!chromePath && chromeRequired) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('the pinned player: real Chrome layout', () => {
  const rig = new LayoutRig();
  const html = { landscape: '', portrait: '' };
  beforeAll(async () => {
    const l = await markup(asset(1920, 1080)); html.landscape = l.html; l.unmount();
    const p = await markup(asset(1080, 1920)); html.portrait = p.html; p.unmount();
  }, 120_000);
  afterAll(() => rig.stop(), 60_000);
  beforeAll(() => rig.start(), 60_000);

  for (const theme of ['light', 'dark'] as const) {
    for (const shape of ['landscape', 'portrait'] as const) {
      it(`${theme} ${shape}: scrolled down, the player stays at the top and the analysis passes under it`, async () => {
        const r = await rig.measure<M>(shell(html[shape]), MEASURE, { name: `sticky-${shape}`, width: 1024, height: 700, theme }, `sticky-player-${shape}`);
        expect(r.scrolled).toBeGreaterThan(0);
        expect(Math.abs(r.pinnedTop), 'the block holds at the top edge of the scrolling body').toBeLessThanOrEqual(1);
        expect(r.underneath, 'the analysis scrolls under the player').toBe(true);
        expect(r.height, 'the player never takes more than 60% of the panel').toBeLessThanOrEqual(r.panelHeight * 0.6);
        expect(r.scroll).toBeLessThanOrEqual(r.inner);
      }, 120_000);
    }
  }
});

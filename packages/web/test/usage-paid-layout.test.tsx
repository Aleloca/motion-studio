/**
 * Report 66: Settings → Usage with Claude's card and the paid services' card, measured in real Chrome at 1024 × 700 (and 1400 tall, the whole page) and
 * 2000 × 1200, light and dark: nothing cut, every row inside its card, the page without horizontal scroll.
 */
import type { UsageReport, WorkspaceSettingsView } from '@motion-studio/shared';
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { chromePath, chromeRequired, LayoutRig } from './support/layoutPage.ts';

// The last 7 local days, so today is the accented bar.
const pad = (n: number) => String(n).padStart(2, '0');
const days = [6, 5, 4, 3, 2, 1, 0].map((back) => { const d = new Date(); d.setDate(d.getDate() - back); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; });
const report: UsageReport = {
  from: '2026-10-02T22:00:00.000Z', to: '2026-10-09T22:00:00.000Z',
  total: { tokens: { input: 60_000, output: 38_000, cacheRead: 900_000, cacheWrite: 10_600 }, costUsd: 2.14 },
  byDay: days.map((day, i) => ({ day, tokens: [12_000, 0, 24_000, 41_000, 0, 9_000, 22_600][i]!, costUsd: 0.3 })),
  byProject: [{ slug: 'acme', name: 'Acme Corporation — campagna autunno', tokens: 80_000, costUsd: 1.6 }, { slug: 'beta', name: 'Beta', tokens: 28_600, costUsd: 0.54 }],
  byKind: [{ kind: 'creative', tokens: 90_000, costUsd: 1.9 }, { kind: 'localize', tokens: 18_600, costUsd: 0.24 }],
  paid: {
    costUsd: 1.27, calls: 14,
    byDay: days.map((day, i) => ({ day, costUsd: [0.12, 0, 0.4, 0, 0.05, 0.3, 0.4][i]!, calls: [1, 0, 4, 0, 1, 3, 5][i]! })),
    byService: [
      { provider: 'openai', costUsd: 0.86, calls: 9, units: [{ unit: 'tokens', amount: 12_400 }, { unit: 'characters', amount: 3210 }, { unit: 'minutes', amount: 2 }] },
      { provider: 'elevenlabs', costUsd: 0.41, calls: 5, units: [{ unit: 'characters', amount: 1840 }, { unit: 'seconds', amount: 22, estimated: true }] },
    ],
    byKind: [
      { service: 'images', costUsd: 0.78, calls: 5, units: [{ unit: 'tokens', amount: 12_400 }] },
      { service: 'voice', costUsd: 0.23, calls: 5, units: [{ unit: 'characters', amount: 5050 }] },
      { service: 'music', costUsd: 0.0375, calls: 1, units: [{ unit: 'seconds', amount: 15 }] },
      { service: 'sfx', costUsd: 0.24, calls: 2, units: [{ unit: 'seconds', amount: 7, estimated: true }] },
      { service: 'transcription', costUsd: 0.0004, calls: 1, units: [{ unit: 'minutes', amount: 2 }] },
    ],
    byProject: [{ slug: 'acme', name: 'Acme Corporation — campagna autunno', costUsd: 1.1, calls: 11 }, { slug: 'beta', name: 'Beta', costUsd: 0.17, calls: 3 }],
  },
  trackedSince: '2026-09-01T09:00:00.000Z', billing: 'subscription', utcOffsetMinutes: -new Date().getTimezoneOffset(),
};
const api = { getUsage: vi.fn(async () => report), getSecrets: vi.fn(async () => []) };
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { AppSettings } = await import('../src/screens/AppSettings.tsx');

async function markup(): Promise<string> {
  const settings = { theme: 'system' } as unknown as WorkspaceSettingsView;
  const { container, unmount } = render(<I18nProvider locale="it"><div id="page">
    <AppSettings section="usage" settings={settings} checks={[]} checking={false} checksRun={1} loadError={null} onRecheck={() => {}}
      language="system" systemLocale="it" onLanguage={() => {}} onSettings={() => {}} />
  </div></I18nProvider>);
  await screen.findByRole('region', { name: /Servizi a pagamento/ });
  const html = container.querySelector('#page')!.innerHTML;
  unmount();
  return html;
}

const MEASURE = `(() => {
  const main = document.querySelector('.ms-set-main') ?? document.querySelector('.ms-page');
  const cards = [...document.querySelectorAll('.ms-usage-card')];
  const out = cards.flatMap((c) => outside(c, '.ms-usage-row, .ms-usage-billing, .ms-usage-bars', c.getBoundingClientRect()));
  return { cards: cards.length, cut: cutIn(main, '.ms-usage-num, .ms-usage-cost, .ms-usage-total, b'), out,
    sideways: main.scrollWidth > main.clientWidth + 1, scroll: document.documentElement.scrollWidth, inner: innerWidth };
})()`;
type M = { cards: number; cut: string[]; out: string[]; sideways: boolean; scroll: number; inner: number };

const run = chromePath ? describe : describe.skip;
if (!chromePath && chromeRequired) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('Settings → Utilizzo with the paid services: real Chrome layout (report 66)', () => {
  const rig = new LayoutRig();
  let html = '';
  beforeAll(async () => { await rig.start(); html = await markup(); }, 120_000);
  afterAll(() => rig.stop(), 60_000);
  const shell = () => `<div class="ms-app ms-bare"><div class="ms-main" id="main"><div class="ms-stage"><div class="ms-page">${html}</div></div></div></div>`;

  for (const theme of ['light', 'dark'] as const) {
    for (const [width, height] of [[1024, 700], [1024, 1400], [2000, 1200]] as const) {
      it(`${theme} ${width}: both cards fit; nothing cut or sideways`, async () => {
        const r = await rig.measure<M>(shell(), MEASURE, { name: 'settings', width, height, theme }, 'paid-usage');
        expect(r.cards).toBe(2);
        expect(r.cut).toEqual([]);
        expect(r.out).toEqual([]);
        expect(r.sideways).toBe(false);
        expect(r.scroll).toBeLessThanOrEqual(r.inner);
      }, 120_000);
    }
  }
});

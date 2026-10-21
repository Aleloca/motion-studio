/**
 * Task 22: Settings → Trascrizione video in the settings page, measured in real Chrome at 1024 × 700 and 2000 × 1200, light and
 * dark, with a model downloading and a detected Whisper with a long problem: the five methods on screen whole, nothing cut or
 * sideways, every button inside its card, the page without horizontal scroll.
 */
import type { TranscriptionStatus, WorkspaceSettingsView } from '@motion-studio/shared';
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { chromePath, chromeRequired, LayoutRig } from './support/layoutPage.ts';

const status: TranscriptionStatus = {
  settings: { method: 'whisper', model: 'large-v3-turbo', custom: { program: '/Users/designer/Applications/whisper.cpp/build/bin/whisper-cli', engine: 'whisper.cpp', modelFile: '/Users/designer/Models/ggml-large-v3-turbo-q5_0.bin' } },
  models: [
    { id: 'small', sizeBytes: 487_601_967, installed: true, bytesOnDisk: 487_601_967 },
    { id: 'large-v3-turbo', sizeBytes: 1_624_555_275, installed: false, bytesOnDisk: 0 },
  ],
  whisper: { engine: 'whisper.cpp', program: '/Users/designer/Applications/whisper.cpp/build/bin/whisper-cli', version: '1.7.6', model: '/Users/designer/Models/ggml-large-v3-turbo-q5_0.bin', gpu: true, source: 'settings' },
  detected: [
    { engine: 'whisper.cpp', program: '/opt/homebrew/bin/whisper-cli', version: '1.8.2', model: 'ggml-small.bin', gpu: true, source: 'detected', needsModel: true },
    { engine: 'faster-whisper', program: '/Users/designer/.local/pipx/venvs/whisper-ctranslate2/bin/whisper-ctranslate2', version: null, model: 'small', gpu: null, source: 'detected', downloadsOwnModel: true },
    { engine: 'openai-whisper', program: '/usr/local/bin/whisper', version: null, model: 'small', gpu: null, source: 'detected', problem: 'Traceback (most recent call last): ModuleNotFoundError: No module named \'torch\' — reinstall openai-whisper in its own environment' },
  ],
  detection: { state: 'done', at: '2026-10-21T10:00:00.000Z' },
  bundled: false,
  download: { state: 'running', model: 'large-v3-turbo', bytes: 406_138_818, total: 1_624_555_275 },
  providers: { openai: true, elevenlabs: true },
  prices: { openai: 0.006, elevenlabs: 0.0037 },
};
const api = {
  getTranscription: vi.fn(async () => status),
  getSecrets: vi.fn(async () => []),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { AppSettings } = await import('../src/screens/AppSettings.tsx');

async function markup(): Promise<string> {
  const settings = { theme: 'system' } as unknown as WorkspaceSettingsView;
  const { container, unmount } = render(<I18nProvider locale="it"><div id="page">
    <AppSettings section="transcription" settings={settings} checks={[]} checking={false} checksRun={1} loadError={null} onRecheck={() => {}}
      language="system" systemLocale="it" onLanguage={() => {}} onSettings={() => {}} />
  </div></I18nProvider>);
  await screen.findByText(/Whisper trovato/);
  const html = container.querySelector('#page')!.innerHTML;
  unmount();
  return html;
}

const MEASURE = `(() => {
  const main = document.querySelector('.ms-set-main');
  const cards = [...main.querySelectorAll('.ms-set-card')];
  const out = cards.flatMap((c) => outside(c, 'button, .ms-input, .ms-progress', c.getBoundingClientRect()));
  const methods = [...document.querySelectorAll('.ms-tset-methods [role=radio]')];
  return { cut: cutIn(main, 'button, .ms-pill, b'), out, methods: methods.length, methodsShown: methods.every((m) => m.getBoundingClientRect().width > 20 && m.scrollWidth <= m.clientWidth + 1),
    sideways: main.scrollWidth > main.clientWidth + 1, scroll: document.documentElement.scrollWidth, inner: innerWidth, maxTransition: maxTransition() };
})()`;
type M = { cut: string[]; out: string[]; methods: number; methodsShown: boolean; sideways: boolean; scroll: number; inner: number; maxTransition: number };

const run = chromePath ? describe : describe.skip;
if (!chromePath && chromeRequired) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('Settings → Trascrizione video: real Chrome layout (Task 22)', () => {
  const rig = new LayoutRig();
  let html = '';
  beforeAll(async () => { await rig.start(); html = await markup(); }, 120_000);
  afterAll(() => rig.stop(), 60_000);
  const shell = () => `<div class="ms-app ms-bare"><div class="ms-main" id="main"><div class="ms-stage"><div class="ms-page">${html}</div></div></div></div>`;

  for (const theme of ['light', 'dark'] as const) {
    for (const [width, height] of [[1024, 700], [2000, 1200]] as const) {
      it(`${theme} ${width}: the section fits; the five methods whole; nothing cut or sideways`, async () => {
        const r = await rig.measure<M>(shell(), MEASURE, { name: 'settings', width, height, theme }, 'va-transcription-settings');
        expect(r.methods).toBe(5);
        expect(r.methodsShown).toBe(true);
        expect(r.cut).toEqual([]);
        expect(r.out).toEqual([]);
        expect(r.sideways).toBe(false);
        expect(r.scroll).toBeLessThanOrEqual(r.inner);
      }, 120_000);
    }
  }
  it('reduced motion makes every transition instant', async () => {
    const r = await rig.measure<M>(shell(), MEASURE, { name: 'settings', width: 1024, height: 700, theme: 'light', reduce: true }, 'va-transcription-settings');
    expect(r.maxTransition).toBeLessThanOrEqual(0.001);
  }, 120_000);
});

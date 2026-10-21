/**
 * Task 20: the transcription dialog, the long-video dialog and the brief chat's card, measured in real Chrome at 1024 × 700 and
 * 2000 × 1200, light and dark: the dialogs fit the window without scrolling, nothing cut or sideways; the card fits the brief
 * panel (360 px at 1024, 448 px wide). Reduced motion makes every transition instant; reduced transparency keeps the dialog opaque.
 */
import { EMPTY_BRIEF_FORM, type BriefSessionView, type ConversationEntry, type TranscriptionPending, type VideoAnalysisView } from '@motion-studio/shared';
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initialEventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { chromePath, chromeRequired, LayoutRig } from './support/layoutPage.ts';

const at = '2026-10-21T10:00:00.000Z';
const FILE = 'assets/Intervista al fondatore - versione lunga definitiva #2.mp4';
const q: TranscriptionPending = {
  kind: 'transcription', audioSec: 754, openai: { costUsd: 0.078 }, elevenlabs: { costUsd: 0.047 },
  whisper: { available: true, installed: false, model: 'large-v3-turbo', sizeBytes: 1_624_555_275, canInstall: true, engine: 'whisper.cpp', downloadsOwnModel: false },
  error: 'Il file scaricato non è quello atteso (controllo sha256 non riuscito): è stato eliminato.',
};
const view = (pending: VideoAnalysisView['pending']): VideoAnalysisView => ({ file: FILE, state: 'waiting', jobId: 'j', error: null, pending, header: null, body: null });
const api = {
  getBriefSession: vi.fn(async (): Promise<BriefSessionView | null> => ({ id: 's1', createdAt: at, updatedAt: at, context: { codebases: [], assets: [FILE] }, form: EMPTY_BRIEF_FORM, userEdited: [], agentFields: [], queued: [], jobId: null, revision: 1 })),
  getBriefConversation: vi.fn(async (): Promise<ConversationEntry[]> => [{ type: 'user', at, text: 'Usa il video del fondatore per un reel di 15 secondi.', pins: [], attachments: [] } as ConversationEntry]),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: at })),
  projectFileUrl: () => 'data:,',
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { TranscriptionDialog } = await import('../src/components/TranscriptionDialog.tsx');
const { LongVideoDialog } = await import('../src/components/LongVideoDialog.tsx');
const { BriefSessionPanel } = await import('../src/screens/new-creative/BriefSessionPanel.tsx');
const { useBriefSession } = await import('../src/screens/new-creative/useBriefSession.ts');

function dialog(kind: 'transcription' | 'long'): string {
  const long = { kind: 'long' as const, frames: 182, reducedFrames: 61, tokens: 145_600, reducedTokens: 48_800 };
  const { unmount } = render(<I18nProvider locale="it">{kind === 'long'
    ? <LongVideoDialog slug="acme" view={view(long)} question={long} open onClose={() => {}} />
    : <TranscriptionDialog slug="acme" view={view(q)} question={q} open onClose={() => {}} />}</I18nProvider>);
  const html = document.querySelector('.ms-modal')!.outerHTML;
  unmount();
  return html;
}
function Panel() {
  const brief = useBriefSession('acme', initialEventsState);
  return (
    <BriefSessionPanel slug="acme" projectName="Acme" brief={brief} live={initialEventsState} snapshot={() => ({ form: EMPTY_BRIEF_FORM, userEdited: [], baseRevision: 1 })}
      library={{ value: [], error: null }} onRetryLibrary={() => {}} onLibraryChanged={() => {}} className="ms-nc-panel" analysisQuestions={[view(q)]} />
  );
}
async function card(): Promise<string> {
  const { container, unmount } = render(<I18nProvider locale="it"><div className="ms-nc ms-nc-agent"><Panel /></div></I18nProvider>);
  await screen.findByText('Usa il video del fondatore per un reel di 15 secondi.');
  const html = container.innerHTML;
  unmount();
  return html;
}

const DIALOG = `(() => {
  const dlg = document.querySelector('.ms-dialog');
  const d = dlg.getBoundingClientRect();
  return { left: d.left, right: d.right, top: d.top, bottom: d.bottom, innerH: innerHeight, inner: innerWidth,
    scrolls: dlg.scrollHeight > dlg.clientHeight + 1, sideways: dlg.scrollWidth > dlg.clientWidth + 1,
    cut: cutIn(dlg, 'button, h2, p, label'), out: outside(dlg, 'button, h2, p', d), bg: getComputedStyle(dlg).backgroundColor, maxTransition: maxTransition() };
})()`;
type D = { left: number; right: number; top: number; bottom: number; innerH: number; inner: number; scrolls: boolean; sideways: boolean; cut: string[]; out: string[]; bg: string; maxTransition: number };
const CARD = `(() => {
  const panel = document.querySelector('.ms-brief-panel').getBoundingClientRect();
  const c = document.querySelector('.ms-tcard');
  const r = c.getBoundingClientRect();
  const list = document.querySelector('.ms-convo-list');
  return { panelW: Math.round(panel.width), inside: r.left >= panel.left - 0.5 && r.right <= panel.right + 0.5, cut: cutIn(c, 'button, h2, p, label'),
    out: outside(c, 'button', r), sideways: list.scrollWidth > list.clientWidth + 1, scroll: document.documentElement.scrollWidth, inner: innerWidth };
})()`;
type C = { panelW: number; inside: boolean; cut: string[]; out: string[]; sideways: boolean; scroll: number; inner: number };

const run = chromePath ? describe : describe.skip;
if (!chromePath && chromeRequired) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('the analysis questions: real Chrome layout (Task 20)', () => {
  const rig = new LayoutRig();
  const html = { transcription: '', long: '', card: '' };
  beforeAll(async () => { await rig.start(); html.transcription = dialog('transcription'); html.long = dialog('long'); html.card = await card(); }, 120_000);
  afterAll(() => rig.stop(), 60_000);
  const dialogOk = (r: D) => {
    expect(r.left).toBeGreaterThanOrEqual(16);
    expect(r.right).toBeLessThanOrEqual(r.inner - 16);
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.bottom).toBeLessThanOrEqual(r.innerH);
    expect(r.scrolls, 'the dialog fits without scrolling').toBe(false);
    expect(r.sideways).toBe(false);
    expect(r.cut).toEqual([]);
    expect(r.out).toEqual([]);
  };

  for (const theme of ['light', 'dark'] as const) {
    for (const [width, height] of [[1024, 700], [2000, 1200]] as const) {
      it(`${theme} ${width}: the transcription dialog with every choice and an error`, async () => {
        dialogOk(await rig.measure<D>(html.transcription, DIALOG, { name: 'tdialog', width, height, theme }, 'va-transcription-dialog'));
      }, 120_000);
      it(`${theme} ${width}: the long-video dialog`, async () => {
        dialogOk(await rig.measure<D>(html.long, DIALOG, { name: 'long', width, height, theme }, 'va-long-video-dialog'));
      }, 120_000);
      it(`${theme} ${width}: the card in the brief agent's chat`, async () => {
        const r = await rig.measure<C>(`<div class="ms-app ms-bare"><div class="ms-main"><div class="ms-stage" style="position:relative;height:100vh">${html.card}</div></div></div>`, CARD, { name: 'card', width, height, theme }, 'va-transcription-card');
        expect(r.panelW).toBe(width >= 1440 ? 448 : 360);
        expect(r.inside).toBe(true);
        expect(r.cut).toEqual([]);
        expect(r.out).toEqual([]);
        expect(r.sideways).toBe(false);
        expect(r.scroll).toBeLessThanOrEqual(r.inner);
      }, 120_000);
    }
  }

  it('reduced motion makes every transition instant; reduced transparency keeps the dialog opaque', async () => {
    const r = await rig.measure<D>(html.transcription, DIALOG, { name: 'tdialog', width: 1024, height: 700, theme: 'light', reduce: true }, 'va-transcription-dialog');
    expect(r.maxTransition).toBeLessThanOrEqual(0.001);
    const o = await rig.measure<D>(html.transcription, DIALOG, { name: 'tdialog', width: 1024, height: 700, theme: 'dark', opaque: true }, 'va-transcription-dialog');
    dialogOk(o);
    expect(o.bg.startsWith('rgb(') || /rgba\(.*, 1\)$/.test(o.bg)).toBe(true);
  }, 120_000);
});

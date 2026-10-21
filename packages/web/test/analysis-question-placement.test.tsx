import { DEFAULT_FORMATS, EMPTY_BRAND_KIT, type AssetEntry, type TranscriptionPending, type VideoAnalysisView } from '@motion-studio/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventsReducer, initialEventsState, type EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { ShellContext, type Shell } from '../src/shell/ShellContext.tsx';
import { requestAssetFocus, requestNewCreativeWithAssets } from '../src/shell/intents.ts';

const at = '2026-10-21T10:00:00.000Z';
const video = (file: string): AssetEntry => ({ file, kind: 'video', origin: 'upload', sourceUrl: null, description: '', tags: [], width: 640, height: 360, addedAt: at, attribution: null, durationSec: 30 });
const q: TranscriptionPending = {
  kind: 'transcription', audioSec: 30, openai: null, elevenlabs: null,
  whisper: { available: true, installed: false, model: 'small', sizeBytes: 487_601_967, canInstall: true, engine: 'whisper.cpp', downloadsOwnModel: false },
};
const view = (file: string, over: Partial<VideoAnalysisView> = {}): VideoAnalysisView => ({ file, state: 'waiting', jobId: null, error: null, pending: q, header: null, body: null, ...over });
const api = {
  getBriefSession: vi.fn(async () => null),
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  listAssets: vi.fn(async () => ({ assets: [video('a.mp4'), video('b.mp4')], error: null, unregistered: [] })),
  getBrand: vi.fn(async () => ({ kit: EMPTY_BRAND_KIT, kitError: null, guidelines: '', sources: [], sourcesError: null, proposals: [], jobKey: 'k' })),
  getProject: vi.fn(async () => ({ slug: 'acme', jobKey: 'k', project: { name: 'Acme' } })),
  projectFileUrl: () => 'data:,',
  getFirstGenerations: vi.fn(async () => ({ tokens: [] })),
  getSecrets: vi.fn(async () => []),
  listVideoAnalyses: vi.fn(async (): Promise<VideoAnalysisView[]> => [view('assets/a.mp4'), view('assets/b.mp4')]),
  transcriptionChoice: vi.fn(async (_s: string, b: { file: string }) => view(b.file)),
  getTranscription: vi.fn(async () => ({ download: { state: 'running', model: 'small', bytes: 0, total: 487_601_967 } })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { NewCreative } = await import('../src/screens/NewCreative.tsx');
const { Assets } = await import('../src/screens/Assets.tsx');
afterEach(() => vi.clearAllMocks());

const page = (live: EventsState) => {
  const shell = { live, catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} } } as unknown as Shell;
  return <I18nProvider locale="it"><ShellContext.Provider value={shell}><NewCreative slug="acme" live={live} /></ShellContext.Provider></I18nProvider>;
};
const msg = (l: EventsState, v: VideoAnalysisView) => eventsReducer(l, { type: 'video-analysis', project: 'acme', file: v.file, view: v });

describe('New creative asks about each video of its brief in turn (review of phase 3)', () => {
  it('after Installa on the first video, the second video\'s dialog shows its own choices', async () => {
    requestNewCreativeWithAssets('acme', ['assets/a.mp4', 'assets/b.mp4']);
    let live = initialEventsState;
    const { rerender } = render(page(live));
    const first = await screen.findByRole('dialog', { name: 'Trascrivere il parlato di a.mp4?' });
    await userEvent.click(within(first).getByRole('button', { name: /Installa Whisper/ }));
    expect(api.transcriptionChoice).toHaveBeenCalledWith('acme', { file: 'assets/a.mp4', choice: 'whisper', remember: false, sizeBytes: 487_601_967 });
    await waitFor(() => expect(within(first).getByRole('progressbar')).toBeTruthy());
    // The download ended: a.mp4 asks no more, the analysis goes on.
    live = msg(live, view('assets/a.mp4', { state: 'queued', pending: null }));
    act(() => rerender(page(live)));
    const second = await screen.findByRole('dialog', { name: 'Trascrivere il parlato di b.mp4?' });
    expect(within(second).queryByRole('progressbar')).toBeNull();
    expect(within(second).getByRole('button', { name: /Installa Whisper/ })).toBeTruthy();
  });

  it('a question answered elsewhere closes its dialog', async () => {
    api.listVideoAnalyses.mockResolvedValueOnce([view('assets/a.mp4')]);
    requestNewCreativeWithAssets('acme', ['assets/a.mp4']);
    let live = initialEventsState;
    const { rerender } = render(page(live));
    await screen.findByRole('dialog', { name: 'Trascrivere il parlato di a.mp4?' });
    live = msg(live, view('assets/a.mp4', { state: 'running', pending: null }));
    act(() => rerender(page(live)));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Trascrivere il parlato di a.mp4?' })).toBeNull());
  });
});

describe('the activity centre\'s focus waits for the analyses (review of phase 3)', () => {
  it('two videos with the same name: the one whose analysis has the job is selected once the list arrives', async () => {
    api.listAssets.mockResolvedValue({ assets: [video('one/clip.mp4'), video('two/clip.mp4')], error: null, unregistered: [] });
    let resolve!: (v: VideoAnalysisView[]) => void;
    api.listVideoAnalyses.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    render(<I18nProvider locale="it"><Assets slug="acme" live={initialEventsState} /></I18nProvider>);
    await screen.findAllByRole('button', { name: /^Apri clip\.mp4/ });
    // The row is clicked while the page is open and the analyses have not answered yet.
    act(() => requestAssetFocus('acme', { jobId: 'job-2', name: 'clip.mp4' }));
    // The analyses may be asked for after the list shows (slower CI): answer once they have been.
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    await act(async () => resolve([view('assets/one/clip.mp4', { state: 'ready', pending: null }), view('assets/two/clip.mp4', { state: 'running', pending: null, jobId: 'job-2' })]));
    await waitFor(() => expect(document.querySelector('[data-file="two/clip.mp4"] .ms-acard-open')?.getAttribute('aria-expanded')).toBe('true'));
    api.listAssets.mockReset();
  });
});

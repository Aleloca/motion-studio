/**
 * Report 65: a held analysis's question opens its dialog by itself, on any screen, once per question: one at a time (queued),
 * never while the user types in a text field or another dialog is open, never again after Chiudi, closed when answered elsewhere.
 */
import type { JobSummary, TranscriptionPending, VideoAnalysisView } from '@motion-studio/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventsReducer, initialEventsState, type EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

const at = '2026-10-21T10:00:00.000Z';
const q: TranscriptionPending = {
  kind: 'transcription', audioSec: 30, openai: null, elevenlabs: null,
  whisper: { available: true, installed: false, model: 'small', sizeBytes: 487_601_967, canInstall: true, engine: 'whisper.cpp', downloadsOwnModel: false },
};
const long = { kind: 'long' as const, frames: 150, reducedFrames: 50, tokens: 120_000, reducedTokens: 40_000 };
const view = (file: string, jobId: string, pending: VideoAnalysisView['pending'] = q): VideoAnalysisView =>
  ({ file, state: pending ? 'waiting' : 'running', jobId, error: null, pending, header: null, body: null });
const job = (id: string, project: string, waitReason: JobSummary['waitReason'] | undefined): JobSummary =>
  ({ id, key: `video-analysis:/root:${project}:${id.padEnd(64, '0')}`, kind: 'video-analysis', label: 'Analisi video', state: waitReason ? 'queued' : 'running', createdAt: at, ...(waitReason ? { waitReason } : {}) });
/** What the core's listing answers: the views broadcast so far (a listing never hides a newer live view's question). */
let server: Record<string, Record<string, VideoAnalysisView>> = {};
const api = {
  listVideoAnalyses: vi.fn(async (slug: string): Promise<VideoAnalysisView[]> => Object.values(server[slug] ?? {})),
  transcriptionChoice: vi.fn(async (_s: string, b: { file: string }) => view(b.file, 'x', null)),
  confirmLongVideo: vi.fn(async (_s: string, file: string) => view(file, 'x', null)),
  getTranscription: vi.fn(async () => ({ download: { state: 'idle', model: null, bytes: 0, total: 0 } })),
  recheckTranscription: vi.fn(),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { AnalysisQuestionHost, useAnalysisQuestions } = await import('../src/components/AnalysisQuestionHost.tsx');
const { Modal } = await import('../src/ui/index.ts');
afterEach(() => { vi.clearAllMocks(); server = {}; });

/** The live state with the held jobs and their views (as the core broadcasts them). */
function liveWith(items: Array<{ project: string; v: VideoAnalysisView; hold?: JobSummary['waitReason'] }>, base: EventsState = initialEventsState): EventsState {
  let l = base;
  for (const { project, v, hold } of items) {
    l = eventsReducer(l, { type: 'job', job: job(v.jobId!, project, v.pending ? hold ?? (v.pending.kind === 'long' ? 'video-long' : 'transcription-choice') : undefined) } as never);
    l = eventsReducer(l, { type: 'video-analysis', project, file: v.file, view: v });
    server = { ...server, [project]: { ...server[project], [v.file]: v } };
  }
  return l;
}
const host = (live: EventsState, extra?: React.ReactNode) => <I18nProvider locale="it"><AnalysisQuestionHost live={live}><input aria-label="Nome" />{extra}</AnalysisQuestionHost></I18nProvider>;

describe('the held questions open by themselves (report 65)', () => {
  it('a transcription question opens its dialog on any screen; answering closes it and the next question (a long video, another project) opens', async () => {
    let live = liveWith([{ project: 'acme', v: view('assets/a.mp4', 'j1') }, { project: 'beta', v: view('assets/b.mp4', 'j2', long) }]);
    const { rerender } = render(host(live));
    const first = await screen.findByRole('dialog', { name: 'Trascrivere il parlato di a.mp4?' });
    // Never two at once.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await userEvent.click(within(first).getByRole('button', { name: 'Continua senza trascrizione' }));
    expect(api.transcriptionChoice).toHaveBeenCalledWith('acme', { file: 'assets/a.mp4', choice: 'none', remember: false });
    live = liveWith([{ project: 'acme', v: view('assets/a.mp4', 'j1', null) }], live);
    act(() => rerender(host(live)));
    expect(await screen.findByRole('dialog', { name: 'Video lungo: b.mp4' })).toBeTruthy();
  });

  it('closed with Chiudi: not reopened (the next one opens instead); answered elsewhere: its dialog closes', async () => {
    let live = liveWith([{ project: 'acme', v: view('assets/a.mp4', 'j1') }, { project: 'acme', v: view('assets/c.mp4', 'j3') }]);
    const { rerender } = render(host(live));
    const first = await screen.findByRole('dialog', { name: 'Trascrivere il parlato di a.mp4?' });
    await userEvent.click(within(first).getByRole('button', { name: 'Chiudi' }));
    const next = await screen.findByRole('dialog', { name: 'Trascrivere il parlato di c.mp4?' });
    expect(next).toBeTruthy();
    // c.mp4 answered in another window: its dialog closes; a.mp4 (closed) does not come back.
    live = liveWith([{ project: 'acme', v: view('assets/c.mp4', 'j3', null) }], live);
    act(() => rerender(host(live)));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await new Promise((r) => setTimeout(r, 700));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('waits while the user types in a text field', async () => {
    const live = liveWith([{ project: 'acme', v: view('assets/a.mp4', 'j1') }]);
    const { rerender } = render(host(initialEventsState));
    const field = screen.getByRole('textbox', { name: 'Nome' });
    field.focus();
    fireEvent.keyDown(field, { key: 'a' });
    act(() => rerender(host(live)));
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('dialog')).toBeNull();
    // The user leaves the field: the dialog opens.
    act(() => field.blur());
    expect(await screen.findByRole('dialog', { name: 'Trascrivere il parlato di a.mp4?' }, { timeout: 3000 })).toBeTruthy();
  });

  it('another dialog open: it waits until that one closes', async () => {
    const live = liveWith([{ project: 'acme', v: view('assets/a.mp4', 'j1') }]);
    const other = (open: boolean) => <Modal open={open} onClose={() => {}} label="Altro">x</Modal>;
    const { rerender } = render(host(live, other(true)));
    await new Promise((r) => setTimeout(r, 700));
    expect(screen.getAllByRole('dialog').map((d) => d.getAttribute('aria-label'))).toEqual(['Altro']);
    act(() => rerender(host(live, other(false))));
    expect(await screen.findByRole('dialog', { name: 'Trascrivere il parlato di a.mp4?' }, { timeout: 3000 })).toBeTruthy();
  });

  it('a question a screen shows itself (the brief chat\'s card) is not opened as a dialog', async () => {
    function Claim() { const qs = useAnalysisQuestions(); useEffect_(() => qs.claim('acme', ['assets/a.mp4']), [qs]); return null; }
    const live = liveWith([{ project: 'acme', v: view('assets/a.mp4', 'j1') }]);
    render(host(live, <Claim />));
    await new Promise((r) => setTimeout(r, 700));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a listing fetched for a held job whose view never came live (a reload) opens its question too', async () => {
    server = { acme: { 'assets/a.mp4': view('assets/a.mp4', 'j1') } };
    const live = eventsReducer(initialEventsState, { type: 'job', job: job('j1', 'acme', 'transcription-choice') } as never);
    render(host(live));
    expect(await screen.findByRole('dialog', { name: 'Trascrivere il parlato di a.mp4?' })).toBeTruthy();
    expect(api.listVideoAnalyses).toHaveBeenCalledWith('acme');
  });
});

const { useEffect: useEffect_ } = await import('react');

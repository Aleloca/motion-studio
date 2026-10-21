import { EMPTY_BRIEF_FORM, type AssetEntry, type BriefSessionView, type ConversationEntry, type TranscriptionPending, type TranscriptionStatus, type VideoAnalysisView } from '@motion-studio/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialEventsState, type EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

const at = '2026-10-21T10:00:00.000Z';
export const ask = (over: Partial<TranscriptionPending> = {}): TranscriptionPending => ({
  kind: 'transcription', audioSec: 125, openai: null, elevenlabs: null,
  whisper: { available: false, installed: false, model: 'small', sizeBytes: 487_601_967, canInstall: false }, ...over,
});
const waiting = (pending: VideoAnalysisView['pending'], file = 'assets/demo.mp4'): VideoAnalysisView =>
  ({ file, state: 'waiting', jobId: 'j1', error: null, pending, header: null, body: null });
const status = (download: Partial<TranscriptionStatus['download']>): TranscriptionStatus => ({
  settings: { method: 'ask', model: 'small', custom: null }, models: [], whisper: null, detected: [], bundled: true, providers: { openai: false, elevenlabs: false },
  prices: { openai: 0.006, elevenlabs: 0.0037 }, download: { state: 'running', model: 'small', bytes: 0, total: 487_601_967, ...download },
});
const api = {
  transcriptionChoice: vi.fn(async (_s: string, b: { file: string; choice: string }): Promise<VideoAnalysisView> => ({ ...waiting(null, b.file), state: 'queued' })),
  confirmLongVideo: vi.fn(async (_s: string, file: string) => ({ ...waiting(null, file), state: 'queued' })),
  getTranscription: vi.fn(async () => status({ bytes: 243_800_983 })),
  // The brief panel and New creative.
  getBriefSession: vi.fn(async (): Promise<BriefSessionView | null> => ({ id: 's1', createdAt: at, updatedAt: at, context: { codebases: [], assets: ['assets/demo.mp4'] }, form: EMPTY_BRIEF_FORM, userEdited: [], agentFields: [], queued: [], jobId: null, revision: 1 })),
  getBriefConversation: vi.fn(async (): Promise<ConversationEntry[]> => []),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: at })),
  listVideoAnalyses: vi.fn(async (): Promise<VideoAnalysisView[]> => [waiting(ask({ openai: { costUsd: 0.018 } }))]),
  projectFileUrl: () => 'data:,',
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { TranscriptionChoices } = await import('../src/components/TranscriptionChoices.tsx');
const { TranscriptionDialog } = await import('../src/components/TranscriptionDialog.tsx');
const { LongVideoDialog } = await import('../src/components/LongVideoDialog.tsx');
const { BriefSessionPanel } = await import('../src/screens/new-creative/BriefSessionPanel.tsx');
const { useBriefSession } = await import('../src/screens/new-creative/useBriefSession.ts');
const { useVideoAnalyses } = await import('../src/useVideoAnalyses.ts');
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

const it_ = (node: React.ReactNode) => render(<I18nProvider locale="it">{node}</I18nProvider>);

describe('the transcription choices (Task 20, spec §6)', () => {
  it('no keys and no Whisper to install: only "Continua senza trascrizione", what transcription is for, and how to get a Whisper', () => {
    const q = ask();
    it_(<TranscriptionChoices slug="acme" view={waiting(q)} question={q} />);
    const list = screen.getByRole('group', { name: 'Come trascrivere il parlato' });
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(['Continua senza trascrizione']);
    expect(screen.getByText(/l'agente sa cosa viene detto e quando/)).toBeTruthy();
    expect(screen.getByText(/brew install whisper-cpp/)).toBeTruthy();
  });

  it('an OpenAI key: its line with the cost and the audio leaving the Mac; a click posts the choice without remember', async () => {
    const q = ask({ openai: { costUsd: 0.018 } });
    const onDone = vi.fn();
    it_(<TranscriptionChoices slug="acme" view={waiting(q)} question={q} onDone={onDone} />);
    const line = screen.getByRole('button', { name: /Trascrivi con OpenAI · ~/ });
    expect(line.textContent).toMatch(/0,018\s\$/);
    expect(line.textContent).toContain('L\'audio lascia il Mac.');
    await userEvent.click(line);
    expect(api.transcriptionChoice).toHaveBeenCalledWith('acme', { file: 'assets/demo.mp4', choice: 'openai', remember: false });
    expect(onDone).toHaveBeenCalled();
  });

  it('Installa Whisper posts the size shown, then shows the download until the analysis goes on; "Ricorda la scelta" is sent', async () => {
    const q = ask({ whisper: { available: true, installed: false, model: 'small', sizeBytes: 487_601_967, canInstall: true } });
    api.transcriptionChoice.mockImplementationOnce(async (_s, b) => waiting(q, b.file));
    const onDone = vi.fn();
    const { rerender } = it_(<TranscriptionChoices slug="acme" view={waiting(q)} question={q} onDone={onDone} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Ricorda la scelta' }));
    await userEvent.click(screen.getByRole('button', { name: /Installa Whisper \(gratis, sul tuo Mac\) · 488 MB/ }));
    expect(api.transcriptionChoice).toHaveBeenCalledWith('acme', { file: 'assets/demo.mp4', choice: 'whisper', remember: true, sizeBytes: 487_601_967 });
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50'));
    expect(onDone).not.toHaveBeenCalled();
    rerender(<I18nProvider locale="it"><TranscriptionChoices slug="acme" view={{ ...waiting(null), state: 'running' }} question={q} onDone={onDone} /></I18nProvider>);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('a failed download shows the core\'s reason above the choices again', async () => {
    const q = ask({ whisper: { available: true, installed: false, model: 'small', sizeBytes: 487_601_967, canInstall: true }, error: 'sha256 non riuscito' });
    it_(<TranscriptionChoices slug="acme" view={waiting(q)} question={q} />);
    expect(screen.getByRole('alert').textContent).toContain('sha256 non riuscito');
    expect(screen.getByRole('button', { name: /Installa Whisper/ })).toBeTruthy();
  });

  it('the dialog is a modal with the question', () => {
    const q = ask();
    it_(<TranscriptionDialog slug="acme" view={waiting(q)} question={q} open onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Trascrivere il parlato di demo.mp4?' })).toBeTruthy();
  });

  it('the long video: both densities with frames and tokens; Analizza a densità ridotta posts reduced', async () => {
    const onClose = vi.fn();
    const q = { kind: 'long' as const, frames: 150, reducedFrames: 50, tokens: 120_000, reducedTokens: 40_000 };
    it_(<LongVideoDialog slug="acme" view={waiting(q, 'assets/lungo.mp4')} question={q} open onClose={onClose} />);
    const d = screen.getByRole('dialog', { name: 'Video lungo: lungo.mp4' });
    expect(within(d).getByRole('button', { name: /Analizza tutto/ }).textContent).toContain('150 fotogrammi · circa 120.000 token');
    await userEvent.click(within(d).getByRole('button', { name: /Analizza a densità ridotta/ }));
    expect(api.confirmLongVideo).toHaveBeenCalledWith('acme', 'assets/lungo.mp4', 'reduced');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('the brief agent asks in its chat (spec 1479)', () => {
  function Harness({ l }: { l: EventsState }) {
    const brief = useBriefSession('acme', l);
    const analyses = useVideoAnalyses('acme', l);
    return (
      <BriefSessionPanel slug="acme" projectName="Acme" brief={brief} live={l} snapshot={() => ({ form: EMPTY_BRIEF_FORM, userEdited: [], baseRevision: 1 })}
        library={{ value: [] as AssetEntry[], error: null }} onRetryLibrary={() => {}} onLibraryChanged={() => {}}
        analysisQuestions={analyses.pending.filter((v) => brief.session?.context.assets.includes(v.file))} />
    );
  }

  it('a card in the conversation, not a modal', async () => {
    it_(<Harness l={initialEventsState} />);
    const card = await screen.findByRole('group', { name: 'Trascrivere il parlato di demo.mp4?' });
    expect(card.closest('.ms-convo-card')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => { await userEvent.click(within(card).getByRole('button', { name: 'Continua senza trascrizione' })); });
    expect(api.transcriptionChoice).toHaveBeenCalledWith('acme', { file: 'assets/demo.mp4', choice: 'none', remember: false });
  });
});

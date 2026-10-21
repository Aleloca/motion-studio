import { EMPTY_BRIEF_FORM, type AssetEntry, type BriefSessionView, type ConversationEntry, type TranscriptionPending, type TranscriptionStatus, type VideoAnalysisView } from '@motion-studio/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialEventsState, type EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

const at = '2026-10-21T10:00:00.000Z';
export const ask = (over: Partial<TranscriptionPending> = {}): TranscriptionPending => ({
  kind: 'transcription', audioSec: 125, openai: null, elevenlabs: null,
  whisper: { available: false, installed: false, model: 'small', sizeBytes: 487_601_967, canInstall: false, engine: null, downloadsOwnModel: false }, ...over,
});
const waiting = (pending: VideoAnalysisView['pending'], file = 'assets/demo.mp4'): VideoAnalysisView =>
  ({ file, state: 'waiting', jobId: 'j1', error: null, pending, header: null, body: null });
const status = (download: Partial<TranscriptionStatus['download']>): TranscriptionStatus => ({
  settings: { method: 'ask', model: 'small', custom: null }, models: [], whisper: null, detected: [], bundled: true, detection: { state: 'done', at }, providers: { openai: false, elevenlabs: false },
  prices: { openai: 0.006, elevenlabs: 0.0037 }, download: { state: 'running', model: 'small', bytes: 0, total: 487_601_967, ...download },
});
const api = {
  transcriptionChoice: vi.fn(async (_s: string, b: { file: string; choice: string }): Promise<VideoAnalysisView> => ({ ...waiting(null, b.file), state: 'queued' })),
  recheckTranscription: vi.fn(async (_s: string, file: string): Promise<VideoAnalysisView> => waiting(ask(), file)),
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

const installable = (over: Partial<TranscriptionPending['whisper']> = {}): TranscriptionPending['whisper'] =>
  ({ available: true, installed: false, model: 'small', sizeBytes: 487_601_967, canInstall: true, engine: 'whisper.cpp', downloadsOwnModel: false, ...over });

describe('the transcription choices (Task 20, spec §6; report 64: Whisper first)', () => {
  it('Whisper installable and both keys: Whisper first and primary with "Consigliato" and its facts; the paid ones after, under "A pagamento"', () => {
    const q = ask({ whisper: installable(), openai: { costUsd: 0.018 }, elevenlabs: { costUsd: 0.011 } });
    it_(<TranscriptionChoices slug="acme" view={waiting(q)} question={q} />);
    const list = screen.getByRole('group', { name: 'Come trascrivere il parlato' });
    const buttons = within(list).getAllByRole('button');
    expect(buttons.map((b) => /^Trascrivi con (Whisper|OpenAI|ElevenLabs)/.exec(b.textContent!)?.[1])).toEqual(['Whisper', 'OpenAI', 'ElevenLabs']);
    expect(buttons[0]!.classList.contains('ms-tchoice-primary')).toBe(true);
    expect(buttons[0]!.textContent).toContain('Gratis · l\'audio resta sul Mac · modello Small, 488 MB una volta sola');
    expect(buttons[1]!.classList.contains('ms-tchoice-primary')).toBe(false);
    expect(within(list).getByText('A pagamento')).toBeTruthy();
    // "Continua senza trascrizione" is a quiet action outside the options.
    const skip = screen.getByRole('button', { name: 'Continua senza trascrizione' });
    expect(list.contains(skip)).toBe(false);
    expect(skip.classList.contains('ms-tchoices-skip')).toBe(true);
  });

  it('Whisper installed: no download size; no keys: no "A pagamento" heading', () => {
    const q = ask({ whisper: installable({ installed: true }) });
    it_(<TranscriptionChoices slug="acme" view={waiting(q)} question={q} />);
    const line = screen.getByRole('button', { name: /^Trascrivi con Whisper/ });
    expect(line.textContent).toMatch(/modello Small$/);
    expect(screen.queryByText('A pagamento')).toBeNull();
  });

  it('no Whisper to install: still first, with the commands to copy, the Settings link and Ricontrolla; nothing paid without keys', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const q = ask();
    const onDone = vi.fn();
    it_(<TranscriptionChoices slug="acme" view={waiting(q)} question={q} onDone={onDone} />);
    const list = screen.getByRole('group', { name: 'Come trascrivere il parlato' });
    expect(within(list).getByText('Trascrivi con Whisper')).toBeTruthy();
    expect(within(list).getByText('Consigliato')).toBeTruthy();
    expect(screen.queryByText('A pagamento')).toBeNull();
    expect(screen.queryByText(/`/)).toBeNull();
    expect(within(list).getByText('brew install whisper-cpp').tagName).toBe('CODE');
    expect(within(list).getByText('pip install openai-whisper').tagName).toBe('CODE');
    await userEvent.click(within(list).getByRole('button', { name: 'Copia brew install whisper-cpp' }));
    expect(writeText).toHaveBeenCalledWith('brew install whisper-cpp');
    expect(within(list).getByRole('link', { name: /Indicalo in Impostazioni/ }).getAttribute('href')).toBe('#/settings/transcription');
    // Ricontrolla: still nothing → says so; then whisper.cpp found → the install option appears.
    api.recheckTranscription.mockImplementationOnce(async () => waiting(q));
    const recheck = within(list).getByRole('button', { name: 'Ricontrolla' });
    // The focus order: the Whisper steps come before the quiet "Continua senza trascrizione".
    expect(recheck.compareDocumentPosition(screen.getByRole('button', { name: 'Continua senza trascrizione' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(recheck);
    expect(api.recheckTranscription).toHaveBeenCalledWith('acme', 'assets/demo.mp4');
    expect(await screen.findByText('Ancora nessun Whisper trovato su questo Mac.')).toBeTruthy();
    api.recheckTranscription.mockImplementationOnce(async () => waiting(ask({ whisper: installable() })));
    await userEvent.click(within(list).getByRole('button', { name: 'Ricontrolla' }));
    const install = await screen.findByRole('button', { name: /^Trascrivi con Whisper.*488 MB una volta sola/ });
    expect(screen.queryByRole('button', { name: 'Ricontrolla' })).toBeNull();
    await userEvent.click(install);
    expect(api.transcriptionChoice).toHaveBeenCalledWith('acme', { file: 'assets/demo.mp4', choice: 'whisper', remember: false, sizeBytes: 487_601_967 });
  });

  it('the copy status clears when the label reverts, so a second copy is announced again (decision 1605)', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true });
    const q = ask();
    it_(<TranscriptionChoices slug="acme" view={waiting(q)} question={q} />);
    const copy = screen.getByRole('button', { name: 'Copia brew install whisper-cpp' });
    await userEvent.click(copy);
    expect(screen.getByText('Comando copiato.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Comando copiato.')).toBeNull(), { timeout: 3000 });
    expect(copy.textContent).toBe('Copia');
    await userEvent.click(copy);
    expect(screen.getByText('Comando copiato.')).toBeTruthy();
  });

  it('an OpenAI key: its line with the cost and the audio leaving the Mac; a click posts the choice without remember', async () => {
    const q = ask({ openai: { costUsd: 0.018 } });
    const onDone = vi.fn();
    it_(<TranscriptionChoices slug="acme" view={waiting(q)} question={q} onDone={onDone} />);
    expect(screen.getByText('A pagamento')).toBeTruthy();
    const line = screen.getByRole('button', { name: /Trascrivi con OpenAI · ~/ });
    expect(line.textContent).toMatch(/0,018\s\$/);
    expect(line.textContent).toContain('L\'audio lascia il Mac.');
    await userEvent.click(line);
    expect(api.transcriptionChoice).toHaveBeenCalledWith('acme', { file: 'assets/demo.mp4', choice: 'openai', remember: false });
    expect(onDone).toHaveBeenCalled();
  });

  it('Trascrivi con Whisper posts the size shown, then shows the download until the analysis goes on; "Ricorda la scelta" is sent', async () => {
    const q = ask({ whisper: installable() });
    api.transcriptionChoice.mockImplementationOnce(async (_s, b) => waiting(q, b.file));
    const onDone = vi.fn();
    const { rerender } = it_(<TranscriptionChoices slug="acme" view={waiting(q)} question={q} onDone={onDone} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Ricorda la scelta' }));
    await userEvent.click(screen.getByRole('button', { name: /Trascrivi con Whisper.*488 MB/ }));
    expect(api.transcriptionChoice).toHaveBeenCalledWith('acme', { file: 'assets/demo.mp4', choice: 'whisper', remember: true, sizeBytes: 487_601_967 });
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50'));
    expect(screen.queryByRole('button', { name: 'Continua senza trascrizione' })).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    rerender(<I18nProvider locale="it"><TranscriptionChoices slug="acme" view={{ ...waiting(null), state: 'running' }} question={q} onDone={onDone} /></I18nProvider>);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('a Python engine that downloads its own model: Whisper with the note, chosen without a download size', async () => {
    const q = ask({ whisper: installable({ canInstall: false, engine: 'openai-whisper', downloadsOwnModel: true }) });
    it_(<TranscriptionChoices slug="acme" view={waiting(q)} question={q} />);
    const line = screen.getByRole('button', { name: /^Trascrivi con Whisper/ });
    expect(line.textContent).toContain('scarica il suo modello al primo uso');
    await userEvent.click(line);
    expect(api.transcriptionChoice).toHaveBeenCalledWith('acme', { file: 'assets/demo.mp4', choice: 'whisper', remember: false });
  });

  it('a failed download shows the core\'s reason above the choices again', async () => {
    const q = ask({ whisper: installable(), error: 'sha256 non riuscito' });
    it_(<TranscriptionChoices slug="acme" view={waiting(q)} question={q} />);
    expect(screen.getByRole('alert').textContent).toContain('sha256 non riuscito');
    expect(screen.getByRole('button', { name: /Trascrivi con Whisper/ })).toBeTruthy();
  });

  it('the dialog is a modal with the question', () => {
    const q = ask();
    it_(<TranscriptionDialog slug="acme" view={waiting(q)} question={q} open onClose={() => {}} />);
    const d = screen.getByRole('dialog', { name: 'Trascrivere il parlato di demo.mp4?' });
    // "Continua senza trascrizione" sits quietly next to Chiudi.
    expect(within(d).getByRole('button', { name: 'Continua senza trascrizione' }).parentElement).toBe(within(d).getByRole('button', { name: 'Chiudi' }).parentElement);
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

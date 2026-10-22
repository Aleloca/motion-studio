/**
 * Decision 1640 (spec §6.2): a subtitles job's outcome in the chat. Ready: "Sottotitoli pronti", the language and the .srt /
 * .vtt downloads (fetched with the UI token and saved, a plain link would be refused); in another language than the brief's:
 * the note. No speech, an unsupported language or a failure: the core's own line, with its reason.
 */
import type { ConversationEntry, TranscriptionPending, VideoAnalysisView } from '@motion-studio/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialEventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

const at = '2026-10-22T10:00:00.000Z';
const api = {
  subtitleFile: vi.fn(async (_s: string, _c: string, _lang: string, _ext: 'srt' | 'vtt') => new Blob(['1\n00:00:00,000 --> 00:00:01,000\nCiao\n'])),
  transcriptionChoice: vi.fn(),
  recheckTranscription: vi.fn(),
  getTranscription: vi.fn(async () => ({ download: { state: 'idle', model: null, bytes: 0, total: 0 } })),
  analysisWait: vi.fn(async () => ({ files: [] })),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: false, interrupt: false, checkedAt: at })),
};
const saveBlob = vi.fn();
vi.mock('../src/api.ts', async () => {
  const real = await vi.importActual<typeof import('../src/api.ts')>('../src/api.ts');
  return { api, ApiError: class extends Error {}, subtitleFileUrl: real.subtitleFileUrl };
});
vi.mock('../src/download.ts', () => ({ saveBlob }));
const { SubtitlesReadyCard } = await import('../src/components/SubtitlesReadyCard.tsx');
const { TranscriptionChoices } = await import('../src/components/TranscriptionChoices.tsx');
const { Conversation } = await import('../src/components/Conversation.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
afterEach(() => vi.clearAllMocks());

type SystemEntry = Extract<ConversationEntry, { type: 'system' }>;
const entry = (subtitles: NonNullable<SystemEntry['subtitles']>, text = 'Sottotitoli pronti (italiano).', level: SystemEntry['level'] = 'info'): SystemEntry =>
  ({ type: 'system', at, level, text, subtitles });
const card = (e: SystemEntry) => render(<I18nProvider locale="it"><SubtitlesReadyCard slug="acme" creative="lancio" entry={e} /></I18nProvider>);

describe('the subtitles card in the chat (Task 8)', () => {
  it('ready: "Sottotitoli pronti", the language, and the .srt / .vtt downloads fetched from the set\'s files', async () => {
    card(entry({ state: 'ready', lang: 'it' }));
    const c = screen.getByRole('group', { name: 'Sottotitoli pronti' });
    expect(within(c).getByText('Sottotitoli pronti')).toBeTruthy();
    expect(within(c).getByText('Italiano')).toBeTruthy();
    expect(screen.queryByText(/lingua parlata nel video/)).toBeNull();
    await userEvent.click(within(c).getByRole('button', { name: 'Scarica .srt' }));
    expect(api.subtitleFile).toHaveBeenCalledWith('acme', 'lancio', 'it', 'srt');
    await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), 'lancio.it.srt'));
    await userEvent.click(within(c).getByRole('button', { name: 'Scarica .vtt' }));
    expect(api.subtitleFile).toHaveBeenLastCalledWith('acme', 'lancio', 'it', 'vtt');
    await waitFor(() => expect(saveBlob).toHaveBeenLastCalledWith(expect.any(Blob), 'lancio.it.vtt'));
  });

  it('the files\' URLs are the set\'s .srt and .vtt routes', async () => {
    const { subtitleFileUrl } = await import('../src/api.ts');
    expect(subtitleFileUrl('acme', 'lancio', 'it', 'srt')).toMatch(/\/api\/projects\/acme\/creatives\/lancio\/subtitles\/it\/file\.srt$/);
    expect(subtitleFileUrl('acme', 'lancio', 'it', 'vtt')).toMatch(/\/subtitles\/it\/file\.vtt$/);
  });

  it('a download that fails says so and saves nothing', async () => {
    api.subtitleFile.mockRejectedValueOnce(new Error('rete assente'));
    card(entry({ state: 'ready', lang: 'it' }));
    await userEvent.click(screen.getByRole('button', { name: 'Scarica .srt' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Download non riuscito: rete assente');
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it('ready in another language than the brief\'s: the note says so', () => {
    card(entry({ state: 'ready', lang: 'en', briefLang: 'it' }, 'Sottotitoli pronti in inglese: …'));
    expect(screen.getByText('Inglese')).toBeTruthy();
    expect(screen.getByText('Sottotitoli pronti in inglese: è la lingua parlata nel video, non quella del brief (italiano).')).toBeTruthy();
  });

  it('no speech, an unsupported language, a failure: their one line, the failure with its reason', () => {
    const { unmount } = card(entry({ state: 'no-speech' }, 'Nessun parlato nel video: nessun sottotitolo.'));
    expect(screen.getByText('Nessun parlato nel video: nessun sottotitolo.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Scarica/ })).toBeNull();
    unmount();
    const u2 = card(entry({ state: 'unsupported-language', detected: 'tlh' }, 'Nessun sottotitolo: la lingua parlata nel video (klingon) non è supportata.', 'warning'));
    expect(screen.getByText('Nessun sottotitolo: la lingua parlata nel video (klingon) non è supportata.')).toBeTruthy();
    u2.unmount();
    card(entry({ state: 'failed' }, 'I sottotitoli non sono riusciti: ffmpeg non ha letto l\'audio', 'error'));
    expect(screen.getByRole('alert').textContent).toContain('I sottotitoli non sono riusciti: ffmpeg non ha letto l\'audio');
    expect(screen.queryByRole('button', { name: /Scarica/ })).toBeNull();
  });

  it('the chat shows a subtitles entry as the card', () => {
    const shell = { live: initialEventsState, route: { name: 'creative', slug: 'acme', creative: 'lancio' }, catalog: { projects: [], creatives: {}, refresh: () => {} } } as never;
    render(
      <I18nProvider locale="it"><ShellContext.Provider value={shell}>
        <Conversation slug="acme" creative="lancio" entries={[entry({ state: 'ready', lang: 'it' })]} approvals={[]} job={undefined} />
      </ShellContext.Provider></I18nProvider>,
    );
    const c = screen.getByRole('group', { name: 'Sottotitoli pronti' });
    expect(within(c).getByRole('button', { name: 'Scarica .srt' })).toBeTruthy();
  });
});

describe('the transcription choices\' submit seam (Task 8)', () => {
  const q: TranscriptionPending = {
    kind: 'transcription', audioSec: 30, openai: null, elevenlabs: null,
    whisper: { available: true, installed: true, model: 'small', sizeBytes: 487_601_967, canInstall: true, engine: 'whisper.cpp', downloadsOwnModel: false },
  };
  const view: VideoAnalysisView = { file: 'creatives/lancio', state: 'waiting', jobId: 's1', error: null, pending: q, header: null, body: null };

  it('with `submit`, Whisper goes through it and not through the analysis route', async () => {
    const submit = vi.fn(async () => ({ pending: null }));
    const onDone = vi.fn();
    render(<I18nProvider locale="it"><TranscriptionChoices slug="acme" view={view} question={q} submit={submit} onDone={onDone} /></I18nProvider>);
    await userEvent.click(screen.getByRole('button', { name: /^Trascrivi con Whisper/ }));
    expect(submit).toHaveBeenCalledWith({ choice: 'whisper', remember: false });
    expect(api.transcriptionChoice).not.toHaveBeenCalled();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});

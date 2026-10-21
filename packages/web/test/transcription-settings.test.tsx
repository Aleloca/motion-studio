import type { TranscriptionStatus } from '@motion-studio/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { __resetToasts } from '../src/ui/toast.tsx';

export const STATUS = (over: Partial<TranscriptionStatus> = {}): TranscriptionStatus => ({
  settings: { method: 'ask', model: 'small', custom: null },
  models: [
    { id: 'small', sizeBytes: 487_601_967, installed: true, bytesOnDisk: 487_601_967 },
    { id: 'large-v3-turbo', sizeBytes: 1_624_555_275, installed: false, bytesOnDisk: 0 },
  ],
  whisper: { engine: 'whisper.cpp', program: '/opt/homebrew/bin/whisper-cli', version: '1.7.6', model: '/data/whisper/ggml-small.bin', gpu: true, source: 'detected' },
  detected: [
    { engine: 'whisper.cpp', program: '/opt/homebrew/bin/whisper-cli', version: '1.7.6', model: '/data/whisper/ggml-small.bin', gpu: true, source: 'detected' },
    { engine: 'openai-whisper', program: '/usr/local/bin/whisper', version: null, model: 'small', gpu: null, source: 'detected', problem: 'exit code 1' },
  ],
  detection: { state: 'done', at: '2026-10-21T10:00:00.000Z' },
  bundled: false,
  download: { state: 'idle', model: null, bytes: 0, total: 0 },
  providers: { openai: true, elevenlabs: false },
  prices: { openai: 0.006, elevenlabs: 0.0037 },
  ...over,
});
class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
const api = {
  getTranscription: vi.fn(async () => STATUS()),
  saveTranscription: vi.fn(async (patch: Record<string, unknown>) => STATUS({ settings: { ...STATUS().settings, ...patch } as TranscriptionStatus['settings'] })),
  downloadWhisperModel: vi.fn(async () => STATUS().download),
  removeWhisperModel: vi.fn(async () => undefined),
  detectWhisper: vi.fn(async () => STATUS()),
};
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { TranscriptionSettings } = await import('../src/screens/settings/TranscriptionSettings.tsx');
afterEach(() => { vi.clearAllMocks(); __resetToasts(); });
const it_ = () => render(<I18nProvider locale="it"><TranscriptionSettings /></I18nProvider>);

describe('Settings → Trascrizione video (Task 22)', () => {
  it('the five methods; switching to OpenAI saves it; ElevenLabs without a key cannot be chosen', async () => {
    it_();
    const methods = await screen.findByRole('radiogroup', { name: 'Metodo' });
    expect(within(methods).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Chiedi ogni volta', 'Whisper sul Mac', 'OpenAI', 'ElevenLabs', 'Mai']);
    expect((within(methods).getByRole('radio', { name: 'ElevenLabs' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(methods).getByRole('radio', { name: 'OpenAI' }));
    expect(api.saveTranscription).toHaveBeenCalledWith({ method: 'openai' });
  });

  it('Installa posts the size shown, then the download\'s progress shows', async () => {
    api.getTranscription.mockResolvedValueOnce(STATUS()).mockResolvedValue(STATUS({ download: { state: 'running', model: 'large-v3-turbo', bytes: 812_277_637, total: 1_624_555_275 } }));
    it_();
    await userEvent.click(await screen.findByRole('button', { name: 'Installa · 1,6 GB' }));
    expect(api.downloadWhisperModel).toHaveBeenCalledWith('large-v3-turbo', 1_624_555_275);
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50'));
    expect(screen.getByText('Installato · 488 MB')).toBeTruthy();
  });

  it('the Whisper in use and the ones found, with the problem of one that does not work; Cerca di nuovo', async () => {
    it_();
    expect(await screen.findByText('Whisper trovato: whisper.cpp, 1.7.6, ggml-small.bin, Metal/GPU sì')).toBeTruthy();
    expect(screen.getByText('Non ha funzionato: exit code 1')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cerca di nuovo' }));
    expect(api.detectWhisper).toHaveBeenCalled();
  });

  it('a program that fails its test-run shows the problem; nothing is saved', async () => {
    api.saveTranscription.mockRejectedValueOnce(new ApiError(400, 'Questo Whisper non ha funzionato su un secondo di audio di prova: no model', 'whisper-probe-failed'));
    it_();
    await userEvent.type(await screen.findByLabelText('Programma'), '/Users/x/bin/whisper-cli');
    await userEvent.click(screen.getByRole('button', { name: 'Prova e salva' }));
    expect(api.saveTranscription).toHaveBeenCalledWith({ custom: { program: '/Users/x/bin/whisper-cli', engine: 'whisper.cpp' } });
    expect((await screen.findByRole('alert')).textContent).toContain('no model');
    expect(screen.queryByText('Salvato')).toBeNull();
  });

  it('a Python engine says it downloads its own model and asks no model file', async () => {
    it_();
    await screen.findByLabelText('Programma');
    await userEvent.click(screen.getByRole('button', { name: /^Motore/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'faster-whisper' }));
    expect(screen.queryByLabelText('File del modello (ggml)')).toBeNull();
    expect(screen.getByText('Questo Whisper scarica i modelli nella sua cartella al primo uso.')).toBeTruthy();
  });
});

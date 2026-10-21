/** OpenAI and ElevenLabs transcription with a FAKE fetch only (never the network, never a real key). */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { usageRecordSchema } from '@motion-studio/shared';
import { UsageLedger, usageLedgerFile } from '../src/usage/usage-ledger.ts';
import { elevenlabsTranscribe, groupWords } from '../src/transcription/elevenlabs-stt.ts';
import { openaiTranscribe, OPENAI_CHUNK_SEC } from '../src/transcription/openai-stt.ts';
import { estimateSttCost, recordTranscriptionUsage, STT_PRICES_USD_PER_MIN } from '../src/transcription/pricing.ts';
import { wavData, writeSilentWav } from '../src/transcription/wav.ts';

const recorder = (answer: (n: number) => Response) => {
  const calls: Array<{ url: string; init: RequestInit; form: FormData }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, form: init.body as FormData });
    return answer(calls.length - 1);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const verbose = (offset = 0) => ({ task: 'transcribe', language: 'italian', duration: 10, text: 'Ciao. Prodotto.', segments: [
  { id: 0, seek: 0, start: offset + 0, end: offset + 2.5, text: ' Ciao a tutti.' }, { id: 1, seek: 0, start: offset + 3, end: offset + 6, text: ' Questo è il prodotto.' },
] });
const wav = async (seconds: number) => { const f = join(await mkdtemp(join(tmpdir(), 'ms-stt-')), 'audio.wav'); await writeSilentWav(f, seconds); return f; };
const signal = () => new AbortController().signal;

describe('openaiTranscribe', () => {
  it('posts whisper-1 verbose_json with segment timestamps and a bearer key; maps the segments and the language', async () => {
    const { calls, fetchImpl } = recorder(() => ok(verbose()));
    const r = await openaiTranscribe({ fetch: fetchImpl, apiKey: 'k' }, await wav(10), { language: null, signal: signal() });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const f = calls[0]!.form;
    expect([f.get('model'), f.get('response_format'), f.getAll('timestamp_granularities[]'), f.get('language')]).toEqual(['whisper-1', 'verbose_json', ['segment'], null]);
    expect((f.get('file') as File).size).toBe(44 + 10 * 32000);
    expect(r.segments).toEqual([{ from: 0, to: 2.5, text: 'Ciao a tutti.' }, { from: 3, to: 6, text: 'Questo è il prodotto.' }]);
    expect(r.language).toBe('it');
  });
  it('a language hint goes as language', async () => {
    const { calls, fetchImpl } = recorder(() => ok(verbose()));
    await openaiTranscribe({ fetch: fetchImpl, apiKey: 'k' }, await wav(1), { language: 'en', signal: signal() });
    expect(calls[0]!.form.get('language')).toBe('en');
  });
  it('1300 s of audio: three 600 s WAV pieces, the third\'s segments offset by 1200', async () => {
    expect(OPENAI_CHUNK_SEC).toBe(600);
    const { calls, fetchImpl } = recorder(() => ok(verbose()));
    const r = await openaiTranscribe({ fetch: fetchImpl, apiKey: 'k' }, await wav(1300), { language: null, signal: signal() });
    expect(calls).toHaveLength(3);
    const sizes = calls.map((c) => (c.form.get('file') as File).size);
    expect(sizes).toEqual([44 + 600 * 32000, 44 + 600 * 32000, 44 + 100 * 32000]);
    // Each piece is a WAV of its own.
    const piece = Buffer.from(await (calls[2]!.form.get('file') as File).arrayBuffer());
    const f = join(await mkdtemp(join(tmpdir(), 'ms-stt-')), 'p.wav');
    await writeFile(f, piece);
    expect((await wavData(f)).durationSec).toBe(100);
    expect(r.segments).toHaveLength(6);
    expect(r.segments[4]).toEqual({ from: 1200, to: 1202.5, text: 'Ciao a tutti.' });
  }, 30_000);
  it('a 401: the error never contains the key', async () => {
    const { fetchImpl } = recorder(() => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-secret-123' } }), { status: 401 }));
    const err = await openaiTranscribe({ fetch: fetchImpl, apiKey: 'sk-secret-123' }, await wav(1), { language: null, signal: signal() }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('sk-secret-123');
  });
  it('a 500 echoing the key: redacted', async () => {
    const { fetchImpl } = recorder(() => new Response(JSON.stringify({ error: { message: 'bad request for sk-secret-123' } }), { status: 500 }));
    const err = await openaiTranscribe({ fetch: fetchImpl, apiKey: 'sk-secret-123' }, await wav(1), { language: null, signal: signal() }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('sk-secret-123');
  });
});

describe('elevenlabsTranscribe', () => {
  const words = { language_code: 'ita', language_probability: 0.98, text: 'Ciao a tutti Questo', words: [
    { text: 'Ciao', start: 0, end: 0.4, type: 'word' }, { text: ' ', start: 0.4, end: 0.5, type: 'spacing' },
    { text: 'a', start: 0.5, end: 0.6, type: 'word' }, { text: ' ', start: 0.6, end: 0.7, type: 'spacing' },
    { text: 'tutti', start: 0.7, end: 1.2, type: 'word' }, { text: ' ', start: 1.2, end: 2.2, type: 'spacing' },
    { text: '(risate)', start: 1.3, end: 1.9, type: 'audio_event' },
    { text: 'Questo', start: 2.2, end: 2.6, type: 'word' }, { text: ' ', start: 2.6, end: 2.7, type: 'spacing' },
    { text: 'funziona.', start: 2.7, end: 3.2, type: 'word' }, { text: ' ', start: 3.2, end: 3.3, type: 'spacing' },
    { text: 'Bene', start: 3.3, end: 3.6, type: 'word' },
  ] };
  it('posts scribe with word timestamps and the xi-api-key header; words grouped at a 1 s gap and at sentence ends', async () => {
    const { calls, fetchImpl } = recorder(() => ok(words));
    const r = await elevenlabsTranscribe({ fetch: fetchImpl, apiKey: 'xi' }, await wav(4), { language: null, signal: signal() });
    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect((calls[0]!.init.headers as Record<string, string>)['xi-api-key']).toBe('xi');
    const f = calls[0]!.form;
    expect([f.get('model_id'), f.get('timestamps_granularity'), f.get('language_code'), f.get('tag_audio_events')]).toEqual([STT_PRICES_USD_PER_MIN.elevenlabs.model, 'word', null, 'false']);
    expect(r.segments).toEqual([
      { from: 0, to: 1.2, text: 'Ciao a tutti' }, { from: 2.2, to: 3.2, text: 'Questo funziona.' }, { from: 3.3, to: 3.6, text: 'Bene' },
    ]);
    expect(r.language).toBe('ita');
  });
  it('two segments split at a 1 s gap', () => {
    expect(groupWords([{ text: 'Uno', start: 0, end: 0.5, type: 'word' }, { text: 'due', start: 1.5, end: 2, type: 'word' }]))
      .toEqual([{ from: 0, to: 0.5, text: 'Uno' }, { from: 1.5, to: 2, text: 'due' }]);
  });
  it('a language hint goes as language_code', async () => {
    const { calls, fetchImpl } = recorder(() => ok(words));
    await elevenlabsTranscribe({ fetch: fetchImpl, apiKey: 'xi' }, await wav(1), { language: 'it', signal: signal() });
    expect(calls[0]!.form.get('language_code')).toBe('it');
  });
});

describe('cost and usage', () => {
  it('estimates on whole minutes at the list price', () => {
    expect(estimateSttCost('openai', 61)).toBe(0.012);
    expect(estimateSttCost('openai', 60)).toBe(0.006);
    expect(estimateSttCost('elevenlabs', 3600)).toBeCloseTo(0.22, 6);
    expect(STT_PRICES_USD_PER_MIN.openai).toEqual({ model: 'whisper-1', usdPerMin: 0.006 });
  });
  it('one usage.jsonl line of kind transcription, zero tokens, the cost', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-stt-'));
    await recordTranscriptionUsage(new UsageLedger(), dir, { jobId: 'j1', provider: 'openai', model: 'whisper-1', audioSec: 61, costUsd: 0.012 });
    const line = JSON.parse((await readFile(usageLedgerFile(dir), 'utf8')).trim()) as unknown;
    const rec = usageRecordSchema.parse(line);
    expect(rec).toMatchObject({ jobId: 'j1', kind: 'transcription', costUsd: 0.012, outcome: 'ok', tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(rec.models).toEqual([{ model: 'whisper-1', tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.012 }]);
  });
});

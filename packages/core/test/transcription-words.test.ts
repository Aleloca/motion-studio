/** Word timings from every engine (fake engines and a fake fetch only: no Whisper model and no provider is ever run). */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppConfigStore } from '../src/app-config.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { elevenlabsTranscribe } from '../src/transcription/elevenlabs-stt.ts';
import { engineFlags, parseFasterWhisper, parseOpenAiWhisper, parseWhisperCpp, whisperArgs } from '../src/transcription/engines.ts';
import { openaiTranscribe } from '../src/transcription/openai-stt.ts';
import { TranscriptionService } from '../src/transcription/transcriber.ts';
import { writeSilentWav } from '../src/transcription/wav.ts';
import { UsageLedger } from '../src/usage/usage-ledger.ts';
import { callsOf, fakeWhisper } from './helpers/fake-whisper.ts';

const temp = () => mkdtemp(join(tmpdir(), 'ms-tw-'));
const wavFile = async (seconds: number) => { const f = join(await temp(), 'audio.wav'); await writeSilentWav(f, seconds); return f; };
const signal = () => new AbortController().signal;
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const recorder = (answer: (n: number) => Response) => {
  const calls: Array<{ form: FormData }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => { calls.push({ form: init.body as FormData }); return answer(calls.length - 1); }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const tok = (text: string, from: number, to: number) => ({ text, offsets: { from, to } });
const cppFull = {
  result: { language: 'it' },
  transcription: [{
    offsets: { from: 0, to: 600 }, text: ' Ciao ami',
    tokens: [tok('[_BEG_]', 0, 0), tok(' Ciao', 0, 400), tok(' a', 450, 500), tok('mi', 500, 600), tok('[_TT_50]', 600, 600)],
  }],
};
const ALL = { vad: true, sns: true, np: true, ojf: true };

describe('whisperArgs with words', () => {
  const base = { program: '/b/whisper-cli', wav: '/t/a.wav', outDir: '/t/o', model: '/m/ggml-small.bin', language: null };
  it('whisper.cpp: -ojf in place of -oj; without words the argv is today\'s', () => {
    const withWords = whisperArgs('whisper.cpp', { ...base, words: true, flags: ALL });
    expect(withWords).toContain('-ojf');
    expect(withWords).not.toContain('-oj');
    expect(whisperArgs('whisper.cpp', { ...base, flags: ALL })).toEqual(['-m', '/m/ggml-small.bin', '-f', '/t/a.wav', '-oj', '-of', '/t/o/out', '-np', '-sns', '-l', 'auto']);
    expect(whisperArgs('whisper.cpp', { ...base, words: false, flags: ALL })).toEqual(whisperArgs('whisper.cpp', { ...base, flags: ALL }));
  });
  it('whisper.cpp without -ojf in its help keeps -oj', () => {
    expect(whisperArgs('whisper.cpp', { ...base, words: true, flags: { ...ALL, ojf: false } })).toContain('-oj');
    expect(engineFlags('  -oj, --output-json  x\n  -ojf, --output-json-full  y').ojf).toBe(true);
    expect(engineFlags('  -oj, --output-json  x').ojf).toBe(false);
  });
  it('Python engines add --word_timestamps True at the end; absent without words', () => {
    for (const e of ['openai-whisper', 'faster-whisper'] as const) {
      expect(whisperArgs(e, { ...base, words: true }).slice(-2)).toEqual(['--word_timestamps', 'True']);
      expect(whisperArgs(e, { ...base })).not.toContain('--word_timestamps');
    }
    expect(whisperArgs('openai-whisper', { ...base, language: 'it', words: true }).slice(-4)).toEqual(['--language', 'it', '--word_timestamps', 'True']);
  });
});

describe('parsers: words', () => {
  it('whisper.cpp tokens: joined at a leading space, special tokens skipped', () => {
    const r = parseWhisperCpp(cppFull);
    expect(r.words).toEqual([{ from: 0, to: 0.4, text: 'Ciao' }, { from: 0.45, to: 0.6, text: 'ami' }]);
    expect(r.segments).toHaveLength(1);
  });
  it('whisper.cpp -oj (no tokens): no words', () => {
    expect(parseWhisperCpp({ transcription: [{ offsets: { from: 0, to: 1000 }, text: ' Ciao' }] }).words).toBeUndefined();
  });
  it('a word does not run across two segments', () => {
    const r = parseWhisperCpp({ transcription: [
      { offsets: { from: 0, to: 500 }, text: ' Ci', tokens: [tok(' Ci', 0, 500)] },
      { offsets: { from: 500, to: 900 }, text: 'ao', tokens: [tok('ao', 500, 900)] },
    ] });
    expect(r.words!.map((w) => w.text)).toEqual(['Ci', 'ao']);
  });
  it('openai-whisper and faster-whisper: segments[].words[]', () => {
    const body = { language: 'en', segments: [{ start: 0, end: 2, text: ' Hello there', words: [{ word: ' Hello', start: 0, end: 0.9 }, { word: ' there', start: 1, end: 1.5 }, { word: ' ', start: 1.5, end: 1.6 }] }] };
    const expected = [{ from: 0, to: 0.9, text: 'Hello' }, { from: 1, to: 1.5, text: 'there' }];
    expect(parseOpenAiWhisper(body).words).toEqual(expected);
    expect(parseFasterWhisper(body).words).toEqual(expected);
    expect(parseOpenAiWhisper({ language: 'en', segments: [{ start: 0, end: 1, text: 'x' }] }).words).toBeUndefined();
  });
});

describe('openaiTranscribe with words', () => {
  const body = (offset: number) => ({ language: 'italian', segments: [{ start: offset, end: offset + 2, text: ' Ciao a tutti' }],
    words: [{ word: 'Ciao', start: offset, end: offset + 0.5 }, { word: 'a', start: offset + 0.6, end: offset + 0.7 }] });
  it('asks for both granularities and offsets the second 600 s piece\'s words by 600', async () => {
    const { calls, fetchImpl } = recorder(() => ok(body(0)));
    const r = await openaiTranscribe({ fetch: fetchImpl, apiKey: 'k' }, await wavFile(700), { language: null, signal: signal(), words: true });
    expect(calls[0]!.form.getAll('timestamp_granularities[]')).toEqual(['segment', 'word']);
    expect(r.words).toEqual([{ from: 0, to: 0.5, text: 'Ciao' }, { from: 0.6, to: 0.7, text: 'a' }, { from: 600, to: 600.5, text: 'Ciao' }, { from: 600.6, to: 600.7, text: 'a' }]);
  }, 30_000);
  it('without words: segment only and no words in the result', async () => {
    const { calls, fetchImpl } = recorder(() => ok(body(0)));
    const r = await openaiTranscribe({ fetch: fetchImpl, apiKey: 'k' }, await wavFile(2), { language: null, signal: signal() });
    expect(calls[0]!.form.getAll('timestamp_granularities[]')).toEqual(['segment']);
    expect('words' in r).toBe(false);
  });
});

describe('elevenlabsTranscribe words', () => {
  it('returns the word items (not the spacing) besides the segments', async () => {
    const { fetchImpl } = recorder(() => ok({ language_code: 'ita', words: [
      { text: 'Ciao', start: 0, end: 0.4, type: 'word' }, { text: ' ', start: 0.4, end: 0.5, type: 'spacing' },
      { text: 'a', start: 0.5, end: 0.6, type: 'word' }, { text: ' ', start: 0.6, end: 0.6, type: 'spacing' }, { text: 'tutti.', start: 0.6, end: 1.1, type: 'word' },
    ] }));
    const r = await elevenlabsTranscribe({ fetch: fetchImpl, apiKey: 'k' }, await wavFile(2), { language: null, signal: signal() });
    expect(r.words).toEqual([{ from: 0, to: 0.4, text: 'Ciao' }, { from: 0.5, to: 0.6, text: 'a' }, { from: 0.6, to: 1.1, text: 'tutti.' }]);
    expect(r.segments).toEqual([{ from: 0, to: 1.1, text: 'Ciao a tutti.' }]);
  });
});

describe('TranscriptionService.transcribe with words', () => {
  const setup = async (fixtureJson: unknown) => {
    const dir = await temp();
    const fixture = join(dir, 'fixture.json');
    await writeFile(fixture, JSON.stringify(fixtureJson));
    const program = await fakeWhisper(dir, 'whisper-cli', { fixture, version: 'version: 1.7.6', help: 'usage: whisper-cli\n  -ojf, --output-json-full  full JSON' });
    const model = join(dir, 'ggml-small.bin');
    await writeFile(model, 'x');
    const app = await temp();
    const config = new AppConfigStore(join(app, 'config'));
    await config.setTranscription({ method: 'whisper' });
    const svc = new TranscriptionService({ config, vault: new MemoryVault({}), ledger: new UsageLedger(), appDataDir: app, fetch: (async () => { throw new Error('no network'); }) as typeof fetch, detect: async () => [], env: { HOME: await temp() } });
    await svc.update({ custom: { program, engine: 'whisper.cpp', modelFile: model } });
    return { svc, program, dir };
  };
  it('words: the result has them and the engine ran with -ojf; the language is passed when given', async () => {
    const { svc, program, dir } = await setup(cppFull);
    const r = await svc.transcribe({ ref: { projectDir: dir }, jobId: 'j', wav: await wavFile(1), durationSec: 1, signal: signal(), method: 'whisper', words: true, language: 'it' });
    expect(r.words).toEqual([{ from: 0, to: 0.4, text: 'Ciao' }, { from: 0.45, to: 0.6, text: 'ami' }]);
    const run = (await callsOf(program)).at(-1)!;
    expect(run).toContain('-ojf');
    expect(run.slice(run.indexOf('-l'), run.indexOf('-l') + 2)).toEqual(['-l', 'it']);
  });
  it('without words (the analysis): -oj, auto language, no words key', async () => {
    const { svc, program, dir } = await setup(cppFull);
    const r = await svc.transcribe({ ref: { projectDir: dir }, jobId: 'j', wav: await wavFile(1), durationSec: 1, signal: signal(), method: 'whisper' });
    expect('words' in r).toBe(false);
    const run = (await callsOf(program)).at(-1)!;
    expect(run).toContain('-oj');
    expect(run).not.toContain('-ojf');
    expect(run.slice(run.indexOf('-l'), run.indexOf('-l') + 2)).toEqual(['-l', 'auto']);
  });
});

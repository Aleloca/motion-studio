import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWhisperCpp, runWhisper, whisperArgs } from '../src/transcription/engines.ts';
import { callsOf, fakeWhisper, fixturePath } from './helpers/fake-whisper.ts';

/**
 * Report 76: with `--vad` whisper.cpp v1.9.5 gives the segments on the source's clock but the tokens of `-ojf` on the clock
 * of the speech without its pauses, so the subtitles ran ahead of the voice. Fixtures: the bundled whisper-cli v1.9.5 with
 * ggml-small on the first 60 s of the report's video, `-ojf` with and without `--vad`.
 */

const json = async (name: string) => JSON.parse(await readFile(fixturePath(name), 'utf8')) as unknown;
const VAD = 'whisper-cpp-vad-ojf.json', NO_VAD = 'whisper-cpp-novad-ojf.json';

describe('whisperArgs: the subtitles keep VAD', () => {
  it('words: -ojf with --vad and its model', () => {
    const args = whisperArgs('whisper.cpp', { program: '/b/whisper-cli', wav: '/t/a.wav', outDir: '/t/o', model: '/m/ggml-small.bin', vadModel: '/m/vad.bin', language: null, flags: { vad: true, sns: true, np: true, ojf: true }, words: true });
    expect(args).toEqual(expect.arrayContaining(['-ojf', '-sns', '--vad', '--vad-model', '/m/vad.bin']));
  });
});

describe('parseWhisperCpp with VAD: the words on the source\'s clock', () => {
  it('each segment\'s tokens move to its start: the first words at 4.03 s, "But" at 7.74 s, "Codecs" at 10.96 s', async () => {
    const r = parseWhisperCpp(await json(VAD), { vad: true });
    const w = r.words!;
    expect(w[0]).toMatchObject({ text: 'If', from: 4.03 });
    expect(w.find((x) => x.text === 'But')!.from).toBe(7.74);
    expect(w.find((x) => x.text === 'Codecs')!.from).toBe(10.96);
    expect(r.segments[0]).toMatchObject({ from: 4.03, to: 7.74 });
  });
  it('every word inside its segment, in order, the last one ending by 60 s', async () => {
    const raw = await json(VAD) as { transcription: Array<{ offsets: { from: number; to: number } }> };
    const r = parseWhisperCpp(raw, { vad: true });
    const segs = raw.transcription.map((s) => ({ from: s.offsets.from / 1000, to: s.offsets.to / 1000 }));
    for (const x of r.words!) expect(segs.some((s) => x.from >= s.from && x.to <= s.to && x.from <= x.to)).toBe(true);
    for (let i = 1; i < r.words!.length; i++) expect(r.words![i]!.from).toBeGreaterThanOrEqual(r.words![i - 1]!.from);
    expect(r.words!.at(-1)!.to).toBeLessThanOrEqual(60);
    expect(r.words!.at(-1)!.from).toBeGreaterThanOrEqual(57.39);
    expect(r.words!.map((x) => x.text).join(' ')).toBe(parseWhisperCpp(raw).words!.map((x) => x.text).join(' '));
  });
  it('without VAD the token times are kept as they are', async () => {
    const r = parseWhisperCpp(await json(NO_VAD));
    expect(r.words![0]).toMatchObject({ text: 'If', from: 0.09 });
  });
});

describe('runWhisper: the remap follows the argv', () => {
  const HELP = 'usage: whisper-cli [options]\n  -np, --no-prints\n  -sns, --suppress-nst\n  -ojf, --output-json-full\n  --vad\n  -vm FNAME, --vad-model FNAME';
  const opts = { language: null, signal: new AbortController().signal, timeoutMs: 20_000, words: true };
  const found = (program: string, d: string) => ({ engine: 'whisper.cpp' as const, program, version: null, model: join(d, 'm.bin'), gpu: null, source: 'bundled' as const, vadModel: join(d, 'vad.bin') });

  it('a run with --vad: one run, the words moved to the source\'s clock', async () => {
    const d = await mkdtemp(join(tmpdir(), 'ms-vad-'));
    await writeFile(join(d, 'a.wav'), Buffer.alloc(100));
    const program = await fakeWhisper(d, 'whisper-cli', { fixture: fixturePath(VAD), fixtureNoVad: fixturePath(NO_VAD), help: HELP });
    const r = await runWhisper(found(program, d), join(d, 'a.wav'), opts);
    const runs = (await callsOf(program)).filter((a) => a.includes('-f'));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain('--vad');
    expect(r.words![0]).toMatchObject({ text: 'If', from: 4.03 });
  }, 30_000);
  it('a whisper.cpp without --vad in its help: the times are not moved', async () => {
    const d = await mkdtemp(join(tmpdir(), 'ms-vad-'));
    await writeFile(join(d, 'a.wav'), Buffer.alloc(100));
    const program = await fakeWhisper(d, 'whisper-cli', { fixture: fixturePath(VAD), fixtureNoVad: fixturePath(NO_VAD), help: 'usage: whisper-cli [options]\n  -ojf, --output-json-full' });
    const r = await runWhisper(found(program, d), join(d, 'a.wav'), opts);
    expect(r.words![0]).toMatchObject({ text: 'If', from: 0.09 });
  }, 30_000);
});

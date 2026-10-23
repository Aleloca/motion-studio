import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWhisper, vadClockSuspect, whisperArgs } from '../src/transcription/engines.ts';
import { speechSpan, WAV_RATE, wavHeader } from '../src/transcription/wav.ts';
import { callsOf, fakeWhisper } from './helpers/fake-whisper.ts';

/**
 * Report 76: with `--vad` whisper.cpp hears the speech with the pauses cut out, and the times it gives can stay on that
 * shorter clock (the token times of `-ojf` do): the subtitles ran ahead of the voice by the pauses heard so far.
 */

const temp = () => mkdtemp(join(tmpdir(), 'ms-vad-'));

/** A 16 kHz mono WAV of [seconds, loud] blocks: a 440 Hz tone (about -13 dBFS) or digital silence. */
async function wavOf(path: string, blocks: Array<[number, boolean]>): Promise<void> {
  const parts = blocks.map(([sec, loud]) => {
    const n = Math.round(sec * WAV_RATE), b = Buffer.alloc(n * 2);
    if (loud) for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / WAV_RATE) * 9000), i * 2);
    return b;
  });
  const data = Buffer.concat(parts);
  await writeFile(path, Buffer.concat([wavHeader(data.length), data]));
}

/** Speech 0–3.4, pause 1 s, speech 4.4–8, pause 3 s, speech 11–20, then 2 s of silence: 4 s of pauses before the end. */
const SPEECH: Array<[number, boolean]> = [[3.4, true], [1, false], [3.6, true], [3, false], [9, true], [2, false]];

const tok = (text: string, from: number, to: number) => ({ text, offsets: { from, to } });
/** whisper.cpp `-ojf` output whose last line ends at `endMs` (segment and tokens). */
const cppJson = (endMs: number) => ({
  result: { language: 'en' },
  transcription: [
    { offsets: { from: 0, to: 3400 }, text: ' Hello there.', tokens: [tok(' Hello', 0, 1500), tok(' there.', 1500, 3400)] },
    { offsets: { from: endMs - 3000, to: endMs }, text: ' The end.', tokens: [tok(' The', endMs - 3000, endMs - 1500), tok(' end.', endMs - 1500, endMs)] },
  ],
});

describe('whisperArgs: VAD only when the word times are not asked for', () => {
  const base = { program: '/b/whisper-cli', wav: '/t/a.wav', outDir: '/t/o', model: '/m/ggml-small.bin', vadModel: '/m/vad.bin', language: null, flags: { vad: true, sns: true, np: true, ojf: true } };
  it('the subtitles (words): no --vad, -sns kept', () => {
    const args = whisperArgs('whisper.cpp', { ...base, words: true });
    expect(args).not.toContain('--vad');
    expect(args).not.toContain('--vad-model');
    expect(args).toEqual(expect.arrayContaining(['-ojf', '-sns', '-np']));
  });
  it('the analysis (segments): --vad with its model', () => {
    expect(whisperArgs('whisper.cpp', base)).toEqual(expect.arrayContaining(['--vad', '--vad-model', '/m/vad.bin']));
  });
});

describe('speechSpan: where the speech ends and how long its pauses are, from the WAV', () => {
  it('the last loud moment and the pauses before it (leading silence too)', async () => {
    const d = await temp();
    const wav = join(d, 'a.wav');
    await wavOf(wav, [[0.5, false], ...SPEECH]);
    const s = (await speechSpan(wav))!;
    expect(s.endSec).toBeCloseTo(20.5, 1);
    expect(s.quietSec).toBeCloseTo(4.5, 1);
  });
  it('short gaps between words are no pause; silence only: null; not a 16 kHz WAV: null', async () => {
    const d = await temp();
    const wav = join(d, 'a.wav');
    await wavOf(wav, [[2, true], [0.1, false], [2, true]]);
    expect((await speechSpan(wav))!.quietSec).toBe(0);
    await wavOf(wav, [[3, false]]);
    expect(await speechSpan(wav)).toBeNull();
    await writeFile(wav, Buffer.alloc(100));
    expect(await speechSpan(wav)).toBeNull();
  });
});

describe('vadClockSuspect', () => {
  const span = { endSec: 20, quietSec: 4 };
  it('the transcript ends early by about the pauses: suspect', () => {
    expect(vadClockSuspect(16, span)).toBe(true);
    expect(vadClockSuspect(125.5 + 2.5, { endSec: 147.3, quietSec: 21 })).toBe(true);
  });
  it('a transcript ending with the speech, a short shortfall, or one far smaller than the pauses: not suspect', () => {
    expect(vadClockSuspect(19.8, span)).toBe(false);
    expect(vadClockSuspect(19, { endSec: 20, quietSec: 0.5 })).toBe(false);
    expect(vadClockSuspect(17, { endSec: 20, quietSec: 40 })).toBe(false);
  });
});

describe('runWhisper: times on the source\'s own clock', () => {
  const found = (program: string, d: string) => ({ engine: 'whisper.cpp' as const, program, version: null, model: join(d, 'm.bin'), gpu: null, source: 'bundled' as const, vadModel: join(d, 'vad.bin') });
  const HELP = 'usage: whisper-cli [options]\n  -np, --no-prints\n  -sns, --suppress-nst\n  -ojf, --output-json-full\n  --vad\n  -vm FNAME, --vad-model FNAME';
  const opts = { language: null, signal: new AbortController().signal, timeoutMs: 20_000 };

  async function setup(vadEndMs: number) {
    const d = await temp();
    const wav = join(d, 'a.wav');
    await wavOf(wav, SPEECH);
    await writeFile(join(d, 'vad.json'), JSON.stringify(cppJson(vadEndMs)));
    await writeFile(join(d, 'full.json'), JSON.stringify(cppJson(19_900)));
    const program = await fakeWhisper(d, 'whisper-cli', { fixture: join(d, 'vad.json'), fixtureNoVad: join(d, 'full.json'), help: HELP });
    return { d, wav, program, runs: async () => (await callsOf(program)).filter((a) => a.includes('-f')) };
  }

  it('the analysis: a VAD transcript ending short by the pauses is redone without VAD, and that one is kept', async () => {
    const { d, wav, program, runs } = await setup(16_000);
    const r = await runWhisper(found(program, d), wav, opts);
    const calls = await runs();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--vad');
    expect(calls[1]).not.toContain('--vad');
    expect(calls[1]).toContain('-sns');
    expect(r.segments.at(-1)!.to).toBe(19.9);
  }, 30_000);
  it('the analysis: a VAD transcript already on the source\'s clock runs once', async () => {
    const { d, wav, program, runs } = await setup(19_800);
    const r = await runWhisper(found(program, d), wav, opts);
    expect(await runs()).toHaveLength(1);
    expect(r.segments.at(-1)!.to).toBe(19.8);
  }, 30_000);
  it('the subtitles: one run without VAD, the words on the source\'s clock', async () => {
    const { d, wav, program, runs } = await setup(16_000);
    const r = await runWhisper(found(program, d), wav, { ...opts, words: true });
    const calls = await runs();
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('--vad');
    expect(r.words!.at(-1)).toEqual({ from: 18.4, to: 19.9, text: 'end.' });
  }, 30_000);
});

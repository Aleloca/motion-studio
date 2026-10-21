import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectWhispers, identifyWhisper, probeWhisper, resolveWhisper, WHISPER_NAMES } from '../src/transcription/detect.ts';
import { writeSilentWav } from '../src/transcription/wav.ts';
import { fakeWhisper, fixturePath } from './helpers/fake-whisper.ts';

const temp = () => mkdtemp(join(tmpdir(), 'ms-wd-'));
const settings = (o: Partial<{ method: 'ask'; model: 'small' | 'large-v3-turbo'; custom: unknown }> = {}) => ({ method: 'ask' as const, model: 'small' as const, custom: null, ...o }) as Parameters<typeof resolveWhisper>[0]['settings'];

describe('detectWhispers (fake executables only)', () => {
  it('finds a whisper-cli on the PATH and a Python whisper in an extra folder, each with its engine; a main that is not whisper is ignored', async () => {
    const pathDir = await temp(), brew = await temp(), other = await temp();
    await fakeWhisper(pathDir, 'whisper-cli', { version: 'whisper.cpp version: 1.9.5' });
    await fakeWhisper(brew, 'whisper', {});
    await fakeWhisper(other, 'main', { help: 'usage: main [options] -- a random tool' });
    const found = await detectWhispers({ pathEnv: [pathDir, other].join(':'), extraDirs: [brew], probe: identifyWhisper });
    expect(found.map((f) => [f.engine, f.program, f.source])).toEqual([
      ['whisper.cpp', join(pathDir, 'whisper-cli'), 'detected'], ['openai-whisper', join(brew, 'whisper'), 'detected'],
    ]);
    expect(found[0]!.version).toBe('1.9.5');
  });
  it('a main whose help mentions whisper counts as whisper.cpp; a folder listed twice gives one entry', async () => {
    const d = await temp();
    await fakeWhisper(d, 'main', { help: 'usage: ./main [options] file0.wav ... whisper.cpp' });
    const found = await detectWhispers({ pathEnv: `${d}:${d}`, extraDirs: [d], probe: identifyWhisper });
    expect(found.map((f) => f.engine)).toEqual(['whisper.cpp']);
  });
  it('knows the usual names', () => {
    expect(WHISPER_NAMES['whisper.cpp']).toEqual(['whisper-cli', 'whisper-cpp', 'main']);
    expect(WHISPER_NAMES['faster-whisper']).toEqual(['whisper-ctranslate2', 'faster-whisper']);
  });
});

describe('probeWhisper (one second of generated audio, fake engines)', () => {
  it('whisper.cpp reporting the GPU: found, gpu true, the model file named', async () => {
    const d = await temp();
    const model = join(d, 'ggml-small.bin');
    await writeFile(model, 'x');
    const program = await fakeWhisper(d, 'whisper-cli', { fixture: fixturePath('whisper-cpp.json'), stderr: 'whisper_init_with_params_no_state: use gpu    = 1\n', version: 'version: 1.9.5' });
    const r = await probeWhisper(program, 'whisper.cpp', { modelFile: model, modelName: 'small' });
    expect(r).toMatchObject({ engine: 'whisper.cpp', program, model, gpu: true, version: '1.9.5' });
  });
  it('a failing engine: the problem is its stderr\'s last line', async () => {
    const d = await temp();
    await writeFile(join(d, 'm.bin'), 'x');
    const program = await fakeWhisper(d, 'whisper-cli', { stderr: 'loading model\nerror: invalid model file\n', exit: 1 });
    expect(await probeWhisper(program, 'whisper.cpp', { modelFile: join(d, 'm.bin'), modelName: 'small' })).toEqual({ problem: 'error: invalid model file' });
  });
  it('whisper.cpp without a model file, or a program that is not there: a problem', async () => {
    const d = await temp();
    const program = await fakeWhisper(d, 'whisper-cli', {});
    expect(await probeWhisper(program, 'whisper.cpp', { modelFile: join(d, 'none.bin'), modelName: 'small' })).toHaveProperty('problem');
    expect(await probeWhisper(join(d, 'nope'), 'openai-whisper', { modelName: 'small' })).toHaveProperty('problem');
  });
  it('a Python engine: the model by name, gpu unknown', async () => {
    const d = await temp();
    const program = await fakeWhisper(d, 'whisper', { fixture: fixturePath('openai-whisper.json') });
    expect(await probeWhisper(program, 'openai-whisper', { modelName: 'large-v3-turbo' })).toMatchObject({ engine: 'openai-whisper', model: 'large-v3-turbo', gpu: null });
  });
  it('the silent wav is one second of 16 kHz mono PCM', async () => {
    const f = join(await temp(), 'a.wav');
    await writeSilentWav(f, 1);
    expect((await stat(f)).size).toBe(44 + 32000);
  });
});

describe('resolveWhisper: settings → bundled → detected', () => {
  const detected = (program: string) => async () => [{ engine: 'openai-whisper' as const, program, version: null, model: 'small', gpu: null, source: 'detected' as const }];
  it('the program set in Settings wins over the bundled one', async () => {
    const d = await temp(), app = await temp();
    const custom = await fakeWhisper(join(d, 'custom'), 'whisper', {});
    const bundled = join(d, 'bundled');
    await fakeWhisper(bundled, 'whisper-cli', {});
    await mkdir(join(app, 'whisper'), { recursive: true });
    await writeFile(join(app, 'whisper', 'ggml-small.bin'), 'x');
    const r = await resolveWhisper({ settings: settings({ model: 'large-v3-turbo', custom: { program: custom, engine: 'openai-whisper' } }), whisperDir: bundled, appDataDir: app, detected: detected('/x') });
    expect(r).toMatchObject({ source: 'settings', engine: 'openai-whisper', program: custom, model: 'large-v3-turbo' });
  });
  it('bundled with its model (and the bundled VAD model); without the model file it falls to the detected one', async () => {
    const d = await temp(), app = await temp();
    const bundled = join(d, 'bundled');
    await fakeWhisper(bundled, 'whisper-cli', {});
    await writeFile(join(bundled, 'ggml-silero-v6.2.0.bin'), 'v');
    expect(await resolveWhisper({ settings: settings(), whisperDir: bundled, appDataDir: app, detected: detected('/usr/local/bin/whisper') }))
      .toMatchObject({ source: 'detected', program: '/usr/local/bin/whisper' });
    await mkdir(join(app, 'whisper'), { recursive: true });
    await writeFile(join(app, 'whisper', 'ggml-small.bin'), 'x');
    expect(await resolveWhisper({ settings: settings(), whisperDir: bundled, appDataDir: app, detected: detected('/usr/local/bin/whisper') }))
      .toMatchObject({ source: 'bundled', engine: 'whisper.cpp', program: join(bundled, 'whisper-cli'), model: join(app, 'whisper', 'ggml-small.bin'), vadModel: join(bundled, 'ggml-silero-v6.2.0.bin') });
  });
  it('a custom whisper.cpp without a model file is not available; nothing at all → null', async () => {
    const d = await temp(), app = await temp();
    const custom = await fakeWhisper(d, 'whisper-cli', {});
    expect(await resolveWhisper({ settings: settings({ custom: { program: custom, engine: 'whisper.cpp' } }), appDataDir: app, detected: async () => [] })).toBeNull();
  });
  it('a detected whisper.cpp uses the downloaded model; without one it is skipped', async () => {
    const app = await temp();
    const cpp = async () => [{ engine: 'whisper.cpp' as const, program: '/opt/homebrew/bin/whisper-cli', version: '1.7.0', model: '', gpu: null, source: 'detected' as const }];
    expect(await resolveWhisper({ settings: settings(), appDataDir: app, detected: cpp })).toBeNull();
    await mkdir(join(app, 'whisper'), { recursive: true });
    await writeFile(join(app, 'whisper', 'ggml-small.bin'), 'x');
    expect(await resolveWhisper({ settings: settings(), appDataDir: app, detected: cpp })).toMatchObject({ program: '/opt/homebrew/bin/whisper-cli', model: join(app, 'whisper', 'ggml-small.bin') });
  });
});

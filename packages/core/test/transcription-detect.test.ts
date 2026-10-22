import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectWhispers, engineFlags, identifyWhisper, probeWhisper, resolveWhisper, versionOf, WHISPER_NAMES } from '../src/transcription/detect.ts';
import { runWhisper } from '../src/transcription/engines.ts';
import { writeSilentWav } from '../src/transcription/wav.ts';
import { callsOf, fakeWhisper, fixturePath } from './helpers/fake-whisper.ts';

const temp = () => mkdtemp(join(tmpdir(), 'ms-wd-'));
const settings = (o: Partial<{ method: 'ask'; model: 'small' | 'large-v3-turbo'; custom: unknown }> = {}) => ({ method: 'ask' as const, model: 'small' as const, custom: null, ...o }) as Parameters<typeof resolveWhisper>[0]['settings'];
const CPP_HELP = 'usage: whisper-cli [options] file0 file1 ...\n  -np, --no-prints [false ] do not print anything other than the results\n  -sns, --suppress-nst [false ] suppress non-speech tokens\n  --vad [false ] enable Voice Activity Detection (VAD)\n  -wt N, --word-thold N [0.01 ] word timestamp probability threshold';

describe('detectWhispers (fake executables only)', () => {
  it('finds a whisper-cli on the PATH and a Python whisper in an extra folder, each with its engine; a main that is not whisper is ignored', async () => {
    const pathDir = await temp(), brew = await temp(), other = await temp();
    await fakeWhisper(pathDir, 'whisper-cli', { version: 'whisper.cpp version: 1.9.5', help: CPP_HELP });
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

describe('version and flags come only from what the program really says', () => {
  it('a version is read only from a version line; usage text with numbers is no version', () => {
    expect(versionOf('whisper.cpp version: 1.9.5')).toBe('1.9.5');
    expect(versionOf('v1.7.6\n')).toBe('1.7.6');
    expect(versionOf(`error: unknown argument: --version\n${CPP_HELP}`)).toBeNull();
  });
  it('a whisper-cli with no --version (it prints its usage): version unknown', async () => {
    const d = await temp();
    const program = await fakeWhisper(d, 'whisper-cli', { version: `error: unknown argument: --version\n${CPP_HELP}`, help: CPP_HELP });
    expect((await identifyWhisper(program, 'whisper.cpp'))!.version).toBeNull();
  });
  it('flags from --help: --vad, -sns, -np and -ojf only when listed', () => {
    expect(engineFlags(CPP_HELP)).toEqual({ vad: true, sns: true, np: true, ojf: false });
    expect(engineFlags('usage: main [options]\n  -l LANG, --language LANG')).toEqual({ vad: false, sns: false, np: false, ojf: false });
    expect(engineFlags('usage: main [options]\n  -ojf,      --output-json-full  [false  ] include more information in the JSON file').ojf).toBe(true);
    expect(engineFlags('usage: main [options]\n  --output-json-full').ojf).toBe(true);
    expect(engineFlags('usage: main [options]\n  -oj,       --output-json       [false  ] output result in a JSON file').ojf).toBe(false);
  });
  it('an older whisper.cpp: no --vad, -sns or -np in its argv even with a VAD model', async () => {
    const d = await temp();
    const wav = join(d, 'a.wav');
    await writeSilentWav(wav, 1);
    const program = await fakeWhisper(d, 'whisper-cli', { fixture: fixturePath('whisper-cpp.json'), help: 'usage: whisper-cli [options]\n  -l LANG' });
    await runWhisper({ engine: 'whisper.cpp', program, version: null, model: join(d, 'm.bin'), gpu: null, source: 'bundled', vadModel: join(d, 'vad.bin') }, wav, { language: null, signal: new AbortController().signal, timeoutMs: 20_000 });
    const run = (await callsOf(program)).find((a) => a.includes('-f'))!;
    expect(run).not.toContain('--vad');
    expect(run).not.toContain('-sns');
    expect(run).not.toContain('-np');
  });
});

describe('probeWhisper', () => {
  it('whisper.cpp reporting the GPU: a 1 s test-run with its flags, found, gpu true, the model file named', async () => {
    const d = await temp();
    const model = join(d, 'ggml-small.bin');
    await writeFile(model, 'x');
    const program = await fakeWhisper(d, 'whisper-cli', { fixture: fixturePath('whisper-cpp.json'), stderr: 'whisper_init_with_params_no_state: use gpu    = 1\n', version: 'version: 1.9.5', help: CPP_HELP });
    const r = await probeWhisper(program, 'whisper.cpp', { modelFile: model, modelName: 'small' });
    expect(r).toMatchObject({ engine: 'whisper.cpp', program, model, gpu: true, version: '1.9.5' });
    expect((await callsOf(program)).find((a) => a.includes('-f'))).toEqual(expect.arrayContaining(['-sns', '-np']));
  });
  it('a failing whisper.cpp: the problem is its stderr\'s last line', async () => {
    const d = await temp();
    await writeFile(join(d, 'm.bin'), 'x');
    const program = await fakeWhisper(d, 'whisper-cli', { stderr: 'loading model\nerror: invalid model file\n', exit: 1 });
    expect(await probeWhisper(program, 'whisper.cpp', { modelFile: join(d, 'm.bin'), modelName: 'small' })).toEqual({ problem: 'error: invalid model file' });
  });
  it('whisper.cpp without a model file, or a program that is not there: a problem', async () => {
    const d = await temp();
    const program = await fakeWhisper(d, 'whisper-cli', {});
    expect(await probeWhisper(program, 'whisper.cpp', { modelFile: join(d, 'none.bin'), modelName: 'small' })).toMatchObject({ problem: expect.any(String), needsModel: true });
    expect(await probeWhisper(join(d, 'nope'), 'openai-whisper', { modelName: 'small' })).toHaveProperty('problem');
  });
  it('a Python engine is never made to transcribe (it could download its model): its --help is checked, and its cache looked at', async () => {
    const d = await temp(), home = await temp();
    const program = await fakeWhisper(d, 'whisper', { fixture: fixturePath('openai-whisper.json') });
    const env = { HOME: home };
    expect(await probeWhisper(program, 'openai-whisper', { modelName: 'large-v3-turbo', env })).toMatchObject({ engine: 'openai-whisper', model: 'large-v3-turbo', gpu: null, downloadsOwnModel: true });
    expect((await callsOf(program)).every((a) => a.includes('--help') || a.includes('--version'))).toBe(true);
    await mkdir(join(home, '.cache', 'whisper'), { recursive: true });
    await writeFile(join(home, '.cache', 'whisper', 'large-v3-turbo.pt'), 'x');
    expect(await probeWhisper(program, 'openai-whisper', { modelName: 'large-v3-turbo', env })).toMatchObject({ downloadsOwnModel: false });
    const ct2 = await fakeWhisper(d, 'whisper-ctranslate2', {});
    await mkdir(join(home, '.cache', 'huggingface', 'hub', 'models--Systran--faster-whisper-small'), { recursive: true });
    expect(await probeWhisper(ct2, 'faster-whisper', { modelName: 'small', env })).toMatchObject({ downloadsOwnModel: false });
  });
  it('a broken Python engine: its --help failing is the problem', async () => {
    const d = await temp();
    const program = await fakeWhisper(d, 'whisper', { broken: true, stderr: 'Traceback\nModuleNotFoundError: No module named torch\n', exit: 1 });
    expect(await probeWhisper(program, 'openai-whisper', { modelName: 'small' })).toEqual({ problem: 'ModuleNotFoundError: No module named torch' });
  });
  it('the silent wav is one second of 16 kHz mono PCM', async () => {
    const f = join(await temp(), 'a.wav');
    await writeSilentWav(f, 1);
    expect((await stat(f)).size).toBe(44 + 32000);
  });
});

describe('resolveWhisper: settings → bundled → detected (never runs a program)', () => {
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
    expect(await callsOf(custom)).toEqual([]);
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
  it('a detected whisper.cpp uses the downloaded model, never a VAD model; one with a problem or needing a model is skipped', async () => {
    const app = await temp();
    await mkdir(join(app, 'whisper'), { recursive: true });
    await writeFile(join(app, 'whisper', 'ggml-small.bin'), 'x');
    await writeFile(join(app, 'whisper', 'ggml-silero-v6.2.0.bin'), 'v');
    const cpp = { engine: 'whisper.cpp' as const, program: '/opt/homebrew/bin/whisper-cli', version: '1.8.0', model: '', gpu: null, source: 'detected' as const };
    const r = await resolveWhisper({ settings: settings(), appDataDir: app, detected: async () => [cpp] });
    expect(r).toMatchObject({ program: '/opt/homebrew/bin/whisper-cli', model: join(app, 'whisper', 'ggml-small.bin') });
    expect(r).not.toHaveProperty('vadModel');
    expect(await resolveWhisper({ settings: settings(), appDataDir: app, detected: async () => [{ ...cpp, problem: 'boom' }] })).toBeNull();
    expect(await resolveWhisper({ settings: settings(), appDataDir: app, detected: async () => [{ ...cpp, problem: 'no model', needsModel: true }] })).toBeNull();
  });
});


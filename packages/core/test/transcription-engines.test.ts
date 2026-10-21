import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runChild } from '../src/transcription/child-run.ts';
import { parseFasterWhisper, parseOpenAiWhisper, parseWhisperCpp, pythonModelName, runWhisper, whisperArgs } from '../src/transcription/engines.ts';
import { fakeWhisper, fixturePath } from './helpers/fake-whisper.ts';

const json = async (name: string) => JSON.parse(await readFile(fixturePath(name), 'utf8')) as unknown;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('engine output parsers (recorded fixtures)', () => {
  it('whisper.cpp: offsets in ms, text trimmed, empty segments dropped, the detected language', async () => {
    const r = parseWhisperCpp(await json('whisper-cpp.json'));
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]).toEqual({ from: 0, to: 2.5, text: 'Ciao a tutti, benvenuti.' });
    expect(r.segments[1]).toEqual({ from: 3, to: 6.12, text: 'Questo è il nuovo prodotto.' });
    expect(r.language).toBe('it');
  });
  it('openai-whisper: segments start/end/text and language', async () => {
    const r = parseOpenAiWhisper(await json('openai-whisper.json'));
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]).toEqual({ from: 0, to: 2.48, text: 'Hello everyone, welcome.' });
    expect(r.language).toBe('en');
  });
  it('faster-whisper (whisper-ctranslate2): same shape, empty dropped', async () => {
    const r = parseFasterWhisper(await json('faster-whisper.json'));
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]).toEqual({ from: 0, to: 1.92, text: 'Hola a todos.' });
    expect(r.language).toBe('es');
  });
  it('refuses something that is not an engine output', () => {
    expect(() => parseWhisperCpp({ nope: 1 })).toThrow();
    expect(() => parseOpenAiWhisper([])).toThrow();
  });
});

describe('whisperArgs', () => {
  it('whisper.cpp: model, wav, JSON out, no prints, no non-speech tokens, VAD when given, auto language', () => {
    expect(whisperArgs('whisper.cpp', { program: '/b/whisper-cli', wav: '/t/a.wav', outDir: '/t/o', model: '/m/ggml-small.bin', vadModel: '/m/vad.bin', language: null }))
      .toEqual(['-m', '/m/ggml-small.bin', '-f', '/t/a.wav', '-oj', '-of', '/t/o/out', '-np', '-sns', '--vad', '--vad-model', '/m/vad.bin', '-l', 'auto']);
    expect(whisperArgs('whisper.cpp', { program: '/b/whisper-cli', wav: '/t/a.wav', outDir: '/t/o', model: '/m/ggml-small.bin', language: 'it' }))
      .toEqual(['-m', '/m/ggml-small.bin', '-f', '/t/a.wav', '-oj', '-of', '/t/o/out', '-np', '-sns', '-l', 'it']);
  });
  it('the Python engines: wav first, model name, JSON into the out folder, language only when set', () => {
    for (const e of ['openai-whisper', 'faster-whisper'] as const) {
      expect(whisperArgs(e, { program: '/b/whisper', wav: '/t/a.wav', outDir: '/t/o', model: 'small', language: null }))
        .toEqual(['/t/a.wav', '--model', 'small', '--output_format', 'json', '--output_dir', '/t/o']);
      expect(whisperArgs(e, { program: '/b/whisper', wav: '/t/a.wav', outDir: '/t/o', model: 'small', language: 'en' }))
        .toEqual(['/t/a.wav', '--model', 'small', '--output_format', 'json', '--output_dir', '/t/o', '--language', 'en']);
    }
    expect(pythonModelName('large-v3-turbo')).toBe('large-v3-turbo');
    expect(pythonModelName('small')).toBe('small');
  });
});

describe('runWhisper against fake engines', () => {
  it('each engine: the fake writes its recorded output, the segments come back, the temp folder goes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-fw-'));
    const wav = join(dir, 'audio clip.wav');
    await writeFile(wav, Buffer.alloc(100));
    const cases = [
      { engine: 'whisper.cpp' as const, name: 'whisper-cli', fixture: 'whisper-cpp.json', model: join(dir, 'ggml-small.bin'), first: 'Ciao a tutti, benvenuti.' },
      { engine: 'openai-whisper' as const, name: 'whisper', fixture: 'openai-whisper.json', model: 'small', first: 'Hello everyone, welcome.' },
      { engine: 'faster-whisper' as const, name: 'whisper-ctranslate2', fixture: 'faster-whisper.json', model: 'small', first: 'Hola a todos.' },
    ];
    for (const c of cases) {
      const program = await fakeWhisper(join(dir, c.engine), c.name, { fixture: fixturePath(c.fixture) });
      const r = await runWhisper({ engine: c.engine, program, version: null, model: c.model, gpu: null, source: 'settings' }, wav, { language: null, signal: new AbortController().signal, timeoutMs: 20_000 });
      expect(r.segments[0]!.text).toBe(c.first);
      const args = JSON.parse(await readFile(`${program}.args.json`, 'utf8')) as string[];
      const out = args[args.indexOf(c.engine === 'whisper.cpp' ? '-of' : '--output_dir') + 1]!;
      expect(out).toContain('ms-whisper-');
      await vi.waitFor(async () => expect(await readFile(c.engine === 'whisper.cpp' ? `${out}.json` : join(out, 'audio clip.json')).catch(() => null)).toBeNull());
    }
  }, 30_000);
  it('a failing engine: the error names its last stderr line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-fw-'));
    const program = await fakeWhisper(dir, 'whisper-cli', { stderr: 'loading\nerror: failed to open model\n', exit: 1 });
    await expect(runWhisper({ engine: 'whisper.cpp', program, version: null, model: '/x.bin', gpu: null, source: 'settings' }, join(dir, 'a.wav'), { language: null, signal: new AbortController().signal, timeoutMs: 20_000 }))
      .rejects.toThrow(/failed to open model/);
  });
});

describe('runChild', () => {
  it('captures output and the exit code, without a shell', async () => {
    const r = await runChild(process.execPath, ['-e', 'process.stdout.write("a;b $HOME"); process.stderr.write("e"); process.exit(3)'], { timeoutMs: 10_000 });
    expect(r).toMatchObject({ code: 3, stdout: 'a;b $HOME', stderr: 'e', timedOut: false, cancelled: false });
  });
  it('the core\'s secrets never reach the child, even when the caller passes an env', async () => {
    const names = ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'PEXELS_API_KEY', 'UNSPLASH_ACCESS_KEY', 'MOTION_STUDIO_BRIDGE_TOKEN'];
    const saved = names.map((n) => [n, process.env[n]] as const);
    for (const n of names) process.env[n] = `secret-${n}`;
    try {
      const print = ['-e', 'process.stdout.write(JSON.stringify(process.env))'];
      const own = JSON.parse((await runChild(process.execPath, print, { timeoutMs: 10_000 })).stdout) as Record<string, string>;
      const given = JSON.parse((await runChild(process.execPath, print, { timeoutMs: 10_000, env: { ...process.env, KEEP: 'yes' } })).stdout) as Record<string, string>;
      for (const n of names) { expect(own[n]).toBeUndefined(); expect(given[n]).toBeUndefined(); }
      expect(given.KEEP).toBe('yes');
      expect(own.PATH).toBe(process.env.PATH);
    } finally {
      for (const [n, v] of saved) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
    }
  });
  it('a missing program: no throw, a null code and the reason', async () => {
    const r = await runChild('/nonexistent/whisper-cli', [], { timeoutMs: 5000 });
    expect(r.code).toBeNull();
    expect(r.stderr).toMatch(/ENOENT/);
  });
  it('timeout: its own child is killed and gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-fw-'));
    const program = await fakeWhisper(dir, 'whisper-cli', { sleep: true });
    const r = await runChild(program, [], { timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    const pid = Number(await readFile(`${program}.pid`, 'utf8'));
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  }, 15_000);
  it('abort: cancelled, the child is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-fw-'));
    const program = await fakeWhisper(dir, 'whisper-cli', { sleep: true });
    const ac = new AbortController();
    const p = runChild(program, [], { timeoutMs: 20_000, signal: ac.signal });
    await vi.waitFor(async () => expect(await readFile(`${program}.pid`, 'utf8').catch(() => '')).not.toBe(''));
    ac.abort();
    const r = await p;
    expect(r.cancelled).toBe(true);
    const pid = Number(await readFile(`${program}.pid`, 'utf8'));
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  }, 15_000);
});

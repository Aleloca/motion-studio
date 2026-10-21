import { constants } from 'node:fs';
import { access, lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import type { TranscriptionSettings, WhisperEngine, WhisperFound } from '@motion-studio/shared';
import { t } from '../i18n.ts';
import { lastLine, runChild } from './child-run.ts';
import { parseFasterWhisper, parseOpenAiWhisper, parseWhisperCpp, pythonModelName, whisperArgs } from './engines.ts';
import { writeSilentWav } from './wav.ts';

/** Spec §7: the names each engine's CLI goes by. `main` (old whisper.cpp builds) only when its help mentions whisper. */
export const WHISPER_NAMES: Record<WhisperEngine, string[]> = {
  'whisper.cpp': ['whisper-cli', 'whisper-cpp', 'main'],
  'openai-whisper': ['whisper'],
  'faster-whisper': ['whisper-ctranslate2', 'faster-whisper'],
};
/** The Homebrew folders (Apple Silicon, Intel), searched besides the login-shell PATH. */
export const HOMEBREW_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];
/** The bundled VAD model's file name (whisper.cpp's Silero, spec §7). */
export const SILERO_FILE = 'ggml-silero-v6.2.0.bin';
/** The first whisper.cpp release with `--vad` (an older one would refuse the flag). */
const VAD_SINCE = [1, 7, 6];

const IDENTIFY_TIMEOUT_MS = 10_000;
/** A test-run: whisper.cpp loads its model; a Python engine may download its model into its own cache first. */
const PROBE_TIMEOUT_MS: Record<WhisperEngine, number> = { 'whisper.cpp': 120_000, 'openai-whisper': 15 * 60_000, 'faster-whisper': 15 * 60_000 };

export const modelFileOf = (appDataDir: string, model: string) => join(appDataDir, 'whisper', `ggml-${model}.bin`);
const isFile = async (p: string) => (await stat(p).catch(() => null))?.isFile() === true;
const isExecutable = async (p: string) => (await isFile(p)) && (await access(p, constants.X_OK).then(() => true, () => false));
const versionIn = (text: string) => text.match(/\bv?(\d+\.\d+(?:\.\d+)?)\b/)?.[1] ?? null;
const atLeast = (v: string | null, min: number[]) => {
  if (!v) return false;
  const p = v.split('.').map(Number);
  for (let i = 0; i < min.length; i++) if ((p[i] ?? 0) !== min[i]) return (p[i] ?? 0) > min[i]!;
  return true;
};

/**
 * Who a program on the PATH is, without running a transcription: its version (`--version`, when it answers), and for an
 * old whisper.cpp `main` whether its help mentions whisper (null: not a Whisper). The model is not known yet ('').
 */
export async function identifyWhisper(program: string, engine: WhisperEngine): Promise<WhisperFound | null> {
  if (/^main(\.exe)?$/i.test(basename(program))) {
    const help = await runChild(program, ['--help'], { timeoutMs: IDENTIFY_TIMEOUT_MS });
    if (!/whisper/i.test(`${help.stdout}\n${help.stderr}`)) return null;
  }
  const v = await runChild(program, ['--version'], { timeoutMs: IDENTIFY_TIMEOUT_MS });
  const version = v.code === 0 ? versionIn(`${v.stdout}\n${v.stderr}`) : null;
  return { engine, program, version, model: '', gpu: null, source: 'detected' };
}

/**
 * Spec §7: every Whisper on the login-shell PATH (`LoginShellPath.path`) and in the Homebrew folders, under each engine's
 * names, in PATH order; one entry per real file. `probe` says what each one is (null: not a Whisper).
 */
export async function detectWhispers(o: { pathEnv: string; extraDirs?: string[]; probe: (program: string, engine: WhisperEngine) => Promise<WhisperFound | null> }): Promise<WhisperFound[]> {
  const dirs = [...new Set([...o.pathEnv.split(delimiter), ...(o.extraDirs ?? HOMEBREW_DIRS)].filter((d) => d.startsWith('/') || /^[A-Za-z]:[\\/]/.test(d)))];
  const seen = new Set<string>();
  const out: WhisperFound[] = [];
  for (const engine of Object.keys(WHISPER_NAMES) as WhisperEngine[]) {
    for (const dir of dirs) {
      for (const name of WHISPER_NAMES[engine]) {
        for (const program of process.platform === 'win32' ? [join(dir, `${name}.exe`), join(dir, `${name}.cmd`)] : [join(dir, name)]) {
          if (!(await isExecutable(program))) continue;
          const real = await realpath(program).catch(() => program);
          if (seen.has(real)) continue;
          seen.add(real);
          const found = await o.probe(program, engine).catch(() => null);
          if (found) out.push(found);
        }
      }
    }
  }
  return out;
}

/**
 * The test-run before a Whisper is saved (spec §7): one second of generated silence through the engine, as a real
 * transcription would run. Gives what was found (version, model, GPU from whisper.cpp's own report; null for the Python
 * engines) or `{ problem }` (the engine's last stderr line).
 */
export async function probeWhisper(program: string, engine: WhisperEngine, o: { modelFile?: string; modelName: string; vadModel?: string; signal?: AbortSignal }): Promise<WhisperFound | { problem: string }> {
  if (!(await isExecutable(program))) return { problem: t().errors.whisperNotFound };
  if (engine === 'whisper.cpp' && !(o.modelFile && await isFile(o.modelFile))) return { problem: t().errors.whisperModelMissing };
  const dir = await mkdtemp(join(tmpdir(), 'ms-whisper-probe-'));
  try {
    const wav = join(dir, 'probe.wav');
    await writeSilentWav(wav, 1);
    const model = engine === 'whisper.cpp' ? o.modelFile! : o.modelName;
    const r = await runChild(program, whisperArgs(engine, { program, wav, outDir: dir, model, ...(o.vadModel ? { vadModel: o.vadModel } : {}), language: null }), { timeoutMs: PROBE_TIMEOUT_MS[engine], cwd: dir, ...(o.signal ? { signal: o.signal } : {}) });
    if (r.cancelled) return { problem: 'cancelled' };
    if (r.timedOut) return { problem: t().errors.timedOut({ seconds: PROBE_TIMEOUT_MS[engine] / 1000 }) };
    if (r.code !== 0) return { problem: lastLine(r.stderr) || t().errors.exitCode({ code: r.code ?? -1 }) };
    const out = engine === 'whisper.cpp' ? join(dir, 'out.json') : join(dir, 'probe.json');
    try {
      const json = JSON.parse(await readFile(out, 'utf8')) as unknown;
      if (engine === 'whisper.cpp') parseWhisperCpp(json); else if (engine === 'openai-whisper') parseOpenAiWhisper(json); else parseFasterWhisper(json);
    } catch {
      return { problem: `${engine}: no usable output` };
    }
    const gpu = engine !== 'whisper.cpp' ? null : /use gpu\s*=\s*1|ggml_metal_init/.test(r.stderr) ? true : false;
    const id = await identifyWhisper(program, engine).catch(() => null);
    return { engine, program, version: id?.version ?? null, model, gpu, source: 'settings' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export type ResolvedWhisper = WhisperFound & { vadModel?: string };

/**
 * The Whisper an analysis uses now (spec §7, lookup order): the program set in Settings → the bundled `whisper-cli`
 * (`whisperDir`) with the model downloaded into `<appData>/whisper/` → the first one detected. A whisper.cpp without a
 * model file counts as not available. VAD: the bundled Silero model for the bundled binary; for another whisper.cpp only a
 * downloaded one, and only from the release that knows `--vad`.
 */
export async function resolveWhisper(o: { settings: TranscriptionSettings; whisperDir?: string; appDataDir: string; detected: () => Promise<WhisperFound[]> }): Promise<ResolvedWhisper | null> {
  const ownModel = modelFileOf(o.appDataDir, o.settings.model);
  const downloadedVad = join(o.appDataDir, 'whisper', SILERO_FILE);
  const vadFor = async (version: string | null) => (atLeast(version, VAD_SINCE) && await isFile(downloadedVad) ? { vadModel: downloadedVad } : {});
  const c = o.settings.custom;
  if (c && await isExecutable(c.program)) {
    if (c.engine !== 'whisper.cpp') return { engine: c.engine, program: c.program, version: null, model: pythonModelName(o.settings.model), gpu: null, source: 'settings' };
    const model = c.modelFile ?? ownModel;
    if (await isFile(model)) return { engine: 'whisper.cpp', program: c.program, version: null, model, gpu: null, source: 'settings' };
  }
  if (o.whisperDir) {
    const program = join(o.whisperDir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
    if (await isExecutable(program) && await isFile(ownModel)) {
      const vad = join(o.whisperDir, SILERO_FILE);
      return { engine: 'whisper.cpp', program, version: null, model: ownModel, gpu: null, source: 'bundled', ...((await lstat(vad).catch(() => null))?.isFile() ? { vadModel: vad } : {}) };
    }
  }
  for (const d of await o.detected().catch(() => [])) {
    if (d.engine !== 'whisper.cpp') return { ...d, model: pythonModelName(o.settings.model), source: 'detected' };
    if (await isFile(ownModel)) return { ...d, model: ownModel, source: 'detected', ...(await vadFor(d.version)) };
  }
  return null;
}

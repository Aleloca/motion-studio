import { constants } from 'node:fs';
import { access, lstat, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import type { TranscriptionSettings, WhisperEngine, WhisperFound } from '@motion-studio/shared';
import { t } from '../i18n.ts';
import { lastLine, runChild } from './child-run.ts';
import { engineFlags, parseWhisperCpp, pythonModelName, versionOf, whisperArgs, whisperHelp } from './engines.ts';

export { engineFlags, versionOf } from './engines.ts';
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
const IDENTIFY_TIMEOUT_MS = 10_000;
/** The test-run of a whisper.cpp (it loads its model and transcribes one second). */
const PROBE_TIMEOUT_MS = 120_000;

export const modelFileOf = (appDataDir: string, model: string) => join(appDataDir, 'whisper', `ggml-${model}.bin`);
const isFile = async (p: string) => (await stat(p).catch(() => null))?.isFile() === true;
const isExecutable = async (p: string) => (await isFile(p)) && (await access(p, constants.X_OK).then(() => true, () => false));
/**
 * Who a program on the PATH is, without running a transcription: an old whisper.cpp `main` only when its `--help` mentions
 * whisper (null: not a Whisper); the version only when `--version` really prints one (decision 1550). The model is not
 * known yet ('').
 */
export async function identifyWhisper(program: string, engine: WhisperEngine): Promise<WhisperFound | null> {
  if (/^main(\.exe)?$/i.test(basename(program)) && !/whisper/i.test((await whisperHelp(program)).text)) return null;
  const v = await runChild(program, ['--version'], { timeoutMs: IDENTIFY_TIMEOUT_MS });
  const version = v.code === 0 ? versionOf(`${v.stdout}\n${v.stderr}`) : null;
  return { engine, program, version, model: '', gpu: null, source: 'detected' };
}

/**
 * Whether a Python engine already has `model` in its own cache (decision 1552; looked up, never downloaded): openai-whisper
 * keeps `<cache>/whisper/<name>.pt`, faster-whisper the Hugging Face hub's `models--*--faster-whisper-<name>*` folders.
 */
export async function pythonModelCached(engine: WhisperEngine, model: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const cache = env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache');
  if (engine === 'openai-whisper') return isFile(join(cache, 'whisper', `${model}.pt`));
  const hub = env.HF_HUB_CACHE || (env.HF_HOME ? join(env.HF_HOME, 'hub') : join(cache, 'huggingface', 'hub'));
  return (await readdir(hub).catch(() => [] as string[])).some((d) => d.startsWith('models--') && d.toLowerCase().includes(`faster-whisper-${model}`));
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
 * The check of a Whisper before it is saved or offered (spec §7, decisions 1551–1552). A whisper.cpp transcribes one second
 * of generated silence with the flags its `--help` lists (no VAD): version, model and GPU from its own report, or
 * `{ problem }` (its last stderr line); without a model file it cannot be checked (`needsModel`). A Python engine is never
 * made to transcribe here (it would download its model): its `--help` must work, and its cache says whether the model is
 * already there (`downloadsOwnModel` otherwise).
 */
export async function probeWhisper(program: string, engine: WhisperEngine, o: { modelFile?: string; modelName: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<WhisperFound | { problem: string; needsModel?: true }> {
  if (!(await isExecutable(program))) return { problem: t().errors.whisperNotFound };
  if (engine !== 'whisper.cpp') {
    const help = await whisperHelp(program);
    if (!help.ok || !/whisper|--model/i.test(help.text)) return { problem: lastLine(help.text) || t().errors.whisperNotFound };
    const id = await identifyWhisper(program, engine).catch(() => null);
    return { engine, program, version: id?.version ?? null, model: o.modelName, gpu: null, source: 'settings', downloadsOwnModel: !(await pythonModelCached(engine, o.modelName, o.env)) };
  }
  if (!(o.modelFile && await isFile(o.modelFile))) return { problem: t().errors.whisperModelMissing, needsModel: true };
  const dir = await mkdtemp(join(tmpdir(), 'ms-whisper-probe-'));
  try {
    const wav = join(dir, 'probe.wav');
    await writeSilentWav(wav, 1);
    const flags = engineFlags((await whisperHelp(program)).text);
    const r = await runChild(program, whisperArgs(engine, { program, wav, outDir: dir, model: o.modelFile, language: null, flags }), { timeoutMs: PROBE_TIMEOUT_MS, cwd: dir, ...(o.signal ? { signal: o.signal } : {}) });
    if (r.cancelled) return { problem: 'cancelled' };
    if (r.timedOut) return { problem: t().errors.timedOut({ seconds: PROBE_TIMEOUT_MS / 1000 }) };
    if (r.code !== 0) return { problem: lastLine(r.stderr) || t().errors.exitCode({ code: r.code ?? -1 }) };
    try { parseWhisperCpp(JSON.parse(await readFile(join(dir, 'out.json'), 'utf8')) as unknown); }
    catch { return { problem: `${engine}: no usable output` }; }
    const gpu = /use gpu\s*=\s*1|ggml_metal_init/.test(r.stderr);
    const id = await identifyWhisper(program, engine).catch(() => null);
    return { engine, program, version: id?.version ?? null, model: o.modelFile, gpu, source: 'settings' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export type ResolvedWhisper = WhisperFound & { vadModel?: string };

/**
 * The Whisper an analysis uses now (spec §7, lookup order): the program set in Settings → the bundled `whisper-cli`
 * (`whisperDir`) with the model downloaded into `<appData>/whisper/` → the first one detected. A whisper.cpp without a
 * model file counts as not available, and so does a detected one that failed its check. VAD only with the bundled binary and
 * its bundled Silero model (decision 1550; the run drops it when the binary's `--help` lacks `--vad`). Runs no program.
 */
export async function resolveWhisper(o: { settings: TranscriptionSettings; whisperDir?: string; appDataDir: string; detected: () => Promise<WhisperFound[]> }): Promise<ResolvedWhisper | null> {
  const ownModel = modelFileOf(o.appDataDir, o.settings.model);
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
    if (d.problem !== undefined || d.needsModel) continue;
    if (d.engine !== 'whisper.cpp') return { ...d, model: pythonModelName(o.settings.model), source: 'detected' };
    if (await isFile(ownModel)) return { ...d, model: ownModel, source: 'detected' };
  }
  return null;
}

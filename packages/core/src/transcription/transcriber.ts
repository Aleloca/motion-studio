import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  TranscribeMethod, TranscriptionChoice, TranscriptionModelId, TranscriptionPending, TranscriptionSettings, TranscriptionSettingsPatch,
  TranscriptionStatus, TranscriptKind, TranscriptSegment, WhisperEngine, WhisperFound,
} from '@motion-studio/shared';
import type { AppConfigStore } from '../app-config.ts';
import { currentLocale, t } from '../i18n.ts';
import type { SecretsVault } from '../secrets/vault.ts';
import type { UsageLedger } from '../usage/usage-ledger.ts';
import { CodedError } from '../workspace-store.ts';
import { detectWhispers, identifyWhisper, modelFileOf, probeWhisper, pythonModelCached, resolveWhisper, WHISPER_NAMES, type ResolvedWhisper } from './detect.ts';
import { elevenlabsTranscribe } from './elevenlabs-stt.ts';
import { pythonModelName, runWhisper } from './engines.ts';
import { installedModels, installWhisperModel, removeWhisperModel, WHISPER_MODELS, WHISPER_REDIRECT_HOSTS, type WhisperModelManifest } from './models.ts';
import { openaiTranscribe } from './openai-stt.ts';
import { estimateSttCost, recordTranscriptionUsage, STT_PRICES_USD_PER_MIN, type SttProvider } from './pricing.ts';

/** What happens to a video's speech (spec §6): run a method now, ask the user, or skip it (`never`). */
export type TranscriptionPlan = { run: TranscribeMethod } | { ask: TranscriptionPending } | { skip: true };

export interface TranscriptionDeps {
  config: AppConfigStore;
  vault: SecretsVault;
  ledger: UsageLedger;
  /** `<appData>`: the models live in `<appData>/whisper/`. Null: no models (nothing is downloaded). */
  appDataDir: string | null;
  /** The bundled `whisper-cli` folder (desktop resources); absent: none. */
  whisperDir?: string;
  /** Network of the providers and of the model downloads (tests: a fake fetch). */
  fetch: typeof fetch;
  /** Replaces the whole detection (test seam). Default: `detectWhispers` on `pathEnv`, each found program checked once. */
  detect?: () => Promise<WhisperFound[]>;
  /** The PATH searched (default `process.env.PATH`, the login shell's in the desktop app); under vitest, none unless given. */
  pathEnv?: string;
  /** Folders searched besides the PATH (default: the Homebrew ones). */
  extraDirs?: string[];
  /** Where the Python engines' caches are looked for (HOME, XDG_CACHE_HOME, HF_HOME…; default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Test seam: the model manifest and the redirect hosts of its downloads. */
  manifest?: WhisperModelManifest;
  redirectHosts?: readonly string[];
}

const PROVIDER_LABEL: Record<SttProvider, string> = { openai: 'OpenAI', elevenlabs: 'ElevenLabs' };
const isExecutable = (p: string) => access(p, constants.X_OK).then(() => true, () => false);
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/**
 * Phase 2 (spec §6–§7): the transcription of the analyses. Resolves the method from the app-wide settings (`never` skips,
 * a saved method that works runs, `ask` or a saved method that no longer works asks), builds the dialog's offer, applies
 * the user's choice (a model download only with the size the user saw), runs Whisper or a provider, and records a paid
 * transcription's cost in `usage.jsonl`. Language: auto-detected, the app language when the engine reports none
 * (decision 1503).
 */
export class TranscriptionService {
  /** Decision 1553: what the last detection found; read by every call, refreshed only in the background or on request. */
  private detection: { list: WhisperFound[]; state: 'idle' | 'running' | 'done'; at: string | null; running: Promise<WhisperFound[]> | null } = { list: [], state: 'idle', at: null, running: null };
  /** Each detected program's check, by path, size, mtime, engine and model (decision 1551): a binary is test-run once. */
  private readonly checks = new Map<string, Promise<WhisperFound | null>>();
  private download: TranscriptionStatus['download'] = { state: 'idle', model: null, bytes: 0, total: 0 };
  private running: { model: TranscriptionModelId; done: Promise<void> } | null = null;
  private readonly manifest: WhisperModelManifest;

  constructor(private readonly deps: TranscriptionDeps) {
    this.manifest = deps.manifest ?? WHISPER_MODELS;
  }

  settings(): Promise<TranscriptionSettings> { return this.deps.config.readTranscription(); }

  /** The Whispers the last detection found (decision 1553): runs nothing. */
  detectedWhispers(): Promise<WhisperFound[]> { return Promise.resolve(this.detection.list); }

  /** Detection in the background (server start; after a setting or a model changes). */
  startDetection(): void { void this.detect().catch(() => {}); }

  /**
   * Looks for Whispers on the PATH and in Homebrew and checks each one (decision 1551): a whisper.cpp is test-run on one
   * second of silence with the model of the setting (without one it `needsModel`), a Python engine only answers `--help`.
   * One that fails is listed with its `problem` and never used. A detection already running is joined.
   */
  detect(): Promise<WhisperFound[]> {
    if (this.detection.running) return this.detection.running;
    const run = async (): Promise<WhisperFound[]> => {
      if (this.deps.detect) return this.deps.detect();
      if (this.deps.pathEnv === undefined && process.env.VITEST) return [];
      const s = await this.settings();
      const modelFile = this.deps.appDataDir ? modelFileOf(this.deps.appDataDir, s.model) : undefined;
      return detectWhispers({
        pathEnv: this.deps.pathEnv ?? process.env.PATH ?? '', ...(this.deps.extraDirs ? { extraDirs: this.deps.extraDirs } : {}),
        probe: (program, engine) => this.checkDetected(program, engine, modelFile, pythonModelName(s.model)),
      });
    };
    this.detection.state = 'running';
    const running = run().catch(() => [] as WhisperFound[]).then((list) => {
      this.detection = { list, state: 'done', at: new Date().toISOString(), running: null };
      return list;
    });
    this.detection.running = running;
    return running;
  }

  private async checkDetected(program: string, engine: WhisperEngine, modelFile: string | undefined, modelName: string): Promise<WhisperFound | null> {
    const st = await stat(program).catch(() => null);
    const mst = modelFile ? await stat(modelFile).catch(() => null) : null;
    const key = [program, st?.size, st?.mtimeMs, engine, modelFile, mst?.size, mst?.mtimeMs, modelName].join('\0');
    let p = this.checks.get(key);
    if (!p) {
      p = (async (): Promise<WhisperFound | null> => {
        // An old whisper.cpp `main` that is not whisper is never test-run.
        if (!(await identifyWhisper(program, engine))) return null;
        const r = await probeWhisper(program, engine, { ...(modelFile ? { modelFile } : {}), modelName, ...(this.deps.env ? { env: this.deps.env } : {}) });
        if (!isProblem(r)) return { ...r, source: 'detected' };
        return { engine, program, version: null, model: '', gpu: null, source: 'detected', problem: r.problem, ...(r.needsModel ? { needsModel: true } : {}) };
      })();
      this.checks.set(key, p);
    }
    return p;
  }

  /** A Python engine's first transcription downloads its model when it is not in its cache (looked up, nothing run). */
  private async downloadsOwnModel(w: WhisperFound): Promise<boolean> {
    return w.engine !== 'whisper.cpp' && !(await pythonModelCached(w.engine, w.model, this.deps.env));
  }

  /** The Whisper that would run now, with its model (lookup order §7), or null. */
  async whisper(settings?: TranscriptionSettings): Promise<ResolvedWhisper | null> {
    if (!this.deps.appDataDir) return null;
    return resolveWhisper({ settings: settings ?? await this.settings(), appDataDir: this.deps.appDataDir, ...(this.deps.whisperDir ? { whisperDir: this.deps.whisperDir } : {}), detected: () => this.detectedWhispers() });
  }

  private bundledProgram(): string | null {
    return this.deps.whisperDir ? join(this.deps.whisperDir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli') : null;
  }

  /**
   * Whether the downloaded model alone would make Whisper work: a bundled `whisper-cli`, or a whisper.cpp set in Settings
   * (without its own model file) or detected.
   */
  private async canInstall(settings: TranscriptionSettings): Promise<boolean> {
    if (!this.deps.appDataDir) return false;
    const bundled = this.bundledProgram();
    if (bundled && await isExecutable(bundled)) return true;
    if (settings.custom?.engine === 'whisper.cpp' && !settings.custom.modelFile && await isExecutable(settings.custom.program)) return true;
    return this.detection.list.some((d) => d.engine === 'whisper.cpp' && (d.problem === undefined || d.needsModel));
  }

  private async hasKey(p: SttProvider): Promise<boolean> { return (await this.deps.vault.get(p).catch(() => null)) !== null; }

  private async available(m: TranscribeMethod, settings: TranscriptionSettings): Promise<boolean> {
    return m === 'whisper' ? (await this.whisper(settings)) !== null : this.hasKey(m);
  }

  /** The dialog's offer for `audioSec` seconds of speech (spec §6): only the providers with a saved key. */
  async offer(audioSec: number, settings?: TranscriptionSettings): Promise<TranscriptionPending> {
    const s = settings ?? await this.settings();
    const found = await this.whisper(s);
    const bundled = this.bundledProgram();
    const usable = this.detection.list.filter((d) => d.problem === undefined || d.needsModel);
    const custom = s.custom !== null && await isExecutable(s.custom.program);
    const engine = found?.engine ?? (custom ? s.custom!.engine : null) ?? (bundled && await isExecutable(bundled) ? 'whisper.cpp' : null) ?? usable[0]?.engine ?? null;
    const ownModel = found ? await this.downloadsOwnModel(found) : engine !== null && engine !== 'whisper.cpp';
    return {
      kind: 'transcription', audioSec: Number(audioSec.toFixed(3)),
      whisper: {
        available: engine !== null, installed: found !== null && !ownModel, model: s.model, sizeBytes: this.manifest[s.model].sizeBytes,
        canInstall: await this.canInstall(s), engine, downloadsOwnModel: ownModel,
      },
      openai: await this.hasKey('openai') ? { costUsd: estimateSttCost('openai', audioSec) } : null,
      elevenlabs: await this.hasKey('elevenlabs') ? { costUsd: estimateSttCost('elevenlabs', audioSec) } : null,
    };
  }

  /** Spec §6: `never` → skip; a saved method that works → run; `ask`, or a saved method that does not work now → ask. */
  async plan(audioSec: number): Promise<TranscriptionPlan> {
    const s = await this.settings();
    if (s.method === 'never') return { skip: true };
    if (s.method === 'whisper') {
      // A detected Python engine whose first run would download its model waits for the user's choice (decision 1552).
      const w = await this.whisper(s);
      if (w && !(w.source === 'detected' && await this.downloadsOwnModel(w))) return { run: 'whisper' };
    } else if (s.method !== 'ask' && await this.available(s.method, s)) return { run: s.method };
    return { ask: await this.offer(audioSec, s) };
  }

  /**
   * Checks the user's answer and gets it ready (spec §6). `openai`/`elevenlabs` need a saved key (409
   * `transcription-no-key`); `whisper` works now, or its model is downloaded when the size the user saw matches the
   * manifest (409 `download-size-changed`) and something can run it (409 `whisper-not-found`). `remember` saves the method
   * (`none` → `never`). `wait`: the download, when one started.
   */
  async prepareChoice(c: TranscriptionChoice): Promise<{ wait?: Promise<void> }> {
    const s = await this.settings();
    let wait: Promise<void> | undefined;
    if (c.choice === 'openai' || c.choice === 'elevenlabs') {
      if (!await this.hasKey(c.choice)) throw new CodedError(409, t().errors.transcriptionNoKey({ provider: PROVIDER_LABEL[c.choice] }), 'transcription-no-key');
    } else if (c.choice === 'whisper' && !(await this.whisper(s))) {
      if (!await this.canInstall(s)) throw new CodedError(409, t().errors.whisperNotFound, 'whisper-not-found');
      wait = this.startDownload(s.model, c.sizeBytes);
    }
    if (c.remember) await this.deps.config.setTranscription({ method: c.choice === 'none' ? 'never' : c.choice });
    return wait ? { wait } : {};
  }

  /**
   * Downloads a model (one at a time; the same model asked again joins the running download). Refused before any request
   * when the size the user saw is not the manifest's, or another model is downloading.
   */
  startDownload(model: TranscriptionModelId, sizeBytes: number | undefined): Promise<void> {
    if (!this.deps.appDataDir) throw new CodedError(409, t().errors.transcriptionNoBundled, 'whisper-not-found');
    if (sizeBytes !== this.manifest[model].sizeBytes) throw new CodedError(409, t().errors.downloadSizeChanged, 'download-size-changed');
    if (this.running) {
      if (this.running.model === model) return this.running.done;
      throw new CodedError(409, t().errors.downloadBusy, 'download-busy');
    }
    const total = this.manifest[model].sizeBytes;
    this.download = { state: 'running', model, bytes: 0, total };
    const done = installWhisperModel({
      id: model, appDataDir: this.deps.appDataDir, consent: true, sizeBytes, fetchImpl: this.deps.fetch, manifest: this.manifest,
      allowRedirectHosts: this.deps.redirectHosts ?? WHISPER_REDIRECT_HOSTS,
      onProgress: (p) => { this.download = { state: 'running', model, bytes: p.bytes, total }; },
    }).then(async () => {
      // A detected whisper.cpp is checked again with the new model before the analyses that waited for it go on.
      await this.detect().catch(() => []);
      this.download = { state: 'done', model, bytes: total, total };
    }, (err: Error & { code?: string }) => {
      const error = err.code === 'hashMismatch' ? t().errors.downloadHashMismatch : err.message;
      this.download = { state: 'failed', model, bytes: this.download.bytes, total, error };
      throw new Error(error);
    }).finally(() => { this.running = null; });
    this.running = { model, done };
    done.catch(() => {});
    return done;
  }

  async removeModel(model: TranscriptionModelId): Promise<void> {
    if (!this.deps.appDataDir) return;
    if (this.running?.model === model) throw new CodedError(409, t().errors.downloadBusy, 'download-busy');
    await removeWhisperModel(model, this.deps.appDataDir, this.manifest);
  }

  /** Settings → Trascrizione video. */
  async status(): Promise<TranscriptionStatus> {
    const settings = await this.settings();
    const bundled = this.bundledProgram();
    return {
      settings,
      models: this.deps.appDataDir ? await installedModels(this.deps.appDataDir, this.manifest) : (['small', 'large-v3-turbo'] as const).map((id) => ({ id, sizeBytes: this.manifest[id].sizeBytes, installed: false, bytesOnDisk: 0 })),
      whisper: await this.whisper(settings),
      detected: [...this.detection.list],
      detection: { state: this.detection.state, at: this.detection.at },
      bundled: bundled !== null && await isExecutable(bundled),
      download: { ...this.download },
      providers: { openai: await this.hasKey('openai'), elevenlabs: await this.hasKey('elevenlabs') },
      prices: { openai: STT_PRICES_USD_PER_MIN.openai.usdPerMin, elevenlabs: STT_PRICES_USD_PER_MIN.elevenlabs.usdPerMin },
    };
  }

  /** The test-run of a program (spec §7), with the model of the setting (or the given ggml file for whisper.cpp). */
  async probe(i: { program: string; engine?: WhisperEngine; modelFile?: string }): Promise<WhisperFound | { problem: string; needsModel?: true }> {
    const engine = i.engine ?? engineOfName(i.program);
    if (!engine) return { problem: t().errors.whisperNotFound };
    const s = await this.settings();
    const modelFile = i.modelFile ?? (this.deps.appDataDir ? modelFileOf(this.deps.appDataDir, s.model) : undefined);
    return probeWhisper(i.program, engine, { ...(modelFile ? { modelFile } : {}), modelName: pythonModelName(s.model), ...(this.deps.env ? { env: this.deps.env } : {}) });
  }

  /** Saves settings; a program set in `custom` is test-run first (400 with the problem when it fails, spec §7). */
  async update(patch: TranscriptionSettingsPatch): Promise<TranscriptionSettings> {
    if (patch.custom) {
      const r = await this.probe(patch.custom);
      if (isProblem(r)) throw new CodedError(400, t().errors.whisperProbeFailed({ detail: r.problem }), 'whisper-probe-failed');
    }
    const before = await this.settings();
    const saved = await this.deps.config.setTranscription(patch);
    // The detected programs are checked with the model of the setting: a new model, a new check.
    if (saved.model !== before.model) this.startDetection();
    return saved;
  }

  /**
   * Transcribes an analysis's audio with `method` (the user's choice), or with the method the settings resolve to now
   * (absent). A method that does not work at that moment, or a failed transcription, gives `none-skipped`: the rest of the
   * analysis goes on (decision 1515). Aborts propagate.
   */
  async transcribe(i: { ref: { projectDir: string }; jobId: string; wav: string; durationSec: number; signal: AbortSignal; method?: TranscribeMethod }): Promise<{ kind: TranscriptKind; segments: TranscriptSegment[]; language: string | null }> {
    const skipped = { kind: 'none-skipped' as const, segments: [], language: null };
    let method = i.method;
    if (!method) {
      const p = await this.plan(i.durationSec);
      if (!('run' in p)) return skipped;
      method = p.run;
    }
    const hint = currentLocale();
    try {
      if (method === 'whisper') {
        const s = await this.settings();
        const w = await this.whisper(s);
        if (!w) return skipped;
        const r = await runWhisper(w, i.wav, { language: null, signal: i.signal, timeoutMs: Math.max(10 * 60_000, Math.ceil(i.durationSec * 3000)) });
        return { kind: s.model === 'large-v3-turbo' ? 'whisper-large-v3-turbo' : 'whisper-small', segments: r.segments, language: r.language ?? hint };
      }
      const apiKey = await this.deps.vault.get(method);
      if (!apiKey) return skipped;
      const http = { fetch: this.deps.fetch, apiKey };
      // Decision 1549: each OpenAI piece is billed when it is answered, so a later failure keeps the earlier cost recorded.
      const bill = (seconds: number) => recordTranscriptionUsage(this.deps.ledger, i.ref.projectDir, {
        jobId: i.jobId, provider: method as SttProvider, model: STT_PRICES_USD_PER_MIN[method as SttProvider].model, audioSec: seconds, costUsd: estimateSttCost(method as SttProvider, seconds),
      }).catch((err: Error) => console.warn(`Motion Studio: the transcription usage was not recorded: ${err.message}`));
      const r = method === 'openai'
        ? await openaiTranscribe(http, i.wav, { language: null, signal: i.signal, onPiece: (p) => bill(p.seconds) })
        : await elevenlabsTranscribe(http, i.wav, { language: null, signal: i.signal });
      if (method === 'elevenlabs') await bill(i.durationSec);
      return { kind: method, segments: r.segments, language: r.language ?? hint };
    } catch (err) {
      if (i.signal.aborted || (err as Error).name === 'AbortError') throw abortError();
      console.warn(`Motion Studio: ${t().errors.transcriptionFailed({ reason: (err as Error).message })}`);
      return skipped;
    }
  }
}

const isProblem = (r: WhisperFound | { problem: string }): r is { problem: string; needsModel?: true } => !('engine' in r);

/** The engine a program's name says (`whisper-cli` → whisper.cpp…); null when the name is none of them. */
export function engineOfName(program: string): WhisperEngine | null {
  const name = program.split(/[\\/]/).pop()!.replace(/\.(exe|cmd)$/i, '');
  for (const [engine, names] of Object.entries(WHISPER_NAMES) as Array<[WhisperEngine, string[]]>) if (names.includes(name)) return engine;
  return null;
}

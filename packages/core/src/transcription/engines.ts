import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { TranscriptionModelId, TranscriptSegment, WhisperEngine, WhisperFound } from '@motion-studio/shared';
import { t } from '../i18n.ts';
import { lastLine, runChild } from './child-run.ts';

/** What an engine heard: the segments (seconds) and the language it detected (null: it did not say). */
export interface EngineTranscript { segments: TranscriptSegment[]; language: string | null }

const MAX_SEGMENTS = 20_000;
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const lang = (v: unknown) => (typeof v === 'string' && /^[A-Za-z-]{2,16}$/.test(v) ? v.toLowerCase() : null);

function segment(from: unknown, to: unknown, text: unknown): TranscriptSegment | null {
  if (typeof from !== 'number' || typeof to !== 'number' || typeof text !== 'string' || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!clean) return null;
  const a = Math.max(0, Number(from.toFixed(3)));
  return { from: a, to: Math.max(a, Number(to.toFixed(3))), text: clean };
}

const shapeError = (engine: string) => new Error(t().errors.transcriptionFailed({ reason: `${engine}: unexpected output` }));

/** whisper.cpp `-oj`: `transcription[].offsets.from/to` in milliseconds; `result.language`. */
export function parseWhisperCpp(json: unknown): EngineTranscript {
  const j = json as { transcription?: unknown; result?: { language?: unknown } } | null;
  if (!j || typeof j !== 'object' || !Array.isArray(j.transcription)) throw shapeError('whisper.cpp');
  const segments = j.transcription.slice(0, MAX_SEGMENTS).map((s: { offsets?: { from?: unknown; to?: unknown }; text?: unknown }) =>
    segment(typeof s?.offsets?.from === 'number' ? s.offsets.from / 1000 : null, typeof s?.offsets?.to === 'number' ? s.offsets.to / 1000 : null, s?.text));
  return { segments: segments.filter((s): s is TranscriptSegment => s !== null), language: lang(j.result?.language) };
}

/** openai-whisper `--output_format json`: `segments[].start/end/text`, `language`. */
export function parseOpenAiWhisper(json: unknown, engine = 'openai-whisper'): EngineTranscript {
  const j = json as { segments?: unknown; language?: unknown } | null;
  if (!j || typeof j !== 'object' || Array.isArray(j) || !Array.isArray(j.segments)) throw shapeError(engine);
  const segments = j.segments.slice(0, MAX_SEGMENTS).map((s: { start?: unknown; end?: unknown; text?: unknown }) => segment(s?.start, s?.end, s?.text));
  return { segments: segments.filter((s): s is TranscriptSegment => s !== null), language: lang(j.language) };
}

/** faster-whisper through `whisper-ctranslate2 --output_format json`: the openai-whisper shape. */
export const parseFasterWhisper = (json: unknown): EngineTranscript => parseOpenAiWhisper(json, 'faster-whisper');

/**
 * Decision 1490: the Python engines take the Small / Large v3 Turbo setting by model name (both CLIs know `small` and
 * `large-v3-turbo`) and keep the models in their own cache.
 */
export const pythonModelName = (id: TranscriptionModelId): string => (id === 'large-v3-turbo' ? 'large-v3-turbo' : 'small');

/** The argv of one transcription. `model`: a ggml file for whisper.cpp, a name for the Python engines. `language` null: auto. */
export function whisperArgs(e: WhisperEngine, i: { program: string; wav: string; outDir: string; model: string; vadModel?: string; language: string | null }): string[] {
  if (e === 'whisper.cpp') {
    return ['-m', i.model, '-f', i.wav, '-oj', '-of', join(i.outDir, 'out'), '-np', '-sns',
      ...(i.vadModel ? ['--vad', '--vad-model', i.vadModel] : []), '-l', i.language ?? 'auto'];
  }
  return [i.wav, '--model', i.model, '--output_format', 'json', '--output_dir', i.outDir, ...(i.language ? ['--language', i.language] : [])];
}

/** Where the engine wrote its JSON. */
const outputOf = (e: WhisperEngine, outDir: string, wav: string) => (e === 'whisper.cpp' ? join(outDir, 'out.json') : join(outDir, `${basename(wav).replace(/\.[^.]+$/, '')}.json`));

/**
 * Transcribes `wav` with a found Whisper (spec §7): a child process with a deadline and the job's signal, its JSON in a
 * temp folder removed afterwards. Throws a translated `transcriptionFailed` (the engine's last stderr line), or an
 * AbortError when cancelled.
 */
export async function runWhisper(found: WhisperFound & { vadModel?: string }, wav: string, o: { language: string | null; signal: AbortSignal; timeoutMs: number }): Promise<EngineTranscript> {
  if (o.signal.aborted) throw abortError();
  const outDir = await mkdtemp(join(tmpdir(), 'ms-whisper-'));
  try {
    const args = whisperArgs(found.engine, { program: found.program, wav, outDir, model: found.model, ...(found.vadModel ? { vadModel: found.vadModel } : {}), language: o.language });
    const r = await runChild(found.program, args, { timeoutMs: o.timeoutMs, signal: o.signal, cwd: outDir });
    if (r.cancelled || o.signal.aborted) throw abortError();
    if (r.timedOut) throw new Error(t().errors.transcriptionFailed({ reason: t().errors.timedOut({ seconds: Math.round(o.timeoutMs / 1000) }) }));
    if (r.code !== 0) throw new Error(t().errors.transcriptionFailed({ reason: lastLine(r.stderr) || t().errors.exitCode({ code: r.code ?? -1 }) }));
    const text = await readFile(outputOf(found.engine, outDir, wav), 'utf8').catch(() => null);
    if (text === null) throw new Error(t().errors.transcriptionFailed({ reason: `${found.engine}: no output file` }));
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw shapeError(found.engine); }
    return found.engine === 'whisper.cpp' ? parseWhisperCpp(json) : found.engine === 'openai-whisper' ? parseOpenAiWhisper(json) : parseFasterWhisper(json);
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

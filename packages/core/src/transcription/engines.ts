import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { TranscriptionModelId, TranscriptSegment, TranscriptWord, WhisperEngine, WhisperFound } from '@motion-studio/shared';
import { t } from '../i18n.ts';
import { lastLine, runChild } from './child-run.ts';

/** What an engine heard: the segments (seconds), the language it detected (null: it did not say) and, when asked for, the words. */
export interface EngineTranscript { segments: TranscriptSegment[]; words?: TranscriptWord[]; language: string | null }

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

function word(from: unknown, to: unknown, text: unknown): TranscriptWord | null {
  const s = segment(from, to, text);
  return s ? { from: s.from, to: s.to, text: s.text.slice(0, 200) } : null;
}

const shapeError = (engine: string) => new Error(t().errors.transcriptionFailed({ reason: `${engine}: unexpected output` }));

/**
 * whisper.cpp `-ojf` tokens as words: a token starting with a space opens a word, the others continue it; special tokens
 * (`[_BEG_]`, `[_TT_50]`…) are dropped, and a word never runs across two segments.
 */
function cppWords(transcription: unknown[]): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const seg of transcription.slice(0, MAX_SEGMENTS) as Array<{ tokens?: unknown }>) {
    if (!Array.isArray(seg?.tokens)) continue;
    let cur: { from: number; to: number; text: string } | null = null;
    const close = () => {
      const w = cur && word(cur.from, cur.to, cur.text);
      if (w) out.push(w);
      cur = null;
    };
    for (const k of seg.tokens as Array<{ offsets?: { from?: unknown; to?: unknown }; text?: unknown }>) {
      if (typeof k?.text !== 'string' || /^\[_/.test(k.text.trim()) || typeof k.offsets?.from !== 'number' || typeof k.offsets.to !== 'number') continue;
      if (!k.text.trim()) { close(); continue; }
      const from = k.offsets.from / 1000, to = k.offsets.to / 1000;
      if (!cur || /^\s/.test(k.text)) { close(); cur = { from, to, text: k.text.trim() }; }
      else { cur.text += k.text; cur.to = Math.max(cur.to, to); }
    }
    close();
  }
  return out;
}

/** openai-whisper / whisper-ctranslate2 `--word_timestamps True`: `segments[].words[]` with `word`, `start`, `end`. */
function pythonWords(segs: unknown[]): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const s of segs.slice(0, MAX_SEGMENTS) as Array<{ words?: unknown }>) {
    if (!Array.isArray(s?.words)) continue;
    for (const w of s.words as Array<{ word?: unknown; start?: unknown; end?: unknown }>) {
      const x = word(w?.start, w?.end, w?.word);
      if (x) out.push(x);
    }
  }
  return out;
}

/** whisper.cpp `-oj`: `transcription[].offsets.from/to` in milliseconds; `result.language`. With `-ojf` also the words (from the tokens). */
export function parseWhisperCpp(json: unknown): EngineTranscript {
  const j = json as { transcription?: unknown; result?: { language?: unknown } } | null;
  if (!j || typeof j !== 'object' || !Array.isArray(j.transcription)) throw shapeError('whisper.cpp');
  const segments = j.transcription.slice(0, MAX_SEGMENTS).map((s: { offsets?: { from?: unknown; to?: unknown }; text?: unknown }) =>
    segment(typeof s?.offsets?.from === 'number' ? s.offsets.from / 1000 : null, typeof s?.offsets?.to === 'number' ? s.offsets.to / 1000 : null, s?.text));
  const words = cppWords(j.transcription);
  return { segments: segments.filter((s): s is TranscriptSegment => s !== null), ...(words.length ? { words } : {}), language: lang(j.result?.language) };
}

/** openai-whisper `--output_format json`: `segments[].start/end/text`, `language`. */
export function parseOpenAiWhisper(json: unknown, engine = 'openai-whisper'): EngineTranscript {
  const j = json as { segments?: unknown; language?: unknown } | null;
  if (!j || typeof j !== 'object' || Array.isArray(j) || !Array.isArray(j.segments)) throw shapeError(engine);
  const segments = j.segments.slice(0, MAX_SEGMENTS).map((s: { start?: unknown; end?: unknown; text?: unknown }) => segment(s?.start, s?.end, s?.text));
  const words = pythonWords(j.segments);
  return { segments: segments.filter((s): s is TranscriptSegment => s !== null), ...(words.length ? { words } : {}), language: lang(j.language) };
}

/** faster-whisper through `whisper-ctranslate2 --output_format json`: the openai-whisper shape. */
export const parseFasterWhisper = (json: unknown): EngineTranscript => parseOpenAiWhisper(json, 'faster-whisper');

/**
 * Decision 1490: the Python engines take the Small / Large v3 Turbo setting by model name (both CLIs know `small` and
 * `large-v3-turbo`) and keep the models in their own cache.
 */
export const pythonModelName = (id: TranscriptionModelId): string => (id === 'large-v3-turbo' ? 'large-v3-turbo' : 'small');

/** What a whisper.cpp build accepts, read from its `--help` (decision 1550): an older one refuses an unknown flag. */
export interface EngineFlags { vad: boolean; sns: boolean; np: boolean; ojf: boolean }
export function engineFlags(help: string): EngineFlags {
  return { vad: /(^|\s)--vad\b/m.test(help), sns: /(^|\s)(-sns|--suppress-nst)\b/m.test(help), np: /(^|\s)(-np|--no-prints)\b/m.test(help), ojf: /(^|\s)(-ojf|--output-json-full)\b/m.test(help) };
}

/** A version only from a version line ("version: 1.9.5", "v1.7.6"): usage text full of numbers is no version (decision 1550). */
export function versionOf(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/\bversion\b\W{0,4}v?(\d+\.\d+\.\d+)\b/i) ?? line.trim().match(/^v?(\d+\.\d+\.\d+)$/);
    if (m && !/error|unknown|usage/i.test(line)) return m[1]!;
  }
  return null;
}

const HELP_TIMEOUT_MS = 10_000;
/** `--help` of a program, by path, size and mtime (a replaced binary is asked again). */
const helps = new Map<string, Promise<{ ok: boolean; text: string }>>();
export async function whisperHelp(program: string): Promise<{ ok: boolean; text: string }> {
  const st = await stat(program).catch(() => null);
  const key = `${program}\0${st?.size ?? -1}\0${st?.mtimeMs ?? -1}`;
  let p = helps.get(key);
  if (!p) {
    p = runChild(program, ['--help'], { timeoutMs: HELP_TIMEOUT_MS }).then((r) => ({ ok: r.code === 0, text: `${r.stdout}\n${r.stderr}` }));
    helps.set(key, p);
  }
  return p;
}

/** The argv of one transcription. `model`: a ggml file for whisper.cpp, a name for the Python engines. `language` null: auto. */
export function whisperArgs(e: WhisperEngine, i: { program: string; wav: string; outDir: string; model: string; vadModel?: string; language: string | null; flags?: EngineFlags; words?: boolean }): string[] {
  if (e === 'whisper.cpp') {
    const f = i.flags ?? { vad: true, sns: true, np: true, ojf: true };
    return ['-m', i.model, '-f', i.wav, i.words && f.ojf ? '-ojf' : '-oj', '-of', join(i.outDir, 'out'), ...(f.np ? ['-np'] : []), ...(f.sns ? ['-sns'] : []),
      ...(i.vadModel && f.vad ? ['--vad', '--vad-model', i.vadModel] : []), '-l', i.language ?? 'auto'];
  }
  return [i.wav, '--model', i.model, '--output_format', 'json', '--output_dir', i.outDir, ...(i.language ? ['--language', i.language] : []), ...(i.words ? ['--word_timestamps', 'True'] : [])];
}

/** Where the engine wrote its JSON. */
const outputOf = (e: WhisperEngine, outDir: string, wav: string) => (e === 'whisper.cpp' ? join(outDir, 'out.json') : join(outDir, `${basename(wav).replace(/\.[^.]+$/, '')}.json`));

/**
 * Transcribes `wav` with a found Whisper (spec §7): a child process with a deadline and the job's signal, its JSON in a
 * temp folder removed afterwards. Throws a translated `transcriptionFailed` (the engine's last stderr line), or an
 * AbortError when cancelled.
 */
export async function runWhisper(found: WhisperFound & { vadModel?: string }, wav: string, o: { language: string | null; signal: AbortSignal; timeoutMs: number; words?: boolean }): Promise<EngineTranscript> {
  if (o.signal.aborted) throw abortError();
  const outDir = await mkdtemp(join(tmpdir(), 'ms-whisper-'));
  try {
    const flags = found.engine === 'whisper.cpp' ? engineFlags((await whisperHelp(found.program)).text) : undefined;
    const args = whisperArgs(found.engine, { program: found.program, wav, outDir, model: found.model, ...(found.vadModel ? { vadModel: found.vadModel } : {}), language: o.language, ...(flags ? { flags } : {}), ...(o.words ? { words: true } : {}) });
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

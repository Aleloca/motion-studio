import { openAsBlob } from 'node:fs';
import { open } from 'node:fs/promises';
import type { TranscriptSegment, TranscriptWord } from '@motion-studio/shared';
import { requestJson, type HttpDeps } from '../providers/http.ts';
import { STT_PRICES_USD_PER_MIN } from './pricing.ts';
import { wavData, wavHeader } from './wav.ts';

const URL_ = 'https://api.openai.com/v1/audio/transcriptions';
/**
 * Decision 1510: audio over this many seconds goes in pieces of this length, each a 16 kHz mono WAV of its own
 * (600 s ≈ 19.2 MB, under the API's 25 MB upload limit); segment times are offset by the piece's start.
 */
export const OPENAI_CHUNK_SEC = 600;
const BYTES_PER_SEC = 32_000;
/** A last piece shorter than this joins the previous one (decision 1549): no request, and no billed minute, for a sliver. */
const MIN_TAIL_SEC = 1;
/** One piece can take a while to transcribe: a deadline well above the default. */
const PIECE_TIMEOUT_MS = 10 * 60_000;

/** OpenAI names the language in English ("italian"): the codes of the common ones, else the name. */
const LANGS: Record<string, string> = {
  english: 'en', italian: 'it', spanish: 'es', french: 'fr', german: 'de', portuguese: 'pt', dutch: 'nl', japanese: 'ja', chinese: 'zh',
  korean: 'ko', russian: 'ru', polish: 'pl', turkish: 'tr', swedish: 'sv', danish: 'da', norwegian: 'no', finnish: 'fi', greek: 'el', arabic: 'ar', hindi: 'hi',
};
const langOf = (v: unknown) => (typeof v === 'string' && v.length <= 32 ? (LANGS[v.toLowerCase()] ?? v.toLowerCase()) : null);

const readRange = async (path: string, offset: number, length: number): Promise<Buffer> => {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
};

interface Verbose { language?: unknown; segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>; words?: Array<{ word?: unknown; start?: unknown; end?: unknown }> }

/**
 * Transcribes a 16 kHz mono WAV with OpenAI (spec §6): `whisper-1`, `verbose_json`, segment timestamps, `language` only as
 * a hint when set; with `words` also word timestamps. Through `requestJson` (no redirects, the key redacted from every error). Longer audio goes in 600 s
 * pieces (decision 1510).
 */
export async function openaiTranscribe(
  deps: HttpDeps & { apiKey: string }, wav: string,
  o: { language: string | null; signal: AbortSignal; words?: boolean; onPiece?: (p: { index: number; seconds: number }) => void | Promise<void> },
): Promise<{ segments: TranscriptSegment[]; words?: TranscriptWord[]; language: string | null }> {
  const data = await wavData(wav);
  const http: HttpDeps = { ...deps, timeoutMs: deps.timeoutMs ?? PIECE_TIMEOUT_MS };
  const pieceBytes = OPENAI_CHUNK_SEC * BYTES_PER_SEC;
  let pieces = Math.max(1, Math.ceil(data.bytes / pieceBytes));
  if (pieces > 1 && data.bytes - (pieces - 1) * pieceBytes < MIN_TAIL_SEC * BYTES_PER_SEC) pieces--;
  const segments: TranscriptSegment[] = [];
  const words: TranscriptWord[] = [];
  let language: string | null = null;
  for (let k = 0; k < pieces; k++) {
    let file: Blob;
    const start = k * pieceBytes;
    const length = k === pieces - 1 ? data.bytes - start : pieceBytes;
    if (pieces === 1) file = await openAsBlob(wav, { type: 'audio/wav' });
    else {
      const pcm = await readRange(wav, data.offset + start, length);
      file = new Blob([new Uint8Array(wavHeader(pcm.length)), new Uint8Array(pcm)], { type: 'audio/wav' });
    }
    const form = new FormData();
    form.append('file', file, 'audio.wav');
    form.append('model', STT_PRICES_USD_PER_MIN.openai.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    if (o.words) form.append('timestamp_granularities[]', 'word');
    if (o.language) form.append('language', o.language);
    const out = await requestJson<Verbose>(http, URL_, { method: 'POST', headers: { Authorization: `Bearer ${deps.apiKey}` }, body: form, signal: o.signal }, { provider: 'OpenAI', secrets: [deps.apiKey] });
    await o.onPiece?.({ index: k, seconds: length / BYTES_PER_SEC });
    language ??= langOf(out.language);
    const offset = k * OPENAI_CHUNK_SEC;
    for (const s of Array.isArray(out.segments) ? out.segments : []) {
      if (typeof s?.start !== 'number' || typeof s.end !== 'number' || typeof s.text !== 'string') continue;
      const text = s.text.replace(/\s+/g, ' ').trim().slice(0, 2000);
      if (!text) continue;
      const from = Number((offset + Math.max(0, s.start)).toFixed(3));
      segments.push({ from, to: Math.max(from, Number((offset + s.end).toFixed(3))), text });
    }
    if (o.words) {
      for (const w of Array.isArray(out.words) ? out.words : []) {
        if (typeof w?.start !== 'number' || typeof w.end !== 'number' || typeof w.word !== 'string') continue;
        const text = w.word.trim().slice(0, 200);
        if (!text) continue;
        const from = Number((offset + Math.max(0, w.start)).toFixed(3));
        words.push({ from, to: Math.max(from, Number((offset + w.end).toFixed(3))), text });
      }
    }
  }
  return { segments, ...(o.words ? { words } : {}), language };
}

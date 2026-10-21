import { openAsBlob } from 'node:fs';
import { open } from 'node:fs/promises';
import type { TranscriptSegment } from '@motion-studio/shared';
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

interface Verbose { language?: unknown; segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }> }

/**
 * Transcribes a 16 kHz mono WAV with OpenAI (spec §6): `whisper-1`, `verbose_json`, segment timestamps, `language` only as
 * a hint when set. Through `requestJson` (no redirects, the key redacted from every error). Longer audio goes in 600 s
 * pieces (decision 1510).
 */
export async function openaiTranscribe(deps: HttpDeps & { apiKey: string }, wav: string, o: { language: string | null; signal: AbortSignal }): Promise<{ segments: TranscriptSegment[]; language: string | null }> {
  const data = await wavData(wav);
  const http: HttpDeps = { ...deps, timeoutMs: deps.timeoutMs ?? PIECE_TIMEOUT_MS };
  const pieces = Math.max(1, Math.ceil(data.durationSec / OPENAI_CHUNK_SEC));
  const segments: TranscriptSegment[] = [];
  let language: string | null = null;
  for (let k = 0; k < pieces; k++) {
    let file: Blob;
    if (pieces === 1) file = await openAsBlob(wav, { type: 'audio/wav' });
    else {
      const start = k * OPENAI_CHUNK_SEC * BYTES_PER_SEC;
      const pcm = await readRange(wav, data.offset + start, Math.min(OPENAI_CHUNK_SEC * BYTES_PER_SEC, data.bytes - start));
      file = new Blob([new Uint8Array(wavHeader(pcm.length)), new Uint8Array(pcm)], { type: 'audio/wav' });
    }
    const form = new FormData();
    form.append('file', file, 'audio.wav');
    form.append('model', STT_PRICES_USD_PER_MIN.openai.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    if (o.language) form.append('language', o.language);
    const out = await requestJson<Verbose>(http, URL_, { method: 'POST', headers: { Authorization: `Bearer ${deps.apiKey}` }, body: form, signal: o.signal }, { provider: 'OpenAI', secrets: [deps.apiKey] });
    language ??= langOf(out.language);
    const offset = k * OPENAI_CHUNK_SEC;
    for (const s of Array.isArray(out.segments) ? out.segments : []) {
      if (typeof s?.start !== 'number' || typeof s.end !== 'number' || typeof s.text !== 'string') continue;
      const text = s.text.replace(/\s+/g, ' ').trim().slice(0, 2000);
      if (!text) continue;
      const from = Number((offset + Math.max(0, s.start)).toFixed(3));
      segments.push({ from, to: Math.max(from, Number((offset + s.end).toFixed(3))), text });
    }
  }
  return { segments, language };
}

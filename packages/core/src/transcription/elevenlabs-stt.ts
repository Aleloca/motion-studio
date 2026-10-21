import { openAsBlob } from 'node:fs';
import type { TranscriptSegment } from '@motion-studio/shared';
import { requestJson, type HttpDeps } from '../providers/http.ts';
import { STT_PRICES_USD_PER_MIN } from './pricing.ts';

const URL_ = 'https://api.elevenlabs.io/v1/speech-to-text';
/** A pause of at least this many seconds between two words starts a new segment. */
const GAP_SEC = 0.8;
const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;
const TIMEOUT_MS = 30 * 60_000;

export interface ScribeWord { text?: unknown; start?: unknown; end?: unknown; type?: unknown }

/** Scribe's words as segments: a new one at a sentence end or a pause of 0.8 s or more; spacing and audio events dropped. */
export function groupWords(words: readonly ScribeWord[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let cur: { from: number; to: number; words: string[] } | null = null;
  const close = () => {
    if (!cur) return;
    const text = cur.words.join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
    if (text) out.push({ from: Number(cur.from.toFixed(3)), to: Number(Math.max(cur.from, cur.to).toFixed(3)), text });
    cur = null;
  };
  for (const w of words) {
    if (w.type !== 'word' || typeof w.text !== 'string' || typeof w.start !== 'number' || typeof w.end !== 'number' || !w.text.trim()) continue;
    const start = Math.max(0, w.start);
    if (cur && start - cur.to >= GAP_SEC) close();
    if (!cur) cur = { from: start, to: w.end, words: [] };
    cur.words.push(w.text.trim());
    cur.to = Math.max(cur.to, w.end);
    if (SENTENCE_END.test(w.text.trim())) close();
  }
  close();
  return out;
}

/**
 * Transcribes a WAV with ElevenLabs Scribe (spec §6): word timestamps grouped into segments, no audio-event tags,
 * `language_code` only as a hint when set. The key goes in `xi-api-key` and is redacted from every error.
 */
export async function elevenlabsTranscribe(deps: HttpDeps & { apiKey: string }, wav: string, o: { language: string | null; signal: AbortSignal }): Promise<{ segments: TranscriptSegment[]; language: string | null }> {
  const form = new FormData();
  form.append('model_id', STT_PRICES_USD_PER_MIN.elevenlabs.model);
  form.append('file', await openAsBlob(wav, { type: 'audio/wav' }), 'audio.wav');
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false');
  if (o.language) form.append('language_code', o.language);
  const out = await requestJson<{ language_code?: unknown; words?: ScribeWord[] }>({ ...deps, timeoutMs: deps.timeoutMs ?? TIMEOUT_MS }, URL_,
    { method: 'POST', headers: { 'xi-api-key': deps.apiKey }, body: form, signal: o.signal }, { provider: 'ElevenLabs', secrets: [deps.apiKey] });
  const language = typeof out.language_code === 'string' && /^[a-z]{2,3}$/i.test(out.language_code) ? out.language_code.toLowerCase() : null;
  return { segments: groupWords(Array.isArray(out.words) ? out.words : []), language };
}

import type { PaidProvider, PaidUsage, UsageRecord } from '@motion-studio/shared';
import type { UsageLedger } from './usage-ledger.ts';

/**
 * Report 66 (decisions 1606–1625): every list price the app estimates the paid services with, in USD, checked on 2026-10-22
 * from what was known then (no billing API is ever called). The estimate is shown as such: the bill is on the user's own
 * provider account. A price marked "da verificare" in the decisions log is the closest published figure known.
 */
export const PAID_PRICES = {
  checkedOn: '2026-10-22',
  /** OpenAI image tokens (gpt-image list prices, per million): text and image input, image output. */
  openaiImages: {
    model: 'gpt-image-2', usdPerMTokens: { textInput: 5, imageInput: 10, output: 40 },
    /** Without `usage` in the answer: per picture of 1024×1024 by quality (`auto` counts as high), scaled by its pixels. */
    usdPerImage1024: { low: 0.011, medium: 0.042, high: 0.167 },
  },
  /** OpenAI speech: about $0.015 a minute of speech, a minute being about 1,000 characters of input. */
  openaiTts: { model: 'gpt-4o-mini-tts', usdPerChar: 0.015 / 1000 },
  /** ElevenLabs speech: Multilingual v2, $0.10 per 1,000 characters (one credit a character). */
  elevenlabsTts: { model: 'eleven_multilingual_v2', usdPerChar: 0.10 / 1000 },
  /** ElevenLabs music: per second of music asked. */
  elevenlabsMusic: { model: 'music_v1', usdPerSec: 0.80 / 60 },
  /** ElevenLabs sound effects: 40 credits a second; with no duration asked the provider picks one, counted as 5 s (200 credits). */
  elevenlabsSfx: { model: 'eleven_text_to_sound_v2', usdPerSec: 0.004, defaultSeconds: 5 },
  /** Decision 1509: transcription per minute of audio. OpenAI `whisper-1`; ElevenLabs Scribe v2 at $0.22 an hour. */
  stt: {
    openai: { model: 'whisper-1', usdPerMin: 0.006 },
    elevenlabs: { model: 'scribe_v2', usdPerMin: 0.22 / 60 },
  },
} as const;

/** A paid call's measure and its estimated cost, ready for the ledger. */
export interface PaidBill extends PaidUsage { costUsd: number; inputTokens?: number; outputTokens?: number }

const round = (usd: number) => Number(Math.max(0, usd).toFixed(6));
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** The `usage` block of an Images API answer (only the fields the estimate reads). */
export interface ImageApiUsage {
  input_tokens?: unknown; output_tokens?: unknown;
  input_tokens_details?: { text_tokens?: unknown; image_tokens?: unknown } | null;
}

/**
 * An OpenAI picture: the tokens the answer's `usage` gives (input split into text and image when told, else all text), or
 * without it a price per picture by quality and size.
 */
export function imageBill(usage: ImageApiUsage | null | undefined, req: { quality?: string; width: number; height: number }): PaidBill {
  const p = PAID_PRICES.openaiImages;
  const input = count(usage?.input_tokens);
  const output = count(usage?.output_tokens);
  if (input !== null && output !== null) {
    const image = Math.min(input, count(usage?.input_tokens_details?.image_tokens) ?? 0);
    const cost = ((input - image) * p.usdPerMTokens.textInput + image * p.usdPerMTokens.imageInput + output * p.usdPerMTokens.output) / 1e6;
    return { provider: 'openai', service: 'images', model: p.model, units: { amount: input + output, unit: 'tokens' }, costUsd: round(cost), inputTokens: input, outputTokens: output };
  }
  const quality = req.quality === 'low' || req.quality === 'medium' ? req.quality : 'high';
  const cost = p.usdPerImage1024[quality] * Math.max(1, (req.width * req.height) / (1024 * 1024));
  return { provider: 'openai', service: 'images', model: p.model, units: { amount: 1, unit: 'images' }, costUsd: round(cost) };
}

/** Speech: the characters sent (ElevenLabs: the ones its `character-cost` header says it charged, when given). */
export function voiceBill(provider: PaidProvider, characters: number): PaidBill {
  const p = provider === 'openai' ? PAID_PRICES.openaiTts : PAID_PRICES.elevenlabsTts;
  const chars = Math.max(0, Math.round(characters));
  return { provider, service: 'voice', model: p.model, units: { amount: chars, unit: 'characters' }, costUsd: round(chars * p.usdPerChar) };
}

export function musicBill(seconds: number): PaidBill {
  const p = PAID_PRICES.elevenlabsMusic;
  return { provider: 'elevenlabs', service: 'music', model: p.model, units: { amount: seconds, unit: 'seconds' }, costUsd: round(seconds * p.usdPerSec) };
}

export function sfxBill(seconds: number | undefined): PaidBill {
  const p = PAID_PRICES.elevenlabsSfx;
  const s = seconds ?? p.defaultSeconds;
  return { provider: 'elevenlabs', service: 'sfx', model: p.model, units: { amount: s, unit: 'seconds' }, costUsd: round(s * p.usdPerSec) };
}

/** Transcription, billed on whole minutes (an upper bound of the bill). */
export function sttBill(provider: PaidProvider, audioSec: number): PaidBill {
  const p = PAID_PRICES.stt[provider];
  const minutes = Math.max(1, Math.ceil(Math.max(0, audioSec) / 60));
  return { provider, service: 'transcription', model: p.model, units: { amount: minutes, unit: 'minutes' }, costUsd: round(minutes * p.usdPerMin) };
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * One ledger line for a paid call that succeeded: kind `paid` (`transcription` for a transcription, the kind older lines
 * have), no Claude tokens, the measure in `paid`. The image tokens go in the model's token counts (input/output).
 */
export function paidRecord(i: { jobId: string; creativeSlug?: string | null; bill: PaidBill; at?: Date }): UsageRecord {
  const { costUsd, inputTokens, outputTokens, ...paid } = i.bill;
  return {
    at: (i.at ?? new Date()).toISOString(), jobId: i.jobId, kind: paid.service === 'transcription' ? 'transcription' : 'paid',
    creativeSlug: i.creativeSlug ?? null, version: null, attempt: null, tokens: { ...ZERO }, costUsd,
    models: [{ model: paid.model, tokens: { ...ZERO, input: inputTokens ?? 0, output: outputTokens ?? 0 }, costUsd }],
    durationMs: null, outcome: 'ok', sessionId: null, cumulativeCostUsd: null, cumulativeModels: [], paid,
  };
}

/** Appends the paid call's line; a failed write is logged and swallowed (recording never fails the call it measures). */
export async function recordPaidUsage(ledger: UsageLedger, projectDir: string, i: { jobId: string; creativeSlug?: string | null; bill: PaidBill }): Promise<void> {
  try { await ledger.append(projectDir, paidRecord(i)); }
  catch (err) { console.warn(`Motion Studio: the paid usage was not recorded: ${(err as Error).message}`); }
}

const STT_BY_MODEL = new Map<string, PaidProvider>([[PAID_PRICES.stt.openai.model, 'openai'], [PAID_PRICES.stt.elevenlabs.model, 'elevenlabs']]);

/**
 * The paid measure of a record, null for Claude's runs. A transcription line written before report 66 has no `paid`: its
 * provider comes from its model, its minutes from its cost at the list price it was written with.
 */
export function paidUsageOf(r: UsageRecord): PaidUsage | null {
  if (r.paid) return r.paid;
  if (r.kind !== 'transcription' && r.kind !== 'paid') return null;
  const model = r.models[0]?.model ?? '';
  const provider = STT_BY_MODEL.get(model);
  if (r.kind !== 'transcription' || !provider) return null;
  const minutes = r.costUsd !== null ? Math.max(1, Math.round(r.costUsd / PAID_PRICES.stt[provider].usdPerMin)) : 0;
  return { provider, service: 'transcription', model, units: { amount: minutes, unit: 'minutes' } };
}

/** A paid service's record (kind `paid` or `transcription`, with or without its measure): never one of Claude's runs. */
export const isPaidRecord = (r: UsageRecord) => r.kind === 'paid' || r.kind === 'transcription' || r.paid !== undefined;

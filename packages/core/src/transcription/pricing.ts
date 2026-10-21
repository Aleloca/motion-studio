import type { UsageRecord } from '@motion-studio/shared';
import type { UsageLedger } from '../usage/usage-ledger.ts';

/**
 * Decision 1509: the transcription models and their list prices (USD per minute of audio), checked on 2026-10-21. OpenAI
 * `whisper-1` is the model with segment timestamps (`verbose_json`); ElevenLabs Scribe v2 lists $0.22 per hour.
 */
export const STT_PRICES_USD_PER_MIN = {
  openai: { model: 'whisper-1', usdPerMin: 0.006 },
  elevenlabs: { model: 'scribe_v2', usdPerMin: 0.22 / 60 },
} as const;
export type SttProvider = keyof typeof STT_PRICES_USD_PER_MIN;

/** What a transcription of `audioSec` seconds costs at list price, on whole minutes (an upper bound of the bill). */
export function estimateSttCost(provider: SttProvider, audioSec: number): number {
  const minutes = Math.max(1, Math.ceil(Math.max(0, audioSec) / 60));
  return Number((minutes * STT_PRICES_USD_PER_MIN[provider].usdPerMin).toFixed(6));
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A paid transcription in `usage.jsonl`: kind `transcription`, no tokens, its estimated cost (spec §6). */
export async function recordTranscriptionUsage(ledger: UsageLedger, projectDir: string, i: { jobId: string; provider: SttProvider; model: string; audioSec: number; costUsd: number; outcome?: UsageRecord['outcome'] }): Promise<void> {
  await ledger.append(projectDir, {
    at: new Date().toISOString(), jobId: i.jobId, kind: 'transcription', creativeSlug: null, version: null, attempt: null,
    tokens: { ...ZERO }, costUsd: i.costUsd, models: [{ model: i.model, tokens: { ...ZERO }, costUsd: i.costUsd }],
    durationMs: null, outcome: i.outcome ?? 'ok', sessionId: null, cumulativeCostUsd: null, cumulativeModels: [],
  });
}

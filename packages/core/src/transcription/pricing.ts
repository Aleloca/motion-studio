import type { UsageRecord } from '@motion-studio/shared';
import { PAID_PRICES, paidRecord, sttBill } from '../usage/paid-usage.ts';
import type { UsageLedger } from '../usage/usage-ledger.ts';

/**
 * Decision 1509: the transcription models and their list prices (USD per minute of audio), checked on 2026-10-21. OpenAI
 * `whisper-1` is the model with segment timestamps (`verbose_json`); ElevenLabs Scribe v2 lists $0.22 per hour. Kept with
 * every other paid price in usage/paid-usage.ts (report 66).
 */
export const STT_PRICES_USD_PER_MIN = PAID_PRICES.stt;
export type SttProvider = keyof typeof STT_PRICES_USD_PER_MIN;

/** What a transcription of `audioSec` seconds costs at list price, on whole minutes (an upper bound of the bill). */
export function estimateSttCost(provider: SttProvider, audioSec: number): number {
  return sttBill(provider, audioSec).costUsd;
}

/** A paid transcription in `usage.jsonl`: kind `transcription`, no tokens, its minutes and estimated cost (spec §6, report 66). */
export async function recordTranscriptionUsage(ledger: UsageLedger, projectDir: string, i: { jobId: string; provider: SttProvider; model: string; audioSec: number; costUsd: number; outcome?: UsageRecord['outcome'] }): Promise<void> {
  const bill = { ...sttBill(i.provider, i.audioSec), model: i.model, costUsd: i.costUsd };
  await ledger.append(projectDir, { ...paidRecord({ jobId: i.jobId, bill }), outcome: i.outcome ?? 'ok' });
}

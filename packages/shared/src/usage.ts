import { z } from 'zod';

const count = z.number().int().min(0);
export const tokenCountsSchema = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count });
export type TokenCounts = z.infer<typeof tokenCountsSchema>;

export const modelUsageSchema = z.object({
  model: z.string().min(1), tokens: tokenCountsSchema, costUsd: z.number().min(0).nullable(),
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;

export const usageSummarySchema = z.object({
  tokens: tokenCountsSchema, costUsd: z.number().min(0).nullable(), estimated: z.boolean().optional(),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;

export const usageKindSchema = z.enum(['creative', 'brand-analysis', 'describe', 'console']);

/**
 * One ledger line. `tokens`/`costUsd`/`models` are PER RUN. The agent's `total_cost_usd` and `modelUsage` are
 * CUMULATIVE over resumed sessions, so the raw cumulative values are kept in `cumulativeCostUsd`/`cumulativeModels`
 * next to `sessionId`: per-run cost = this run's cumulative minus the previous record with the same sessionId;
 * a negative delta gives `costUsd` null and `estimated` true. Older lines lack these fields and parse with null/[].
 */
export const usageRecordSchema = z.object({
  at: z.string(),
  jobId: z.string(),
  kind: usageKindSchema,
  creativeSlug: z.string().nullable(),
  version: z.number().int().nullable(),
  attempt: z.number().int().nullable(),
  tokens: tokenCountsSchema,
  costUsd: z.number().min(0).nullable(),
  models: z.array(modelUsageSchema),
  durationMs: z.number().min(0).nullable(),
  /**
   * The outcome of the `claude` run this record measures, NOT of the job: a run that succeeded and whose job then
   * failed later (output checks, the git commit) is still 'ok'. Such a job's tokens are real, and a retry adds its own
   * records, so the New creative estimate (first generation, every attempt summed) may be biased high for a creative
   * whose first job failed and was retried.
   */
  outcome: z.enum(['ok', 'error', 'cancelled']),
  estimated: z.boolean().optional(),
  sessionId: z.string().nullable().default(null),
  cumulativeCostUsd: z.number().min(0).nullable().default(null),
  cumulativeModels: z.array(modelUsageSchema).default([]),
});
export type UsageRecord = z.infer<typeof usageRecordSchema>;

/** Tokens shown to the user: cacheRead is left out (details only). */
export function shownTotal(t: TokenCounts): number {
  return t.input + t.output + t.cacheWrite;
}

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

export interface UsageReport {
  from: string; to: string; total: UsageSummary;
  /** `estimated`: some run of the bucket has no known cost (or only a live estimate), so `costUsd` is partial. */
  byDay: { day: string; tokens: number; costUsd: number | null; estimated?: boolean }[];
  byProject: { slug: string; name: string; tokens: number; costUsd: number | null; estimated?: boolean }[];
  byKind: { kind: UsageRecord['kind']; tokens: number; costUsd: number | null; estimated?: boolean }[];
  trackedSince: string | null;
  billing: UsageBilling;
  /**
   * Offset from UTC (minutes, e.g. 120 for UTC+2) of the server's local time zone, which buckets `byDay`. One value for
   * the whole range, taken at its last instant (`to` - 1 ms): a range that crosses a DST change has days with another
   * offset (the buckets are still whole local days, only this single number cannot describe both halves).
   */
  utcOffsetMinutes: number;
}
export type UsageBilling = 'subscription' | 'api' | 'unknown';

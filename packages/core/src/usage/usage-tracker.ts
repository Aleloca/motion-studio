import { addTokens, type AgentEvent, type ModelUsage, type TokenCounts, type UsageRecord, type UsageSummary } from '@motion-studio/shared';
import type { AgentRunResult } from '../agent/runner.ts';
import type { LastOfSession, UsageLedger } from './usage-ledger.ts';

type UsageEvent = Extract<AgentEvent, { kind: 'usage' }>;
export interface UsageTrackerMeta {
  projectDir: string; jobId: string; kind: UsageRecord['kind'];
  creativeSlug?: string | null; version?: number | null; attempt?: number | null;
  /** The session this run resumed (or forked from): a fork may carry the parent's cumulative values over. */
  resumeSessionId?: string;
}

const ZERO: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** Cumulative values are sums of floats: a difference this close to zero is rounding, not a session reset. */
const EPSILON = 1e-9;
const OUTCOME: Record<AgentRunResult['status'], UsageRecord['outcome']> = { succeeded: 'ok', failed: 'error', cancelled: 'cancelled' };

function subTokens(a: TokenCounts, b: TokenCounts): TokenCounts | null {
  const d = { input: a.input - b.input, output: a.output - b.output, cacheRead: a.cacheRead - b.cacheRead, cacheWrite: a.cacheWrite - b.cacheWrite };
  return d.input < 0 || d.output < 0 || d.cacheRead < 0 || d.cacheWrite < 0 ? null : d;
}
/** `b` undefined: no baseline value (the whole of `a` is this run's); null: the baseline had no cost, so no difference can be told. */
function subCost(a: number | null, b: number | null | undefined): number | null | 'negative' {
  if (a === null) return null;
  if (b === null) return 'negative';
  const d = a - (b ?? 0);
  if (d < -EPSILON) return 'negative';
  return Math.max(0, d);
}
const sameTokens = (a: TokenCounts, b: TokenCounts) => a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;

/** Per-run cost and models: this run's cumulative values minus the baseline's; null when anything went backwards. */
function delta(final: UsageEvent, baseline: UsageRecord | null): { costUsd: number | null; models: ModelUsage[] } | 'negative' {
  const cost = subCost(final.costUsd, baseline ? baseline.cumulativeCostUsd : undefined);
  if (cost === 'negative') return 'negative';
  const models: ModelUsage[] = [];
  for (const m of final.models ?? []) {
    const prev = baseline?.cumulativeModels.find((p) => p.model === m.model);
    const tokens = subTokens(m.tokens, prev?.tokens ?? ZERO);
    const c = subCost(m.costUsd, prev ? prev.costUsd : undefined);
    if (!tokens || c === 'negative') return 'negative';
    models.push({ model: m.model, tokens, costUsd: c });
  }
  // A model of the baseline missing now means the cumulative values were reset.
  if (baseline?.cumulativeModels.some((p) => !(final.models ?? []).some((m) => m.model === p.model))) return 'negative';
  return { costUsd: cost, models };
}

/**
 * One per `claude` run. Watches the run's events: keeps the last live estimate and holds back the final `usage`
 * (whose cost and models are CUMULATIVE over a resumed session). At the end it writes one ledger line with per-run
 * values and returns the corrected final event for the UI:
 * - final usage present (whatever the outcome): tokens from it (per run), cost/models = cumulative minus the last
 *   ledger record of the same session (a fork is measured against its parent when the tokens prove the values carried
 *   over); any negative difference gives `costUsd: null, estimated: true`;
 * - only a live estimate (cancel, crash): written with `estimated: true` and no cost;
 * - neither: nothing is written.
 */
export class UsageTracker {
  private live: UsageEvent | null = null;
  private final: UsageEvent | null = null;
  private sessionId: string | null = null;
  private durationMs: number | null = null;

  constructor(private readonly meta: UsageTrackerMeta, private readonly ledger: UsageLedger, private readonly now: () => Date = () => new Date()) {}

  /** The event to forward to the listeners, or null when it is held back (the final usage, re-emitted by finish). */
  observe(e: AgentEvent): AgentEvent | null {
    if (e.kind === 'session') this.sessionId = e.sessionId;
    if (e.kind === 'result') {
      if (e.sessionId) this.sessionId = e.sessionId;
      if (e.durationMs !== undefined) this.durationMs = e.durationMs;
    }
    if (e.kind === 'usage') {
      if (!e.live) { this.final = e; return null; }
      this.live = e;
    }
    return e;
  }

  /**
   * Writes the ledger line (a write failure is swallowed: usage never fails a run). The baseline lookup and the append
   * run under the ledger file's lock, so no other run of the project can slip a line in between.
   */
  async finish(status: AgentRunResult['status']): Promise<{ record: UsageRecord | null; event: UsageEvent | null }> {
    let built: UsageRecord | null = null;
    const saved = await this.ledger.appendComputed(this.meta.projectDir, async (lastOfSession) => {
      built = await this.buildRecord(OUTCOME[status], lastOfSession).catch(() => null);
      return built;
    }).catch(() => built);
    if (!saved) return { record: null, event: null };
    const event: UsageEvent | null = this.final
      ? { kind: 'usage', live: false, tokens: saved.tokens, costUsd: saved.costUsd, models: saved.models }
      : null;
    return { record: saved, event };
  }

  private async buildRecord(outcome: UsageRecord['outcome'], lastOfSession: LastOfSession): Promise<UsageRecord | null> {
    const base = {
      at: this.now().toISOString(), jobId: this.meta.jobId, kind: this.meta.kind,
      creativeSlug: this.meta.creativeSlug ?? null, version: this.meta.version ?? null, attempt: this.meta.attempt ?? null,
      outcome, sessionId: this.sessionId,
    };
    if (!this.final) {
      if (!this.live) return null;
      return { ...base, tokens: this.live.tokens, costUsd: null, models: [], durationMs: null, estimated: true, cumulativeCostUsd: null, cumulativeModels: [] };
    }
    const final = this.final;
    const d = await this.perRun(final, lastOfSession);
    return {
      ...base, tokens: final.tokens, durationMs: this.durationMs,
      ...(d === 'negative' ? { costUsd: null, models: [], estimated: true } : d),
      cumulativeCostUsd: final.costUsd, cumulativeModels: final.models ?? [],
    };
  }

  private async perRun(final: UsageEvent, lastOfSession: LastOfSession): Promise<ReturnType<typeof delta>> {
    const own = this.sessionId ? await lastOfSession(this.sessionId) : null;
    if (own) return delta(final, own);
    const first = delta(final, null);
    const parentId = this.meta.resumeSessionId;
    // A fresh session: its cumulative values are this run's.
    if (!parentId) return first;
    // Resumed (or forked) with no record of its own: a session from before tracking, a lost line, or a fork. The
    // cumulative values may include earlier runs, so a baseline is accepted only when the tokens prove it: the
    // per-model deltas must add up exactly to this run's own (per-run) tokens. Otherwise the cost is unknown
    // (never back-filled from a session's history).
    const proven = (d: ReturnType<typeof delta>) => d !== 'negative' && sameTokens(modelTotal(d.models), final.tokens);
    if (proven(first)) return first;
    if (parentId !== this.sessionId) {
      const parent = await lastOfSession(parentId);
      const fromParent = parent ? delta(final, parent) : 'negative';
      if (proven(fromParent)) return fromParent;
    }
    return 'negative';
  }
}

const modelTotal = (models: ModelUsage[]) => models.reduce((s, m) => addTokens(s, m.tokens), ZERO);

/** Usage of several runs (e.g. a version's attempts): tokens add up; the cost is known only if every run's cost is. */
export function sumUsage(records: Array<UsageRecord | null | undefined>): UsageSummary | undefined {
  const known = records.filter((r): r is UsageRecord => Boolean(r));
  if (known.length === 0) return undefined;
  const tokens = known.reduce((s, r) => addTokens(s, r.tokens), ZERO);
  const costUsd = known.every((r) => r.costUsd !== null) ? known.reduce((s, r) => s + r.costUsd!, 0) : null;
  return { tokens, costUsd, ...(known.some((r) => r.estimated) ? { estimated: true } : {}) };
}

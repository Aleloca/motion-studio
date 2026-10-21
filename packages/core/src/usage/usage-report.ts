import { addTokens, CLAUDE_USAGE_KINDS, type ClaudeUsageKind, paidProviderSchema, paidServiceSchema, paidUnitSchema, shownTotal, type PaidUnit, type PaidUnits, type PaidUsage, type TokenCounts, type UsageBilling, type UsageRecord, type UsageReport } from '@motion-studio/shared';
import { isPaidRecord, paidUsageOf } from './paid-usage.ts';
import type { UsageLedger } from './usage-ledger.ts';

export interface UsageProject { slug: string; name: string; dir: string }
/**
 * `billing` may be a promise: it is awaited in parallel with the ledger reads. `creative`: only the records of that
 * creative slug (every run: failed, cancelled and fix rounds included). `from: null`: since the first matching record
 * (its local day; today when there is none), for an all-time creative total.
 */
export interface UsageReportInput { ledger: UsageLedger; projects: UsageProject[]; billing: UsageBilling | Promise<UsageBilling>; from: Date | null; to: Date; creative?: string }

const ZERO: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const pad = (n: number) => String(n).padStart(2, '0');
/** The day of `d` in the server's local time zone, e.g. "2026-10-09". */
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localMidnight = (d: Date, addDays = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays);

/** The last 7 local days, today included: [local midnight six days ago, local midnight after today). */
export function defaultUsageRange(now: Date = new Date()): { from: Date; to: Date } {
  return { from: localMidnight(now, -6), to: localMidnight(now, 1) };
}

/** Only `to` given: the 7 local days before it (from the local midnight seven days before `to`'s day). */
export function rangeEndingAt(to: Date): { from: Date; to: Date } {
  return { from: localMidnight(to, -7), to };
}

/** Local days touched by [from, to): one bucket each, DST changes included (days are counted by date, not by 24 h). */
export function localDays(from: Date, to: Date): string[] {
  const days: string[] = [];
  for (let d = localMidnight(from); d < to; d = localMidnight(d, 1)) days.push(localDay(d));
  return days;
}

/**
 * Sum of the known costs; null when no record of the bucket has one (never 0 standing in for "unknown"). `estimated`
 * when some record had no cost (or was a live estimate): the cost is then partial.
 */
class Bucket {
  tokens = ZERO;
  estimated = false;
  private cost = 0;
  private costs = 0;
  add(r: UsageRecord) {
    this.tokens = addTokens(this.tokens, r.tokens);
    if (r.costUsd !== null) { this.cost += r.costUsd; this.costs++; }
    if (r.costUsd === null || r.estimated) this.estimated = true;
  }
  get costUsd(): number | null { return this.costs > 0 ? this.cost : null; }
  view() { return { tokens: shownTotal(this.tokens), costUsd: this.costUsd, ...(this.estimated ? { estimated: true } : {}) }; }
}

/** Report 66: a paid bucket. Every paid record has an estimated cost, so the sum is the estimate (no "unknown" part). */
class PaidBucket {
  costUsd = 0;
  calls = 0;
  private units = new Map<PaidUnit, number>();
  private guessed = new Set<PaidUnit>();
  add(r: UsageRecord, p: PaidUsage) {
    this.costUsd += r.costUsd ?? 0;
    this.calls++;
    this.units.set(p.units.unit, (this.units.get(p.units.unit) ?? 0) + p.units.amount);
    if (p.units.estimated) this.guessed.add(p.units.unit);
  }
  view() { return { costUsd: this.costUsd, calls: this.calls }; }
  /** Summed per unit, in a fixed order (tokens, characters, seconds, minutes, images); `estimated` when part of it is a guess. */
  unitsView(): PaidUnits[] {
    return paidUnitSchema.options.flatMap((unit) => (this.units.has(unit) ? [{ unit, amount: this.units.get(unit)!, ...(this.guessed.has(unit) ? { estimated: true as const } : {}) }] : []));
  }
}

/** Builds the usage report from the projects' ledgers. Never throws on bad ledger content (bad lines are skipped). */
export async function buildUsageReport(i: UsageReportInput): Promise<UsageReport> {
  const [billing, ledgers] = await Promise.all([
    Promise.resolve(i.billing).catch(() => 'unknown' as const),
    Promise.all(i.projects.map((p) => i.ledger.read(p.dir))),
  ]);
  const match = (r: UsageRecord) => i.creative === undefined || r.creativeSlug === i.creative;
  let firstMs = Infinity;
  // Claude's runs only (report 66): a paid call never moves the start of Claude's figures.
  for (const all of ledgers) for (const r of all) if (match(r) && !isPaidRecord(r)) firstMs = Math.min(firstMs, Date.parse(r.at));
  const from = i.from ?? localMidnight(Number.isFinite(firstMs) && firstMs < i.to.getTime() ? new Date(firstMs) : new Date(i.to.getTime() - 1));
  const days = localDays(from, i.to);
  const byDay = new Map(days.map((d) => [d, new Bucket()]));
  const byKind = new Map(CLAUDE_USAGE_KINDS.map((k) => [k, new Bucket()]));
  const total = new Bucket();
  const paid = { total: new PaidBucket(), byDay: new Map(days.map((d) => [d, new PaidBucket()])), byProject: [] as UsageReport['paid']['byProject'],
    byService: new Map(paidProviderSchema.options.map((p) => [p, new PaidBucket()])), byKind: new Map(paidServiceSchema.options.map((k) => [k, new PaidBucket()])) };
  let trackedSince: { at: string; ms: number } | null = null;
  const byProject: UsageReport['byProject'] = [];
  for (const [k, p] of i.projects.entries()) {
    const all = ledgers[k]!;
    const project = new Bucket();
    const paidProject = new PaidBucket();
    for (const r of all) {
      const ms = Date.parse(r.at);
      if (!isPaidRecord(r) && (!trackedSince || ms < trackedSince.ms)) trackedSince = { at: r.at, ms };
      if (!match(r) || ms < from.getTime() || ms >= i.to.getTime()) continue;
      // Report 66: a paid service's call never counts toward Claude's figures; one with no readable measure is left out.
      if (isPaidRecord(r)) {
        const p = paidUsageOf(r);
        if (!p) continue;
        for (const b of [paid.total, paidProject, paid.byService.get(p.provider)!, paid.byKind.get(p.service)!, paid.byDay.get(localDay(new Date(ms)))]) b?.add(r, p);
        continue;
      }
      project.add(r);
      total.add(r);
      byKind.get(r.kind as ClaudeUsageKind)!.add(r);
      byDay.get(localDay(new Date(ms)))?.add(r);
    }
    byProject.push({ slug: p.slug, name: p.name, ...project.view() });
    paid.byProject.push({ slug: p.slug, name: p.name, ...paidProject.view() });
  }
  return {
    from: from.toISOString(), to: i.to.toISOString(),
    total: { tokens: total.tokens, costUsd: total.costUsd, ...(total.estimated ? { estimated: true } : {}) },
    byDay: days.map((day) => ({ day, ...byDay.get(day)!.view() })),
    byProject,
    byKind: [...byKind].map(([kind, b]) => ({ kind, ...b.view() })),
    paid: {
      ...paid.total.view(),
      byDay: days.map((day) => ({ day, ...paid.byDay.get(day)!.view() })),
      byService: [...paid.byService].map(([provider, b]) => ({ provider, ...b.view(), units: b.unitsView() })),
      byKind: [...paid.byKind].map(([service, b]) => ({ service, ...b.view(), units: b.unitsView() })),
      byProject: paid.byProject,
    },
    trackedSince: trackedSince?.at ?? null,
    billing,
    utcOffsetMinutes: -new Date(i.to.getTime() - 1).getTimezoneOffset() || 0, // never -0
  };
}

/**
 * Shown tokens of each creative's first generation (spec §5.4, the New creative estimate): the `creative` records of
 * version 1, every attempt summed (fix rounds included), one total per creative of each ledger (the same slug in two
 * projects is two creatives). A creative counts only when its first run is at or after `from` (a creative straddling
 * the window would give a partial sum). Creatives with an `estimated` record are left out: that record holds the last
 * live sum of a run cut short (cancelled, or no `result`), which undercounts the run, so the total is not a real
 * figure. Records without a cost still count: their tokens are real.
 */
export function firstGenerationTokens(ledgers: UsageRecord[][], from: Date): number[] {
  const out: number[] = [];
  for (const records of ledgers) {
    const byCreative = new Map<string, { tokens: number; first: number; estimated: boolean }>();
    for (const r of records) {
      if (r.kind !== 'creative' || r.version !== 1 || !r.creativeSlug) continue;
      const ms = Date.parse(r.at);
      const c = byCreative.get(r.creativeSlug) ?? { tokens: 0, first: ms, estimated: false };
      c.tokens += shownTotal(r.tokens);
      c.first = Math.min(c.first, ms);
      c.estimated ||= r.estimated === true;
      byCreative.set(r.creativeSlug, c);
    }
    for (const c of byCreative.values()) if (!c.estimated && c.first >= from.getTime() && c.tokens > 0) out.push(c.tokens);
  }
  return out;
}

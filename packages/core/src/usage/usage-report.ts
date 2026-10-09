import { addTokens, shownTotal, usageKindSchema, type TokenCounts, type UsageBilling, type UsageRecord, type UsageReport } from '@motion-studio/shared';
import type { UsageLedger } from './usage-ledger.ts';

export interface UsageProject { slug: string; name: string; dir: string }
/** `billing` may be a promise: it is awaited in parallel with the ledger reads. */
export interface UsageReportInput { ledger: UsageLedger; projects: UsageProject[]; billing: UsageBilling | Promise<UsageBilling>; from: Date; to: Date }

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

/** Builds the usage report from the projects' ledgers. Never throws on bad ledger content (bad lines are skipped). */
export async function buildUsageReport(i: UsageReportInput): Promise<UsageReport> {
  const [billing, ledgers] = await Promise.all([
    Promise.resolve(i.billing).catch(() => 'unknown' as const),
    Promise.all(i.projects.map((p) => i.ledger.read(p.dir))),
  ]);
  const days = localDays(i.from, i.to);
  const byDay = new Map(days.map((d) => [d, new Bucket()]));
  const byKind = new Map(usageKindSchema.options.map((k) => [k, new Bucket()]));
  const total = new Bucket();
  let trackedSince: { at: string; ms: number } | null = null;
  const byProject: UsageReport['byProject'] = [];
  for (const [k, p] of i.projects.entries()) {
    const all = ledgers[k]!;
    const project = new Bucket();
    for (const r of all) {
      const ms = Date.parse(r.at);
      if (!trackedSince || ms < trackedSince.ms) trackedSince = { at: r.at, ms };
      if (ms < i.from.getTime() || ms >= i.to.getTime()) continue;
      project.add(r);
      total.add(r);
      byKind.get(r.kind)!.add(r);
      byDay.get(localDay(new Date(ms)))?.add(r);
    }
    byProject.push({ slug: p.slug, name: p.name, ...project.view() });
  }
  return {
    from: i.from.toISOString(), to: i.to.toISOString(),
    total: { tokens: total.tokens, costUsd: total.costUsd, ...(total.estimated ? { estimated: true } : {}) },
    byDay: days.map((day) => ({ day, ...byDay.get(day)!.view() })),
    byProject,
    byKind: [...byKind].map(([kind, b]) => ({ kind, ...b.view() })),
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

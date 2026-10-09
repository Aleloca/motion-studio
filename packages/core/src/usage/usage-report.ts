import { addTokens, shownTotal, usageKindSchema, type TokenCounts, type UsageBilling, type UsageRecord, type UsageReport } from '@motion-studio/shared';
import type { UsageLedger } from './usage-ledger.ts';

export interface UsageProject { slug: string; name: string; dir: string }
export interface UsageReportInput { ledger: UsageLedger; projects: UsageProject[]; billing: UsageBilling; from: Date; to: Date }

const ZERO: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const pad = (n: number) => String(n).padStart(2, '0');
/** The day of `d` in the server's local time zone, e.g. "2026-10-09". */
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localMidnight = (d: Date, addDays = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays);

/** The last 7 local days, today included: [local midnight six days ago, local midnight after today). */
export function defaultUsageRange(now: Date = new Date()): { from: Date; to: Date } {
  return { from: localMidnight(now, -6), to: localMidnight(now, 1) };
}

/** Local days touched by [from, to): one bucket each, DST changes included (days are counted by date, not by 24 h). */
export function localDays(from: Date, to: Date): string[] {
  const days: string[] = [];
  for (let d = localMidnight(from); d < to; d = localMidnight(d, 1)) days.push(localDay(d));
  return days;
}

/** Sum of the known costs; null when no record of the bucket has one (never 0 standing in for "unknown"). */
class Bucket {
  tokens = ZERO;
  private cost = 0;
  private costs = 0;
  add(r: UsageRecord) {
    this.tokens = addTokens(this.tokens, r.tokens);
    if (r.costUsd !== null) { this.cost += r.costUsd; this.costs++; }
  }
  get costUsd(): number | null { return this.costs > 0 ? this.cost : null; }
}

/** Builds the usage report from the projects' ledgers. Never throws on bad ledger content (bad lines are skipped). */
export async function buildUsageReport(i: UsageReportInput): Promise<UsageReport> {
  const days = localDays(i.from, i.to);
  const byDay = new Map(days.map((d) => [d, new Bucket()]));
  const byKind = new Map(usageKindSchema.options.map((k) => [k, new Bucket()]));
  const total = new Bucket();
  let estimated = false;
  let trackedSince: { at: string; ms: number } | null = null;
  const byProject: UsageReport['byProject'] = [];
  for (const p of i.projects) {
    const all = await i.ledger.read(p.dir);
    const project = new Bucket();
    for (const r of all) {
      const ms = Date.parse(r.at);
      if (!trackedSince || ms < trackedSince.ms) trackedSince = { at: r.at, ms };
      if (ms < i.from.getTime() || ms >= i.to.getTime()) continue;
      project.add(r);
      total.add(r);
      byKind.get(r.kind)!.add(r);
      byDay.get(localDay(new Date(ms)))?.add(r);
      if (r.estimated || r.costUsd === null) estimated = true;
    }
    byProject.push({ slug: p.slug, name: p.name, tokens: shownTotal(project.tokens), costUsd: project.costUsd });
  }
  return {
    from: i.from.toISOString(), to: i.to.toISOString(),
    total: { tokens: total.tokens, costUsd: total.costUsd, ...(estimated ? { estimated: true } : {}) },
    byDay: days.map((day) => { const b = byDay.get(day)!; return { day, tokens: shownTotal(b.tokens), costUsd: b.costUsd }; }),
    byProject,
    byKind: [...byKind].map(([kind, b]) => ({ kind, tokens: shownTotal(b.tokens), costUsd: b.costUsd })),
    trackedSince: trackedSince?.at ?? null,
    billing: i.billing,
    utcOffsetMinutes: -new Date(i.to.getTime() - 1).getTimezoneOffset() || 0, // never -0
  };
}

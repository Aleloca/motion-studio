import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageRecordSchema, type UsageRecord } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageLedger } from '../src/usage/usage-ledger.ts';
import { buildUsageReport, defaultUsageRange, firstGenerationTokens } from '../src/usage/usage-report.ts';

const tokens = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, cacheRead, cacheWrite });
const record = (over: Partial<UsageRecord>): UsageRecord => usageRecordSchema.parse({
  at: '2026-10-09T10:00:00.000Z', jobId: 'j', kind: 'creative', creativeSlug: null, version: null, attempt: null,
  tokens: tokens(1, 1, 1000, 1), costUsd: 0.01, models: [], durationMs: 1, outcome: 'ok', ...over,
});

let previousTz: string | undefined;
beforeAll(() => { previousTz = process.env.TZ; process.env.TZ = 'Europe/Rome'; });
afterAll(() => { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; });

async function workspace() {
  const ledger = new UsageLedger();
  const a = await mkdtemp(join(tmpdir(), 'ms-rep-a-'));
  const b = await mkdtemp(join(tmpdir(), 'ms-rep-b-'));
  return { ledger, projects: [{ slug: 'acme', name: 'Acme', dir: a }, { slug: 'beta', name: 'Beta', dir: b }] };
}

describe('buildUsageReport', () => {
  it('buckets by local day across midnight, by project and by kind', async () => {
    const { ledger, projects } = await workspace();
    // Rome is UTC+2 in October: 21:30Z is 23:30 on the 8th, 22:30Z is 00:30 on the 9th.
    await ledger.append(projects[0]!.dir, record({ at: '2026-10-08T21:30:00.000Z', tokens: tokens(10, 20, 5000, 30), costUsd: 0.1 }));
    await ledger.append(projects[0]!.dir, record({ at: '2026-10-08T22:30:00.000Z', kind: 'brand-analysis', tokens: tokens(1, 2, 0, 3), costUsd: 0.2 }));
    await ledger.append(projects[1]!.dir, record({ at: '2026-10-09T09:00:00.000Z', kind: 'describe', tokens: tokens(100, 0, 0, 0), costUsd: null, estimated: true }));
    // Outside the range: counts for trackedSince only.
    await ledger.append(projects[1]!.dir, record({ at: '2026-09-01T09:00:00.000Z', tokens: tokens(7, 7, 7, 7) }));
    const now = new Date('2026-10-09T12:00:00.000Z');
    const r = await buildUsageReport({ ledger, projects, billing: 'subscription', ...defaultUsageRange(now) });
    expect(r.utcOffsetMinutes).toBe(120);
    expect(r.from).toBe('2026-10-02T22:00:00.000Z'); // local midnight six days before today
    expect(r.to).toBe('2026-10-09T22:00:00.000Z'); // local midnight after today
    expect(r.byDay.map((d) => d.day)).toEqual(['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
    expect(r.byDay.at(-2)).toEqual({ day: '2026-10-08', tokens: 60, costUsd: 0.1 });
    // The describe run has no cost: the day's cost is partial.
    expect(r.byDay.at(-1)).toEqual({ day: '2026-10-09', tokens: 106, costUsd: 0.2, estimated: true });
    expect(r.byDay[0]).toEqual({ day: '2026-10-03', tokens: 0, costUsd: null });
    expect(r.byProject).toEqual([
      { slug: 'acme', name: 'Acme', tokens: 66, costUsd: expect.closeTo(0.3, 12) },
      { slug: 'beta', name: 'Beta', tokens: 100, costUsd: null, estimated: true },
    ]);
    expect(r.byKind).toEqual([
      { kind: 'creative', tokens: 60, costUsd: 0.1 },
      { kind: 'brand-analysis', tokens: 6, costUsd: 0.2 },
      { kind: 'describe', tokens: 100, costUsd: null, estimated: true },
      { kind: 'console', tokens: 0, costUsd: null },
    ]);
    expect(r.total).toEqual({ tokens: tokens(111, 22, 5000, 33), costUsd: expect.closeTo(0.3, 12), estimated: true });
    expect(r.trackedSince).toBe('2026-09-01T09:00:00.000Z');
    expect(r.billing).toBe('subscription');
  });

  it('limits the report to one project', async () => {
    const { ledger, projects } = await workspace();
    await ledger.append(projects[0]!.dir, record({ at: '2026-10-09T08:00:00.000Z' }));
    await ledger.append(projects[1]!.dir, record({ at: '2026-10-01T08:00:00.000Z' }));
    const r = await buildUsageReport({ ledger, projects: [projects[1]!], billing: 'api', ...defaultUsageRange(new Date('2026-10-09T12:00:00.000Z')) });
    expect(r.byProject).toEqual([{ slug: 'beta', name: 'Beta', tokens: 0, costUsd: null }]);
    expect(r.trackedSince).toBe('2026-10-01T08:00:00.000Z');
  });

  it('an empty workspace gives zero buckets and no trackedSince', async () => {
    const r = await buildUsageReport({ ledger: new UsageLedger(), projects: [], billing: 'unknown', ...defaultUsageRange(new Date('2026-10-09T12:00:00.000Z')) });
    expect(r.byDay).toHaveLength(7);
    expect(r.byDay.every((d) => d.tokens === 0 && d.costUsd === null)).toBe(true);
    expect(r.byProject).toEqual([]);
    expect(r.byKind.map((k) => [k.kind, k.tokens, k.costUsd])).toEqual([['creative', 0, null], ['brand-analysis', 0, null], ['describe', 0, null], ['console', 0, null]]);
    expect(r.total).toEqual({ tokens: tokens(0, 0, 0, 0), costUsd: null });
    expect(r.trackedSince).toBeNull();
  });

  it('a range that crosses the DST change still has one bucket per local day', async () => {
    const r = await buildUsageReport({ ledger: new UsageLedger(), projects: [], billing: 'unknown', ...defaultUsageRange(new Date('2026-10-27T12:00:00.000Z')) });
    expect(r.byDay.map((d) => d.day)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
  });
});

describe('firstGenerationTokens', () => {
  const from = new Date('2026-07-11T00:00:00.000Z');
  it('sums every attempt of version 1 per creative, per project, and leaves out other versions and kinds', () => {
    const a = [
      record({ creativeSlug: 'x', version: 1, attempt: 1, tokens: tokens(100, 50, 9999, 10) }), // 160
      record({ creativeSlug: 'x', version: 1, attempt: 2, tokens: tokens(10, 10, 0, 20) }), // +40 = 200
      record({ creativeSlug: 'x', version: 2, attempt: 1, tokens: tokens(5000, 0, 0, 0) }),
      record({ creativeSlug: 'y', version: 1, attempt: 1, tokens: tokens(300, 0, 0, 0) }),
      record({ kind: 'brand-analysis', creativeSlug: null, version: null, tokens: tokens(7000, 0, 0, 0) }),
    ];
    // The same slug in another project is another creative.
    const b = [record({ creativeSlug: 'x', version: 1, attempt: 1, tokens: tokens(400, 0, 0, 0) })];
    expect(firstGenerationTokens([a, b], from).sort((m, n) => m - n)).toEqual([200, 300, 400]);
  });

  it('leaves out creatives with an estimated run (a live partial sum) and creatives started before the window', () => {
    const a = [
      record({ creativeSlug: 'cancelled', version: 1, attempt: 1, tokens: tokens(100, 0, 0, 0) }),
      record({ creativeSlug: 'cancelled', version: 1, attempt: 2, tokens: tokens(50, 0, 0, 0), costUsd: null, estimated: true }),
      record({ creativeSlug: 'old', version: 1, attempt: 1, at: '2026-07-01T10:00:00.000Z', tokens: tokens(100, 0, 0, 0) }),
      record({ creativeSlug: 'old', version: 1, attempt: 2, tokens: tokens(100, 0, 0, 0) }),
      record({ creativeSlug: 'ok', version: 1, attempt: 1, tokens: tokens(900, 0, 0, 0), costUsd: null }),
    ];
    expect(firstGenerationTokens([a], from)).toEqual([900]);
  });
});

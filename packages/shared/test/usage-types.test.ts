import { describe, expect, it } from 'vitest';
import { addTokens, shownTotal, usageRecordSchema, versionEntrySchema } from '../src/index.ts';

const tokens = { input: 10, output: 20, cacheRead: 1000, cacheWrite: 5 };
const record = {
  at: '2026-10-09T10:00:00.000Z', jobId: 'j1', kind: 'creative', creativeSlug: 'a', version: 1, attempt: 1,
  tokens, costUsd: 0.01, models: [{ model: 'haiku', tokens, costUsd: 0.01 }], durationMs: 1200, outcome: 'ok',
};

describe('usageRecordSchema', () => {
  it('accepts a record and the estimated flag', () => {
    expect(usageRecordSchema.safeParse({ ...record, estimated: true }).success).toBe(true);
  });
  it('defaults the cumulative fields for older lines', () => {
    const r = usageRecordSchema.parse(record);
    expect(r.sessionId).toBeNull();
    expect(r.cumulativeCostUsd).toBeNull();
    expect(r.cumulativeModels).toEqual([]);
  });
  it('keeps cumulative fields when present', () => {
    const r = usageRecordSchema.parse({ ...record, sessionId: 's', cumulativeCostUsd: 0.5, cumulativeModels: record.models });
    expect(r.sessionId).toBe('s');
    expect(r.cumulativeCostUsd).toBe(0.5);
  });
  it('rejects negative or fractional tokens and negative cost', () => {
    expect(usageRecordSchema.safeParse({ ...record, tokens: { ...tokens, input: -1 } }).success).toBe(false);
    expect(usageRecordSchema.safeParse({ ...record, tokens: { ...tokens, output: 1.5 } }).success).toBe(false);
    expect(usageRecordSchema.safeParse({ ...record, costUsd: -1 }).success).toBe(false);
  });
});

describe('token helpers', () => {
  it('shownTotal excludes cacheRead', () => {
    expect(shownTotal(tokens)).toBe(35);
  });
  it('addTokens sums every field', () => {
    expect(addTokens(tokens, tokens)).toEqual({ input: 20, output: 40, cacheRead: 2000, cacheWrite: 10 });
  });
});

describe('versionEntrySchema', () => {
  const entry = {
    n: 1, commit: null, sessionId: null, status: 'complete', createdAt: '2026-10-09T10:00:00.000Z', request: 'x',
    outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null,
  };
  it('parses an old entry without usage', () => {
    expect(versionEntrySchema.parse(entry).usage).toBeUndefined();
  });
  it('parses an entry with usage', () => {
    expect(versionEntrySchema.parse({ ...entry, usage: { tokens, costUsd: null } }).usage?.costUsd).toBeNull();
  });
});

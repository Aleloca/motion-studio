import { appendFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageRecordSchema, type UsageRecord } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageBill, musicBill, PAID_PRICES, paidRecord, sfxBill, sttBill, voiceBill } from '../src/usage/paid-usage.ts';
import { UsageLedger, usageLedgerFile } from '../src/usage/usage-ledger.ts';
import { buildUsageReport, defaultUsageRange } from '../src/usage/usage-report.ts';

const tokens = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, cacheRead, cacheWrite });
const claude = (over: Partial<UsageRecord>): UsageRecord => usageRecordSchema.parse({
  at: '2026-10-09T10:00:00.000Z', jobId: 'j', kind: 'creative', creativeSlug: null, version: null, attempt: null,
  tokens: tokens(100, 50, 0, 10), costUsd: 0.5, models: [], durationMs: 1, outcome: 'ok', ...over,
});
const at = (iso: string) => new Date(iso);

let previousTz: string | undefined;
beforeAll(() => { previousTz = process.env.TZ; process.env.TZ = 'Europe/Rome'; });
afterAll(() => { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; });

describe('paid bills', () => {
  it('images: the tokens of `usage` (text and image input, output) at token prices', () => {
    const b = imageBill({ input_tokens: 1000, output_tokens: 4000, input_tokens_details: { text_tokens: 200, image_tokens: 800 } }, { quality: 'high', width: 1024, height: 1024 });
    expect(b).toMatchObject({ provider: 'openai', service: 'images', model: 'gpt-image-2', units: { amount: 5000, unit: 'tokens' }, inputTokens: 1000, outputTokens: 4000 });
    expect(b.costUsd).toBeCloseTo((200 * 5 + 800 * 10 + 4000 * 40) / 1e6, 9);
  });
  it('images without `usage`: a price per picture by quality, scaled by size; auto counts as high', () => {
    expect(imageBill(undefined, { quality: 'medium', width: 1024, height: 1024 })).toMatchObject({ units: { amount: 1, unit: 'images' }, costUsd: 0.042 });
    expect(imageBill({}, { quality: 'auto', width: 1024, height: 2048 }).costUsd).toBeCloseTo(0.334, 6);
    expect(imageBill(null, { width: 512, height: 512 }).costUsd).toBe(0.167);
  });
  it('voice per character, music and sound effects per second (default duration when none), transcription per minute', () => {
    expect(voiceBill('openai', 1000)).toMatchObject({ model: 'gpt-4o-mini-tts', units: { amount: 1000, unit: 'characters' }, costUsd: 0.015 });
    expect(voiceBill('elevenlabs', 1000)).toMatchObject({ model: 'eleven_multilingual_v2', costUsd: 0.1 });
    expect(musicBill(30)).toMatchObject({ provider: 'elevenlabs', service: 'music', units: { amount: 30, unit: 'seconds' }, costUsd: 0.4 });
    expect(sfxBill(undefined)).toMatchObject({ service: 'sfx', units: { amount: PAID_PRICES.elevenlabsSfx.defaultSeconds, unit: 'seconds' }, costUsd: 0.02 });
    expect(sfxBill(2.5).costUsd).toBe(0.01);
    expect(sttBill('openai', 61)).toMatchObject({ service: 'transcription', units: { amount: 2, unit: 'minutes' }, costUsd: 0.012 });
  });
  it('a record of kind paid with zero Claude tokens and the image tokens on its model', () => {
    const r = usageRecordSchema.parse(paidRecord({ jobId: 'j', creativeSlug: 'promo', bill: imageBill({ input_tokens: 10, output_tokens: 20 }, { width: 1024, height: 1024 }), at: at('2026-10-09T10:00:00.000Z') }));
    expect(r).toMatchObject({ kind: 'paid', creativeSlug: 'promo', tokens: tokens(0, 0, 0, 0), paid: { provider: 'openai', service: 'images', units: { amount: 30, unit: 'tokens' } } });
    expect(r.models[0]!.tokens).toEqual(tokens(10, 20, 0, 0));
  });
});

describe('buildUsageReport · paid services', () => {
  it("keeps Claude's figures to Claude's runs and puts the paid calls in `paid`, old transcription lines and a bad line too", async () => {
    const ledger = new UsageLedger();
    const a = await mkdtemp(join(tmpdir(), 'ms-paid-a-'));
    const b = await mkdtemp(join(tmpdir(), 'ms-paid-b-'));
    const projects = [{ slug: 'acme', name: 'Acme', dir: a }, { slug: 'beta', name: 'Beta', dir: b }];
    await ledger.append(a, claude({ creativeSlug: 'promo' }));
    await ledger.append(a, paidRecord({ jobId: 'i', creativeSlug: 'promo', bill: imageBill({ input_tokens: 100, output_tokens: 900 }, { width: 1024, height: 1024 }), at: at('2026-10-09T09:00:00.000Z') }));
    await ledger.append(a, paidRecord({ jobId: 'v', bill: voiceBill('openai', 2000), at: at('2026-10-08T09:00:00.000Z') }));
    await ledger.append(b, paidRecord({ jobId: 'e', bill: voiceBill('elevenlabs', 500), at: at('2026-10-09T09:00:00.000Z') }));
    await ledger.append(b, paidRecord({ jobId: 'm', bill: musicBill(30), at: at('2026-10-09T09:30:00.000Z') }));
    // A transcription line written before report 66 (no `paid`), then a malformed one: the first lands in paid, the second is skipped.
    await mkdir(join(b, '.studio'), { recursive: true });
    await appendFile(usageLedgerFile(b), `${JSON.stringify({
      at: '2026-10-09T11:00:00.000Z', jobId: 't', kind: 'transcription', creativeSlug: null, version: null, attempt: null,
      tokens: tokens(0, 0, 0, 0), costUsd: 0.003667, models: [{ model: 'scribe_v2', tokens: tokens(0, 0, 0, 0), costUsd: 0.003667 }],
      durationMs: null, outcome: 'ok', sessionId: null, cumulativeCostUsd: null, cumulativeModels: [],
    })}\n{"at":"2026-10-09T11:00:00.000Z","kind":"paid","paid":{"provider":"nope"}}\n`);
    const r = await buildUsageReport({ ledger, projects, billing: 'api', ...defaultUsageRange(at('2026-10-09T12:00:00.000Z')) });

    expect(r.total).toEqual({ tokens: tokens(100, 50, 0, 10), costUsd: 0.5 });
    expect(r.byProject).toEqual([{ slug: 'acme', name: 'Acme', tokens: 160, costUsd: 0.5 }, { slug: 'beta', name: 'Beta', tokens: 0, costUsd: null }]);
    expect(r.byKind.map((k) => k.kind)).toEqual(['creative', 'brand-analysis', 'describe', 'console', 'localize', 'video-analysis']);
    expect(r.byDay.at(-1)).toEqual({ day: '2026-10-09', tokens: 160, costUsd: 0.5 });

    const imageCost = (100 * 5 + 900 * 40) / 1e6;
    const p = r.paid;
    expect(p.calls).toBe(5);
    expect(p.costUsd).toBeCloseTo(imageCost + 0.03 + 0.05 + 0.4 + 0.003667, 6);
    expect(p.byDay.at(-2)).toEqual({ day: '2026-10-08', costUsd: 0.03, calls: 1 });
    expect(p.byDay.at(-1)!.calls).toBe(4);
    expect(p.byService).toEqual([
      { provider: 'openai', calls: 2, costUsd: expect.closeTo(imageCost + 0.03, 9), units: [{ unit: 'tokens', amount: 1000 }, { unit: 'characters', amount: 2000 }] },
      { provider: 'elevenlabs', calls: 3, costUsd: expect.closeTo(0.05 + 0.4 + 0.003667, 9), units: [{ unit: 'characters', amount: 500 }, { unit: 'seconds', amount: 30 }, { unit: 'minutes', amount: 1 }] },
    ]);
    expect(p.byKind).toEqual([
      { service: 'images', calls: 1, costUsd: expect.closeTo(imageCost, 9), units: [{ unit: 'tokens', amount: 1000 }] },
      { service: 'voice', calls: 2, costUsd: expect.closeTo(0.08, 9), units: [{ unit: 'characters', amount: 2500 }] },
      { service: 'music', calls: 1, costUsd: 0.4, units: [{ unit: 'seconds', amount: 30 }] },
      { service: 'sfx', calls: 0, costUsd: 0, units: [] },
      { service: 'transcription', calls: 1, costUsd: 0.003667, units: [{ unit: 'minutes', amount: 1 }] },
    ]);
    expect(p.byProject).toEqual([
      { slug: 'acme', name: 'Acme', calls: 2, costUsd: expect.closeTo(imageCost + 0.03, 9) },
      { slug: 'beta', name: 'Beta', calls: 3, costUsd: expect.closeTo(0.453667, 9) },
    ]);
  });

  it("a creative's report stays Claude's; its paid calls are in `paid`", async () => {
    const ledger = new UsageLedger();
    const a = await mkdtemp(join(tmpdir(), 'ms-paid-c-'));
    await ledger.append(a, claude({ creativeSlug: 'promo' }));
    await ledger.append(a, paidRecord({ jobId: 'i', creativeSlug: 'promo', bill: musicBill(10), at: at('2026-10-09T09:00:00.000Z') }));
    const r = await buildUsageReport({ ledger, projects: [{ slug: 'acme', name: 'Acme', dir: a }], billing: 'api', from: null, to: at('2026-10-09T22:00:00.000Z'), creative: 'promo' });
    expect(r.total.costUsd).toBe(0.5);
    expect(r.paid).toMatchObject({ calls: 1, costUsd: expect.closeTo(0.133333, 6) });
  });

  it('empty when nothing paid', async () => {
    const r = await buildUsageReport({ ledger: new UsageLedger(), projects: [], billing: 'unknown', ...defaultUsageRange(at('2026-10-09T12:00:00.000Z')) });
    expect(r.paid.calls).toBe(0);
    expect(r.paid.costUsd).toBe(0);
    expect(r.paid.byDay).toHaveLength(7);
    expect(r.paid.byService.map((s) => s.provider)).toEqual(['openai', 'elevenlabs']);
  });
});

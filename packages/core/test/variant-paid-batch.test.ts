// @vitest-environment node
/**
 * Phase 15, Task 3, Review Focus 4 (spec §3 "Servizi a pagamento"), with the orchestrator's fix round 1: "Tutte" with 4 active
 * variants and a paid tool. Exactly one `paid-batch` confirmation (the phase 12 mechanism) lists every variant, the calls per
 * provider and the total. No variant turn starts before it is answered: approving starts them (two run, two wait with the
 * reason) under its cover (their paid calls ask nothing more); declining or the card expiring cancels all four, so nothing ran
 * and nothing was spent. Working variants are in the same card: their request waits in their own queue for the decision and
 * leaves it on a decline. No card when nothing paid can be called. A single creative keeps its per-call confirmation.
 * Controlled runner, MemoryVault and a fake fetch: nothing leaves the machine.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messages, type ApprovalRequest } from '@motion-studio/shared';
import { variantApp, type VariantApp } from './helpers/variant-app.ts';

vi.setConfig({ testTimeout: 60_000 });

let v: VariantApp;
afterEach(async () => { await v?.close(); });

const KEYS = { OPENAI_API_KEY: 'sk-test-0123456789' };
const OLD_BRIEF = { goal: 'x', message: '', formats: ['instagram-post-1x1'], durationSec: 10, assets: [], notes: '' };
const run = (slug: string, body: unknown) => v.app.inject({ method: 'POST', url: `${v.url(slug)}/variants/run`, payload: body as object });
const decide = (a: ApprovalRequest, decision: string) => v.app.inject({ method: 'POST', url: `/api/approvals/${a.id}`, payload: { decision } });
const stateOf = async (id: string) => (await v.jobs()).find((j) => j.id === id)!;
const turn = (slug: string, text: string) => v.app.inject({ method: 'POST', url: `${v.url(slug)}/turns`, payload: { text } });
/** The `nth` run (0: first) of member `s`, once it started (runs released together start in any order). */
const runOf = async (s: string, nth = 0) => {
  const mine = () => v.runner.runs.filter((r) => r.req.prompt.includes(`creatives/${s}/outputs`));
  await vi.waitFor(() => expect(mine().length).toBeGreaterThan(nth), { timeout: 10_000 });
  return mine()[nth]!;
};

async function fourVariants() {
  const slug = await v.group(['Audace', 'Calma', 'Retro', 'Pop']);
  const res = await run(slug, { targets: 'all-active', request: { text: 'Aggiungi una voce fuori campo' } });
  expect(res.statusCode, res.body).toBe(202);
  const body = res.json() as { jobs: Record<'a' | 'b' | 'c' | 'd', string>; batchId: string };
  expect(body.batchId).toBeTruthy();
  return { slug, ids: body.jobs, batchId: body.batchId };
}

describe('variant paid batch (Review Focus 4)', () => {
  it('one card for the whole fan-out; no turn starts before it; declining cancels all four: nothing ran, nothing was spent', async () => {
    v = await variantApp({ keys: KEYS });
    const { ids, batchId } = await fourVariants();
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    const card = (await v.pending())[0]!;
    expect(card).toMatchObject({ kind: 'paid-batch', jobId: batchId, alwaysRule: null });
    const items = card.paidBatch!.items!;
    expect([...new Set(items.map((i) => i.variant))].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(items.filter((i) => i.variant === 'a').map((i) => [i.provider, i.capability]).sort()).toEqual([['openai', 'images'], ['openai', 'voice']]);
    expect(card.paidBatch!.total).toEqual({ variants: 4, calls: 8, providers: [{ provider: 'openai', calls: 8 }] });
    // Today's card still renders: one call line per item; the detail gives the call estimate, no price.
    expect(card.paidBatch!.calls).toHaveLength(8);
    expect(card.detail).toContain('OpenAI 8');
    // Held: every turn waits for the card, no agent runs.
    for (const id of Object.values(ids)) expect(await stateOf(id)).toMatchObject({ state: 'queued', waitReason: 'variant-confirm' });
    await new Promise((r) => setTimeout(r, 150));
    expect(v.runner.runs).toHaveLength(0);
    expect((await decide(card, 'deny')).statusCode).toBe(200);
    await v.waitIdle();
    for (const id of Object.values(ids)) expect((await stateOf(id)).state, id).toBe('cancelled');
    expect(v.runner.runs).toHaveLength(0);
    expect(v.fetches).toEqual([]);
    expect(await v.pending()).toEqual([]);
  });

  it('an expired card cancels all four the same way', async () => {
    v = await variantApp({ keys: KEYS, approvalTimeoutMs: 400 });
    const { ids } = await fourVariants();
    await vi.waitFor(async () => expect((await stateOf(ids.d)).state).toBe('cancelled'), { timeout: 10_000 });
    await v.waitIdle();
    for (const id of Object.values(ids)) expect((await stateOf(id)).state, id).toBe('cancelled');
    expect(v.runner.runs).toHaveLength(0);
    expect(await v.pending()).toEqual([]);
  });

  it('approved: two run, two wait with the reason; covered calls ask nothing more; stopping one leaves the others running', async () => {
    v = await variantApp({ keys: KEYS });
    const { slug, ids } = await fourVariants();
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    const [card] = await v.pending();
    expect((await decide(card!, 'once')).statusCode).toBe(200);
    const ra = await runOf(slug);
    const rb = await runOf(`${slug}~b`);
    await vi.waitFor(async () => expect((await stateOf(ids.d)).waitReason).toBe('variant-slot'));
    expect((await stateOf(ids.a)).state).toBe('running');
    expect((await stateOf(ids.b)).state).toBe('running');
    expect(await stateOf(ids.c)).toMatchObject({ state: 'queued', waitReason: 'variant-slot' });
    const voice = await v.bridge(ra, 'tts', { text: 'Benvenuti', provider: 'openai' });
    expect(voice.statusCode, voice.body).toBe(200);
    expect(await v.pending()).toEqual([]);
    expect(v.fetches.filter((u) => u.includes('/audio/speech'))).toHaveLength(1);
    // Stop B: C takes its slot, A and the queued D are untouched.
    await v.app.inject({ method: 'POST', url: `/api/jobs/${ids.b}/stop` });
    await vi.waitFor(async () => expect((await stateOf(ids.b)).state).toBe('cancelled'), { timeout: 10_000 });
    const rc = await runOf(`${slug}~c`);
    expect(rb.cancelled).toBe(true);
    expect((await stateOf(ids.a)).state).toBe('running');
    expect((await stateOf(ids.d)).state).toBe('queued');
    expect((await v.bridge(rc, 'tts', { text: 'Ciao', provider: 'openai' })).statusCode).toBe(200);
    expect(await v.pending()).toEqual([]);
    ra.finish();
    rc.finish();
    await runOf(`${slug}~d`).then((r) => r.finish());
    await v.waitIdle();
    expect((await stateOf(ids.d)).state).toBe('succeeded');
  });

  it('1 idle + 2 working: one card for all three; a working variant\'s request waits for it even when its turn ends first, then runs covered', async () => {
    v = await variantApp({ keys: KEYS });
    const slug = await v.group(['Audace', 'Calma', 'Retro']);
    expect((await turn(`${slug}~b`, 'Prima B')).statusCode).toBe(202);
    expect((await turn(`${slug}~c`, 'Prima C')).statusCode).toBe(202);
    const [rb0, rc0] = [await v.runner.next(0), await v.runner.next(1)];
    const res = await run(slug, { targets: 'all-active', request: { text: 'Più luce' } });
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json() as { jobs: Record<string, string>; queued: string[]; batchId: string };
    expect(Object.keys(body.jobs)).toEqual(['a']);
    expect(body.queued).toEqual(['b', 'c']);
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    const cards = await v.pending();
    expect([...new Set(cards[0]!.paidBatch!.items!.map((i) => i.variant))].sort()).toEqual(['a', 'b', 'c']);
    expect(await stateOf(body.jobs.a!)).toMatchObject({ state: 'queued', waitReason: 'variant-confirm' });
    // B's turn ends before the decision: its queued request becomes a turn, but held.
    rb0.finish();
    await vi.waitFor(async () => expect(await v.jobOf(`${slug}~b`)).toMatchObject({ state: 'queued', waitReason: 'variant-confirm' }), { timeout: 10_000 });
    expect(v.runner.runs).toHaveLength(2);
    await decide(cards[0]!, 'once');
    // C still works its first turn: A (older) takes the second slot, B's request waits for a slot.
    const ra = await runOf(slug);
    await vi.waitFor(async () => expect(await v.jobOf(`${slug}~b`)).toMatchObject({ state: 'queued', waitReason: 'variant-slot' }));
    rc0.finish();
    const rb = await runOf(`${slug}~b`, 1);
    expect((await v.bridge(rb, 'tts', { text: 'Ciao B', provider: 'openai' })).statusCode).toBe(200);
    ra.finish();
    // C's queued request starts after its turn, under the cover keyed by its clientId.
    const rc = await runOf(`${slug}~c`, 1);
    expect((await v.bridge(rc, 'tts', { text: 'Ciao C', provider: 'openai' })).statusCode).toBe(200);
    expect(await v.pending()).toEqual([]);
    rb.finish();
    rc.finish();
    await v.waitIdle();
  });

  it('all working: one card; declining takes the requests out of their queues (and cancels one that already became a held turn)', async () => {
    v = await variantApp({ keys: KEYS });
    const slug = await v.group(['Audace', 'Calma']);
    await turn(slug, 'Prima A');
    await turn(`${slug}~b`, 'Prima B');
    const [ra0, rb0] = [await v.runner.next(0), await v.runner.next(1)];
    const res = await run(slug, { targets: 'all-active', request: { text: 'Più luce' } });
    const body = res.json() as { jobs: Record<string, string>; queued: string[] };
    expect(body.jobs).toEqual({});
    expect(body.queued).toEqual(['a', 'b']);
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    expect((await v.detail(slug)).creative.queued).toHaveLength(1);
    rb0.finish();
    await vi.waitFor(async () => expect(await v.jobOf(`${slug}~b`)).toMatchObject({ state: 'queued', waitReason: 'variant-confirm' }), { timeout: 10_000 });
    const held = (await v.jobOf(`${slug}~b`))!.id;
    await decide((await v.pending())[0]!, 'deny');
    await vi.waitFor(async () => expect((await stateOf(held)).state).toBe('cancelled'));
    await vi.waitFor(async () => expect((await v.detail(slug)).creative.queued ?? []).toEqual([]));
    ra0.finish();
    await v.waitIdle();
    expect(v.runner.runs).toHaveLength(2);
    expect(v.fetches).toEqual([]);
  });

  it('a working variant\'s request for some formats is refused with the reason, not widened to every format', async () => {
    v = await variantApp({ keys: KEYS });
    const slug = await v.group(['Audace', 'Calma']);
    await turn(`${slug}~b`, 'Prima B');
    const rb0 = await v.runner.next(0);
    const res = await run(slug, { targets: 'all-active', request: { text: 'Solo il post', formats: ['instagram-post-1x1'] } });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { jobs: Record<string, string>; queued: string[]; failed: Record<string, string> };
    expect(Object.keys(body.jobs)).toEqual(['a']);
    expect(body.queued).toEqual([]);
    expect([messages('it').errors.variantBusyFormats({ letter: 'B' }), messages('en').errors.variantBusyFormats({ letter: 'B' })]).toContain(body.failed.b);
    expect((await v.detail(`${slug}~b`)).creative.queued ?? []).toEqual([]);
    // One target left: a single turn, no card, started at once.
    expect(await v.pending()).toEqual([]);
    expect((await stateOf(body.jobs.a!)).state).toBe('running');
    rb0.finish();
    await v.runner.next(1).then((r) => r.finish());
    await v.waitIdle();
  });

  it('a call the batch does not cover still asks; a single creative keeps its own per-call card', async () => {
    v = await variantApp({ keys: KEYS });
    const old = ((await v.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Vecchia', brief: OLD_BRIEF, generate: false } })).json() as { slug: string }).slug;
    const job = (await v.app.inject({ method: 'POST', url: `${v.url(old)}/turns`, payload: { text: 'Con voce' } })).json();
    const r = await v.runner.next(0);
    const call = v.bridge(r, 'tts', { text: 'Benvenuti', provider: 'openai' });
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    const [card] = await v.pending();
    expect(card).toMatchObject({ kind: 'provider', jobId: job.id, toolName: 'provider:tts-openai' });
    expect(card!.paidBatch).toBeUndefined();
    await decide(card!, 'deny');
    expect((await call).statusCode).toBe(403);
    r.finish();
    await v.waitIdle();
  });

  it('no card, and the turns start at once, when nothing paid can be called, when the confirmation is off, or for one target', async () => {
    // No provider configured.
    v = await variantApp({ keys: {} });
    let slug = await v.group(['Audace', 'Calma']);
    let res = await run(slug, { targets: 'all-active', request: null });
    expect(res.json().batchId).toBeUndefined();
    expect(await v.pending()).toEqual([]);
    await vi.waitFor(() => expect(v.runner.runs).toHaveLength(2));
    await v.close();
    // Every paid type `none` in the brief, keys set.
    v = await variantApp({ keys: { ...KEYS, ELEVENLABS_API_KEY: 'el-test-0123456789' } });
    slug = await v.group(['Audace', 'Calma']);
    expect((await v.app.inject({ method: 'PUT', url: v.url(slug), payload: { services: { images: 'none', voice: 'none', music: 'none', sfx: 'none' } } })).statusCode).toBe(200);
    res = await run(slug, { targets: 'all-active', request: null });
    expect(res.json().batchId).toBeUndefined();
    expect(await v.pending()).toEqual([]);
    await vi.waitFor(() => expect(v.runner.runs).toHaveLength(2));
    await v.close();
    // The confirmation is off.
    v = await variantApp({ keys: KEYS, settings: { confirmPaidProviders: false } });
    slug = await v.group(['Audace', 'Calma']);
    expect((await run(slug, { targets: 'all-active', request: null })).statusCode).toBe(202);
    expect(await v.pending()).toEqual([]);
    await vi.waitFor(() => expect(v.runner.runs).toHaveLength(2));
    await v.close();
    // One target is a single turn: its paid calls ask one by one, as a single creative's do.
    v = await variantApp({ keys: KEYS });
    slug = await v.group(['Audace', 'Calma']);
    expect((await run(slug, { targets: ['b'], request: null })).statusCode).toBe(202);
    expect(await v.pending()).toEqual([]);
    await vi.waitFor(() => expect(v.runner.runs).toHaveLength(1));
  });
});

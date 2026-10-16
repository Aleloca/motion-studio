// @vitest-environment node
/**
 * Phase 15, Task 3, Review Focus 4 (spec §3 "Servizi a pagamento"): "Tutte" with 4 active variants and a paid tool. Exactly
 * one `paid-batch` confirmation (the phase 12 mechanism) lists every variant and the total; the variant turns' own paid calls
 * wait for that one decision instead of asking again. Two run, two wait with the reason. Declining cancels all four with no
 * spend; approving lets the covered calls through without another card; stopping one variant leaves the others running. A
 * single creative keeps its per-call confirmation. Controlled runner, MemoryVault and a fake fetch: nothing leaves the machine.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@motion-studio/shared';
import { variantApp, type VariantApp } from './helpers/variant-app.ts';

vi.setConfig({ testTimeout: 60_000 });

let v: VariantApp;
afterEach(async () => { await v?.close(); });

const KEYS = { OPENAI_API_KEY: 'sk-test-0123456789' };
const run = (slug: string, body: unknown) => v.app.inject({ method: 'POST', url: `${v.url(slug)}/variants/run`, payload: body as object });
const decide = (a: ApprovalRequest, decision: string) => v.app.inject({ method: 'POST', url: `/api/approvals/${a.id}`, payload: { decision } });
const stateOf = async (id: string) => (await v.jobs()).find((j) => j.id === id)!;

async function fourVariants() {
  const slug = await v.group(['Audace', 'Calma', 'Retro', 'Pop']);
  const res = await run(slug, { targets: 'all-active', request: { text: 'Aggiungi una voce fuori campo' } });
  expect(res.statusCode, res.body).toBe(202);
  return { slug, ids: res.json().jobs as Record<'a' | 'b' | 'c' | 'd', string> };
}

describe('variant paid batch (Review Focus 4)', () => {
  it('one card for the whole fan-out, listing every variant and the total; declining cancels all four with no spend', async () => {
    v = await variantApp({ keys: KEYS });
    const { ids } = await fourVariants();
    const cards = await v.pending();
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.kind).toBe('paid-batch');
    expect(card.alwaysRule).toBeNull();
    expect(Object.values(ids)).not.toContain(card.jobId);
    const items = card.paidBatch!.items!;
    expect([...new Set(items.map((i) => i.variant))].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(items.filter((i) => i.variant === 'a').map((i) => [i.provider, i.capability]).sort()).toEqual([['openai', 'images'], ['openai', 'voice']]);
    expect(card.paidBatch!.total).toMatchObject({ variants: 4, calls: items.length });
    // Today's card still renders: one call line per item.
    expect(card.paidBatch!.calls).toHaveLength(items.length);
    // Two run, two wait with the reason.
    expect((await stateOf(ids.a)).state).toBe('running');
    expect((await stateOf(ids.b)).state).toBe('running');
    expect(await stateOf(ids.c)).toMatchObject({ state: 'queued', waitReason: 'variant-slot' });
    expect(await stateOf(ids.d)).toMatchObject({ state: 'queued', waitReason: 'variant-slot' });
    // A's agent asks for a voice: no card of its own, the call waits for the batch's decision.
    const ra = await v.runner.next(0);
    const call = v.bridge(ra, 'tts', { text: 'Benvenuti', provider: 'openai' });
    await new Promise((r) => setTimeout(r, 150));
    expect(await v.pending()).toHaveLength(1);
    expect((await decide(card, 'deny')).statusCode).toBe(200);
    // Refused: 403 (declined) or 499 (its job was stopped by the decline first); either way nothing was sent.
    const answer = await call;
    expect([403, 499]).toContain(answer.statusCode);
    await v.waitIdle();
    for (const id of Object.values(ids)) expect((await stateOf(id)).state, id).toBe('cancelled');
    expect(v.fetches).toEqual([]);
    expect(await v.pending()).toEqual([]);
    // The two that never started never ran an agent.
    expect(v.runner.runs).toHaveLength(2);
  });

  it('approved once: the covered calls go through without another card; stopping one variant leaves the others running', async () => {
    v = await variantApp({ keys: KEYS });
    const { ids } = await fourVariants();
    const [card] = await v.pending();
    expect((await decide(card!, 'once')).statusCode).toBe(200);
    const ra = await v.runner.next(0);
    const rb = await v.runner.next(1);
    const voice = await v.bridge(ra, 'tts', { text: 'Benvenuti', provider: 'openai' });
    expect(voice.statusCode, voice.body).toBe(200);
    expect(await v.pending()).toEqual([]);
    expect(v.fetches.filter((u) => u.includes('/audio/speech'))).toHaveLength(1);
    // Stop B: C takes its slot, A and the queued D are untouched.
    await v.app.inject({ method: 'POST', url: `/api/jobs/${ids.b}/stop` });
    await vi.waitFor(async () => expect((await stateOf(ids.b)).state).toBe('cancelled'));
    const rc = await v.runner.next(2);
    expect(rb.cancelled).toBe(true);
    expect((await stateOf(ids.a)).state).toBe('running');
    expect((await stateOf(ids.d)).state).toBe('queued');
    // C started after the decision: still covered by it.
    expect((await v.bridge(rc, 'tts', { text: 'Ciao', provider: 'openai' })).statusCode).toBe(200);
    expect(await v.pending()).toEqual([]);
    ra.finish();
    rc.finish();
    await v.runner.next(3).then((r) => r.finish());
    await v.waitIdle();
    expect((await stateOf(ids.d)).state).toBe('succeeded');
  });

  it('a call the batch does not cover still asks; a single creative keeps its own per-call card', async () => {
    v = await variantApp({ keys: KEYS });
    const old = ((await v.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Vecchia', brief: { goal: 'x', message: '', formats: ['instagram-post-1x1'], durationSec: 10, assets: [], notes: '' }, generate: false } })).json() as { slug: string }).slug;
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

  it('no card when nothing paid can be used, when the confirmation is off, or for a single target', async () => {
    v = await variantApp({ keys: {} });
    let slug = await v.group(['Audace', 'Calma']);
    expect((await run(slug, { targets: 'all-active', request: null })).statusCode).toBe(202);
    expect(await v.pending()).toEqual([]);
    v.runner.runs.forEach((r) => r.finish());
    await vi.waitFor(() => expect(v.runner.runs).toHaveLength(2));
    v.runner.runs.forEach((r) => r.finish());
    await v.waitIdle();
    await v.close();
    v = await variantApp({ keys: KEYS, settings: { confirmPaidProviders: false } });
    slug = await v.group(['Audace', 'Calma']);
    expect((await run(slug, { targets: 'all-active', request: null })).statusCode).toBe(202);
    expect(await v.pending()).toEqual([]);
    await v.close();
    // One target is a single turn: its paid calls ask one by one, as a single creative's do.
    v = await variantApp({ keys: KEYS });
    slug = await v.group(['Audace', 'Calma']);
    expect((await run(slug, { targets: ['b'], request: null })).statusCode).toBe(202);
    expect(await v.pending()).toEqual([]);
  });
});

// @vitest-environment node
/**
 * Phase 15, Task 3, Review Focus 4 (spec §3 "Servizi a pagamento"), with the orchestrator's fix round 1: "Tutte" with 4 active
 * variants and a paid tool. Exactly one `paid-batch` confirmation (the phase 12 mechanism) lists every variant, the calls per
 * provider and the total. No variant turn starts before it is answered: approving starts them (two run, two wait with the
 * reason) under its cover (their paid calls ask nothing more); declining (decision 1126) starts them with paid services off;
 * the card expiring or going away cancels all four, so nothing ran and nothing was spent. Working variants are in the same card: their request waits in their own queue for the decision and
 * leaves it on a decline. No card when nothing paid can be called. A single creative keeps its per-call confirmation.
 * Controlled runner, MemoryVault and a fake fetch: nothing leaves the machine.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messages, type ApprovalRequest } from '@motion-studio/shared';
import { CreativeSideStateStore } from '../src/creatives/creative-side-state.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { CreativeTurnService } from '../src/creatives/creative-turns.ts';
import { variantApp, type VariantApp } from './helpers/variant-app.ts';

vi.setConfig({ testTimeout: 60_000 });

let v: VariantApp;
afterEach(async () => { vi.restoreAllMocks(); await v?.close(); });

/** A gate: `wait()` blocks until `open()`; `reached` resolves once something waits on it. */
function gate() {
  let open!: () => void;
  let reach!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const reached = new Promise<void>((r) => { reach = r; });
  return { open, reached, wait: () => { reach(); return opened; } };
}

const KEYS = { OPENAI_API_KEY: 'sk-test-0123456789' };
const OLD_BRIEF = { goal: 'x', message: '', formats: ['instagram-post-1x1'], durationSec: 10, assets: [], notes: '' };
const run = (slug: string, body: unknown) => v.app.inject({ method: 'POST', url: `${v.url(slug)}/variants/run`, payload: body as object });
/** The card gone without an answer (as when every target is stopped): the whole run is cancelled. */
const dismiss = (a: ApprovalRequest) => v.approvals.cancelJob(a.jobId);
const decide = (a: ApprovalRequest, decision: string) => v.app.inject({ method: 'POST', url: `/api/approvals/${a.id}`, payload: { decision } });
const stateOf = async (id: string) => (await v.jobs()).find((j) => j.id === id)!;
const turn = (slug: string, text: string) => v.app.inject({ method: 'POST', url: `${v.url(slug)}/turns`, payload: { text } });
const runOf = (s: string, nth = 0) => v.runOf(s, nth);

async function fourVariants() {
  const slug = await v.group(['Audace', 'Calma', 'Retro', 'Pop']);
  const res = await run(slug, { targets: 'all-active', request: { text: 'Aggiungi una voce fuori campo' } });
  expect(res.statusCode, res.body).toBe(202);
  const body = res.json() as { jobs: Record<'a' | 'b' | 'c' | 'd', string>; batchId: string };
  expect(body.batchId).toBeTruthy();
  return { slug, ids: body.jobs, batchId: body.batchId };
}

describe('variant paid batch (Review Focus 4)', () => {
  it('one card for the whole fan-out; no turn starts before it; declining starts all four WITHOUT paid services: nothing spent, no new question', async () => {
    v = await variantApp({ keys: KEYS });
    const { slug, ids, batchId } = await fourVariants();
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
    // Decision 1126: the card says what Decline does.
    expect(card.detail).toMatch(/Decline starts the variants without paid services|Rifiuta avvia le varianti senza servizi a pagamento/);
    // Held: every turn waits for the card, no agent runs.
    for (const id of Object.values(ids)) expect(await stateOf(id)).toMatchObject({ state: 'queued', waitReason: 'variant-confirm' });
    await new Promise((r) => setTimeout(r, 150));
    expect(v.runner.runs).toHaveLength(0);
    expect((await decide(card, 'deny')).statusCode).toBe(200);
    // Two run, two wait for a slot: the run goes on, with paid services off.
    const ra = await runOf(slug);
    await runOf(`${slug}~b`);
    await vi.waitFor(async () => expect((await stateOf(ids.d)).waitReason).toBe('variant-slot'));
    expect(ra.req.prompt).toMatch(/off for this run/);
    // A paid call is refused without a card, even though the provider has a key.
    const voice = await v.bridge(ra, 'tts', { text: 'Benvenuti', provider: 'openai' });
    expect(voice.statusCode).toBeGreaterThanOrEqual(400);
    expect(await v.pending()).toEqual([]);
    expect(v.fetches).toEqual([]);
    ra.finish();
    (await runOf(`${slug}~b`)).finish();
    (await runOf(`${slug}~c`)).finish();
    (await runOf(`${slug}~d`)).finish();
    await v.waitIdle();
  });

  it('decision 1125: an identity pack (vector logo, favicon, app icon) asks for no paid service at all; a still image only for images; a video for all', async () => {
    v = await variantApp({ keys: { ...KEYS, ELEVENLABS_API_KEY: 'el-test-0123456789' } });
    const make = async (formats: string[]) => {
      const slug = ((await v.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: formats[0], brief: { ...OLD_BRIEF, formats }, generate: false } })).json() as { slug: string }).slug;
      expect((await v.app.inject({ method: 'POST', url: `${v.url(slug)}/variants`, payload: { count: 2, directions: ['x', 'y'] } })).statusCode).toBe(201);
      return slug;
    };
    const identity = await make(['identity-logo', 'identity-favicon', 'identity-app-icon']);
    const res = await run(identity, { targets: 'all-active', request: null });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().batchId).toBeUndefined();
    expect(await v.pending()).toEqual([]);
    await vi.waitFor(() => expect(v.runner.runs).toHaveLength(2));
    for (const r of v.runner.runs) { expect(r.req.prompt).not.toMatch(/- tts: .*\(ready\)/); expect(r.req.prompt).not.toMatch(/- generate_image: .*\(ready\)/); }
    // A still image: only images.
    const still = await make(['instagram-image-1x1']);
    await run(still, { targets: 'all-active', request: null });
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    const items = (await v.pending())[0]!.paidBatch!.items!;
    expect([...new Set(items.map((i) => i.capability))]).toEqual(['images']);
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
    const [rb0, rc0] = [await runOf(`${slug}~b`), await runOf(`${slug}~c`)];
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

  it('all working: one card; a dismissed card takes the requests out of their queues (and cancels one that already became a held turn)', async () => {
    v = await variantApp({ keys: KEYS });
    const slug = await v.group(['Audace', 'Calma']);
    await turn(slug, 'Prima A');
    await turn(`${slug}~b`, 'Prima B');
    const [ra0, rb0] = [await runOf(slug), await runOf(`${slug}~b`)];
    const res = await run(slug, { targets: 'all-active', request: { text: 'Più luce' } });
    const body = res.json() as { jobs: Record<string, string>; queued: string[] };
    expect(body.jobs).toEqual({});
    expect(body.queued).toEqual(['a', 'b']);
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    expect((await v.detail(slug)).creative.queued).toHaveLength(1);
    rb0.finish();
    await vi.waitFor(async () => expect(await v.jobOf(`${slug}~b`)).toMatchObject({ state: 'queued', waitReason: 'variant-confirm' }), { timeout: 10_000 });
    const held = (await v.jobOf(`${slug}~b`))!.id;
    dismiss((await v.pending())[0]!);
    await vi.waitFor(async () => expect((await stateOf(held)).state).toBe('cancelled'));
    await vi.waitFor(async () => expect((await v.detail(slug)).creative.queued ?? []).toEqual([]));
    ra0.finish();
    await v.waitIdle();
    expect(v.runner.runs).toHaveLength(2);
    expect(v.fetches).toEqual([]);
  });

  it('decision 1126: declining with a working variant: its request stays queued and, when it starts, has paid services off', async () => {
    v = await variantApp({ keys: KEYS });
    const slug = await v.group(['Audace', 'Calma']);
    await turn(`${slug}~b`, 'Prima B');
    const rb0 = await runOf(`${slug}~b`);
    const res = await run(slug, { targets: 'all-active', request: { text: 'Più luce' } });
    expect(res.json().queued).toEqual(['b']);
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    await decide((await v.pending())[0]!, 'deny');
    const ra = await runOf(slug);
    expect(ra.req.prompt).toMatch(/off for this run/);
    rb0.finish();
    const rb = await runOf(`${slug}~b`, 1);
    expect(rb.req.prompt).toMatch(/off for this run/);
    expect((await v.bridge(rb, 'tts', { text: 'Ciao', provider: 'openai' })).statusCode).toBeGreaterThanOrEqual(400);
    expect(await v.pending()).toEqual([]);
    expect(v.fetches).toEqual([]);
    ra.finish(); rb.finish();
    await v.waitIdle();
  });

  it('race (a): the card is approved while a working variant\'s queued request is being started: its turn is not left held', async () => {
    v = await variantApp({ keys: KEYS });
    const slug = await v.group(['Audace', 'Calma']);
    await turn(`${slug}~b`, 'Prima B');
    const rb0 = await v.runner.next(0);
    const res = await run(slug, { targets: 'all-active', request: { text: 'Più luce' } });
    expect(res.json().queued).toEqual(['b']);
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    // Stop B's queued request in the middle of its start (after it is taken off the queue, before it is enqueued as a job).
    const g = gate();
    const update = CreativeStore.prototype.update;
    vi.spyOn(CreativeStore.prototype, 'update').mockImplementation(async function (this: CreativeStore, slugArg, patch) {
      if (slugArg === `${slug}~b` && (patch as { status?: string }).status === 'working') await g.wait();
      return update.call(this, slugArg, patch);
    });
    rb0.finish();
    await g.reached;
    await decide((await v.pending())[0]!, 'once');
    await vi.waitFor(async () => expect((await stateOf(res.json().jobs.a)).state).toBe('running'), { timeout: 10_000 });
    g.open();
    // B's turn must start (it was approved), not stay held with nobody left to release it.
    await vi.waitFor(async () => expect((await v.jobOf(`${slug}~b`))!.state).toBe('running'), { timeout: 10_000 });
    (await runOf(`${slug}~b`, 1)).finish();
    (await runOf(slug)).finish();
    await v.waitIdle();
  });

  it('race (b): the card is dismissed while a working variant\'s queued request is being started: that turn never runs', async () => {
    v = await variantApp({ keys: KEYS });
    const slug = await v.group(['Audace', 'Calma']);
    await turn(`${slug}~b`, 'Prima B');
    const rb0 = await v.runner.next(0);
    const res = await run(slug, { targets: 'all-active', request: { text: 'Più luce' } });
    expect(res.json().queued).toEqual(['b']);
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    // Stop B's queued request right after it is taken off the queue, before its start reads the run's hook.
    const g = gate();
    const memberOf = CreativeTurnService.prototype.memberOf;
    vi.spyOn(CreativeTurnService.prototype, 'memberOf').mockImplementation(async function (this: CreativeTurnService, ref) {
      if (ref.creativeSlug === `${slug}~b`) await g.wait();
      return memberOf.call(this, ref);
    });
    rb0.finish();
    await g.reached;
    dismiss((await v.pending())[0]!);
    // The run's cancel has reached A (its turn is cancelled) and now waits for B's start in flight.
    await vi.waitFor(async () => expect((await stateOf(res.json().jobs.a)).state).toBe('cancelled'));
    g.open();
    const bJobs = async () => (await v.jobs()).filter((j) => j.kind === 'creative' && j.key.endsWith(`:${slug}~b`));
    // The start in flight finishes (B's second turn exists), then the run's cancel catches it.
    await vi.waitFor(async () => expect(await bJobs()).toHaveLength(2), { timeout: 10_000 });
    await vi.waitFor(async () => expect((await bJobs()).map((j) => j.state)).toContain('cancelled'), { timeout: 10_000 });
    for (const r of v.runner.runs.slice(1)) r.finish();
    await v.waitIdle();
    // Nothing of the declined run ran: A's turn and B's request's turn are cancelled, no new agent run started.
    expect((await stateOf(res.json().jobs.a)).state).toBe('cancelled');
    expect((await bJobs()).map((j) => j.state).sort()).toEqual(['cancelled', 'succeeded']);
    expect(v.runner.runs).toHaveLength(1);
    expect((await v.detail(`${slug}~b`)).creative.queued ?? []).toEqual([]);
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

  it('minor (Task 3): stopping the held turn and removing the queued requests by hand takes the card away at once (no 600 s wait)', async () => {
    v = await variantApp({ keys: KEYS });
    const slug = await v.group(['Audace', 'Calma']);
    await turn(`${slug}~b`, 'Prima B');
    const rb0 = await runOf(`${slug}~b`);
    const res = await run(slug, { targets: 'all-active', request: { text: 'Più luce' } });
    const body = res.json() as { jobs: Record<string, string>; queued: string[] };
    expect(body.queued).toEqual(['b']);
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    // By hand: A's held turn is cancelled, B's request is taken out of its queue. Nothing is left for the card to confirm.
    expect((await v.app.inject({ method: 'POST', url: `/api/jobs/${body.jobs.a}/cancel` })).statusCode).toBe(200);
    expect(await v.pending()).toHaveLength(1);
    const clientId = (await v.detail(`${slug}~b`)).creative.queued![0]!.clientId;
    expect((await v.app.inject({ method: 'DELETE', url: `${v.url(`${slug}~b`)}/queue/${clientId}` })).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await v.pending()).toEqual([]), { timeout: 5000 });
    rb0.finish();
    await v.waitIdle();
    expect(v.runner.runs).toHaveLength(1);
  });

  it('minor (Task 3): a dismissed request that could not be taken out of the queue never runs (its turn is stopped as it starts)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    v = await variantApp({ keys: KEYS });
    const slug = await v.group(['Audace', 'Calma']);
    await turn(`${slug}~b`, 'Prima B');
    const rb0 = await v.runner.next(0);
    const res = await run(slug, { targets: 'all-active', request: { text: 'Più luce' } });
    expect(res.json().queued).toEqual(['b']);
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    vi.spyOn(CreativeTurnService.prototype, 'removeQueued').mockRejectedValueOnce(new Error('disk full'));
    dismiss((await v.pending())[0]!);
    await vi.waitFor(async () => expect((await stateOf(res.json().jobs.a)).state).toBe('cancelled'));
    await vi.waitFor(async () => expect((await v.detail(`${slug}~b`)).creative.queued).toHaveLength(1));
    // The chat of B says what will happen to the request.
    const conv = (await v.app.inject(`${v.url(`${slug}~b`)}/conversation`)).json() as Array<{ type: string; text?: string }>;
    expect(conv.filter((e) => e.type === 'system').map((e) => e.text)).toContainEqual(expect.stringMatching(/fermata appena parte|stopped as soon as it starts/));
    // B's turn ends: the request is still in its queue, so it starts by itself; its turn is stopped before it can run.
    rb0.finish();
    const bJobs = async () => (await v.jobs()).filter((j) => j.kind === 'creative' && j.key.endsWith(`:${slug}~b`));
    await vi.waitFor(async () => expect((await bJobs()).map((j) => j.state).sort()).toEqual(['cancelled', 'succeeded']), { timeout: 10_000 });
    await v.waitIdle();
    expect(v.runner.runs).toHaveLength(1);
  });

  it('minor (Task 3): the card lists only the variants whose start worked', async () => {
    v = await variantApp({ keys: KEYS });
    const slug = await v.group(['Audace', 'Calma', 'Retro']);
    const start = CreativeTurnService.prototype.start;
    vi.spyOn(CreativeTurnService.prototype, 'start').mockImplementation(async function (this: CreativeTurnService, ref, ...rest) {
      if (ref.creativeSlug === `${slug}~b`) throw new Error('boom');
      return start.call(this, ref, ...rest);
    });
    const res = await run(slug, { targets: 'all-active', request: { text: 'Più luce' } });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().failed).toEqual({ b: 'boom' });
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    const card = (await v.pending())[0]!;
    expect([...new Set(card.paidBatch!.items!.map((i) => i.variant))].sort()).toEqual(['a', 'c']);
    expect(card.paidBatch!.total?.variants).toBe(2);
    dismiss(card);
    await v.waitIdle();
  });

  it('fix wave: the queue write is through, so the card goes even when the answer\'s read fails', async () => {
    v = await variantApp({ keys: KEYS });
    const slug = await v.group(['Audace', 'Calma']);
    await turn(`${slug}~b`, 'Prima B');
    const rb0 = await runOf(`${slug}~b`);
    const res = await run(slug, { targets: 'all-active', request: { text: 'Più luce' } });
    const body = res.json() as { jobs: Record<string, string> };
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    await v.app.inject({ method: 'POST', url: `/api/jobs/${body.jobs.a}/cancel` });
    const clientId = (await v.detail(`${slug}~b`)).creative.queued![0]!.clientId;
    vi.spyOn(CreativeSideStateStore.prototype, 'merged').mockRejectedValueOnce(new Error('read failed'));
    expect((await v.app.inject({ method: 'DELETE', url: `${v.url(`${slug}~b`)}/queue/${clientId}` })).statusCode).toBe(500);
    await vi.waitFor(async () => expect(await v.pending()).toEqual([]), { timeout: 5000 });
    rb0.finish();
    await v.waitIdle();
  });

  it('fix wave: the cover\'s rules are those of the variants that started (a failed variant\'s rule is not covered)', async () => {
    v = await variantApp({ keys: KEYS });
    const slug = await v.group(['Audace', 'Calma', 'Retro']);
    // A and C need only images; B (which will fail to start) also needs the voice.
    const store = new CreativeStore(v.projectDir);
    for (const s of [slug, `${slug}~c`]) {
      const c = await store.get(s);
      await store.update(s, { brief: { ...c.brief, services: { ...c.brief.services, voice: 'none' } } });
    }
    const start = CreativeTurnService.prototype.start;
    vi.spyOn(CreativeTurnService.prototype, 'start').mockImplementation(async function (this: CreativeTurnService, ref, ...rest) {
      if (ref.creativeSlug === `${slug}~b`) throw new Error('boom');
      return start.call(this, ref, ...rest);
    });
    const cover = vi.spyOn(v.approvals, 'cover');
    await run(slug, { targets: 'all-active', request: { text: 'Più luce' } });
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    const card = (await v.pending())[0]!;
    expect(card.paidBatch!.items!.map((i) => i.capability)).not.toContain('voice');
    await decide(card, 'once');
    await vi.waitFor(() => expect(cover).toHaveBeenCalled());
    const rules = cover.mock.calls[0]![1] as string[];
    expect([...rules].length).toBeGreaterThan(0);
    expect([...rules]).not.toContain('provider:tts-openai');
    (await runOf(slug)).finish();
    (await runOf(`${slug}~c`)).finish();
    await v.waitIdle();
  });

  it('fix wave: a request gone by hand gets no hook back when the card is approved', async () => {
    v = await variantApp({ keys: KEYS });
    const slug = await v.group(['Audace', 'Calma', 'Retro']);
    await turn(`${slug}~b`, 'Prima B');
    const rb0 = await runOf(`${slug}~b`);
    const res = await run(slug, { targets: 'all-active', request: { text: 'Più luce' } });
    const body = res.json() as { jobs: Record<string, string>; queued: string[] };
    expect(body.queued).toEqual(['b']);
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    const clientId = (await v.detail(`${slug}~b`)).creative.queued![0]!.clientId;
    expect((await v.app.inject({ method: 'DELETE', url: `${v.url(`${slug}~b`)}/queue/${clientId}` })).statusCode).toBe(200);
    const hooks = vi.spyOn(CreativeTurnService.prototype, 'setQueuedHook');
    await decide((await v.pending())[0]!, 'once');
    const ra = await runOf(slug);
    // Approved: the run released its held turns and covered them, but set nothing for the request that is gone.
    expect(hooks.mock.calls.filter((c) => c[1] === clientId && c[2] !== null)).toEqual([]);
    rb0.finish();
    ra.finish();
    (await runOf(`${slug}~c`)).finish();
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

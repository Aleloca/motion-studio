// @vitest-environment node
/**
 * Phase 15, Task 3 (spec §3 "Turni delle varianti", §4 "Tutte"): the fan-out. A request (or the first generation) starts in
 * each target variant as a normal creative turn of that member; at most two variant turns of a group run at once, the others
 * wait queued with the reason `variant-slot`, and the next one starts when one finishes, fails or is stopped. Stopping one
 * variant leaves the others running. A discarded variant stays inert until it is restored: the fan-out skips it and any
 * direct start or queue entry on it is refused (409 `variant-discarded`). Controlled runner only (no `claude`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { creativeJobKey, messages } from '@motion-studio/shared';
import { variantApp, type VariantApp } from './helpers/variant-app.ts';
import { cid } from './helpers/live-app.ts';

vi.setConfig({ testTimeout: 60_000 });

let v: VariantApp;
afterEach(async () => { await v?.close(); });

const run = (slug: string, body: unknown) => v.app.inject({ method: 'POST', url: `${v.url(slug)}/variants/run`, payload: body as object });
const byMember = async (slug: string) => {
  const jobs = await v.jobs();
  const key = (s: string) => creativeJobKey(v.base + '/ws', 'acme', s);
  return (letter: string) => jobs.find((j) => j.key === key(letter === 'a' ? slug : `${slug}~${letter}`) && j.kind === 'creative');
};

describe('variant fan-out', () => {
  it('"Tutte" with 4 active variants: each is a normal creative turn of its member; two run, two wait with the reason', async () => {
    v = await variantApp();
    const slug = await v.group(['Audace', 'Calma', 'Retro', 'Pop']);
    const res = await run(slug, { targets: 'all-active', request: { text: 'Più contrasto' } });
    expect(res.statusCode, res.body).toBe(202);
    const ids = res.json().jobs as Record<string, string>;
    expect(Object.keys(ids).sort()).toEqual(['a', 'b', 'c', 'd']);
    const job = await byMember(slug);
    for (const l of ['a', 'b', 'c', 'd']) expect(job(l)?.id, l).toBe(ids[l]);
    expect(['a', 'b'].map((l) => job(l)!.state)).toEqual(['running', 'running']);
    expect(['c', 'd'].map((l) => [job(l)!.state, job(l)!.waitReason])).toEqual([['queued', 'variant-slot'], ['queued', 'variant-slot']]);
    // Each turn is in its own conversation, with the same request.
    for (const s of [slug, `${slug}~b`, `${slug}~c`, `${slug}~d`]) {
      const conv = (await v.app.inject(`${v.url(s)}/conversation`)).json() as Array<{ type: string; text?: string }>;
      expect(conv.filter((e) => e.type === 'user').map((e) => e.text), s).toEqual(['Più contrasto']);
    }
    await vi.waitFor(() => expect(v.runner.runs).toHaveLength(2));
    // A finishes: C starts. B fails: D starts. The slot is released in every case.
    // A and B start together, in any order: each run is picked by member.
    const [ra, rb] = [await v.runOf(slug), await v.runOf(`${slug}~b`)];
    expect(ra.req.cwd).toBe(v.projectDir);
    ra.finish();
    const rc = await v.runOf(`${slug}~c`);
    await vi.waitFor(async () => expect((await byMember(slug))('c')!.state).toBe('running'), { timeout: 10_000 });
    expect((await byMember(slug))('c')!.waitReason).toBeUndefined();
    expect((await byMember(slug))('d')!.state).toBe('queued');
    rb.finish({ ok: false, error: 'boom' });
    const rd = await v.runOf(`${slug}~d`);
    await vi.waitFor(async () => expect((await byMember(slug))('d')!.state).toBe('running'), { timeout: 10_000 });
    // Stopping one leaves the other running.
    const stop = await v.app.inject({ method: 'POST', url: `/api/jobs/${ids.c}/stop` });
    expect(stop.json()).toMatchObject({ status: 'stopping' });
    await vi.waitFor(async () => expect((await byMember(slug))('c')!.state).toBe('cancelled'), { timeout: 10_000 });
    expect(rc.cancelled).toBe(true);
    expect(rd.cancelled).toBe(false);
    expect((await byMember(slug))('d')!.state).toBe('running');
    rd.finish();
    await v.waitIdle();
    expect((await byMember(slug))('a')!.state, (await byMember(slug))('a')!.error).toBe('succeeded');
  });

  it('the queue releases the next variant when a running one is stopped', async () => {
    v = await variantApp();
    const slug = await v.group(['Audace', 'Calma', 'Retro']);
    const ids = (await run(slug, { targets: 'all-active', request: null })).json().jobs as Record<string, string>;
    await vi.waitFor(() => expect(v.runner.runs).toHaveLength(2));
    expect((await byMember(slug))('c')).toMatchObject({ state: 'queued', waitReason: 'variant-slot' });
    await v.app.inject({ method: 'POST', url: `/api/jobs/${ids.a}/stop` });
    await v.runOf(`${slug}~c`);
    await vi.waitFor(async () => expect((await byMember(slug))('c')!.state).toBe('running'), { timeout: 10_000 });
    expect((await byMember(slug))('b')!.state).toBe('running');
    // A stopped queued variant never runs and frees nothing it did not hold.
    (await v.runOf(`${slug}~b`)).finish();
    (await v.runOf(`${slug}~c`)).finish();
    await v.waitIdle();
  });

  it('any turn of a grouped member counts towards the two slots (a direct POST …/turns waits too); an old creative never waits', async () => {
    v = await variantApp();
    const slug = await v.group(['Audace', 'Calma', 'Retro']);
    await run(slug, { targets: ['a', 'b'], request: null });
    await vi.waitFor(() => expect(v.runner.runs).toHaveLength(2));
    const direct = await v.app.inject({ method: 'POST', url: `${v.url(`${slug}~c`)}/turns`, payload: { text: 'Prova' } });
    expect(direct.statusCode).toBe(202);
    expect(direct.json()).toMatchObject({ kind: 'creative', state: 'queued', waitReason: 'variant-slot' });
    // An old creative (no group) is not gated by the group (the queue's global limit aside).
    (await v.runOf(slug)).finish();
    await v.runOf(`${slug}~c`);
    const old = ((await v.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Vecchia', brief: { goal: 'x', message: '', formats: ['instagram-post-1x1'], durationSec: 10, assets: [], notes: '' }, generate: false } })).json() as { slug: string }).slug;
    const res = await v.app.inject({ method: 'POST', url: `${v.url(old)}/turns`, payload: {} });
    expect(res.json().waitReason).toBeUndefined();
    (await v.runOf(`${slug}~b`)).finish();
    (await v.runOf(`${slug}~c`)).finish();
    (await v.runOf(old)).finish();
    await v.waitIdle();
  });

  it('a discarded variant is inert: the fan-out skips it; a direct turn or a queue entry on it is refused until it is restored', async () => {
    v = await variantApp();
    const slug = await v.group(['Audace', 'Calma', 'Retro']);
    expect((await v.app.inject({ method: 'POST', url: `${v.url(slug)}/variants/b/discard` })).statusCode).toBe(200);
    const res = await run(slug, { targets: 'all-active', request: { text: 'Più luce' } });
    expect(res.statusCode, res.body).toBe(202);
    expect(Object.keys(res.json().jobs).sort()).toEqual(['a', 'c']);
    // Named explicitly, it is skipped too; with nothing left to start the answer is the 409.
    const only = await run(slug, { targets: ['b'], request: { text: 'Più luce' } });
    expect(only.statusCode).toBe(409);
    expect(only.json().code).toBe('variant-discarded');
    const reason = { it: 'Ripristina la variante per lavorarci', en: 'Restore the variant to work on it' };
    // The stable wait-reason codes and their strings (Task 5 shows them).
    expect(messages('it').web.variantGroup.waitReasons).toEqual({ 'variant-directions': 'in attesa delle direzioni', 'variant-confirm': 'in attesa della conferma', 'variant-slot': 'in coda: due varianti già al lavoro' });
    expect(messages('en').web.variantGroup.waitReasons).toEqual({ 'variant-directions': 'waiting for directions', 'variant-confirm': 'waiting for confirmation', 'variant-slot': 'queued: two variants already working' });
    expect(messages('it').errors.variantDiscardedTurn).toBe(reason.it);
    expect(messages('en').errors.variantDiscardedTurn).toBe(reason.en);
    const turn = await v.app.inject({ method: 'POST', url: `${v.url(`${slug}~b`)}/turns`, payload: { text: 'Prova' } });
    expect(turn.statusCode).toBe(409);
    expect(turn.json()).toMatchObject({ code: 'variant-discarded' });
    expect(Object.values(reason)).toContain(turn.json().error);
    const queued = await v.app.inject({ method: 'POST', url: `${v.url(`${slug}~b`)}/messages`, payload: { clientId: cid(), text: 'Dopo', mode: 'queued' } });
    expect(queued.statusCode).toBe(409);
    expect(queued.json()).toMatchObject({ code: 'variant-discarded' });
    expect((await v.detail(`${slug}~b`)).creative.queued ?? []).toEqual([]);
    expect((await byMember(slug))('b')).toBeUndefined();
    // Restored, it works again.
    expect((await v.app.inject({ method: 'POST', url: `${v.url(slug)}/variants/b/restore` })).statusCode).toBe(200);
    v.runner.runs.forEach((r) => r.finish());
    await vi.waitFor(() => expect(v.runner.runs.length).toBeGreaterThanOrEqual(2));
    await v.waitIdle();
    const again = await v.app.inject({ method: 'POST', url: `${v.url(`${slug}~b`)}/turns`, payload: { text: 'Prova' } });
    expect(again.statusCode, again.body).toBe(202);
    (await v.runOf(`${slug}~b`)).finish();
    await v.waitIdle();
  });

  it('bad bodies, unknown letters, an old creative and an orphan', async () => {
    v = await variantApp();
    const slug = await v.group(['Audace', 'Calma']);
    for (const body of [{}, { targets: [], request: null }, { targets: 'all', request: null }, { targets: ['a'], request: { text: 1 } }, { targets: ['a'] }]) {
      expect((await run(slug, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await run(slug, { targets: ['e'], request: null })).json()).toMatchObject({ code: 'variant-unknown' });
    const old = ((await v.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Vecchia', brief: { goal: 'x', message: '', formats: ['instagram-post-1x1'], durationSec: 10, assets: [], notes: '' }, generate: false } })).json() as { slug: string }).slug;
    const res = await run(old, { targets: 'all-active', request: null });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('variant-no-group');
    expect(await v.jobs()).toEqual([]);
  });
});

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { creativeFileSchema, messages } from '@motion-studio/shared';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { cid, liveApp, type LiveApp } from './helpers/live-app.ts';

// Phase 13 Task 2: the request queue (spec §2, "Queue for after"; Rulings S and T; Review Focus 4).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let s: LiveApp;
afterEach(async () => { await s?.app.close(); });

const it_ = messages('it').live;
const queue = (clientId: string, text: string) => s.app.inject({ method: 'POST', url: `${s.url}/messages`, payload: { clientId, text, mode: 'queued' } });
const queuedTexts = async () => ((await s.creative()).queued ?? []).map((q) => q.text);

describe('queue', () => {
  it('queues for after, edits, removes and reorders only while queued (Ruling S), then runs in order', async () => {
    s = await liveApp();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    const run = await s.runner.next(0);
    const [a, b, c] = [cid(), cid(), cid()];
    for (const [id, text] of [[a, 'A'], [b, 'B'], [c, 'C']] as const) expect((await queue(id, text)).json().outcome).toBe('queued');
    expect(await queuedTexts()).toEqual(['A', 'B', 'C']);
    // Edit (text and pins), remove.
    let res = await s.app.inject({ method: 'PUT', url: `${s.url}/queue/${b}`, payload: { text: 'B2', pins: [] } });
    expect(res.statusCode).toBe(200);
    expect((await s.app.inject({ method: 'PUT', url: `${s.url}/queue/${b}`, payload: { text: 'x'.repeat(4001), pins: [] } })).statusCode).toBe(409);
    res = await s.app.inject({ method: 'DELETE', url: `${s.url}/queue/${a}` });
    expect(res.statusCode).toBe(200);
    expect(await queuedTexts()).toEqual(['B2', 'C']);
    const gone = await s.app.inject({ method: 'DELETE', url: `${s.url}/queue/${a}` });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toEqual({ code: 'not-queued', error: it_.notQueued });
    // Reorder: a permutation of the current queue only.
    expect((await s.app.inject({ method: 'PUT', url: `${s.url}/queue`, payload: { order: [c, b] } })).statusCode).toBe(200);
    expect(await queuedTexts()).toEqual(['C', 'B2']);
    for (const order of [[c], [c, b, a], [c, c], [b, 'nope']]) {
      const bad = await s.app.inject({ method: 'PUT', url: `${s.url}/queue`, payload: { order } });
      expect(bad.statusCode).toBe(409);
      expect(bad.json()).toEqual({ code: 'queue-changed', error: it_.queueChanged });
    }
    // The turn ends: C starts by itself, then B2.
    run.finish();
    const second = await s.runner.next(1);
    expect(second.req.prompt).toContain('C');
    expect(await queuedTexts()).toEqual(['B2']);
    // Started: no longer editable.
    expect((await s.app.inject({ method: 'PUT', url: `${s.url}/queue/${c}`, payload: { text: 'tardi', pins: [] } })).statusCode).toBe(404);
    second.finish();
    const third = await s.runner.next(2);
    expect(third.req.prompt).toContain('B2');
    third.finish();
    await s.waitIdle();
    const users = (await s.conversation()).filter((e) => e.type === 'user').map((e) => [e.text, e.mode ?? null]);
    expect(users).toEqual([['Primo', null], ['C', 'queued'], ['B2', 'queued']]);
    expect(await s.versions()).toHaveLength(3);
  });

  it('after a Stop the queue waits for Run next', async () => {
    s = await liveApp();
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } })).json();
    await s.runner.next(0);
    await queue(cid(), 'Dopo lo stop');
    const stop = await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/stop` });
    expect(stop.json()).toEqual({ status: 'stopping' });
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('cancelled');
    expect(s.runner.runs).toHaveLength(1);
    expect(await queuedTexts()).toEqual(['Dopo lo stop']);
    const next = await s.app.inject({ method: 'POST', url: `${s.url}/queue/run-next` });
    expect(next.statusCode).toBe(202);
    const run = await s.runner.next(1);
    expect(run.req.prompt).toContain('Dopo lo stop');
    expect((await s.app.inject({ method: 'POST', url: `${s.url}/queue/run-next` })).statusCode).toBe(409);
    run.finish();
    await s.waitIdle();
    const empty = await s.app.inject({ method: 'POST', url: `${s.url}/queue/run-next` });
    expect(empty.json()).toEqual({ code: 'queue-empty', error: it_.queueEmpty });
  });
});

describe('restart (Ruling T, Review Focus 4)', () => {
  it('requests queued before a restart are shown but run only on Run next', async () => {
    s = await liveApp();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    await s.runner.next(0);
    await queue(cid(), 'Prima del riavvio');
    // The app closes while the turn runs (the turn is cancelled, as today), then starts again on the same data.
    await s.app.close();
    const runner = s.runner;
    s = await liveApp({ base: s.base, runner, slug: s.slug });
    expect(await queuedTexts()).toEqual(['Prima del riavvio']);
    // A new turn ends on the new core: the old request still waits.
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Dopo il riavvio' } });
    (await runner.next(1)).finish();
    await s.waitIdle();
    expect(runner.runs).toHaveLength(2);
    expect(await queuedTexts()).toEqual(['Prima del riavvio']);
    // Run next starts it.
    expect((await s.app.inject({ method: 'POST', url: `${s.url}/queue/run-next` })).statusCode).toBe(202);
    const run = await runner.next(2);
    expect(run.req.prompt).toContain('Prima del riavvio');
    run.finish();
    await s.waitIdle();
    expect(await queuedTexts()).toEqual([]);
  });

  it('a turn cut by a restart is interrupted, with its session remembered for the next turn (spec §5)', async () => {
    s = await liveApp();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    (await s.runner.next(0)).finish();
    await s.waitIdle();
    // A turn whose agent reported a session, then the app dies without cancelling (the creative stays `working`).
    const store = new CreativeStore(join(s.base, 'ws', 'acme'));
    await store.update(s.slug, { status: 'working' });
    await store.appendConversation(s.slug, { type: 'agent', at: new Date().toISOString(), jobId: 'old-job', event: { kind: 'session', sessionId: 'cut-session' } });
    await s.app.close();
    const runner = s.runner;
    s = await liveApp({ base: s.base, runner, slug: s.slug });
    expect(await s.creative()).toMatchObject({ status: 'interrupted', stoppedSession: { sessionId: 'cut-session', jobId: 'old-job' } });
  });
});

describe('compatibility', () => {
  it('old creative.json and conversation.jsonl files load unchanged', async () => {
    s = await liveApp();
    const dir = join(s.base, 'ws', 'acme', 'creatives', s.slug);
    const raw = JSON.parse(await readFile(join(dir, 'creative.json'), 'utf8'));
    expect(raw.queued).toBeUndefined();
    expect(raw.stoppedSession).toBeUndefined();
    expect(creativeFileSchema.parse(raw)).toEqual(raw);
    const old = [
      { type: 'user', at: '2026-01-01T00:00:00.000Z', text: 'vecchio', pins: [], attachments: [] },
      { type: 'agent', at: '2026-01-01T00:00:01.000Z', jobId: 'j', event: { kind: 'text', text: 'ok' } },
      { type: 'version', at: '2026-01-01T00:00:02.000Z', n: 1, status: 'complete' },
    ];
    await writeFile(join(dir, 'conversation.jsonl'), old.map((e) => JSON.stringify(e)).join('\n') + '\n');
    expect(await s.conversation()).toEqual(old);
  });
});

describe('a Stop while the version is being saved', () => {
  it('the version is saved as before, and the queue still waits for Run next', async () => {
    s = await liveApp();
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } })).json();
    const run = await s.runner.next(0);
    await queue(cid(), 'Dopo');
    // The run's result comes and, in the same tick, the user stops: the core is already past the agent.
    run.finish();
    await vi.waitFor(async () => expect((await s.conversation()).some((e) => e.type === 'agent' && (e.event as { kind: string }).kind === 'result')).toBe(true));
    await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/stop` });
    await s.waitIdle();
    const state = (await s.jobs()).find((j) => j.id === job.id)?.state;
    // Either way (stopped before or after the save started) nothing starts by itself.
    expect(['succeeded', 'cancelled']).toContain(state);
    expect(s.runner.runs).toHaveLength(1);
    expect(await queuedTexts()).toEqual(['Dopo']);
  });
});

describe('Ruling U: the queue goes on by itself only after a saved version', () => {
  it('after a failed turn the queue waits for Run next', async () => {
    s = await liveApp();
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } })).json();
    const run = await s.runner.next(0);
    await queue(cid(), 'Dopo il fallimento');
    run.finish({ ok: false, write: false, error: 'boom' });
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('failed');
    await new Promise((r) => setTimeout(r, 200));
    expect(s.runner.runs).toHaveLength(1);
    expect(await queuedTexts()).toEqual(['Dopo il fallimento']);
    // A message to the idle creative does not start it either: Run next does.
    await queue(cid(), 'Ancora');
    await new Promise((r) => setTimeout(r, 200));
    expect(s.runner.runs).toHaveLength(1);
    expect((await s.app.inject({ method: 'POST', url: `${s.url}/queue/run-next` })).statusCode).toBe(202);
    const next = await s.runner.next(1);
    expect(next.req.prompt).toContain('Dopo il fallimento');
    next.finish();
    // That turn saved a version: the second request starts by itself.
    const third = await s.runner.next(2);
    expect(third.req.prompt).toContain('Ancora');
    third.finish();
    await s.waitIdle();
  });

  it('after a /cancel the queue waits too', async () => {
    s = await liveApp();
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } })).json();
    await s.runner.next(0);
    await queue(cid(), 'Dopo');
    await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    await s.waitIdle();
    await new Promise((r) => setTimeout(r, 200));
    expect(s.runner.runs).toHaveLength(1);
    expect(await queuedTexts()).toEqual(['Dopo']);
  });
});

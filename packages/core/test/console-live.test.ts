import { afterEach, describe, expect, it, vi } from 'vitest';
import { messages } from '@motion-studio/shared';
import { CONSOLE_REDIRECT_NOTE } from '../src/creatives/prompt.ts';
import { cid, liveApp, type LiveApp } from './helpers/live-app.ts';

// Phase 13 Task 2: the console takes live messages, Stop and redirect through the same job routes; it has no queue.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let s: LiveApp;
afterEach(async () => { await s?.app.close(); });

const it_ = messages('it').live;
const startConsole = async () => (await s.app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'Elenca i file' } })).json() as { id: string };
const say = (job: string, body: Record<string, unknown>) => s.app.inject({ method: 'POST', url: `/api/console/${job}/messages`, payload: body });

describe('console live messages', () => {
  it('writes a message into the running console turn (capability on), idempotent on clientId', async () => {
    s = await liveApp({ live: true });
    const job = await startConsole();
    const run = await s.runner.next(0);
    const clientId = cid();
    const res = await say(job.id, { clientId, text: 'Anche le cartelle nascoste' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'delivered-pending' });
    expect((await say(job.id, { clientId, text: 'Anche le cartelle nascoste' })).json()).toEqual({ outcome: 'delivered-pending' });
    expect(run.sent).toEqual([{ clientId, text: 'Anche le cartelle nascoste' }]);
    expect((await s.jobs()).find((j) => j.id === job.id)?.liveMessages).toBe(1);
    expect((await say(job.id, { clientId: cid(), text: 'x'.repeat(4001) })).statusCode).toBe(409);
    run.finish({ write: false });
    await s.waitIdle();
    const late = await say(job.id, { clientId: cid(), text: 'tardi' });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toEqual({ code: 'not-running', error: it_.consoleTurnOver });
  });

  it('with live input off (the default) a message is refused with a translated 409: the console has no queue', async () => {
    s = await liveApp();
    const job = await startConsole();
    const run = await s.runner.next(0);
    const res = await say(job.id, { clientId: cid(), text: 'ciao' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: 'live-off', error: it_.consoleLiveOff });
    expect(run.sent).toEqual([]);
    run.finish({ write: false });
    await s.waitIdle();
    expect((await say('nope', { clientId: cid(), text: 'x' })).statusCode).toBe(404);
  });

  it('redirect (fallback): the run stops and a new one in the same job resumes the live session with the message', async () => {
    s = await liveApp();
    const job = await startConsole();
    const run = await s.runner.next(0);
    await vi.waitFor(async () => expect((await s.jobs()).find((j) => j.id === job.id)?.sessionId).toBe(run.sessionId));
    const res = await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text: 'Solo i file .ts' } });
    expect(res.json()).toEqual({ outcome: 'restarted' });
    expect(run.cancelled).toBe(true);
    const next = await s.runner.next(1);
    expect(next.req.resumeSessionId).toBe(run.sessionId);
    expect(next.req.forkSession).toBeFalsy();
    expect(next.req.prompt).toContain('Solo i file .ts');
    expect(next.req.prompt).toContain(CONSOLE_REDIRECT_NOTE);
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('running');
    next.finish({ write: false });
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('succeeded');
  });

  it('redirect (interrupt on) writes into the same run; Stop ends the turn', async () => {
    s = await liveApp({ live: true });
    const job = await startConsole();
    const run = await s.runner.next(0);
    const res = await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text: 'Fermati e dimmi' } });
    expect(res.json()).toEqual({ outcome: 'interrupted' });
    expect(run.interrupts).toBe(1);
    expect(run.sent.map((m) => m.text)).toEqual(['Fermati e dimmi']);
    expect((await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/stop` })).json()).toEqual({ status: 'stopping' });
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('cancelled');
    expect(s.runner.runs).toHaveLength(1);
  });
});

describe('console redirect at the edge of the run (fix round 1, I1)', () => {
  it('right after the run ended: a run takes the words, or the answer is a 409 (never a lost restarted)', async () => {
    s = await liveApp();
    const job = await startConsole();
    const run = await s.runner.next(0);
    await vi.waitFor(async () => expect((await s.jobs()).find((j) => j.id === job.id)?.sessionId).toBe(run.sessionId));
    run.finish({ write: false });
    const res = await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text: 'Solo .ts' } });
    if (res.statusCode === 200) {
      expect(res.json()).toEqual({ outcome: 'restarted' });
      const next = await s.runner.next(1);
      expect(next.req.prompt).toContain('Solo .ts');
      next.finish({ write: false });
    } else {
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('not-running');
    }
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('succeeded');
  });

  it('after the turn settled: a translated 409, nothing started', async () => {
    s = await liveApp();
    const job = await startConsole();
    (await s.runner.next(0)).finish({ write: false });
    await s.waitIdle();
    const res = await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text: 'tardi' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: 'not-running', error: it_.notRunning });
    expect(s.runner.runs).toHaveLength(1);
  });
});

describe('console redirect before the first run (final review I2)', () => {
  it('while the job waits for a slot: answered pending-start, nothing spawned to be killed, one run with the request and the redirect', async () => {
    s = await liveApp();
    await s.app.inject({ method: 'PUT', url: '/api/settings', payload: { maxConcurrentJobs: 1 } });
    // A creative turn holds the only slot: the console job waits.
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    const busy = await s.runner.next(0);
    const job = await startConsole();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('queued');
    const res = await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text: 'Solo i file .ts' } });
    expect(res.json()).toEqual({ outcome: 'pending-start' });
    expect(s.runner.runs).toHaveLength(1);
    busy.finish();
    const run = await s.runner.next(1);
    // The user's original request and the redirect, in that order, in the one prompt (the words are the user's).
    expect(run.req.prompt).toContain('Elenca i file');
    expect(run.req.prompt).toContain('Solo i file .ts');
    expect(run.req.prompt.indexOf('Elenca i file')).toBeLessThan(run.req.prompt.indexOf('Solo i file .ts'));
    expect(run.req.prompt).not.toContain(CONSOLE_REDIRECT_NOTE);
    expect(run.cancelled).toBe(false);
    run.finish({ write: false });
    await s.waitIdle();
    expect(s.runner.runs).toHaveLength(2);
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('succeeded');
  });

  it('two fast redirects: both reach the agent, and each answer is what happened', async () => {
    s = await liveApp();
    const job = await startConsole();
    const run = await s.runner.next(0);
    await vi.waitFor(async () => expect((await s.jobs()).find((j) => j.id === job.id)?.sessionId).toBe(run.sessionId));
    const redirect = (text: string) => s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text } });
    const [a, b] = await Promise.all([redirect('PRIMA-DIREZIONE'), redirect('SECONDA-DIREZIONE')]);
    expect(a.json()).toEqual({ outcome: 'restarted' });
    expect(b.json()).toEqual({ outcome: 'restarted' });
    await vi.waitFor(() => expect(s.runner.runs.at(-1)!.cancelled).toBe(false));
    const last = s.runner.runs.at(-1)!;
    // The run that goes on carries both, in order (a run cut before it wrote anything never counts as having read them).
    expect(last.req.prompt).toContain('PRIMA-DIREZIONE');
    expect(last.req.prompt).toContain('SECONDA-DIREZIONE');
    expect(last.req.prompt.indexOf('PRIMA-DIREZIONE')).toBeLessThan(last.req.prompt.indexOf('SECONDA-DIREZIONE'));
    expect(last.req.resumeSessionId).toBe(run.sessionId);
    last.finish({ write: false });
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('succeeded');
  });
});

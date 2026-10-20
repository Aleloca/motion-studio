// @vitest-environment node
/**
 * Decisions 1421–1422: the brief session. A server on a temp workspace with the controlled runner (no `claude`) and the
 * `studio` bridge active; the test calls the bridge routes with the run's token, as the MCP server would.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { briefJobKey, EMPTY_BRIEF_FORM } from '@motion-studio/shared';
import { setLocale } from '../src/i18n.ts';
import { briefApp, briefHelpers, S, type BriefApp } from './helpers/brief-app.ts';

let t: BriefApp;
afterEach(async () => {
  if (!t) return;
  for (const r of t.runner.runs) r.end();
  await t.app.close();
  await rm(t.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const h = () => briefHelpers(t);
const jobs = () => h().jobs();
const waitIdle = () => h().waitIdle();
const view = () => h().view();
const open = (form = EMPTY_BRIEF_FORM) => h().open(form);
const conversation = (id: string) => h().conversation(id);
const send: ReturnType<typeof briefHelpers>['send'] = (...a) => h().send(...a);
const tool: ReturnType<typeof briefHelpers>['tool'] = (...a) => h().tool(...a);
const briefMessages = () => h().briefMessages();

describe('the brief session (decisions 1421–1422)', () => {
  it('one session per project', async () => {
    t = await briefApp();
    expect(await view()).toBeNull();
    const a = await open({ ...EMPTY_BRIEF_FORM, goal: 'Lancio' });
    const b = await open();
    expect(b.id).toBe(a.id);
    expect(await view()).toMatchObject({ id: a.id, form: { goal: 'Lancio' }, jobId: null });
    expect((await t.app.inject('/api/projects/nope/brief-session')).statusCode).toBe(404);
  });

  it('a message starts a read-only brief job', async () => {
    t = await briefApp();
    const s = await open();
    const res = await send(s.id, 'Un video di lancio della app', { codebases: [{ path: t.code, note: 'App' }] });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ outcome: 'started', job: { kind: 'brief' } });
    const run = await t.runner.next(0);
    const job = (await jobs())[0]!;
    expect(job).toMatchObject({ kind: 'brief', key: briefJobKey(join(t.base, 'ws'), 'acme') });
    expect(run.req.addDirs).toEqual([t.code]);
    expect(run.req.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Grep', 'Edit', `Read(/${join(t.code, '.env')})`]));
    expect(run.req.prompt).toContain('Un video di lancio della app');
    expect(run.req.prompt).toContain("## The user's form now");
    expect((await view())?.jobId).toBe(job.id);
    const [user] = await conversation(s.id);
    expect(user).toMatchObject({ type: 'user', text: 'Un video di lancio della app', jobId: job.id, context: { codebases: [t.code], assets: [] } });
    run.finish({ write: false });
    await waitIdle();
    expect((await view())?.jobId).toBeNull();
  });

  it('fill_brief fills the form, writes a line and tells the clients', async () => {
    t = await briefApp();
    setLocale('en');
    const s = await open();
    await send(s.id, 'Lancio', { assets: ['assets/hero.png'] });
    const run = await t.runner.next(0);
    const formats = await tool(run, 'list_formats', {});
    expect(formats.json().formats.some((f: { id: string }) => f.id === 'instagram-post-1x1')).toBe(true);
    const res = await tool(run, 'fill_brief', { goal: 'Lancio della app', formats: ['instagram-post-1x1'], assets: ['assets/hero.png'] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, written: ['goal', 'assets', 'formats'], kept: [], reclaimed: [] });
    const v = await view();
    expect(v?.form).toMatchObject({ goal: 'Lancio della app', formats: ['instagram-post-1x1'], assets: ['assets/hero.png'] });
    expect(v?.agentFields).toEqual(['goal', 'assets', 'formats']);
    const lines = (await conversation(s.id)).filter((e) => e.type === 'system');
    expect(lines).toEqual([expect.objectContaining({ level: 'info', origin: 'agent', text: 'Filled in the brief: texts, 1 asset, 1 format' })]);
    expect(briefMessages()).toContainEqual({ type: 'brief-session', project: 'acme', sessionId: s.id, fill: { written: ['goal', 'assets', 'formats'], kept: [] } });
    run.finish({ write: false });
    await waitIdle();
  });

  it('fill after PUT form keeps the field, unless the user asked to rewrite it', async () => {
    t = await briefApp();
    const s = await open();
    await send(s.id, 'Lancio');
    const run = await t.runner.next(0);
    const put = await t.app.inject({ method: 'PUT', url: `${S}/${s.id}/form`, payload: { form: { ...EMPTY_BRIEF_FORM, goal: 'Il mio obiettivo' }, userEdited: ['goal'] } });
    expect(put.json()).toEqual({ ok: true });
    const kept = await tool(run, 'fill_brief', { goal: 'Altro', message: 'Prenota' });
    expect(kept.json()).toMatchObject({ written: ['message'], kept: [{ field: 'goal', reason: 'user-edited' }] });
    expect((await view())?.form.goal).toBe('Il mio obiettivo');
    const back = await tool(run, 'fill_brief', { goal: 'Riscritto', reclaim: ['goal'] });
    expect(back.json()).toMatchObject({ written: ['goal'], kept: [], reclaimed: ['goal'] });
    expect(await view()).toMatchObject({ form: { goal: 'Riscritto' }, userEdited: [] });
    const lines = (await conversation(s.id)).filter((e) => e.type === 'system').map((e) => (e as { text: string }).text);
    expect(lines).toContain("L'agente ha riscritto Cosa vuoi realizzare su tua richiesta");
    run.finish({ write: false });
    await waitIdle();
  });

  it('the agent gets clear errors', async () => {
    t = await briefApp();
    const s = await open();
    await send(s.id, 'Lancio');
    const run = await t.runner.next(0);
    const unknown = await tool(run, 'fill_brief', { formats: ['nope-1x1'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toContain('nope-1x1');
    expect((await tool(run, 'fill_brief', { assets: ['assets/other.png'] })).statusCode).toBe(400);
    for (let i = 0; i < 28; i++) expect((await tool(run, 'fill_brief', { message: `m${i}` })).statusCode).toBe(200);
    expect((await tool(run, 'fill_brief', { message: 'one too many' })).statusCode).toBe(429);
    run.finish({ write: false });
    await waitIdle();
  });

  it('only a brief job has these tools', async () => {
    t = await briefApp();
    const s = await open();
    await send(s.id, 'Lancio');
    const run = await t.runner.next(0);
    expect((await tool(run, 'generate_image', { prompt: 'x', size: '1024x1024' })).statusCode).toBe(403);
    expect((await tool(run, 'update_brief', { goal: 'x' })).statusCode).toBe(403);
    run.finish({ write: false });
    await waitIdle();
    // A console turn's token cannot fill a brief.
    await t.app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'ciao' } });
    const consoleRun = await t.runner.next(1);
    expect((await tool(consoleRun, 'fill_brief', { goal: 'x' })).statusCode).toBe(403);
    consoleRun.finish({ write: false });
    await waitIdle();
  });

  it('a live message goes into the run with the form', async () => {
    t = await briefApp({ live: true });
    const s = await open();
    await send(s.id, 'Lancio');
    const run = await t.runner.next(0);
    await vi.waitFor(async () => expect((await view())?.jobId).toBeTruthy());
    const res = await send(s.id, 'Più corto', { mode: 'live', form: { ...EMPTY_BRIEF_FORM, goal: 'Lancio breve' } });
    expect(res.json()).toEqual({ outcome: 'delivered-pending' });
    expect(run.sent[0]!.text).toContain('Più corto');
    expect(run.sent[0]!.text).toContain("## The user's form now");
    expect(run.sent[0]!.text).toContain('"Lancio breve"');
    expect((await conversation(s.id)).filter((e) => e.type === 'user').map((e) => (e as { mode?: string }).mode)).toEqual([undefined, 'live']);
    run.finish({ write: false });
    await waitIdle();
  });

  it('a message that adds context is queued, never live', async () => {
    t = await briefApp({ live: true });
    const s = await open();
    await send(s.id, 'Lancio');
    const first = await t.runner.next(0);
    await vi.waitFor(async () => expect((await view())?.jobId).toBeTruthy());
    const res = await send(s.id, 'Guarda il codice', { mode: 'live', codebases: [{ path: t.code }] });
    expect(res.json()).toEqual({ outcome: 'queued' });
    expect(first.sent).toEqual([]);
    expect((await view())?.queued).toEqual([expect.objectContaining({ text: 'Guarda il codice', context: { codebases: [t.code], assets: [] } })]);
    first.finish({ write: false });
    const second = await t.runner.next(1);
    expect(second.req.resumeSessionId).toBe(first.sessionId);
    expect(second.req.forkSession).toBeFalsy();
    expect(second.req.prompt).toContain('Guarda il codice');
    expect(second.req.addDirs).toEqual([t.code]);
    expect((await view())?.queued).toEqual([]);
    second.finish({ write: false });
    await waitIdle();
  });

  it('a queued message can be taken back', async () => {
    t = await briefApp();
    const s = await open();
    await send(s.id, 'Lancio');
    const run = await t.runner.next(0);
    await vi.waitFor(async () => expect((await view())?.jobId).toBeTruthy());
    await send(s.id, 'Poi questo');
    const [q] = (await view())!.queued;
    const res = await t.app.inject({ method: 'DELETE', url: `${S}/${s.id}/queue/${q!.clientId}` });
    expect(res.json().queued).toEqual([]);
    run.finish({ write: false });
    await waitIdle();
    expect(t.runner.runs.length).toBe(1);
  });

  it('Stop keeps the session', async () => {
    t = await briefApp();
    const s = await open();
    await send(s.id, 'Lancio');
    const run = await t.runner.next(0);
    await vi.waitFor(async () => expect((await view())?.jobId).toBeTruthy());
    const jobId = (await view())!.jobId!;
    await t.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/stop` });
    await waitIdle();
    expect((await jobs()).find((j) => j.id === jobId)?.state).toBe('cancelled');
    expect((await view())?.id).toBe(s.id);
    // No redirect for a brief job: Stop only (decision 1422).
    expect((await t.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/redirect`, payload: { clientId: '00000000-0000-4000-8000-000000000001', text: 'x' } })).json().code).toBe('redirect-unsupported');
    await send(s.id, 'Riprendi');
    const next = await t.runner.next(1);
    expect(next.req.resumeSessionId).toBe(run.sessionId);
    next.finish({ write: false });
    await waitIdle();
  });

  it('a lost session restarts once from the digest', async () => {
    t = await briefApp();
    const s = await open();
    await send(s.id, 'Il primo messaggio');
    const first = await t.runner.next(0);
    first.emit({ kind: 'text', text: 'Ciao, leggo il codice' });
    first.finish({ write: false });
    await waitIdle();
    t.runner.missingSessions.add(first.sessionId);
    await send(s.id, 'Il secondo');
    const retry = await t.runner.next(2);
    expect(t.runner.runs[1]!.req.resumeSessionId).toBe(first.sessionId);
    expect(retry.req.resumeSessionId).toBeUndefined();
    expect(retry.req.prompt).toContain('## The session so far');
    expect(retry.req.prompt).toContain('Il primo messaggio');
    expect(retry.req.prompt).toContain('Il secondo');
    retry.finish({ write: false });
    await waitIdle();
    // A run that fails again is a failed job, not a loop.
    t.runner.missingSessions.add(retry.sessionId);
    t.runner.failStart = (req) => (req.resumeSessionId ? null : { error: 'boom' });
    await send(s.id, 'Il terzo');
    await waitIdle();
    expect(t.runner.runs.length).toBe(5);
    expect((await jobs())[0]!.state).toBe('failed');
  });

  it('a missing codebase is said, not fatal', async () => {
    t = await briefApp();
    const s = await open();
    await send(s.id, 'Lancio', { codebases: [{ path: t.code }] });
    (await t.runner.next(0)).finish({ write: false });
    await waitIdle();
    await rm(t.code, { recursive: true, force: true });
    await send(s.id, 'Ancora', { codebases: [{ path: t.code }] });
    const run = await t.runner.next(1);
    expect(run.req.prompt).toContain(`- ${t.code}: not available in this turn`);
    expect(run.req.addDirs).toEqual([]);
    run.finish({ write: false });
    await waitIdle();
  });

  it('a new folder or asset is checked', async () => {
    t = await briefApp();
    const s = await open();
    expect((await send(s.id, 'x', { codebases: [{ path: join(t.base, 'nope') }] })).statusCode).toBe(400);
    expect((await send(s.id, 'x', { codebases: [{ path: t.projectDir }] })).statusCode).toBe(400);
    expect((await send(s.id, 'x', { assets: ['assets/missing.png'] })).statusCode).toBe(400);
    const ctx = await t.app.inject({ method: 'PUT', url: `${S}/${s.id}/context`, payload: { codebases: [{ path: t.code, note: 'App' }], assets: ['assets/hero.png'] } });
    expect(ctx.json().context).toEqual({ codebases: [{ path: t.code, note: 'App' }], assets: ['assets/hero.png'] });
    expect(t.runner.runs.length).toBe(0);
  });

  it('discard', async () => {
    t = await briefApp();
    const s = await open();
    await send(s.id, 'Lancio');
    await t.runner.next(0);
    await vi.waitFor(async () => expect((await view())?.jobId).toBeTruthy());
    expect((await t.app.inject({ method: 'DELETE', url: `${S}/${s.id}` })).statusCode).toBe(204);
    await waitIdle();
    expect((await jobs())[0]!.state).toBe('cancelled');
    expect(await view()).toBeNull();
    const stale = await send(s.id, 'ancora');
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('brief-session-gone');
    expect(briefMessages().some((m) => m.ended)).toBe(true);
  });

  it('nothing is created', async () => {
    t = await briefApp();
    const s = await open();
    await send(s.id, 'Lancio');
    const run = await t.runner.next(0);
    await tool(run, 'fill_brief', { goal: 'Lancio', formats: ['instagram-post-1x1'], durationSec: 15 });
    run.finish({ write: false });
    await waitIdle();
    expect((await t.app.inject('/api/projects/acme/creatives')).json()).toEqual([]);
    expect((await jobs()).some((j) => j.kind === 'creative')).toBe(false);
  });
});

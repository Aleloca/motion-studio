// @vitest-environment node
/**
 * Decision 1423: Genera and Salva bozza carry the brief session into the new creative: its chat is copied, the creative's
 * first turn (or its group's coordinator) forks the brief agent's session, with the chat's digest as the fallback.
 */
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messages, type ConversationEntry } from '@motion-studio/shared';
import { join } from 'node:path';
import { BriefSessionStore } from '../src/brief/brief-session-store.ts';
import { GROUP_BLOCK } from '../src/creatives/coordinator-prompt.ts';
import { briefApp, briefHelpers, type BriefApp } from './helpers/brief-app.ts';
import type { ControlledRun } from './helpers/controlled-runner.ts';

vi.setConfig({ testTimeout: 60_000 });

const P = '/api/projects/acme/creatives';
const brief = { goal: 'Lancio della app', message: 'Prenota in 3 tap', formats: ['instagram-post-1x1'], durationSec: 10, assets: [], notes: '' };

let t: BriefApp;
afterEach(async () => {
  if (!t) return;
  for (const r of t.runner.runs) r.end();
  await t.app.close();
  await rm(t.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const h = () => briefHelpers(t);

/** A brief session with a user message, an agent text and a fill, its run finished. */
async function session(): Promise<{ id: string; run: ControlledRun }> {
  const s = await h().open();
  await h().send(s.id, 'Un video di lancio per la app');
  const run = await t.runner.next(0);
  run.emit({ kind: 'text', text: 'Ho compilato il brief: controllalo.' });
  expect((await h().tool(run, 'fill_brief', { goal: 'Lancio della app', formats: ['instagram-post-1x1'] })).statusCode).toBe(200);
  run.finish({ write: false });
  await h().waitIdle();
  return { id: s.id, run };
}
const create = (o: Record<string, unknown>) => t.app.inject({ method: 'POST', url: P, payload: { title: 'Lancio', brief, ...o } });
const conversation = async (slug: string) => (await t.app.inject(`${P}/${slug}/conversation`)).json() as ConversationEntry[];
const runsAfter = (n: number) => t.runner.runs.slice(n);

describe('from the brief session to the creative (decision 1423)', () => {
  it('Genera hands the session to the creative', async () => {
    t = await briefApp();
    const { id, run } = await session();
    const copied = await h().conversation(id);
    const res = await create({ generate: true, briefSession: { id } });
    expect(res.statusCode, res.body).toBe(201);
    const { slug } = res.json() as { slug: string };
    const first = await t.runner.next(1);
    expect(first.req.resumeSessionId).toBe(run.sessionId);
    expect(first.req.forkSession).toBe(true);
    const conv = await conversation(slug);
    expect(conv.slice(0, copied.length)).toEqual(copied);
    const line = conv[copied.length]!;
    expect(line).toMatchObject({ type: 'system', level: 'info', origin: 'brief' });
    expect((line as { text: string }).text).toBe(messages('it').briefSession.creativeStarts({ title: 'Lancio', formats: '1 formato' }));
    expect(await h().view()).toBeNull();
    expect(h().briefMessages().some((m) => m.sessionId === id && m.ended)).toBe(true);
    first.finish();
    await h().waitIdle();
    // A version exists: the next turn builds on it, never on the brief's session again.
    await t.app.inject({ method: 'POST', url: `${P}/${slug}/turns`, payload: { text: 'Più luce' } });
    const next = await t.runner.next(2);
    expect(next.req.resumeSessionId).toBe(first.sessionId);
    expect(next.req.forkSession).toBeFalsy();
    next.finish();
    await h().waitIdle();
  });

  it('missing brief session: one fresh attempt with the digest and a chat line', async () => {
    t = await briefApp();
    const { id, run } = await session();
    t.runner.missingSessions.add(run.sessionId);
    const { slug } = (await create({ generate: true, briefSession: { id } })).json() as { slug: string };
    const retry = await t.runner.next(2);
    expect(t.runner.runs[1]!.req.resumeSessionId).toBe(run.sessionId);
    expect(retry.req.resumeSessionId).toBeUndefined();
    expect(retry.req.prompt).toContain('## The brief session (summary)');
    expect(retry.req.prompt).toContain('Un video di lancio per la app');
    expect(retry.req.prompt).toContain('Ho compilato il brief: controllalo.');
    retry.finish();
    await h().waitIdle();
    const lines = (await conversation(slug)).filter((e) => e.type === 'system').map((e) => (e as { text: string }).text);
    expect(lines.filter((l) => l === messages('it').briefSession.memoryUnavailable)).toHaveLength(1);
    // Used: the next turn neither forks nor carries the summary again.
    await t.app.inject({ method: 'POST', url: `${P}/${slug}/turns`, payload: { text: 'Ancora' } });
    const next = await t.runner.next(3);
    expect(next.req.prompt).not.toContain('## The brief session (summary)');
    next.finish();
    await h().waitIdle();
  });

  it('Salva bozza moves the session without a turn', async () => {
    t = await briefApp();
    const { id, run } = await session();
    const copied = await h().conversation(id);
    const res = await create({ generate: false, briefSession: { id } });
    expect(res.statusCode, res.body).toBe(201);
    const { slug } = res.json() as { slug: string; job: unknown };
    expect(res.json().job).toBeNull();
    expect(t.runner.runs).toHaveLength(1);
    expect((await conversation(slug)).slice(0, copied.length)).toEqual(copied);
    expect(await h().view()).toBeNull();
    // The first Generate later forks the brief's session.
    expect((await t.app.inject({ method: 'POST', url: `${P}/${slug}/turns`, payload: {} })).statusCode).toBe(202);
    const first = await t.runner.next(1);
    expect(first.req.resumeSessionId).toBe(run.sessionId);
    expect(first.req.forkSession).toBe(true);
    first.finish();
    await h().waitIdle();
  });

  it('variants: one copy in the group chat, only the coordinator forks', async () => {
    t = await briefApp({ settings: { singleAgent: true, confirmPaidProviders: false } });
    const { id, run } = await session();
    const copied = await h().conversation(id);
    const { slug } = (await create({ generate: false, briefSession: { id, group: true } })).json() as { slug: string };
    expect((await t.app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 2, directions: [null, null] } })).statusCode).toBe(201);
    const conv = await conversation(slug);
    const mine = conv.filter((e) => copied.some((c) => c.at === e.at && c.type === e.type));
    expect(mine.length).toBe(copied.length);
    expect(mine.every((e) => e.group === true && e.variant === undefined)).toBe(true);
    const res = await t.app.inject({ method: 'POST', url: `${P}/${slug}/variants/run`, payload: { targets: 'all-active', request: { text: 'Parti' } } });
    expect(res.statusCode, res.body).toBe(202);
    const isCoordinator = (r: ControlledRun) => r.req.prompt.includes(`\`\`\`${GROUP_BLOCK}`);
    await vi.waitFor(() => expect(t.runner.runs.some(isCoordinator)).toBe(true), { timeout: 10_000 });
    const c = t.runner.runs.find(isCoordinator)!;
    expect(c.req.resumeSessionId).toBe(run.sessionId);
    expect(c.req.forkSession).toBe(true);
    c.finish({ write: false });
    // Whatever the coordinator starts next (its report, the variants' first generations), nothing else resumes the brief.
    await vi.waitFor(() => { for (const r of t.runner.runs) r.finish(); return h().waitIdle(); }, { timeout: 30_000 });
    expect(runsAfter(1).filter((r) => r !== c && r.req.resumeSessionId === run.sessionId)).toEqual([]);
  });

  it('a core-made identity group is a group whatever the flag', async () => {
    t = await briefApp();
    const { id } = await session();
    const identity = { goal: 'Logo per Acme', message: '', formats: ['identity-logo'], durationSec: null, assets: [], notes: '', identity: { start: 'scratch', name: 'Acme', colors: 'brand', concepts: 3 } };
    const res = await t.app.inject({ method: 'POST', url: P, payload: { title: 'Logo', brief: identity, generate: false, briefSession: { id } } });
    expect(res.statusCode, res.body).toBe(201);
    const { slug } = res.json() as { slug: string };
    const conv = await conversation(slug);
    const line = conv.find((e) => e.type === 'system' && e.origin === 'brief');
    expect(line?.group).toBe(true);
    expect(conv.filter((e) => e.type === 'user').every((e) => e.group === true)).toBe(true);
  });

  it('messages a restart left queued start their turn instead of being lost in the move', async () => {
    t = await briefApp();
    const { id } = await session();
    // As after a restart: a message queued, no turn to take it.
    await new BriefSessionStore(join(t.base, 'config')).update(t.projectDir, id, () => ({ queued: [{ clientId: 'q-1', text: 'Messaggio in coda', at: new Date().toISOString(), context: { codebases: [], assets: [] } }] }));
    const res = await create({ generate: true, briefSession: { id } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('brief-session-busy');
    const run = await t.runner.next(1);
    expect(run.req.prompt).toContain('Messaggio in coda');
    run.finish({ write: false });
    await h().waitIdle();
    expect((await create({ generate: false, briefSession: { id } })).statusCode).toBe(201);
  });

  it('busy or gone: nothing is created', async () => {
    t = await briefApp();
    const s = await h().open();
    await h().send(s.id, 'Lancio');
    const run = await t.runner.next(0);
    await vi.waitFor(async () => expect((await h().view())?.jobId).toBeTruthy());
    const busy = await create({ generate: true, briefSession: { id: s.id } });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().code).toBe('brief-session-busy');
    const gone = await create({ generate: true, briefSession: { id: 'not-the-open-one' } });
    expect(gone.statusCode).toBe(409);
    expect(gone.json().code).toBe('brief-session-gone');
    expect((await t.app.inject('/api/projects/acme/creatives')).json()).toEqual([]);
    // Messages left queued with no turn to take them (a restart came between) start their turn instead of being lost.
    await t.app.inject({ method: 'POST', url: `/api/projects/acme/brief-session/${s.id}/messages`, payload: { clientId: 'q-1', text: 'In coda', context: { codebases: [], assets: [] }, form: (await h().view())!.form, userEdited: [] } });
    expect((await h().view())?.queued.map((q) => q.text)).toEqual(['In coda']);
    run.finish({ write: false });
    const queuedRun = await t.runner.next(1);
    expect(queuedRun.req.prompt).toContain('In coda');
    queuedRun.finish({ write: false });
    await h().waitIdle();
    // The session is as it was: a message still works.
    expect((await h().view())?.id).toBe(s.id);
    expect((await h().send(s.id, 'Ancora')).statusCode).toBe(202);
    (await t.runner.next(2)).finish({ write: false });
    await h().waitIdle();
  });
});

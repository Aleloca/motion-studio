// @vitest-environment node
/**
 * Decision 1423: Genera and Salva bozza carry the brief session into the new creative: its chat is copied, the creative's
 * first turn (or its group's coordinator) forks the brief agent's session, with the chat's digest as the fallback.
 */
import { chmod, mkdir, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messages, type ConversationEntry } from '@motion-studio/shared';
import { join } from 'node:path';
import { BriefSessionStore } from '../src/brief/brief-session-store.ts';
import { GROUP_BLOCK } from '../src/creatives/coordinator-prompt.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
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

  it('subtitles asked in the brief chat reach the first turn as the notes line, and its start_subtitles goes to the subtitles job (report 70)', async () => {
    t = await briefApp();
    const s = await h().open();
    await h().send(s.id, 'Aggiungimi i sottotitoli a questo video');
    const run = await t.runner.next(0);
    expect(run.req.prompt).toContain('## Subtitles');
    const notes = 'Subtitles: drawn into the video.';
    expect((await h().tool(run, 'fill_brief', { goal: 'Sottotitoli del video', notes, formats: ['instagram-post-1x1'] })).statusCode).toBe(200);
    run.finish({ write: false });
    await h().waitIdle();
    // Round 1 (M7): the brief sent with Genera is the session's form as the agent filled it (what the page sends), not a copy.
    const form = (await h().view())!.form;
    expect(form.notes).toBe(notes);
    const res = await create({ generate: true, briefSession: { id: s.id }, brief: { ...brief, goal: form.goal, notes: form.notes, formats: form.formats } });
    expect(res.statusCode, res.body).toBe(201);
    const first = await t.runner.next(1);
    expect(first.req.prompt).toContain(notes);
    const line = first.req.prompt.split('\n').find((l) => l.startsWith('- start_subtitles:'))!;
    expect(line).toContain('When the brief\'s notes have a `Subtitles: …` line');
    expect(line).toContain('never copy it from a video analysis\'s transcript');
    // The subtitles feature takes the call (the job starts when the turn ends): no caption text goes through the agent.
    const started = await h().tool(first, 'start_subtitles', { drawn: true });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toEqual({ started: true, when: 'after-turn' });
    first.finish();
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

  it('a restart before the first turn reports its session never takes the brief\'s session as the turn\'s', async () => {
    t = await briefApp();
    const { id } = await session();
    const { slug } = (await create({ generate: false, briefSession: { id } })).json() as { slug: string };
    const store = new CreativeStore(t.projectDir);
    // The copied chat holds the brief run's session events; the creative's own turn reported none yet.
    expect(await store.lastTurnSession(slug)).toBeNull();
    await store.update(slug, { status: 'working' });
    const remembered: string[] = [];
    expect(await store.recoverInterrupted(() => false, async (_s, x) => { remembered.push(x.sessionId); })).toEqual([slug]);
    expect(remembered).toEqual([]);
  });

  it('a move that does not finish answers 201 with briefError, and a second Genera cannot duplicate', async () => {
    t = await briefApp();
    const { id } = await session();
    // The session's chat cannot be read any more (a folder where the log was).
    const dir = (await new BriefSessionStore(join(t.base, 'config')).dirFor(t.projectDir))!;
    await rm(join(dir, 'conversation.jsonl'));
    await mkdir(join(dir, 'conversation.jsonl'));
    const res = await create({ generate: false, briefSession: { id } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().briefError).toBeTruthy();
    const { slug } = res.json() as { slug: string };
    expect((await h().view())?.handedOffTo).toBe(slug);
    const again = await create({ generate: false, briefSession: { id } });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('brief-session-handed-off');
    expect((await h().send(id, 'ancora')).json().code).toBe('brief-session-handed-off');
    expect(((await t.app.inject('/api/projects/acme/creatives')).json() as unknown[]).length).toBe(1);
    // Discard still works.
    expect((await t.app.inject({ method: 'DELETE', url: `/api/projects/acme/brief-session/${id}` })).statusCode).toBe(204);
  });

  it('during a failed move a concurrent Genera is refused: one creative only', async () => {
    t = await briefApp();
    const { id } = await session();
    const dir = (await new BriefSessionStore(join(t.base, 'config')).dirFor(t.projectDir))!;
    await rm(join(dir, 'conversation.jsonl'));
    await mkdir(join(dir, 'conversation.jsonl'));
    const both = await Promise.all([create({ generate: false, briefSession: { id } }), create({ generate: false, briefSession: { id } })]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(((await t.app.inject('/api/projects/acme/creatives')).json() as unknown[]).length).toBe(1);
  });

  it('a move whose mark cannot be written keeps the session refused until it is discarded', async () => {
    t = await briefApp();
    const { id } = await session();
    const dir = (await new BriefSessionStore(join(t.base, 'config')).dirFor(t.projectDir))!;
    await rm(join(dir, 'conversation.jsonl'));
    await mkdir(join(dir, 'conversation.jsonl'));
    // Nothing can be written in the session's folder any more (the mark included).
    await chmod(dir, 0o500);
    try {
      const res = await create({ generate: false, briefSession: { id } });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().briefError).toBeTruthy();
      expect((await h().view())?.handedOffTo).toBeUndefined();
      expect((await create({ generate: false, briefSession: { id } })).json().code).toBe('brief-session-handed-off');
      expect((await h().send(id, 'ancora')).json().code).toBe('brief-session-handed-off');
    } finally {
      await chmod(dir, 0o700);
    }
    expect((await t.app.inject({ method: 'DELETE', url: `/api/projects/acme/brief-session/${id}` })).statusCode).toBe(204);
    // A new session is not refused.
    const next = await h().open();
    expect((await h().send(next.id, 'nuova')).statusCode).toBe(202);
    (await t.runner.next(1)).finish({ write: false });
    await h().waitIdle();
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
    await t.app.inject({ method: 'POST', url: `/api/projects/acme/brief-session/${s.id}/messages`, payload: { clientId: 'q-1', text: 'In coda', context: { codebases: [], assets: [] }, form: (await h().view())!.form, userEdited: [], baseRevision: 0 } });
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

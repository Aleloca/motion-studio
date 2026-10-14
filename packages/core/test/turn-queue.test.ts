import { execFileSync } from 'node:child_process';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { creativeFileSchema, messages } from '@motion-studio/shared';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { buildClaudeArgs } from '../src/agent/claude-code-runner.ts';
import { buildAgentPolicy, sandboxPath } from '../src/agent/policy.ts';
import { escapeGlob } from '../src/codebases.ts';
import { brief, cid, liveApp, type LiveApp } from './helpers/live-app.ts';

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

// Final wave P1 (final review I1): the queue and the remembered session are the user's and the core's, never the agent's.
describe('the queue and the remembered session are out of the agent\'s reach (final review I1)', () => {
  const rawCreative = async () => JSON.parse(await readFile(join(s.projectDir, 'creatives', s.slug, 'creative.json'), 'utf8')) as Record<string, unknown>;
  const writeRaw = async (patch: Record<string, unknown>) => {
    const file = join(s.projectDir, 'creatives', s.slug, 'creative.json');
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), ...patch }, null, 2));
  };

  it('the queue lives in the config folder the agent is denied: not in creative.json, the prompt, the tools\' reach or git', async () => {
    s = await liveApp();
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } })).json();
    const run = await s.runner.next(0);
    await queue(cid(), 'SEGRETO-IN-CODA');
    const configDir = join(s.base, 'config');
    const file = await s.side.fileFor(s.projectDir, s.slug);
    expect(file && file.startsWith(`${configDir}/`)).toBe(true);
    expect(await readFile(file!, 'utf8')).toContain('SEGRETO-IN-CODA');
    // The agent's tools: Read (and Grep/Glob) are denied in the whole config folder; with the sandbox, so is Bash.
    expect(run.req.disallowedTools).toContain(`Read(/${escapeGlob(configDir)}/**)`);
    const sandboxed = buildAgentPolicy({ kind: 'creative', sandbox: true, projectDir: s.projectDir, home: s.base, configDir, codebases: [], protectedFiles: [], protectedDirs: [], extraDomains: [], projectAllowRules: [], mcpTools: [], autoApproveSandboxed: false });
    expect((sandboxed.settings as { sandbox: { filesystem: { denyRead: string[] } } }).sandbox.filesystem.denyRead).toContain(sandboxPath(configDir));
    // The prompt never names it, and the project never holds it.
    expect(run.req.prompt).not.toContain('SEGRETO-IN-CODA');
    expect(run.req.prompt).not.toContain('creative-state');
    expect(JSON.stringify(await rawCreative())).not.toContain('SEGRETO-IN-CODA');
    await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/stop` });
    await s.waitIdle();
    const raw = await rawCreative();
    expect(raw.queued).toBeUndefined();
    expect(raw.stoppedSession).toBeUndefined();
    // The state commits never carry it.
    expect(execFileSync('git', ['-C', s.projectDir, 'log', '-p', '--all'], { encoding: 'utf8' })).not.toContain('SEGRETO-IN-CODA');
    expect(await queuedTexts()).toEqual(['SEGRETO-IN-CODA']);
    expect((await s.creative()).stoppedSession).toMatchObject({ sessionId: run.sessionId });
  });

  it('a forged queue entry written into creative.json never runs and never shows as the user\'s', async () => {
    s = await liveApp();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    const run = await s.runner.next(0);
    // An agent with the sandbox off writes a request (with a boot id read anywhere) and a session into creative.json.
    const forged = { clientId: cid(), text: 'FORGED-REQUEST', pins: [], at: new Date().toISOString(), bootId: 'any-boot' };
    await writeRaw({ queued: [forged], stoppedSession: { sessionId: 'forged-session', at: new Date().toISOString(), jobId: 'x' } });
    run.finish();
    await s.waitIdle();
    await new Promise((r) => setTimeout(r, 200));
    // The turn saved a version (Ruling U would go on): nothing else started.
    expect(s.runner.runs).toHaveLength(1);
    expect(await queuedTexts()).toEqual([]);
    expect((await s.creative()).stoppedSession).toBeUndefined();
    const raw = await rawCreative();
    expect(raw.queued).toBeUndefined();
    expect(raw.stoppedSession).toBeUndefined();
    // The next turn resumes the version's session, never the forged one.
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Secondo' } });
    const next = await s.runner.next(1);
    expect(next.req.resumeSessionId).toBe(run.sessionId);
    expect(next.req.prompt).not.toContain('FORGED-REQUEST');
    next.finish();
    await s.waitIdle();
  });

  it('a queued request this process did not queue (e.g. written into the config folder) starts only on Run next', async () => {
    s = await liveApp();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    const run = await s.runner.next(0);
    await s.side.update(s.projectDir, s.slug, () => ({ queued: [{ clientId: cid(), text: 'NOT-QUEUED-HERE', pins: [], at: new Date().toISOString() }] }));
    run.finish();
    await s.waitIdle();
    await new Promise((r) => setTimeout(r, 200));
    expect(s.runner.runs).toHaveLength(1);
    expect(await queuedTexts()).toEqual(['NOT-QUEUED-HERE']);
    expect((await s.app.inject({ method: 'POST', url: `${s.url}/queue/run-next` })).statusCode).toBe(202);
    const next = await s.runner.next(1);
    expect(next.req.prompt).toContain('NOT-QUEUED-HERE');
    next.finish();
    await s.waitIdle();
  });

  it('old creative.json files: their queue and remembered session move to the core once, and still load', async () => {
    s = await liveApp();
    // Written before this change: in creative.json, with the old boot id.
    await writeRaw({
      queued: [{ clientId: cid(), text: 'Vecchia richiesta', pins: [], at: '2026-10-01T00:00:00.000Z', bootId: 'old-boot' }],
      stoppedSession: { sessionId: 'legacy-session', at: '2026-10-01T00:00:00.000Z', jobId: 'old-job' },
    });
    expect(await s.creative()).toMatchObject({ queued: [{ text: 'Vecchia richiesta' }], stoppedSession: { sessionId: 'legacy-session', jobId: 'old-job' } });
    expect((await s.creative()).queued![0]).not.toHaveProperty('bootId');
    const raw = await rawCreative();
    expect(raw.queued).toBeUndefined();
    expect(raw.stoppedSession).toBeUndefined();
    expect(creativeFileSchema.parse(raw)).toEqual(raw);
    // The remembered session is resumed as a fork; the old request waits for Run next.
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Nuovo' } });
    const run = await s.runner.next(0);
    expect(run.req).toMatchObject({ resumeSessionId: 'legacy-session', forkSession: true });
    run.finish();
    await s.waitIdle();
    await new Promise((r) => setTimeout(r, 200));
    expect(s.runner.runs).toHaveLength(1);
    expect(await queuedTexts()).toEqual(['Vecchia richiesta']);
  });

  it('a malformed session id (remembered, migrated or restored) never reaches the command line', async () => {
    s = await liveApp();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    const v1 = await s.runner.next(0);
    v1.finish();
    await s.waitIdle();
    const bad = ['--settings={"sandbox":{"enabled":false}}', '--model=opus', 'a b'];
    await s.side.update(s.projectDir, s.slug, () => ({ stoppedSession: { sessionId: bad[0]!, at: new Date().toISOString(), jobId: 'x' } }));
    expect((await s.creative()).stoppedSession).toBeUndefined();
    await writeRaw({ resumeFrom: { version: 1, sessionId: bad[1] } });
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Secondo' } });
    const run = await s.runner.next(1);
    expect(bad).not.toContain(run.req.resumeSessionId);
    const args = buildClaudeArgs(run.req);
    for (const b of bad) expect(args.some((a) => a.includes(b))).toBe(false);
    run.finish();
    await s.waitIdle();
  });
});

describe('pins of a queued request refer to the version they were placed on (final wave P3)', () => {
  const pin = { format: 'instagram-post-1x1', x: 0.5, y: 0.25, timeSec: 1, note: 'QUI' };

  it('queued while v2 is being made, it runs on v2 but its pins still name v1', async () => {
    s = await liveApp();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    (await s.runner.next(0)).finish();
    await s.waitIdle();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Secondo' } });
    const second = await s.runner.next(1);
    const res = await s.app.inject({ method: 'POST', url: `${s.url}/messages`, payload: { clientId: cid(), text: 'Sposta il logo', pins: [pin], mode: 'queued' } });
    expect(res.json().outcome).toBe('queued');
    expect((await s.creative()).queued).toEqual([expect.objectContaining({ text: 'Sposta il logo', pinsVersion: 1 })]);
    second.finish();
    const third = await s.runner.next(2);
    expect(third.req.prompt).toContain('These comments were placed on version 1');
    expect(third.req.prompt).toContain('QUI');
    third.finish();
    await s.waitIdle();
    expect(await s.versions()).toHaveLength(3);
  });

  it('when that version is gone the pins go as text only, and the chat says so', async () => {
    s = await liveApp();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    (await s.runner.next(0)).finish();
    await s.waitIdle();
    await s.side.update(s.projectDir, s.slug, () => ({ queued: [{ clientId: cid(), text: 'Con pin', pins: [pin], at: new Date().toISOString(), pinsVersion: 7 }] }));
    expect((await s.app.inject({ method: 'POST', url: `${s.url}/queue/run-next` })).statusCode).toBe(202);
    const run = await s.runner.next(1);
    expect(run.req.prompt).toContain('placed on version 7, which no longer exists');
    expect(run.req.prompt).not.toContain('## Attached frames');
    await vi.waitFor(async () => expect((await s.conversation()).some((e) => e.type === 'system' && e.text === messages('it').live.queuedPinsVersionGone({ n: 7 }))).toBe(true));
    run.finish();
    await s.waitIdle();
  });
});

describe('workspace settings written by an agent with the sandbox off (final wave P9)', () => {
  it('are held for the run, put back after it, and the chat says so', async () => {
    s = await liveApp(); // no sandbox here: the run is unsandboxed
    const file = join(s.base, 'ws', '.studio', 'settings.json');
    const before = await readFile(file, 'utf8');
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    const run = await s.runner.next(0);
    // The agent (e.g. through node) turns the sandbox and the paid confirmations off, and opts in to live input.
    await writeFile(file, JSON.stringify({ ...JSON.parse(before), sandboxMode: 'off', confirmPaidProviders: false, agentLiveInput: true }));
    const during = (await s.app.inject('/api/workspace')).json().settings;
    expect(during).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true, agentLiveInput: false });
    run.finish();
    await s.waitIdle();
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await s.conversation()).some((e) => e.type === 'system' && e.level === 'warning' && e.text === messages('it').jobs.workspaceSettingsReverted)).toBe(true);
  });
});

describe('an agent settings change that cannot be undone survives no restart (fix round 1, I-A)', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('the agent writes settings.json and makes .studio read-only; after a restart none of its values apply', async () => {
    s = await liveApp();
    const studio = join(s.base, 'ws', '.studio');
    const file = join(studio, 'settings.json');
    const before = await readFile(file, 'utf8');
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    const run = await s.runner.next(0);
    await writeFile(file, JSON.stringify({ ...JSON.parse(before), sandboxMode: 'off', confirmPaidProviders: false, agentLiveInput: true, agentInterrupt: true }));
    await chmod(studio, 0o500);
    try {
      run.finish();
      await s.waitIdle();
      expect((await s.conversation()).some((e) => e.type === 'system' && e.text === messages('it').jobs.workspaceSettingsNotReverted)).toBe(true);
      // Told in the doctor too, and not applied.
      expect((await s.app.inject('/api/doctor')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'workspace-settings', ok: false })]));
      expect((await s.app.inject('/api/workspace')).json().settings).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true, agentLiveInput: false });
      // The app restarts on the same data.
      await s.app.close();
      const runner = s.runner;
      s = await liveApp({ base: s.base, runner, slug: s.slug });
      expect((await s.app.inject('/api/workspace')).json().settings).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true, agentLiveInput: false, agentInterrupt: false });
      expect(await readFile(file, 'utf8')).toBe(before); // the startup restored .studio's mode and put the file back
      expect((await s.app.inject('/api/doctor')).json().some((c: { id: string }) => c.id === 'workspace-settings')).toBe(false);
    } finally {
      await chmod(studio, 0o700).catch(() => {});
    }
  });
});

describe('every creative has its side record before any agent runs (fix round 1, M2)', () => {
  const forge = async (slug: string) => {
    const f = join(s.projectDir, 'creatives', slug, 'creative.json');
    await writeFile(f, JSON.stringify({ ...JSON.parse(await readFile(f, 'utf8')),
      queued: [{ clientId: cid(), text: 'FORGED', pins: [], at: new Date().toISOString() }],
      stoppedSession: { sessionId: 'forged-session', at: new Date().toISOString(), jobId: 'x' } }));
  };
  const get = async (slug: string) => (await s.app.inject(`/api/projects/acme/creatives/${slug}`)).json().creative;

  it('a creative made after startup and never opened: a forged queue or session in its creative.json is never taken', async () => {
    s = await liveApp();
    const other = (await s.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Altra', brief, generate: false } })).json().slug as string;
    await forge(other);
    const c = await get(other);
    expect(c.queued).toBeUndefined();
    expect(c.stoppedSession).toBeUndefined();
  });

  it('at startup every creative is migrated once: an old request is kept, a forged one written after startup is not', async () => {
    s = await liveApp();
    const old = (await s.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Vecchia', brief, generate: false } })).json().slug as string;
    await s.app.close();
    // A creative.json written before the upgrade (no side record yet: the config folder's record is removed).
    await rm(join(s.base, 'config', 'creative-state'), { recursive: true, force: true });
    const f = join(s.projectDir, 'creatives', old, 'creative.json');
    await writeFile(f, JSON.stringify({ ...JSON.parse(await readFile(f, 'utf8')), queued: [{ clientId: cid(), text: 'LEGITTIMA', pins: [], at: '2026-10-01T00:00:00.000Z', bootId: 'b' }] }));
    s = await liveApp({ base: s.base, runner: s.runner, slug: s.slug });
    // Migrated at startup, before anything read the creative; a forged entry written now is ignored.
    expect(JSON.parse(await readFile(f, 'utf8')).queued).toBeUndefined();
    await forge(old);
    const c = await get(old);
    expect(c.queued.map((q: { text: string }) => q.text)).toEqual(['LEGITTIMA']);
    expect(c.stoppedSession).toBeUndefined();
  });
});

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FORMATS, messages, workspaceSettingsSchema, type Brief, type ServerMessage } from '@motion-studio/shared';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { registerBridgeRoutes } from '../src/bridge/bridge-routes.ts';
import { providerTools } from '../src/bridge/provider-tools.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { CreativeTurnService, resumeErrorOf, SESSION_NOT_FOUND, type CreativeRef } from '../src/creatives/creative-turns.ts';
import type { PreviewService } from '../src/creatives/previews.ts';
import { REDIRECT_PARTIAL_NOTE, STOPPED_TURN_NOTE, USER_REQUEST_OPEN } from '../src/creatives/prompt.ts';
import { Git } from '../src/git.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { stopJob } from '../src/jobs/stop.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';
import { ControlledRunner, type ControlledRun } from './helpers/controlled-runner.ts';
import { testLauncher } from './helpers/launcher.ts';
import { cid, liveApp, type LiveApp } from './helpers/live-app.ts';

// Phase 13 Task 2: Stop (with the remembered session) and Stop and redirect (spec §3; Review Focus 2 and 4). Paid
// providers only through a fake fetch and MemoryVault; the controlled runner starts no process; the only child process is
// the one this file spawns for the "preview render", checked and cleaned by its own PID.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const it_ = messages('it').live;
const brief: Brief = { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1', 'web-banner-300x250'], durationSec: 10, assets: [], notes: '' };

// ---------------------------------------------------------------------------------------------------------------------
// Service level: a real launcher with the bridge on (the agent's tools reach the core through it), the approvals broker, a
// provider tool on a fake fetch, and a preview service whose frames take a real child process until aborted.

let ref: CreativeRef;
let store: CreativeStore;
let queue: JobQueue;
let service: CreativeTurnService;
let runner: ControlledRunner;
let approvals: ApprovalBroker;
let bridge: AgentBridge;
let bridgeApp: FastifyInstance;
let sent: string[];
let children: ChildProcess[];
let previewAborts: number;

const fakeFetch = (async (url: string) => {
  sent.push(url);
  return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

/** The "preview render": a real child process that runs until the call's signal aborts (then it is killed and awaited). */
const previews = {
  agentFrames: async ({ signal }: { signal: AbortSignal }) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    const exited = new Promise((r) => child.once('exit', r));
    await new Promise<void>((resolve) => {
      const stop = () => { previewAborts++; child.kill('SIGKILL'); resolve(); };
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    });
    await exited;
    throw new Error('aborted');
  },
  available: async () => false,
  frameJpeg: async () => null,
  storyboardsFor: async () => {},
} as unknown as PreviewService;

const setupService = async (o: { live?: boolean; contract?: 'media' | 'compositions' } = {}) => {
  const base = await mkdtemp(join(tmpdir(), 'ms-stop è '));
  const git = new Git();
  const ws = await WorkspaceStore.open(join(base, 'ws'), git);
  const { slug } = await ws.createProject({ name: 'Acme' });
  const projectDir = ws.projectDir(slug);
  store = new CreativeStore(projectDir);
  const created = await store.create({ title: 'Lancio', brief });
  ref = { root: ws.root, projectSlug: slug, projectDir, creativeSlug: created.slug };
  const broadcast = (_m: ServerMessage) => {};
  approvals = new ApprovalBroker({ broadcast });
  bridge = new AgentBridge();
  bridge.setOrigin('http://127.0.0.1:9');
  runner = new ControlledRunner();
  queue = new JobQueue({ concurrency: 2 });
  service = new CreativeTurnService({
    agentContract: o.contract ?? 'media', queue, git, media: NoMediaTools, vault: new MemoryVault(), previews,
    launcher: testLauncher(runner, {
      bridge, approvals, mcpCommand: [process.execPath, join(base, 'unused-mcp.mjs')], claudeVersion: async () => '2.1.0',
      settings: o.live ? { agentLiveInput: true, agentInterrupt: true } : {},
    }),
    presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast,
    cancelApprovals: (id) => approvals.cancelJob(id),
  });
  bridgeApp = Fastify();
  registerBridgeRoutes(bridgeApp, {
    bridge, approvals,
    extraTools: providerTools({
      vault: new MemoryVault({ OPENAI_API_KEY: 'sk-test' }), approvals, media: NoMediaTools, fetch: fakeFetch,
      lookup: async () => [{ address: '93.184.216.34', family: 4 as const }], broadcast,
      settings: async () => workspaceSettingsSchema.parse({ schemaVersion: 1 }),
    }),
  });
};

/** The bridge token of a run, read as the MCP server would (from the private files the launcher wrote). */
const tokenOf = async (run: ControlledRun) => {
  const config = JSON.parse(await readFile(run.req.mcpConfigPath!, 'utf8'));
  return readFile(config.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE, 'utf8');
};
const callTool = async (run: ControlledRun, tool: string, payload: Record<string, unknown>) =>
  bridgeApp.inject({ method: 'POST', url: `/api/bridge/${tool}`, headers: { 'x-motion-studio-bridge': await tokenOf(run) }, payload });
const stateOf = (id: string) => queue.list().find((j) => j.id === id)?.state;

beforeEach(() => { sent = []; children = []; previewAborts = 0; });
afterEach(async () => {
  await bridgeApp?.close();
  // Only this file's own children, and only if still alive (they should not be).
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

describe('Stop with a paid approval open (service level)', () => {
  it('the approval resolves as cancelled, no provider call starts, the job is cancelled and its session remembered', async () => {
    await setupService();
    const job = await service.start(ref, { text: 'Banner', pins: [] });
    const run = await runner.next(0);
    await vi.waitFor(() => expect(queue.list()[0]?.sessionId).toBe(run.sessionId));
    const call = callTool(run, 'generate_image', { prompt: 'Banner blu', width: 1024, height: 1024 });
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1), { timeout: 10_000 });
    expect(stopJob({ queue, approvals }, job.id)).toEqual({ status: 'stopping' });
    expect(approvals.pending()).toEqual([]);
    const res = await call;
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    await queue.whenIdle();
    expect(stateOf(job.id)).toBe('cancelled');
    expect(sent).toEqual([]);
    expect(run.cancelled).toBe(true);
    expect((await service.side.read(ref.projectDir, ref.creativeSlug)).stoppedSession).toMatchObject({ sessionId: run.sessionId, jobId: job.id });
    // Never in creative.json (agent-readable, committed): only in the core's side state (final review I1).
    expect((await store.get(ref.creativeSlug)).stoppedSession).toBeUndefined();
  });

  it('Stop still ends the job when the CLI never sends a result for an interrupted turn', async () => {
    await setupService({ live: true });
    const job = await service.start(ref, { text: 'Banner', pins: [] });
    const run = await runner.next(0);
    expect(run.req.capabilities).toEqual({ liveInput: true, interrupt: true });
    await vi.waitFor(() => expect(queue.list()[0]?.sessionId).toBe(run.sessionId));
    // The step is interrupted (acknowledged) and the redirect written, but the CLI never answers again.
    expect(await service.redirect(job.id, { clientId: cid(), text: 'Altro', pins: [] })).toEqual({ outcome: 'interrupted' });
    await new Promise((r) => setTimeout(r, 200));
    expect(stateOf(job.id)).toBe('running');
    expect(stopJob({ queue, approvals }, job.id)).toEqual({ status: 'stopping' });
    await queue.whenIdle();
    expect(stateOf(job.id)).toBe('cancelled');
    expect(run.cancelled).toBe(true);
  });
});

describe('Stop and redirect (service level)', () => {
  it('with a paid approval open (fallback path): the approval is cancelled first, no fetch, the run restarts in the same job resuming the live session', async () => {
    await setupService();
    const job = await service.start(ref, { text: 'Banner', pins: [] });
    const run = await runner.next(0);
    await vi.waitFor(() => expect(queue.list()[0]?.sessionId).toBe(run.sessionId));
    const call = callTool(run, 'generate_image', { prompt: 'Banner blu', width: 1024, height: 1024 });
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1), { timeout: 10_000 });
    const clientId = cid();
    const out = await service.redirect(job.id, { clientId, text: 'Niente immagini, solo testo', pins: [] });
    expect(out).toEqual({ outcome: 'restarted' });
    expect(approvals.pending()).toEqual([]);
    expect((await call).statusCode).toBeGreaterThanOrEqual(400);
    expect(sent).toEqual([]);
    expect(run.cancelled).toBe(true);
    const next = await runner.next(1);
    // Same job, same session (not a fork), the redirect text delimited as the user's words, the partial-files note.
    expect(stateOf(job.id)).toBe('running');
    expect(next.req.resumeSessionId).toBe(run.sessionId);
    expect(next.req.forkSession).toBeFalsy();
    expect(next.req.prompt).toContain(REDIRECT_PARTIAL_NOTE);
    expect(next.req.prompt).toContain(`${USER_REQUEST_OPEN}\nNiente immagini, solo testo`);
    next.finish();
    await queue.whenIdle();
    expect(stateOf(job.id)).toBe('succeeded');
    expect(await store.readVersions(ref.creativeSlug)).toHaveLength(1);
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.find((e) => e.type === 'user' && e.clientId === clientId)).toMatchObject({ mode: 'redirect', jobId: job.id });
    expect(conv.some((e) => e.type === 'agent' && e.event.kind === 'interrupted')).toBe(true);
    // The same clientId again (a double click, a retry): the same answer, nothing more.
    expect(await service.redirect(job.id, { clientId, text: 'Niente immagini, solo testo', pins: [] })).toEqual({ outcome: 'restarted' });
    expect(runner.runs).toHaveLength(2);
  });

  it('with a running preview render: its abort fires, its process is gone, the job goes on', async () => {
    await setupService({ contract: 'compositions' });
    const job = await service.start(ref, { text: 'Banner', pins: [] });
    const run = await runner.next(0);
    await vi.waitFor(() => expect(queue.list()[0]?.sessionId).toBe(run.sessionId));
    const call = callTool(run, 'preview_frames', { format: 'instagram-post-1x1', times: [0.5] });
    await vi.waitFor(() => expect(children).toHaveLength(1), { timeout: 10_000 });
    const pid = children[0]!.pid!;
    expect(await service.redirect(job.id, { clientId: cid(), text: 'Cambia colore', pins: [] })).toEqual({ outcome: 'restarted' });
    expect((await call).statusCode).toBeGreaterThanOrEqual(400);
    expect(previewAborts).toBe(1);
    expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(stateOf(job.id)).toBe('running');
    const next = await runner.next(1);
    expect(next.req.prompt).toContain('Cambia colore');
    expect(stopJob({ queue, approvals }, job.id)).toEqual({ status: 'stopping' });
    await queue.whenIdle();
    expect(stateOf(job.id)).toBe('cancelled');
  });

  it('with interrupt on: interrupts the step and writes the message into the same run (same job, no new run)', async () => {
    await setupService({ live: true });
    const job = await service.start(ref, { text: 'Banner', pins: [] });
    const run = await runner.next(0);
    await vi.waitFor(() => expect(queue.list()[0]?.sessionId).toBe(run.sessionId));
    const call = callTool(run, 'generate_image', { prompt: 'Banner blu', width: 1024, height: 1024 });
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1), { timeout: 10_000 });
    const clientId = cid();
    expect(await service.redirect(job.id, { clientId, text: 'Solo testo', pins: [] })).toEqual({ outcome: 'interrupted' });
    expect(approvals.pending()).toEqual([]);
    expect((await call).statusCode).toBeGreaterThanOrEqual(400);
    expect(sent).toEqual([]);
    expect(run.interrupts).toBe(1);
    expect(run.sent).toEqual([{ clientId, text: 'Solo testo' }]);
    expect(run.cancelled).toBe(false);
    run.finish();
    await queue.whenIdle();
    expect(runner.runs).toHaveLength(1);
    expect(stateOf(job.id)).toBe('succeeded');
  });

  it('with interrupt on but no acknowledgement: falls back to stop and resume', async () => {
    await setupService({ live: true });
    const job = await service.start(ref, { text: 'Banner', pins: [] });
    const run = await runner.next(0);
    await vi.waitFor(() => expect(queue.list()[0]?.sessionId).toBe(run.sessionId));
    runner.interruptAnswer = 'timeout';
    expect(await service.redirect(job.id, { clientId: cid(), text: 'Altro', pins: [] })).toEqual({ outcome: 'restarted' });
    const next = await runner.next(1);
    expect(next.req.resumeSessionId).toBe(run.sessionId);
    next.finish();
    await queue.whenIdle();
    expect(stateOf(job.id)).toBe('succeeded');
  });

  it('a repair attempt after a redirect carries the request and the redirect, in order', async () => {
    await setupService();
    const job = await service.start(ref, { text: 'Richiesta', pins: [] });
    const run = await runner.next(0);
    await vi.waitFor(() => expect(queue.list()[0]?.sessionId).toBe(run.sessionId));
    await service.redirect(job.id, { clientId: cid(), text: 'Nuova direzione', pins: [] });
    (await runner.next(1)).finish({ write: false });
    const fix = await runner.next(2);
    const p = fix.req.prompt;
    expect(p.indexOf('Richiesta')).toBeGreaterThan(0);
    expect(p.indexOf('Nuova direzione')).toBeGreaterThan(p.indexOf('Richiesta'));
    fix.finish();
    await queue.whenIdle();
    expect(stateOf(job.id)).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Route level: Stop and the remembered session, the resume-error fallback, redirect through the job routes.

let s: LiveApp;
afterEach(async () => { await s?.app.close(); });

describe('remembered session (routes)', () => {
  it('the remembered session is the base version\'s id, and it holds the stopped turn\'s messages (final wave P4)', async () => {
    s = await liveApp();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'PRIMO-TURNO' } });
    const v1 = await s.runner.next(0);
    v1.finish();
    await s.waitIdle();
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'TURNO-FERMATO' } })).json();
    const stoppedRun = await s.runner.next(1);
    // An iteration resumes the base session without a fork: Claude Code appends to it, the id stays (as the live check saw).
    expect(stoppedRun.req).toMatchObject({ resumeSessionId: v1.sessionId });
    expect(stoppedRun.req.forkSession).toBeFalsy();
    await vi.waitFor(async () => expect((await s.jobs()).find((j) => j.id === job.id)?.sessionId).toBe(stoppedRun.sessionId));
    await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/stop` });
    await s.waitIdle();
    const remembered = (await s.creative()).stoppedSession!;
    expect(remembered.sessionId).toBe(v1.sessionId);
    // That session holds the base turn's messages and then the stopped turn's.
    const held = s.runner.transcripts.get(remembered.sessionId)!.join('\n');
    expect(held).toContain('PRIMO-TURNO');
    expect(held).toContain('TURNO-FERMATO');
    expect(held.indexOf('PRIMO-TURNO')).toBeLessThan(held.indexOf('TURNO-FERMATO'));
    // The next turn forks it: the agent continues from the stopped turn's messages, in a new session.
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'DOPO-LO-STOP' } });
    const next = await s.runner.next(2);
    expect(next.req).toMatchObject({ resumeSessionId: v1.sessionId, forkSession: true });
    expect(next.sessionId).not.toBe(v1.sessionId);
    const forked = s.runner.transcripts.get(next.sessionId)!.join('\n');
    for (const w of ['PRIMO-TURNO', 'TURNO-FERMATO', 'DOPO-LO-STOP']) expect(forked).toContain(w);
    next.finish();
    await s.waitIdle();
  });

  it('Stop stores the session; the next turn resumes it as a fork with the note; a saved version clears it', async () => {
    s = await liveApp();
    let job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } })).json();
    (await s.runner.next(0)).finish();
    await s.waitIdle();
    job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Secondo' } })).json();
    const run = await s.runner.next(1);
    await vi.waitFor(async () => expect((await s.jobs()).find((j) => j.id === job.id)?.sessionId).toBe(run.sessionId));
    expect((await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/stop` })).json()).toEqual({ status: 'stopping' });
    await s.waitIdle();
    expect((await s.creative()).stoppedSession).toMatchObject({ sessionId: run.sessionId, jobId: job.id });
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Terzo' } });
    const resumed = await s.runner.next(2);
    expect(resumed.req.resumeSessionId).toBe(run.sessionId);
    expect(resumed.req.forkSession).toBe(true);
    expect(resumed.req.prompt).toContain(STOPPED_TURN_NOTE);
    resumed.finish();
    await s.waitIdle();
    expect((await s.creative()).stoppedSession).toBeUndefined();
    expect(await s.versions()).toHaveLength(2);
    // The next turn builds on the saved version's session (no note).
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Quarto' } });
    const after = await s.runner.next(3);
    expect(after.req.resumeSessionId).toBe(resumed.sessionId);
    expect(after.req.prompt).not.toContain(STOPPED_TURN_NOTE);
    after.finish();
    await s.waitIdle();
  });

  it('a remembered session Claude Code no longer has falls back to the last version\'s session with a note, never a failed turn', async () => {
    s = await liveApp();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    const v1 = await s.runner.next(0);
    v1.finish();
    await s.waitIdle();
    // A turn was stopped in a session Claude Code has since lost (e.g. its transcripts were cleared).
    await s.remember('gone-session');
    s.runner.missingSessions.add('gone-session');
    const next = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Secondo' } })).json();
    const failed = await s.runner.next(1);
    expect(failed.req).toMatchObject({ resumeSessionId: 'gone-session', forkSession: true });
    const fallback = await s.runner.next(2);
    expect(fallback.req.resumeSessionId).toBe(v1.sessionId);
    expect(fallback.req.forkSession).toBeFalsy();
    // Files in work/ may still be partial: the note stays.
    expect(fallback.req.prompt).toContain(STOPPED_TURN_NOTE);
    fallback.finish();
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === next.id)?.state).toBe('succeeded');
    expect((await s.conversation()).some((e) => e.type === 'system' && e.text === it_.stoppedSessionUnavailable)).toBe(true);
    expect((await s.creative()).stoppedSession).toBeUndefined();
    expect(await s.versions()).toHaveLength(2);
  });

  it('when the lost session is the last version\'s own, the turn starts a new session instead of failing', async () => {
    s = await liveApp();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    const v1 = await s.runner.next(0);
    v1.finish();
    await s.waitIdle();
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Secondo' } })).json();
    const stopped = await s.runner.next(1);
    await vi.waitFor(async () => expect((await s.jobs()).find((j) => j.id === job.id)?.sessionId).toBe(stopped.sessionId));
    await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/stop` });
    await s.waitIdle();
    // Resumed without a fork, the stopped turn's session is v1's: both are gone.
    expect(stopped.sessionId).toBe(v1.sessionId);
    s.runner.missingSessions.add(stopped.sessionId);
    const next = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Terzo' } })).json();
    const fresh = await s.runner.next(3);
    expect(fresh.req.resumeSessionId).toBeUndefined();
    fresh.finish();
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === next.id)?.state).toBe('succeeded');
  });

  it('redirect through the job route; brand-analysis-like jobs and unknown ones are refused', async () => {
    s = await liveApp();
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } })).json();
    const run = await s.runner.next(0);
    await vi.waitFor(async () => expect((await s.jobs()).find((j) => j.id === job.id)?.sessionId).toBe(run.sessionId));
    const res = await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text: 'Altra strada' } });
    expect(res.json()).toEqual({ outcome: 'restarted' });
    expect((await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text: 'x'.repeat(4001) } })).statusCode).toBe(409);
    const next = await s.runner.next(1);
    next.finish();
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.liveMessages).toBe(1);
    const late = await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text: 'Tardi' } });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toEqual({ code: 'not-running', error: it_.notRunning });
    expect((await s.app.inject({ method: 'POST', url: '/api/jobs/nope/redirect', payload: { clientId: cid(), text: 'x' } })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'POST', url: '/api/jobs/nope/stop' })).statusCode).toBe(404);
  });
});

describe('redirect when the live session cannot be resumed (fix round 1, C1)', () => {
  it('ends in exactly one fresh run from the base, with the request and the redirect, and no spawn loop', async () => {
    s = await liveApp();
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } })).json();
    const run = await s.runner.next(0);
    await vi.waitFor(async () => expect((await s.jobs()).find((j) => j.id === job.id)?.sessionId).toBe(run.sessionId));
    s.runner.missingSessions.add(run.sessionId);
    const res = await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text: 'Altra strada' } });
    expect(res.json()).toEqual({ outcome: 'restarted' });
    const fresh = await s.runner.next(2);
    expect(s.runner.runs[1]!.req.resumeSessionId).toBe(run.sessionId);
    // No base version yet: a new session, with the request and the redirect as the user's words.
    expect(fresh.req.resumeSessionId).toBeUndefined();
    expect(fresh.req.prompt).toContain('Primo');
    expect(fresh.req.prompt).toContain('Altra strada');
    await new Promise((r) => setTimeout(r, 500));
    expect(s.runner.runs).toHaveLength(3);
    fresh.finish();
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('succeeded');
    expect((await s.conversation()).filter((e) => e.type === 'system' && e.text === it_.stoppedSessionUnavailable)).toHaveLength(1);
  });

  it('with every start failing as well, the runs stay bounded and the turn fails', async () => {
    s = await liveApp();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    (await s.runner.next(0)).finish();
    await s.waitIdle();
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Secondo' } })).json();
    const run = await s.runner.next(1);
    await vi.waitFor(async () => expect((await s.jobs()).find((j) => j.id === job.id)?.sessionId).toBe(run.sessionId));
    // From now on every run fails before any output: resumes of the live session and of the base, and fresh ones.
    s.runner.missingSessions.add(run.sessionId);
    s.runner.failStart = () => ({ error: 'exit code 1' });
    for (const text of ['Uno', 'Due']) {
      const r = await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text } });
      expect([200, 409]).toContain(r.statusCode);
    }
    await s.waitIdle();
    await new Promise((r) => setTimeout(r, 300));
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('failed');
    // The first turn's run, this turn's run, then at most one redirect run and one fallback per redirect.
    expect(s.runner.runs.length).toBeLessThanOrEqual(5);
    expect((await s.conversation()).filter((e) => e.type === 'system' && e.text === it_.stoppedSessionUnavailable).length).toBeLessThanOrEqual(1);
  });
});

describe('resume-error detection (Ruling V)', () => {
  const setup = async () => {
    s = await liveApp();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    const v1 = await s.runner.next(0);
    v1.finish();
    await s.waitIdle();
    await s.remember('kept-session', 'old');
    return v1;
  };

  it('the CLI\'s session-not-found wording is matched (unverified live)', () => {
    expect(SESSION_NOT_FOUND.test('No conversation found with session ID: abc')).toBe(true);
    const none = { session: false, output: false };
    expect(resumeErrorOf({ status: 'failed', error: 'No conversation found with session ID: abc', startFailed: false }, { session: true, output: true })).toBe('not-found');
    expect(resumeErrorOf({ status: 'failed', error: 'exit code 1' }, none)).toBe('guess');
    expect(resumeErrorOf({ status: 'failed', error: 'exit code 1' }, { session: false, output: true })).toBeNull();
    expect(resumeErrorOf({ status: 'failed', error: 'exit code 1' }, { session: true, output: false })).toBeNull();
    expect(resumeErrorOf({ status: 'failed', error: 'claude not found', startFailed: true }, none)).toBeNull();
    expect(resumeErrorOf({ status: 'cancelled' }, none)).toBeNull();
  });

  it('the backup guess (failure before any session event and any output) falls back once but keeps the remembered session', async () => {
    const v1 = await setup();
    s.runner.failStart = (req) => (req.resumeSessionId === 'kept-session' ? { error: 'exit code 1' } : null);
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Secondo' } })).json();
    const fallback = await s.runner.next(2);
    expect(fallback.req.resumeSessionId).toBe(v1.sessionId);
    // The fallback run fails too (after writing): an ordinary failure, the remembered session stays.
    fallback.emit({ kind: 'text', text: 'lavoro' });
    fallback.finish({ ok: false, write: false, error: 'boom' });
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('failed');
    expect((await s.creative()).stoppedSession).toMatchObject({ sessionId: 'kept-session' });
  });

  it('a resumed run that reports its session and then fails before any text is an ordinary failure (Ruling X)', async () => {
    await setup();
    s.runner.failStart = (req) => (req.resumeSessionId === 'kept-session' ? { error: 'overloaded', session: true } : null);
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Secondo' } })).json();
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('failed');
    expect(s.runner.runs).toHaveLength(2);
    expect((await s.creative()).stoppedSession).toMatchObject({ sessionId: 'kept-session' });
    expect((await s.conversation()).some((e) => e.type === 'system' && e.text === it_.stoppedSessionUnavailable)).toBe(false);
  });

  it('a CLI that cannot start is an ordinary failure: no fallback, the remembered session stays', async () => {
    await setup();
    s.runner.failStart = () => ({ error: 'claude not found', startFailed: true });
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Secondo' } })).json();
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('failed');
    expect(s.runner.runs).toHaveLength(2);
    expect((await s.creative()).stoppedSession).toMatchObject({ sessionId: 'kept-session' });
    expect((await s.conversation()).some((e) => e.type === 'system' && e.text === it_.stoppedSessionUnavailable)).toBe(false);
  });

  it('a failure after the agent wrote something is an ordinary failure even when resuming', async () => {
    await setup();
    s.runner.failStart = () => ({ error: 'exit code 1', session: true, output: true });
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Secondo' } })).json();
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('failed');
    expect(s.runner.runs).toHaveLength(2);
    expect((await s.creative()).stoppedSession).toMatchObject({ sessionId: 'kept-session' });
  });
});

describe('two fast redirects and runs that never read their prompt (final wave P3: N4, N5)', () => {
  it('two redirects in a row both reach the agent, in order; the first never becomes an extra queued turn', async () => {
    s = await liveApp();
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } })).json();
    const run = await s.runner.next(0);
    await vi.waitFor(async () => expect((await s.jobs()).find((j) => j.id === job.id)?.sessionId).toBe(run.sessionId));
    const redirect = (text: string) => s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text } });
    const [a, b] = await Promise.all([redirect('PRIMA-DIREZIONE'), redirect('SECONDA-DIREZIONE')]);
    expect(a.json()).toEqual({ outcome: 'restarted' });
    expect(b.json()).toEqual({ outcome: 'restarted' });
    await vi.waitFor(() => expect(s.runner.runs.at(-1)!.cancelled).toBe(false));
    const last = s.runner.runs.at(-1)!;
    expect(last.req.prompt).toContain('PRIMA-DIREZIONE');
    expect(last.req.prompt).toContain('SECONDA-DIREZIONE');
    expect(last.req.prompt.indexOf('PRIMA-DIREZIONE')).toBeLessThan(last.req.prompt.indexOf('SECONDA-DIREZIONE'));
    last.finish();
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('succeeded');
    expect((await s.creative()).queued ?? []).toEqual([]);
    expect(s.runner.runs.filter((r) => !r.cancelled)).toHaveLength(1);
  });

  it('a redirect whose run is cut by a newer one before it reported its session is carried into the next prompt', async () => {
    s = await liveApp();
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } })).json();
    const run = await s.runner.next(0);
    await vi.waitFor(async () => expect((await s.jobs()).find((j) => j.id === job.id)?.sessionId).toBe(run.sessionId));
    // The run that takes the first redirect has not reported its session (it has not read its prompt) when the second comes.
    s.runner.quietStart = (req) => req.prompt.includes('UNO-NON-LETTO') && !req.prompt.includes('DUE-DOPO');
    const first = await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text: 'UNO-NON-LETTO' } });
    expect(first.json()).toEqual({ outcome: 'restarted' });
    const cut = await s.runner.next(1);
    expect(cut.req.resumeSessionId).toBe(run.sessionId);
    const second = await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text: 'DUE-DOPO' } });
    expect(second.json()).toEqual({ outcome: 'restarted' });
    expect(cut.cancelled).toBe(true);
    const next = await s.runner.next(2);
    // Same live session as before (the cut run's never counted), with both directions in order.
    expect(next.req.resumeSessionId).toBe(run.sessionId);
    expect(next.req.prompt).toContain('UNO-NON-LETTO');
    expect(next.req.prompt.indexOf('UNO-NON-LETTO')).toBeLessThan(next.req.prompt.indexOf('DUE-DOPO'));
    next.finish();
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('succeeded');
    expect((await s.creative()).queued ?? []).toEqual([]);
  });

  it('a redirect handed to runs that fail before reading it (a resume that fails) becomes the next request, shown as queued', async () => {
    s = await liveApp();
    await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Primo' } });
    (await s.runner.next(0)).finish();
    await s.waitIdle();
    const job = (await s.app.inject({ method: 'POST', url: `${s.url}/turns`, payload: { text: 'Secondo' } })).json();
    const run = await s.runner.next(1);
    await vi.waitFor(async () => expect((await s.jobs()).find((j) => j.id === job.id)?.sessionId).toBe(run.sessionId));
    // Every later run fails before it reports a session (the resume, then the fresh fallback from the base).
    s.runner.failStart = () => ({ error: 'exit code 1' });
    const clientId = cid();
    await s.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId, text: 'UNO-NON-LETTO' } });
    await s.waitIdle();
    expect((await s.jobs()).find((j) => j.id === job.id)?.state).toBe('failed');
    expect(s.runner.runs.length).toBeLessThanOrEqual(4);
    // Not lost and not shown as read: it waits in the queue (Ruling U: for Run next) under the same id.
    expect((await s.creative()).queued).toEqual([expect.objectContaining({ clientId, text: 'UNO-NON-LETTO' })]);
    await new Promise((r) => setTimeout(r, 200));
    expect(s.runner.runs.length).toBeLessThanOrEqual(4);
  });
});

describe('a redirect before the job starts (Ruling W)', () => {
  it('answers pending-start at once; the words join the first prompt and are marked delivered when it starts', async () => {
    await setupService();
    // One slot, busy with another creative's turn: ours waits in the job queue.
    queue.setConcurrency(1);
    const other = await store.create({ title: 'Altro', brief });
    const others = [await service.start({ ...ref, creativeSlug: other.slug }, { text: 'occupa', pins: [] })];
    await runner.next(0);
    const job = await service.start(ref, { text: 'Richiesta', pins: [] });
    expect(stateOf(job.id)).toBe('queued');
    const clientId = cid();
    const t0 = Date.now();
    expect(await service.redirect(job.id, { clientId, text: 'Cambia tutto', pins: [] })).toEqual({ outcome: 'pending-start' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(runner.runs).toHaveLength(1);
    // A slot frees: our turn starts with the request and the redirect, delimited as the user's words.
    runner.runs[0]!.finish();
    const ours = await runner.next(1);
    expect(ours.req.prompt).toContain('Richiesta');
    expect(ours.req.prompt).toContain(`${USER_REQUEST_OPEN}\nCambia tutto`);
    await vi.waitFor(async () => expect((await store.readConversation(ref.creativeSlug)).some((e) => e.type === 'agent' && e.event.kind === 'user_message_delivered' && e.event.clientId === clientId)).toBe(true));
    ours.finish();
    await queue.whenIdle();
    expect(stateOf(job.id)).toBe('succeeded');
    expect(others.every((o) => stateOf(o.id) === 'succeeded')).toBe(true);
  });
});

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { DEFAULT_FORMATS, explainTool, type AgentEvent, type ApprovalRequest, type Brief } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import type { AgentRunner } from '../src/agent/runner.ts';
import { ApprovalBroker, cleanAgentReason } from '../src/approvals/broker.ts';
import { AgentBridge, type BridgeContext } from '../src/bridge/bridge.ts';
import { registerBridgeRoutes } from '../src/bridge/bridge-routes.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { CreativeTurnService } from '../src/creatives/creative-turns.ts';
import { Git } from '../src/git.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';
import { testLauncher } from './helpers/launcher.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

let app: FastifyInstance;
let bridge: AgentBridge;
let approvals: ApprovalBroker;
let shown: ApprovalRequest[];
let events: AgentEvent[];
let projectDir: string;
let autoApprove: boolean;

const ctxBase = (over: Partial<BridgeContext> = {}): BridgeContext => ({
  jobId: 'j1', kind: 'creative', projectSlug: 'acme', projectDir, creativeSlug: 'c1', sandboxed: true,
  emit: (e) => events.push(e), signal: new AbortController().signal, ...over,
});

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ms-auto-'));
  bridge = new AgentBridge();
  shown = [];
  approvals = new ApprovalBroker({ broadcast: (m) => { if (m.type === 'approval') shown.push(m.approval); } });
  events = [];
  autoApprove = true;
  app = Fastify();
  registerBridgeRoutes(app, { bridge, approvals, settings: async () => ({ autoApproveSandboxed: autoApprove }) });
});
afterEach(async () => { await app.close(); approvals.cancelAll(); await rm(projectDir, { recursive: true, force: true }); });

const approve = (token: string, body: unknown) =>
  app.inject({ method: 'POST', url: '/api/bridge/approve', payload: body as object, headers: { 'x-motion-studio-bridge': token } });

/** Sends the prompt and reports whether it was auto-allowed (true) or reached the user (false, then denied). */
async function outcome(token: string, body: unknown): Promise<'auto' | 'asked'> {
  const before = shown.length;
  const res = approve(token, body);
  for (let i = 0; i < 50 && approvals.pending().length === 0; i++) {
    const done = await Promise.race([res.then(() => true), new Promise((r) => setTimeout(() => r(false), 5))]);
    if (done) break;
  }
  const pending = approvals.pending();
  if (pending.length) {
    expect(shown.length).toBe(before + 1);
    await approvals.decide(pending[0]!.id, 'deny');
    expect((await res).json().behavior).toBe('deny');
    return 'asked';
  }
  expect((await res).json()).toEqual({ behavior: 'allow', updatedInput: (body as { input: unknown }).input });
  expect(shown.length).toBe(before);
  return 'auto';
}

const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', input: { command, description: 'Lists files', ...extra }, tool_use_id: 't' });

describe('automatic approval in approve', () => {
  it('auto-allows Bash in a sandboxed job with the setting on, emits auto_approved, creates no approval', async () => {
    const token = bridge.register(ctxBase());
    expect(await outcome(token, bash('ls -la'))).toBe('auto');
    expect(approvals.pending()).toEqual([]);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev).toMatchObject({ kind: 'auto_approved', toolName: 'Bash', command: 'ls -la' });
    if (ev.kind !== 'auto_approved') throw new Error('unreachable');
    expect(ev.explanation).toEqual(explainTool('Bash', { command: 'ls -la', description: 'Lists files' }, {
      projectDir, workDir: join(projectDir, 'creatives', 'c1', 'work'), cwd: projectDir, home: homedir(), tmpDir: process.env.TMPDIR || tmpdir(),
    }));
    expect(ev.explanation.summary.length).toBeGreaterThan(0);
  });
  it('caps the command in the event at 2000 characters, with a marker', async () => {
    const token = bridge.register(ctxBase());
    const long = `echo ${'a'.repeat(5000)}`;
    expect(await outcome(token, bash(long))).toBe('auto');
    const ev = events[0]!;
    if (ev.kind !== 'auto_approved') throw new Error('unreachable');
    expect(ev.command).toHaveLength(2000);
    expect(ev.command.endsWith('\u2026')).toBe(true);
    expect(ev.command.startsWith('echo aaa')).toBe(true);
    expect(await outcome(token, bash('x'.repeat(2000)))).toBe('auto');
    expect((events[1] as { command: string }).command).toBe('x'.repeat(2000));
  });
  it('asks when the setting is off', async () => {
    autoApprove = false;
    const token = bridge.register(ctxBase());
    expect(await outcome(token, bash('ls'))).toBe('asked');
    expect(events).toEqual([]);
  });
  it('asks when the settings cannot be read', async () => {
    const app2 = Fastify();
    registerBridgeRoutes(app2, { bridge, approvals, settings: async () => { throw new Error('no workspace'); } });
    const token = bridge.register(ctxBase());
    const res = app2.inject({ method: 'POST', url: '/api/bridge/approve', payload: bash('ls'), headers: { 'x-motion-studio-bridge': token } });
    await new Promise((r) => setTimeout(r, 20));
    expect(approvals.pending()).toHaveLength(1);
    approvals.cancelAll();
    expect((await res).json().behavior).toBe('deny');
    await app2.close();
  });
  it('asks when the routes have no settings at all', async () => {
    const app2 = Fastify();
    registerBridgeRoutes(app2, { bridge, approvals });
    const token = bridge.register(ctxBase());
    const res = app2.inject({ method: 'POST', url: '/api/bridge/approve', payload: bash('ls'), headers: { 'x-motion-studio-bridge': token } });
    await new Promise((r) => setTimeout(r, 20));
    expect(approvals.pending()).toHaveLength(1);
    approvals.cancelAll();
    await res;
    await app2.close();
  });
  it('asks when the job is not sandboxed (sandboxMode off, or sandbox unavailable at launch)', async () => {
    const token = bridge.register(ctxBase({ sandboxed: false }));
    expect(await outcome(token, bash('ls'))).toBe('asked');
    expect(events).toEqual([]);
  });
  it('asks with dangerouslyDisableSandbox set to anything but false', async () => {
    const token = bridge.register(ctxBase());
    for (const v of [true, 'true', 1, 'yes', null, {}]) {
      expect(await outcome(token, bash('ls', { dangerouslyDisableSandbox: v })), String(v)).toBe('asked');
    }
    expect(await outcome(token, bash('ls', { dangerouslyDisableSandbox: false }))).toBe('auto');
  });
  it('asks for every other tool name, including look-alikes of Bash', async () => {
    const token = bridge.register(ctxBase());
    const names = ['bash', 'Bash ', ' Bash', 'BASH', 'Bash\u200B', 'B\u0430sh', 'Write', 'WebFetch', 'Read', 'mcp__evil__Bash', 'mcp__other__Bash', 'Bash(ls:*)'];
    for (const tool_name of names) {
      expect(await outcome(token, { tool_name, input: { command: 'ls', description: 'x' } }), tool_name).toBe('asked');
    }
    expect(events).toEqual([]);
  });
  it('never asks nor allows provider tools through approve', async () => {
    const token = bridge.register(ctxBase());
    const res = await approve(token, { tool_name: 'provider:openai-images', input: { command: 'ls' } });
    expect(res.json()).toEqual({ behavior: 'deny', message: 'Richiesta non valida.' });
    expect(events).toEqual([]);
  });
  it('never auto-allows for a job that has already ended', async () => {
    const ended = new AbortController();
    ended.abort();
    const token = bridge.register(ctxBase({ signal: ended.signal }));
    expect((await approve(token, bash('ls'))).json()).toEqual({ behavior: 'deny', message: 'Il lavoro è stato annullato.' });
    expect(events).toEqual([]);
  });
  it('asks when the command is not a string', async () => {
    const token = bridge.register(ctxBase());
    expect(await outcome(token, { tool_name: 'Bash', input: { command: ['ls'] } })).toBe('asked');
  });
  it('reads the setting on every call: turned off mid-job, the next call asks', async () => {
    const token = bridge.register(ctxBase());
    expect(await outcome(token, bash('ls'))).toBe('auto');
    autoApprove = false;
    expect(await outcome(token, bash('ls'))).toBe('asked');
    autoApprove = true;
    expect(await outcome(token, bash('ls'))).toBe('auto');
  });
  it('a forged registration or request body cannot flip sandboxed', async () => {
    const ctx = ctxBase({ sandboxed: false });
    const token = bridge.register(ctx);
    // Mutating the object handed to register() does not reach the stored context.
    (ctx as { sandboxed: boolean }).sandboxed = true;
    expect(bridge.resolve(token)!.sandboxed).toBe(false);
    expect(() => { (bridge.resolve(token) as { sandboxed: boolean }).sandboxed = true; }).toThrow(TypeError);
    // Nothing in the agent's request can claim a sandbox.
    expect(await outcome(token, { ...bash('ls'), sandboxed: true, sandbox: true, autoApproveSandboxed: true })).toBe('asked');
  });
});

describe('explained approval requests', () => {
  const base = () => ({ jobId: 'j1', projectSlug: 'acme', projectDir, creativeSlug: 'c1', kind: 'tool' as const });
  it('the request carries the explanation, computed with the job context, and the agent reason', async () => {
    const input = { command: 'rm -rf ~/Documents', description: '  Clean up old files  ' };
    void approvals.request({ ...base(), toolName: 'Bash', input });
    const [req] = approvals.pending();
    expect(req!.agentReason).toBe('Clean up old files');
    expect(req!.explanation).toEqual(explainTool('Bash', input, {
      projectDir, workDir: join(projectDir, 'creatives', 'c1', 'work'), cwd: projectDir, home: homedir(), tmpDir: process.env.TMPDIR || tmpdir(),
    }));
    expect(req!.explanation!.risk).toBe('high');
    // The title stays, for old clients.
    expect(req!.title).toBe('Eseguire un comando');
    expect(req!.detail).toBe('rm -rf ~/Documents');
  });
  it('without a creative there is no work folder', async () => {
    void approvals.request({ ...base(), creativeSlug: null, toolName: 'Write', input: { file_path: join(projectDir, 'a.txt') } });
    const [req] = approvals.pending();
    expect(req!.explanation).toEqual(explainTool('Write', { file_path: join(projectDir, 'a.txt') }, { projectDir, cwd: projectDir, home: homedir(), tmpDir: process.env.TMPDIR || tmpdir() }));
    expect(req!.agentReason).toBeNull();
  });
  it('provider requests carry no command explanation nor agent reason', async () => {
    void approvals.request({ ...base(), kind: 'provider', toolName: 'provider:openai-images', input: { description: 'x' }, title: 'Genera', detail: 'd' });
    const [req] = approvals.pending();
    expect(req).toMatchObject({ explanation: null, agentReason: null, title: 'Genera' });
  });
  it('agentReason: trimmed, control and bidi characters stripped, at most 300 characters, null when absent or blank', () => {
    expect(cleanAgentReason(undefined)).toBeNull();
    expect(cleanAgentReason(42)).toBeNull();
    expect(cleanAgentReason('')).toBeNull();
    expect(cleanAgentReason('  \n\t ')).toBeNull();
    expect(cleanAgentReason('\u202E\u2066\u200B\u0007')).toBeNull();
    expect(cleanAgentReason('  Render\u001b[31m\n 9:16 \u202Egnp.exe\u2066x\u2069 ')).toBe('Render[31m 9:16 gnp.exex');
    expect(cleanAgentReason('a\u200Bb\u061Cc\uFEFFd\u2028e\u2029f')).toBe('abcd e f');
    const long = cleanAgentReason('x'.repeat(5000))!;
    expect([...long]).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
    expect(cleanAgentReason('y'.repeat(300))).toBe('y'.repeat(300));
    // Truncation never splits a surrogate pair.
    const emoji = cleanAgentReason('😀'.repeat(400))!;
    expect([...emoji]).toHaveLength(300);
    expect(() => encodeURIComponent(emoji)).not.toThrow();
    expect(cleanAgentReason('a\uD800b\uDC00c')).toBe('abc');
  });
  it('agentReason cleaning is linear on hostile input', () => {
    const t0 = performance.now();
    cleanAgentReason(' \u202E'.repeat(10_000) + 'x' + '\t'.repeat(10_000));
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('auto_approved events follow the job event path', () => {
  it('creative: recorded in the conversation and broadcast', { timeout: 20_000 }, async () => {
    const base = await mkdtemp(join(tmpdir(), 'ms-auto-turn '));
    const git = new Git();
    const ws = await WorkspaceStore.open(join(base, 'ws'), git);
    const { slug } = await ws.createProject({ name: 'Acme' });
    const pDir = ws.projectDir(slug);
    const store = new CreativeStore(pDir);
    const brief: Brief = { goal: 'Lancio', message: '', formats: ['web-banner-300x250'], durationSec: 10, assets: [], notes: '' };
    const created = await store.create({ title: 'Lancio', brief });
    bridge.setOrigin('http://127.0.0.1:1');
    const inner = new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 });
    // Before running the fake agent, the "agent" asks the bridge to approve a command, like the studio MCP server does.
    const runner: AgentRunner = { start: (req, onEvent) => {
      const token = readFileSync(req.mcpConfigPath!.replace(/\.mcp\.json$/, '.token'), 'utf8');
      let cancel = () => {};
      const done = (async () => {
        await approve(token, bash('ls -la'));
        const run = inner.start(req, onEvent);
        cancel = run.cancel;
        return run.done;
      })();
      return { done, cancel: () => cancel() };
    } };
    const broadcast: unknown[] = [];
    const queue = new JobQueue({ concurrency: 1 });
    const service = new CreativeTurnService({
      queue, git, media: NoMediaTools, vault: new MemoryVault(),
      launcher: testLauncher(runner, { bridge, approvals, mcpCommand: ['node', '/x/server.mjs'], sandbox: async () => ({ available: true, reason: 'ok' }), settings: { sandboxMode: 'auto', autoApproveSandboxed: true } }),
      presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: (m) => broadcast.push(m),
    });
    process.env.FAKE_CLAUDE_SCENARIO = 'render';
    try {
      await service.start({ root: ws.root, projectSlug: slug, projectDir: pDir, creativeSlug: created.slug });
      await queue.whenIdle();
    } finally { delete process.env.FAKE_CLAUDE_SCENARIO; }
    const conv = await store.readConversation(created.slug);
    const auto = conv.find((e) => e.type === 'agent' && e.event.kind === 'auto_approved');
    expect(auto).toMatchObject({ type: 'agent', event: { kind: 'auto_approved', toolName: 'Bash', command: 'ls -la' } });
    expect(broadcast).toContainEqual(expect.objectContaining({ type: 'agent', event: expect.objectContaining({ kind: 'auto_approved' }) }));
    expect(approvals.pending()).toEqual([]);
    expect(shown).toEqual([]);
    await rm(base, { recursive: true, force: true });
  });
  it('the launcher registers the computed sandbox flag and the turn sink', async () => {
    const seen: (BridgeContext | null)[] = [];
    const b = new AgentBridge();
    b.setOrigin('http://127.0.0.1:1');
    const runner: AgentRunner = { start: (req) => {
      seen.push(b.resolve(readFileSync(req.mcpConfigPath!.replace(/\.mcp\.json$/, '.token'), 'utf8')));
      return { done: Promise.resolve({ status: 'succeeded' as const }), cancel: () => {} };
    } };
    const onEvent = () => {};
    const cases = [
      { sandbox: true, mode: 'auto' as const, expected: true },
      { sandbox: false, mode: 'auto' as const, expected: false },
      { sandbox: true, mode: 'off' as const, expected: false },
    ];
    for (const c of cases) {
      const l = testLauncher(runner, { bridge: b, mcpCommand: ['node', '/x'], sandbox: async () => ({ available: c.sandbox, reason: 'x' }), settings: { sandboxMode: c.mode, autoApproveSandboxed: true } });
      await (await l.start({ kind: 'brand-analysis', jobId: 'jx', projectSlug: 'acme', projectDir, request: { prompt: 'x' }, onEvent })).done;
    }
    expect(seen.map((s) => s?.sandboxed)).toEqual(cases.map((c) => c.expected));
    expect(seen.every((s) => s?.emit === onEvent)).toBe(true);
  });
});

import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { DEFAULT_FORMATS, explainTool, type AgentEvent, type ApprovalRequest, type Brief } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import type { AgentRunner } from '../src/agent/runner.ts';
import { ApprovalBroker, cleanAgentReason } from '../src/approvals/broker.ts';
import { displayTextWork } from '../src/display-text.ts';
import { AgentBridge, type BridgeContext } from '../src/bridge/bridge.ts';
import { AgentLauncher } from '../src/agent/launcher.ts';
import { workspaceSettingsSchema, type WorkspaceSettings } from '@motion-studio/shared';
import { mkdtempSync } from 'node:fs';
import { registerBridgeRoutes } from '../src/bridge/bridge-routes.ts';
import { claudeTmpRootFor } from '../src/bridge/claude-tmp.ts';
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
/** Stands in for Claude Code's per-uid temp root (/tmp/claude-<uid>) in these tests. */
let claudeRoot: string;
/** Resolved by the broker's broadcast: an approval reached the user. Re-armed after each one. */
let nextShown: Promise<void>;
let markShown: () => void;
/** Automatic approvals only: a request that reached the user also logs its decision (approval_decided). */
const autoEvents = () => events.filter((e) => e.kind === 'auto_approved');
const armShown = () => { nextShown = new Promise<void>((r) => { markShown = r; }); };

const ctxBase = (over: Partial<BridgeContext> = {}): BridgeContext => ({
  jobId: 'j1', kind: 'creative', projectSlug: 'acme', projectDir, creativeSlug: 'c1', sandboxed: true, autoApproveAtStart: true,
  emit: (e) => events.push(e), signal: new AbortController().signal, ...over,
});

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ms-auto-'));
  bridge = new AgentBridge();
  shown = [];
  armShown();
  approvals = new ApprovalBroker({ broadcast: (m) => { if (m.type === 'approval') { shown.push(m.approval); markShown(); armShown(); } } });
  events = [];
  autoApprove = true;
  claudeRoot = await mkdtemp(join(tmpdir(), 'ms-claude-root-'));
  await chmod(claudeRoot, 0o700);
  app = Fastify();
  registerBridgeRoutes(app, { bridge, approvals, settings: async () => ({ autoApproveSandboxed: autoApprove }), claudeTmpRoot: claudeRoot });
});
afterEach(async () => {
  await app.close(); approvals.cancelAll();
  await rm(projectDir, { recursive: true, force: true });
  await rm(claudeRoot, { recursive: true, force: true });
});

/** Settles when the request either finished or reached the user: no fixed time budget. */
const settled = (res: Promise<unknown>) => Promise.race([res.then(() => 'done' as const), nextShown.then(() => 'shown' as const)]);

const approve = (token: string, body: unknown) =>
  app.inject({ method: 'POST', url: '/api/bridge/approve', payload: body as object, headers: { 'x-motion-studio-bridge': token } });

/** Sends the prompt and reports whether it was auto-allowed (true) or reached the user (false, then denied). */
async function outcome(token: string, body: unknown): Promise<'auto' | 'asked'> {
  const before = shown.length;
  const res = approve(token, body);
  await settled(res);
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
    // tool_use_id links the event to the agent's tool_use (count work).
    expect(ev).toMatchObject({ kind: 'auto_approved', toolName: 'Bash', command: 'ls -la', toolUseId: 't' });
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
    expect(autoEvents()).toEqual([]);
  });
  it('asks when the settings cannot be read', async () => {
    const app2 = Fastify();
    registerBridgeRoutes(app2, { bridge, approvals, settings: async () => { throw new Error('no workspace'); } });
    const token = bridge.register(ctxBase());
    const res = app2.inject({ method: 'POST', url: '/api/bridge/approve', payload: bash('ls'), headers: { 'x-motion-studio-bridge': token } });
    expect(await settled(res)).toBe('shown');
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
    expect(await settled(res)).toBe('shown');
    expect(approvals.pending()).toHaveLength(1);
    approvals.cancelAll();
    await res;
    await app2.close();
  });
  it('asks when the job is not sandboxed (sandboxMode off, or sandbox unavailable at launch)', async () => {
    const token = bridge.register(ctxBase({ sandboxed: false }));
    expect(await outcome(token, bash('ls'))).toBe('asked');
    expect(autoEvents()).toEqual([]);
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
    expect(autoEvents()).toEqual([]);
  });
  it('never asks nor allows provider tools through approve', async () => {
    const token = bridge.register(ctxBase());
    const res = await approve(token, { tool_name: 'provider:openai-images', input: { command: 'ls' } });
    expect(res.json()).toEqual({ behavior: 'deny', message: 'Richiesta non valida.' });
    expect(autoEvents()).toEqual([]);
  });
  it('never auto-allows for a job that has already ended', async () => {
    const ended = new AbortController();
    ended.abort();
    const token = bridge.register(ctxBase({ signal: ended.signal }));
    expect((await approve(token, bash('ls'))).json()).toEqual({ behavior: 'deny', message: 'Il lavoro è stato annullato.' });
    expect(autoEvents()).toEqual([]);
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

describe('the setting must be on at job start AND now', () => {
  it('on at start, on now: auto-allows', async () => {
    const token = bridge.register(ctxBase({ autoApproveAtStart: true }));
    autoApprove = true;
    expect(await outcome(token, bash('ls'))).toBe('auto');
  });
  it('off at start, turned on mid-job: asks (the setting applies to new jobs)', async () => {
    const token = bridge.register(ctxBase({ autoApproveAtStart: false }));
    autoApprove = true;
    expect(await outcome(token, bash('ls'))).toBe('asked');
    expect(autoEvents()).toEqual([]);
  });
  it('on at start, turned off mid-job: asks at once', async () => {
    const token = bridge.register(ctxBase({ autoApproveAtStart: true }));
    autoApprove = false;
    expect(await outcome(token, bash('ls'))).toBe('asked');
  });
  it('a forged registration or request body cannot flip autoApproveAtStart', async () => {
    const ctx = ctxBase({ autoApproveAtStart: false });
    const token = bridge.register(ctx);
    (ctx as { autoApproveAtStart: boolean }).autoApproveAtStart = true;
    expect(bridge.resolve(token)!.autoApproveAtStart).toBe(false);
    expect(() => { (bridge.resolve(token) as { autoApproveAtStart: boolean }).autoApproveAtStart = true; }).toThrow(TypeError);
    // A non-boolean truthy value at registration does not count as on.
    const loose = bridge.register({ ...ctxBase(), autoApproveAtStart: 'true' as unknown as boolean });
    expect(bridge.resolve(loose)!.autoApproveAtStart).toBe(false);
    expect(await outcome(token, { ...bash('ls'), autoApproveAtStart: true })).toBe('asked');
    expect(await outcome(loose, bash('ls'))).toBe('asked');
  });
  it('end to end through the launcher: the value at launch is recorded, the current one is re-read', async () => {
    const live: WorkspaceSettings = workspaceSettingsSchema.parse({ schemaVersion: 1, sandboxMode: 'auto', autoApproveSandboxed: false });
    bridge.setOrigin('http://127.0.0.1:1');
    const tokens: string[] = [];
    const runner: AgentRunner = { start: (req) => {
      tokens.push(readFileSync(req.mcpConfigPath!.replace(/\.mcp\.json$/, '.token'), 'utf8'));
      return { done: new Promise(() => {}), cancel: () => {} };
    } };
    const launcher = new AgentLauncher({
      runner, bridge, approvals, sandbox: async () => ({ available: true, reason: 'ok' }), settings: async () => live,
      configDir: mkdtempSync(join(tmpdir(), 'ms-cfg-')), mcpCommand: ['node', '/x/server.mjs'],
    });
    const app2 = Fastify();
    registerBridgeRoutes(app2, { bridge, approvals, settings: async () => live });
    const ask = async (token: string) => {
      const res = app2.inject({ method: 'POST', url: '/api/bridge/approve', payload: bash('ls'), headers: { 'x-motion-studio-bridge': token } });
      await settled(res);
      const p = approvals.pending()[0];
      if (p) { await approvals.decide(p.id, 'deny'); await res; return 'asked'; }
      return (await res).json().behavior === 'allow' ? 'auto' : 'denied';
    };
    const runOff = await launcher.start({ kind: 'creative', jobId: 'joff', projectSlug: 'acme', projectDir, request: { prompt: 'x' }, onEvent: () => {} });
    live.autoApproveSandboxed = true; // turned on while the first job runs
    const runOn = await launcher.start({ kind: 'creative', jobId: 'jon', projectSlug: 'acme', projectDir, request: { prompt: 'x' }, onEvent: () => {} });
    expect(bridge.resolve(tokens[0])!.autoApproveAtStart).toBe(false);
    expect(bridge.resolve(tokens[1])!.autoApproveAtStart).toBe(true);
    expect(await ask(tokens[0]!)).toBe('asked');
    expect(await ask(tokens[1]!)).toBe('auto');
    live.autoApproveSandboxed = false; // turned off while the second job runs
    expect(await ask(tokens[1]!)).toBe('asked');
    runOff.cancel(); runOn.cancel();
    await app2.close();
  });
});

describe('LaunchInput.sandboxed can only downgrade', () => {
  const capture = () => {
    const b = new AgentBridge();
    b.setOrigin('http://127.0.0.1:1');
    const seen: { ctx: BridgeContext | null; settings: unknown; env: Record<string, string> | undefined }[] = [];
    const runner: AgentRunner = { start: (req) => {
      seen.push({ ctx: b.resolve(readFileSync(req.mcpConfigPath!.replace(/\.mcp\.json$/, '.token'), 'utf8')), settings: req.settings, env: req.env });
      return { done: Promise.resolve({ status: 'succeeded' as const }), cancel: () => {} };
    } };
    return { b, seen, runner };
  };
  it('sandboxed: true while the sandbox is unavailable (or off) runs unsandboxed: no sandbox settings, no cache env', async () => {
    for (const [available, mode] of [[false, 'auto'], [true, 'off']] as const) {
      const { b, seen, runner } = capture();
      const l = testLauncher(runner, { bridge: b, mcpCommand: ['node', '/x'], sandbox: async () => ({ available, reason: 'x' }), settings: { sandboxMode: mode, autoApproveSandboxed: true } });
      // What callers must put in the prompt: the launcher's own decision.
      expect(await l.sandboxed()).toBe(false);
      await (await l.start({ kind: 'creative', jobId: 'jd', projectSlug: 'acme', projectDir, request: { prompt: 'x' }, onEvent: () => {}, sandboxed: true })).done;
      expect(seen[0]!.ctx!.sandboxed).toBe(false);
      expect(seen[0]!.settings).toBeUndefined();
      expect(seen[0]!.env).toEqual({ MCP_TOOL_TIMEOUT: '900000' });
    }
  });
  it('sandboxed: false while the sandbox is available downgrades the job', async () => {
    const { b, seen, runner } = capture();
    const l = testLauncher(runner, { bridge: b, mcpCommand: ['node', '/x'], sandbox: async () => ({ available: true, reason: 'ok' }), settings: { sandboxMode: 'auto', autoApproveSandboxed: true } });
    await (await l.start({ kind: 'creative', jobId: 'jd', projectSlug: 'acme', projectDir, request: { prompt: 'x' }, onEvent: () => {}, sandboxed: false })).done;
    expect(seen[0]!.ctx!.sandboxed).toBe(false);
    expect(seen[0]!.settings).toBeUndefined();
    await (await l.start({ kind: 'creative', jobId: 'je', projectSlug: 'acme', projectDir, request: { prompt: 'x' }, onEvent: () => {}, sandboxed: true })).done;
    expect(seen[1]!.ctx!.sandboxed).toBe(true);
    expect(seen[1]!.settings).toBeDefined();
  });
});

describe('explained approval requests', () => {
  const base = () => ({ jobId: 'j1', projectSlug: 'acme', projectDir, creativeSlug: 'c1', kind: 'tool' as const });
  it('the request carries the explanation, computed with the job context, and the agent reason', async () => {
    // A home outside the temp folder, as on a real machine (the test isolation puts HOME under the OS temp folder, which
    // the explainer treats as scratch space).
    vi.stubEnv('HOME', '/Users/ms-fake-home-for-test');
    onTestFinished(() => { vi.unstubAllEnvs(); });
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
  it('agentReason cleaning is linear on hostile input: doubling the input at most doubles the work', () => {
    const at = (n: number) => {
      const input = ' \u202E'.repeat(n) + 'x' + '\t\u200B'.repeat(n);
      displayTextWork.reset();
      cleanAgentReason(input);
      return displayTextWork.get();
    };
    expect(at(10_000)).toBeGreaterThan(0);
    expect(at(20_000)).toBeLessThanOrEqual(at(10_000) * 2 + 1);
    expect(at(10_000)).toBeLessThanOrEqual(4 * (2 * 10_000 + 1 + 2 * 10_000));
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
    expect(seen.map((s) => s?.autoApproveAtStart)).toEqual(cases.map(() => true));
    expect(seen.every((s) => s?.emit === onEvent)).toBe(true);
  });
});

describe('automatic approval of Read under Claude Code\'s own temp root', () => {
  const read = (file_path: unknown) => ({ tool_name: 'Read', input: { file_path }, tool_use_id: 't' });
  const frame = async (rel = 'frame.png') => { const p = join(claudeRoot, rel); await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, 'png'); return p; };

  it('auto-allows a file inside the root and emits auto_approved with an explanation', async () => {
    const p = await frame('sess/tmp/frame.png');
    const token = bridge.register(ctxBase());
    expect(await outcome(token, read(p))).toBe('auto');
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev).toMatchObject({ kind: 'auto_approved', toolName: 'Read', command: p });
    if (ev.kind !== 'auto_approved') throw new Error('unreachable');
    expect(ev.explanation.summary.length).toBeGreaterThan(0);
  });
  it('accepts the root spelled through its real path too (/tmp vs /private/tmp)', async () => {
    const p = await frame();
    const token = bridge.register(ctxBase());
    expect(await outcome(token, read(join(await realpath(claudeRoot), 'frame.png')))).toBe('auto');
    expect(await outcome(token, read(p))).toBe('auto');
  });
  it('asks for a file outside the root, including elsewhere in $TMPDIR', async () => {
    const other = await mkdtemp(join(tmpdir(), 'ms-other-'));
    await writeFile(join(other, 'f.png'), 'x');
    await writeFile(join(projectDir, 'p.png'), 'x');
    const token = bridge.register(ctxBase());
    try {
      expect(await outcome(token, read(join(other, 'f.png')))).toBe('asked');
      expect(await outcome(token, read(join(projectDir, 'p.png')))).toBe('asked');
      // A sibling whose name only starts like the root.
      await mkdir(`${claudeRoot}x`, { recursive: true });
      await writeFile(join(`${claudeRoot}x`, 'f.png'), 'x');
      expect(await outcome(token, read(join(`${claudeRoot}x`, 'f.png')))).toBe('asked');
      expect(await outcome(token, read(join(claudeRoot, '..', 'ms-other-x', 'f.png')))).toBe('asked');
      expect(await outcome(token, read(join(claudeRoot, '..', other.split('/').pop()!, 'f.png')))).toBe('asked');
    } finally {
      await rm(other, { recursive: true, force: true });
      await rm(`${claudeRoot}x`, { recursive: true, force: true });
    }
    expect(autoEvents()).toEqual([]);
  });
  it('asks when a symlink inside the root escapes it (file or folder)', async () => {
    const other = await mkdtemp(join(tmpdir(), 'ms-secret-'));
    await writeFile(join(other, 'secret.txt'), 'x');
    await symlink(join(other, 'secret.txt'), join(claudeRoot, 'link.png'));
    await symlink(other, join(claudeRoot, 'dir'));
    const token = bridge.register(ctxBase());
    try {
      expect(await outcome(token, read(join(claudeRoot, 'link.png')))).toBe('asked');
      expect(await outcome(token, read(join(claudeRoot, 'dir', 'secret.txt')))).toBe('asked');
    } finally { await rm(other, { recursive: true, force: true }); }
    expect(autoEvents()).toEqual([]);
  });
  it('asks for a path written outside the root even when it links into it', async () => {
    const p = await frame();
    await symlink(p, join(projectDir, 'in.png'));
    expect(await outcome(bridge.register(ctxBase()), read(join(projectDir, 'in.png')))).toBe('asked');
  });
  it('asks for a missing file, a folder, a relative or non-string path', async () => {
    await mkdir(join(claudeRoot, 'd'));
    const token = bridge.register(ctxBase());
    for (const p of [join(claudeRoot, 'missing.png'), join(claudeRoot, 'd'), claudeRoot, 'frame.png', '', 42, null, [join(claudeRoot, 'x')]]) {
      expect(await outcome(token, read(p)), String(p)).toBe('asked');
    }
    expect(autoEvents()).toEqual([]);
  });
  it('asks with the setting off now, off at job start, or in an unsandboxed job', async () => {
    const p = await frame();
    autoApprove = false;
    expect(await outcome(bridge.register(ctxBase()), read(p))).toBe('asked');
    autoApprove = true;
    expect(await outcome(bridge.register(ctxBase({ autoApproveAtStart: false })), read(p))).toBe('asked');
    expect(await outcome(bridge.register(ctxBase({ sandboxed: false })), read(p))).toBe('asked');
    expect(autoEvents()).toEqual([]);
  });
  it('asks when the root is shared with other users (group or world writable)', async () => {
    const p = await frame();
    await chmod(claudeRoot, 0o777);
    expect(await outcome(bridge.register(ctxBase()), read(p))).toBe('asked');
  });
  it('asks when there is no root (no uid, e.g. Windows) or other Read-like tools', async () => {
    const p = await frame();
    const app2 = Fastify();
    registerBridgeRoutes(app2, { bridge, approvals, settings: async () => ({ autoApproveSandboxed: true }), claudeTmpRoot: null });
    const token = bridge.register(ctxBase());
    const res = app2.inject({ method: 'POST', url: '/api/bridge/approve', payload: read(p), headers: { 'x-motion-studio-bridge': token } });
    expect(await settled(res)).toBe('shown');
    approvals.cancelAll();
    await res;
    await app2.close();
    for (const tool_name of ['read', 'Read ', 'Glob', 'Grep', 'NotebookRead', 'Write', 'Edit']) {
      expect(await outcome(token, { tool_name, input: { file_path: p } }), tool_name).toBe('asked');
    }
    expect(autoEvents()).toEqual([]);
  });
});

describe('claudeTmpRootFor (Claude Code 2.1.x: join(CLAUDE_CODE_TMPDIR || "/tmp", "claude-<uid>"))', () => {
  it('defaults to /tmp/claude-<uid>', () => {
    expect(claudeTmpRootFor({}, 501)).toBe('/tmp/claude-501');
    expect(claudeTmpRootFor({ CLAUDE_CODE_TMPDIR: '' }, 0)).toBe('/tmp/claude-0');
  });
  it('follows CLAUDE_CODE_TMPDIR when absolute, never $TMPDIR', () => {
    expect(claudeTmpRootFor({ CLAUDE_CODE_TMPDIR: '/x/y/' }, 501)).toBe('/x/y/claude-501');
    expect(claudeTmpRootFor({ TMPDIR: '/var/folders/zz/T/' }, 501)).toBe('/tmp/claude-501');
  });
  it('is null without a uid or with a relative override', () => {
    expect(claudeTmpRootFor({}, undefined)).toBeNull();
    expect(claudeTmpRootFor({ CLAUDE_CODE_TMPDIR: 'rel/dir' }, 501)).toBeNull();
  });
});

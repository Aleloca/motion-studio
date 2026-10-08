import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@motion-studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildClaudeArgs, claudeCommandFromEnv, ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AGENT_ALLOWED_TOOLS } from '../src/agent/runner.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const runner = (opts: { drainMs?: number } = {}) => new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200, ...opts });

// Every spawned fake records its pid; afterEach kills its whole process group even if the test failed.
const argsFiles: string[] = [];

async function run(
  scenario: string,
  prompt = 'ciao',
  extra: Partial<Parameters<ClaudeCodeRunner['start']>[0]> = {},
  opts: { drainMs?: number; onEvent?: (e: AgentEvent) => void } = {},
) {
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  if (!process.env.FAKE_CLAUDE_ARGS_FILE) process.env.FAKE_CLAUDE_ARGS_FILE = join(await mkdtemp(join(tmpdir(), 'ms-args-')), 'args.json');
  const argsFile = process.env.FAKE_CLAUDE_ARGS_FILE;
  argsFiles.push(argsFile);
  const cwd = await mkdtemp(join(tmpdir(), 'ms run è '));
  const events: AgentEvent[] = [];
  const handle = runner(opts).start({ cwd, prompt, ...extra }, opts.onEvent ?? ((e) => events.push(e)));
  const leaderPid = async () => (JSON.parse(await readFile(argsFile, 'utf8')) as { pid: number }).pid;
  return { handle, events, cwd, leaderPid };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function grandchildPid(events: AgentEvent[]): number | undefined {
  for (const e of events) {
    const m = e.kind === 'stderr' ? /^grandchild-pid: (\d+)$/.exec(e.text) : null;
    if (m) return Number(m[1]);
  }
  return undefined;
}

afterEach(async () => {
  for (const f of argsFiles.splice(0)) {
    const pid = await readFile(f, 'utf8').then((t) => (JSON.parse(t) as { pid: number }).pid, () => undefined);
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
  delete process.env.FAKE_CLAUDE_SCENARIO;
  delete process.env.FAKE_CLAUDE_ARGS_FILE;
  delete process.env.MOTION_STUDIO_CLAUDE_COMMAND;
});

describe('buildClaudeArgs', () => {
  it('builds headless stream-json args with optional flags', () => {
    expect(buildClaudeArgs({ cwd: '/x', prompt: 'p' })).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    ]);
    expect(buildClaudeArgs({ cwd: '/x', prompt: 'p', resumeSessionId: 's1', addDirs: ['/a b', '/c'], model: 'sonnet', settings: { a: 1 }, mcpConfigPath: '/cfg/run/j1.mcp.json' })).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
      '--resume', 's1', '--add-dir', '/a b', '--add-dir', '/c', '--model', 'sonnet',
      '--settings', '{"a":1}', '--strict-mcp-config', '--mcp-config', '/cfg/run/j1.mcp.json',
    ]);
  });
  it('passes settings, the MCP config file (never inline JSON) and the permission prompt tool', () => {
    const args = buildClaudeArgs({ cwd: '/x', prompt: 'p', settings: { sandbox: { enabled: true } }, mcpConfigPath: '/cfg/run/j1.mcp.json', permissionPromptTool: 'mcp__studio__approve' });
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--settings') + 1]).toBe('{"sandbox":{"enabled":true}}');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/cfg/run/j1.mcp.json');
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__studio__approve');
    expect(args).not.toContain('--permission-prompts');
  });
  it('keeps --permission-prompts none without a prompt tool', () => {
    const args = buildClaudeArgs({ cwd: '/x', prompt: 'p' });
    expect(args.slice(args.indexOf('--permission-prompts'), args.indexOf('--permission-prompts') + 2)).toEqual(['--permission-prompts', 'none']);
  });
  it('adds --fork-session right after --resume, only when resuming', () => {
    const args = buildClaudeArgs({ cwd: '/x', prompt: 'p', resumeSessionId: 's1', forkSession: true });
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 3)).toEqual(['--resume', 's1', '--fork-session']);
    expect(buildClaudeArgs({ cwd: '/x', prompt: 'p', forkSession: true })).not.toContain('--fork-session');
  });
  it('passes allowed tool rules as the last, variadic --allowedTools flag', () => {
    const args = buildClaudeArgs({ cwd: '/x', prompt: 'p', model: 'sonnet', resumeSessionId: 's1', allowedTools: ['Bash(node:*)', 'Bash(ffmpeg:*)'] });
    expect(args.slice(-3)).toEqual(['--allowedTools', 'Bash(node:*)', 'Bash(ffmpeg:*)']);
    expect(args.filter((a) => a === '--allowedTools')).toHaveLength(1);
    expect(args).toContain('--permission-prompts');
    expect(buildClaudeArgs({ cwd: '/x', prompt: 'p' })).not.toContain('--allowedTools');
    expect(buildClaudeArgs({ cwd: '/x', prompt: 'p', allowedTools: [] })).not.toContain('--allowedTools');
  });
  it('puts deny rules before the allow group', () => {
    const args = buildClaudeArgs({ cwd: '/x', prompt: 'p', addDirs: ['/a b'], disallowedTools: ['Edit(//a b/**)'], allowedTools: ['Bash(node:*)'] });
    expect(args.slice(-4)).toEqual(['--disallowedTools', 'Edit(//a b/**)', '--allowedTools', 'Bash(node:*)']);
    expect(args).toContain('--add-dir');
  });
});

describe('AGENT_ALLOWED_TOOLS', () => {
  it('lists the local interpreters, package managers and media tools of spec §6.3', () => {
    expect(AGENT_ALLOWED_TOOLS).toEqual(['Bash(ffmpeg:*)', 'Bash(ffprobe:*)', 'Bash(node:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(pnpm:*)',
      'Bash(python3:*)', 'Bash(pip:*)', 'Bash(pip3:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)']);
  });
});

describe('claudeCommandFromEnv', () => {
  it('defaults to ["claude"] and parses a JSON array override', () => {
    delete process.env.MOTION_STUDIO_CLAUDE_COMMAND;
    expect(claudeCommandFromEnv()).toEqual(['claude']);
    process.env.MOTION_STUDIO_CLAUDE_COMMAND = '["node","/fake.mjs"]';
    expect(claudeCommandFromEnv()).toEqual(['node', '/fake.mjs']);
    delete process.env.MOTION_STUDIO_CLAUDE_COMMAND;
  });
  it('names the variable when the override is not valid JSON or has the wrong shape', () => {
    process.env.MOTION_STUDIO_CLAUDE_COMMAND = '[node';
    expect(() => claudeCommandFromEnv()).toThrow(/MOTION_STUDIO_CLAUDE_COMMAND/);
    process.env.MOTION_STUDIO_CLAUDE_COMMAND = '{"cmd":"node"}';
    expect(() => claudeCommandFromEnv()).toThrow(/MOTION_STUDIO_CLAUDE_COMMAND/);
    process.env.MOTION_STUDIO_CLAUDE_COMMAND = '[]';
    expect(() => claudeCommandFromEnv()).toThrow(/MOTION_STUDIO_CLAUDE_COMMAND/);
  });
});

describe('ClaudeCodeRunner', () => {
  it('streams events (including a line split across chunks) and succeeds', async () => {
    const { handle, events } = await run('ok', 'ciao mondo');
    await expect(handle.done).resolves.toEqual({ status: 'succeeded', sessionId: 'fake-session-1' });
    expect(events.map((e) => e.kind)).toEqual(['session', 'text', 'result']);
    expect(events[1]).toEqual({ kind: 'text', text: 'echo: ciao mondo' });
  });
  it('runs in the requested cwd (with spaces) and passes resume', async () => {
    const { handle, cwd } = await run('ok', 'x', { resumeSessionId: 'abc' });
    await expect(handle.done).resolves.toMatchObject({ status: 'succeeded', sessionId: 'abc' });
    const recorded = JSON.parse(await readFile(process.env.FAKE_CLAUDE_ARGS_FILE!, 'utf8'));
    expect(recorded.args).toContain('--resume');
    expect(await import('node:fs/promises').then((f) => f.realpath(recorded.cwd))).toBe(await import('node:fs/promises').then((f) => f.realpath(cwd)));
  });
  it('emits parse_error for garbage and still succeeds', async () => {
    const { handle, events } = await run('garbage');
    await expect(handle.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(events.some((e) => e.kind === 'parse_error')).toBe(true);
  });
  it('fails with the stderr tail when the process exits without a result', async () => {
    const { handle, events } = await run('crash');
    const res = await handle.done;
    expect(res.status).toBe('failed');
    expect(res.error).toContain('codice 2');
    expect(res.error).toContain('boom: something failed');
    expect(events).toContainEqual({ kind: 'stderr', text: 'boom: something failed' });
  });
  it('fails with the result error text on an error result', async () => {
    const { handle } = await run('error_result');
    await expect(handle.done).resolves.toMatchObject({ status: 'failed', error: 'Usage limit reached', sessionId: 'fake-session-1' });
  });
  it('cancels a hanging process and reports cancelled, killing its descendants', async () => {
    const { handle, events } = await run('hang');
    await vi.waitFor(() => expect(grandchildPid(events)).toBeDefined());
    expect(events[0]?.kind).toBe('session');
    handle.cancel();
    await expect(handle.done).resolves.toMatchObject({ status: 'cancelled' });
    await vi.waitFor(() => expect(alive(grandchildPid(events)!)).toBe(false));
  });
  it('cancel reaches the whole process group and does not wait for descendants holding the pipes', async () => {
    const { handle } = await run('hang');
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    handle.cancel();
    await expect(handle.done).resolves.toMatchObject({ status: 'cancelled' });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const { handle, events, leaderPid } = await run('hang_ignore_term');
    await vi.waitFor(() => expect(events[0]?.kind).toBe('session'));
    const pid = await leaderPid();
    handle.cancel();
    await expect(handle.done).resolves.toMatchObject({ status: 'cancelled' });
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });
  it('resolves after a short drain when a descendant keeps the pipes open after claude exits', async () => {
    const { handle, events } = await run('leak_fd', 'x', {}, { drainMs: 200 });
    const t0 = Date.now();
    await expect(handle.done).resolves.toEqual({ status: 'succeeded', sessionId: 'fake-session-1' });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(events.some((e) => e.kind === 'result')).toBe(true);
    expect(alive(grandchildPid(events)!)).toBe(true); // nobody cancelled: the descendant is left alone (afterEach cleans it)
  });
  it('cancel after claude exited still reaches the process group, resolves promptly and keeps the ok result', async () => {
    const { handle, events, leaderPid } = await run('leak_fd', 'x', {}, { drainMs: 60_000 });
    await vi.waitFor(() => expect(grandchildPid(events)).toBeDefined());
    const pid = await leaderPid();
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    const t0 = Date.now();
    handle.cancel();
    await expect(handle.done).resolves.toEqual({ status: 'succeeded', sessionId: 'fake-session-1' });
    expect(Date.now() - t0).toBeLessThan(2000);
    await vi.waitFor(() => expect(alive(grandchildPid(events)!)).toBe(false));
  });
  it('passes extra environment variables to claude', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-env-'));
    const argsFile = join(dir, 'args.json');
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    const { handle } = await run('ok', 'x', { env: { MS_TEST_ENV: 'ciao' } });
    await handle.done;
    expect(JSON.parse(await readFile(argsFile, 'utf8')).env).toBe('ciao');
    await rm(dir, { recursive: true, force: true });
  });
  it('survives a throwing event listener', async () => {
    const { handle } = await run('ok', 'x', {}, { onEvent: () => { throw new Error('listener boom'); } });
    await expect(handle.done).resolves.toMatchObject({ status: 'succeeded' });
  });
  it('reports a missing project folder without spawning', async () => {
    const res = await runner().start({ cwd: join(tmpdir(), 'ms-does-not-exist-xyz'), prompt: 'x' }, () => {}).done;
    expect(res).toEqual({ status: 'failed', error: `Cartella del progetto non trovata: ${join(tmpdir(), 'ms-does-not-exist-xyz')}` });
  });
  it('fails clearly when the claude binary does not exist', async () => {
    const r = new ClaudeCodeRunner(['definitely-not-claude-ms']);
    const res = await r.start({ cwd: tmpdir(), prompt: 'x' }, () => {}).done;
    expect(res).toEqual({ status: 'failed', error: 'Comando claude non trovato (definitely-not-claude-ms). Installa Claude Code o controlla il Doctor.' });
  });
});

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@motion-studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeArgs, claudeCommandFromEnv, ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const runner = () => new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 });

async function run(scenario: string, prompt = 'ciao', extra: Partial<Parameters<ClaudeCodeRunner['start']>[0]> = {}) {
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  const cwd = await mkdtemp(join(tmpdir(), 'ms run è '));
  const events: AgentEvent[] = [];
  const handle = runner().start({ cwd, prompt, ...extra }, (e) => events.push(e));
  return { handle, events, cwd };
}

afterEach(() => { delete process.env.FAKE_CLAUDE_SCENARIO; delete process.env.FAKE_CLAUDE_ARGS_FILE; });

describe('buildClaudeArgs', () => {
  it('builds headless stream-json args with optional flags', () => {
    expect(buildClaudeArgs({ cwd: '/x', prompt: 'p' })).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    ]);
    expect(buildClaudeArgs({ cwd: '/x', prompt: 'p', resumeSessionId: 's1', addDirs: ['/a b', '/c'], model: 'sonnet', mcpConfigPath: '/m.json' })).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
      '--resume', 's1', '--add-dir', '/a b', '--add-dir', '/c', '--model', 'sonnet', '--mcp-config', '/m.json',
    ]);
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
});

describe('ClaudeCodeRunner', () => {
  it('streams events (including a line split across chunks) and succeeds', async () => {
    const { handle, events } = await run('ok', 'ciao mondo');
    await expect(handle.done).resolves.toEqual({ status: 'succeeded', sessionId: 'fake-session-1' });
    expect(events.map((e) => e.kind)).toEqual(['session', 'text', 'result']);
    expect(events[1]).toEqual({ kind: 'text', text: 'echo: ciao mondo' });
  });
  it('runs in the requested cwd (with spaces) and passes resume', async () => {
    const argsFile = join(await mkdtemp(join(tmpdir(), 'ms-args-')), 'args.json');
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    const { handle, cwd } = await run('ok', 'x', { resumeSessionId: 'abc' });
    await expect(handle.done).resolves.toMatchObject({ status: 'succeeded', sessionId: 'abc' });
    const recorded = JSON.parse(await readFile(argsFile, 'utf8'));
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
  it('cancels a hanging process and reports cancelled', async () => {
    const { handle, events } = await run('hang');
    await new Promise((r) => setTimeout(r, 300));
    expect(events[0]?.kind).toBe('session');
    handle.cancel();
    await expect(handle.done).resolves.toMatchObject({ status: 'cancelled' });
  });
  it('fails clearly when the claude binary does not exist', async () => {
    const r = new ClaudeCodeRunner(['definitely-not-claude-ms']);
    const res = await r.start({ cwd: tmpdir(), prompt: 'x' }, () => {}).done;
    expect(res).toEqual({ status: 'failed', error: 'Comando claude non trovato (definitely-not-claude-ms). Installa Claude Code o controlla il Doctor.' });
  });
});

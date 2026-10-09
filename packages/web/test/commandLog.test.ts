import { classifyPath, type AgentEvent } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { commandLog, webExplainContext } from '../src/components/commandLog.ts';

const ctx = webExplainContext('/Users/me/MotionStudio/', 'acme', 'c1');
const exp = { summary: [{ key: 'explain.runs', params: {} }], indicators: [], risk: 'low' as const, parsed: true };

describe('webExplainContext', () => {
  it('derives the project, work folder and home from the workspace path', () => {
    expect(ctx).toEqual({ projectDir: '/Users/me/MotionStudio/acme', cwd: '/Users/me/MotionStudio/acme', home: '/Users/me', workDir: '/Users/me/MotionStudio/acme/creatives/c1/work' });
    expect(webExplainContext('/home/ann/ws', 'p').home).toBe('/home/ann');
  });
  it('without a usable workspace every absolute path is outside (never a benign guess); relative paths stay in the project', () => {
    for (const ws of [null, undefined, '', 'relative/ws', '/', '///']) {
      const c = webExplainContext(ws, 'acme');
      expect(classifyPath('/Users/me/MotionStudio/acme/x.mp4', c)).toBe('outside');
      expect(classifyPath('out/x.mp4', c)).toBe('project');
    }
  });
  it('is linear on a hostile workspace path', () => {
    const t = performance.now();
    webExplainContext(`/${'/'.repeat(20_000)}x`, 'acme');
    webExplainContext(`/${'a/'.repeat(10_000)}`, 'acme');
    expect(performance.now() - t).toBeLessThan(50);
  });
});

describe('commandLog', () => {
  it('links an older automatic approval without id to its tool_use by (capped) command', () => {
    const long = `echo ${'a'.repeat(3000)}`;
    const events: AgentEvent[] = [
      { kind: 'tool_use', id: 'b1', name: 'Bash', input: { command: long } },
      { kind: 'auto_approved', toolName: 'Bash', command: `${long.slice(0, 1999)}…`, explanation: exp },
      { kind: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'pwd' } },
    ];
    const log = commandLog(events, ctx);
    expect(log.rows).toHaveLength(2);
    expect(log.rows[0]).toMatchObject({ kind: 'command', explanation: exp, mark: 'auto', counted: true });
    expect(log).toMatchObject({ ran: 2, approved: 0, sandboxed: true });
  });
  it('an automatic approval whose tool_use is not in the log is its own counted row', () => {
    const log = commandLog([{ kind: 'auto_approved', toolName: 'Bash', command: 'ls', explanation: exp, toolUseId: 'gone' }], ctx);
    expect(log).toMatchObject({ ran: 1, rows: [{ kind: 'command', command: 'ls', mark: 'auto' }] });
  });
  it('a decision for another tool, or without an id, does not change a Bash row', () => {
    const log = commandLog([
      { kind: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'approval_decided', toolName: 'Write', decision: 'deny', toolUseId: 'b1' },
      { kind: 'approval_decided', toolName: 'Bash', decision: 'deny' },
    ], ctx, false);
    expect(log).toMatchObject({ ran: 1, sandboxed: false, rows: [{ mark: 'auto' }] });
  });
  it('the session flag wins over the hint', () => {
    expect(commandLog([{ kind: 'session', sessionId: 's', sandboxed: false }], ctx, true).sandboxed).toBe(false);
  });
});

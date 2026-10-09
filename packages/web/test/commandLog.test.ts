import { classifyPath, explainTool, type AgentEvent } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { commandLog, webExplainContext } from '../src/components/commandLog.ts';

const ctx = webExplainContext('/Users/me/MotionStudio/', 'acme', 'c1');
const exp = { summary: [{ key: 'explain.runs', params: {} }], indicators: [], risk: 'low' as const, parsed: true };

describe('webExplainContext', () => {
  it('derives the project, work folder and home from the workspace path', () => {
    expect(ctx).toEqual({ projectDir: '/Users/me/MotionStudio/acme', cwd: '/Users/me/MotionStudio/acme', home: '/Users/me', opaqueRoot: '/\u2400motion-studio-unknown', workDir: '/Users/me/MotionStudio/acme/creatives/c1/work' });
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
    const log = commandLog(events, ctx, { finished: false });
    expect(log.rows).toHaveLength(2);
    expect(log.rows[0]).toMatchObject({ kind: 'command', explanation: exp, mark: 'auto', counted: true });
    expect(log).toMatchObject({ ran: 2, approved: 0, sandboxed: true });
  });
  it('an automatic approval whose tool_use is not in the log is its own counted row', () => {
    const log = commandLog([{ kind: 'auto_approved', toolName: 'Bash', command: 'ls', explanation: exp, toolUseId: 'gone' }], ctx, { finished: true });
    expect(log).toMatchObject({ ran: 1, rows: [{ kind: 'command', command: 'ls', mark: 'auto' }] });
  });
  it('a decision for another tool, or without an id, does not change a Bash row', () => {
    const log = commandLog([
      { kind: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'approval_decided', toolName: 'Write', decision: 'deny', toolUseId: 'b1' },
      { kind: 'approval_decided', toolName: 'Bash', decision: 'deny' },
    ], ctx, { finished: false, sandboxedHint: false });
    expect(log).toMatchObject({ ran: 1, sandboxed: false, rows: [{ mark: 'auto' }] });
  });
  it('the session flag wins over the hint', () => {
    expect(commandLog([{ kind: 'session', sessionId: 's', sandboxed: false }], ctx, { finished: true, sandboxedHint: true }).sandboxed).toBe(false);
  });
  it('the FIRST session event wins: a forged line appended later cannot flip it to "in the sandbox"', () => {
    const s = (sandboxed: boolean): AgentEvent => ({ kind: 'session', sessionId: 's', sandboxed });
    expect(commandLog([s(false), s(true)], ctx, { finished: true }).sandboxed).toBe(false);
    expect(commandLog([s(true), s(false)], ctx, { finished: true }).sandboxed).toBe(true);
  });
  it('a call with neither result nor decision is "interrupted" only once the turn is finished', () => {
    const events: AgentEvent[] = [{ kind: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'sleep 100' } }];
    expect(commandLog(events, ctx, { finished: true })).toMatchObject({ ran: 1, attempted: true, rows: [{ mark: 'interrupted', counted: true }] });
    expect(commandLog(events, ctx, { finished: false })).toMatchObject({ ran: 1, attempted: false, rows: [{ mark: 'auto' }] });
  });
  it('id-less matching is linear: 5000 identical commands and approvals', () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 5000; i++) events.push({ kind: 'tool_use', id: `b${i}`, name: 'Bash', input: { command: 'true' } });
    for (let i = 0; i < 5000; i++) events.push({ kind: 'auto_approved', toolName: 'Bash', command: 'true', explanation: exp });
    const t = performance.now();
    const log = commandLog(events, ctx, { finished: false });
    expect(performance.now() - t).toBeLessThan(500);
    expect(log.rows).toHaveLength(5000);
    expect(log.rows.every((r) => r.kind === 'command' && r.explanation === exp)).toBe(true);
  });
  it('never shows the placeholder folder of an unknown project or home', () => {
    const unknown = webExplainContext(null, 'acme');
    for (const command of ['rm -rf ..', 'cat ../../etc/x', 'cp a.mp4 ../../../out', 'ls ~/', 'rm -rf .', 'mv x /']) {
      const e = explainTool('Bash', { command }, unknown);
      const text = JSON.stringify(e);
      expect(text, command).not.toContain('\u2400');
      expect(text, command).not.toContain('motion-studio-unknown');
    }
    expect(JSON.stringify(explainTool('Bash', { command: 'rm -rf ..' }, unknown))).toContain('..');
  });
});

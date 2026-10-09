import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { LineSplitter, parseClaudeLine } from '../src/agent/claude-stream-parser.ts';

describe('LineSplitter', () => {
  it('rejoins lines split across chunks and drops blanks', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\n\n{"b":2}\r\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(s.flush()).toEqual(['{"c"']);
    expect(s.flush()).toEqual([]);
  });
});

describe('parseClaudeLine', () => {
  it('maps the recorded sample to agent events', async () => {
    const raw = await readFile(new URL('./fixtures/claude-stream-sample.jsonl', import.meta.url), 'utf8');
    const events = raw.split('\n').filter(Boolean).flatMap(parseClaudeLine);
    expect(events).toEqual([
      { kind: 'session', sessionId: 's-123', model: 'claude-haiku-4-5-20251001' },
      { kind: 'text', text: 'Creo la scena.' },
      { kind: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: 'work/a.txt', content: 'hi' } },
      { kind: 'tool_result', toolUseId: 'tu_1', isError: false, content: 'File created' },
      { kind: 'tool_result', toolUseId: 'tu_2', isError: true, content: 'permission denied' },
      { kind: 'rate_limit', status: 'allowed', resetsAt: 1791395400 },
      { kind: 'result', ok: true, sessionId: 's-123', text: 'ok', costUsd: 0.0156526, durationMs: 6731 },
    ]);
  });
  it('turns an error result into a failed result with the error text', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Usage limit reached', session_id: 's' });
    expect(parseClaudeLine(line)).toEqual([{ kind: 'result', ok: false, sessionId: 's', text: 'Usage limit reached', error: 'Usage limit reached' }]);
  });
  it('emits parse_error for non-JSON lines (truncated to 500 chars)', () => {
    const [ev] = parseClaudeLine('x'.repeat(800));
    expect(ev).toEqual({ kind: 'parse_error', line: 'x'.repeat(500) });
  });
  it('ignores unknown event types', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'something_new', foo: 1 }))).toEqual([]);
  });
  it('truncates very long tool results to 4000 chars', () => {
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'y'.repeat(5000) }] } });
    const [ev] = parseClaudeLine(line);
    expect(ev && ev.kind === 'tool_result' && ev.content.length).toBe(4000);
  });
  it('uses empty strings for missing tool_result content and missing ids', () => {
    const user = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: null }, { type: 'tool_result' }] } });
    expect(parseClaudeLine(user)).toEqual([
      { kind: 'tool_result', toolUseId: '', isError: false, content: '' },
      { kind: 'tool_result', toolUseId: '', isError: false, content: '' },
    ]);
    const assistant = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', input: {} }] } });
    expect(parseClaudeLine(assistant)).toEqual([{ kind: 'tool_use', id: '', name: '', input: {} }]);
  });
  it('describes a result without text by its subtype', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's' });
    expect(parseClaudeLine(line)).toEqual([{ kind: 'result', ok: false, sessionId: 's', error: 'Turno terminato con esito error_max_turns' }]);
  });
  it('emits parse_error for JSON lines that are not objects', () => {
    expect(parseClaudeLine('123')).toEqual([{ kind: 'parse_error', line: '123' }]);
    expect(parseClaudeLine('[1]')).toEqual([{ kind: 'parse_error', line: '[1]' }]);
  });
});

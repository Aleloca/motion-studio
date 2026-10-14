import { afterEach, describe, expect, it } from 'vitest';
import { alive, expectNoOrphans, killStarted, startFake, waitForEvent } from './helpers/fake-stream-runner.ts';

// Phase 13 Task 1: live input on the Claude Code runner, against the fake CLI only (decisions log 610).
const ON = { liveInput: true, interrupt: false };

afterEach(() => killStarted());

describe('ClaudeCodeRunner live input: capability off (default, today\'s behaviour)', () => {
  it('writes the one message with end() and closes stdin at once, exactly as before', async () => {
    const run = await startFake('mid-turn', { prompt: 'hello' });
    await expect(run.handle.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(run.spy.writes).toEqual([]);
    expect(run.spy.ends).toEqual([`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })}\n`]);
    const r = await run.received();
    expect(r.lines).toHaveLength(1);
    expect(r.eof).toBe(true);
    expect(r.eofAfterLines).toBe(1);
    await expectNoOrphans(run);
  });

  it('send resolves closed without writing (also mid-turn), and never throws', async () => {
    const run = await startFake('mid-turn');
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.send!({ text: 'more', clientId: 'c1' })).resolves.toBe('closed');
    await run.handle.done;
    expect(run.spy.writes).toEqual([]);
    expect(run.spy.afterClose).toEqual([]);
    expect(run.events.some((e) => e.kind === 'user_message_delivered')).toBe(false);
    expect((await run.received()).lines).toHaveLength(1);
  });

  it('the capability object with both flags false behaves like no capability', async () => {
    const run = await startFake('mid-turn', { capabilities: { liveInput: false, interrupt: false } });
    await expect(run.handle.send!({ text: 'x', clientId: 'c' })).resolves.toBe('closed');
    await expect(run.handle.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(run.spy.writes).toEqual([]);
    expect(run.spy.ends).toHaveLength(1);
  });
});

describe('ClaudeCodeRunner live input: capability on (opt-in, unverified live)', () => {
  it('consumes mid-turn: keeps stdin open, writes the stream-json user message, reports it sent, closes on the result', async () => {
    const run = await startFake('mid-turn', { capabilities: ON });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    expect(run.spy.ends).toEqual([]);
    await expect(run.handle.send!({ text: 'the blue logo', clientId: 'c-1' })).resolves.toBe('written');
    expect(run.events).toContainEqual({ kind: 'user_message_delivered', clientId: 'c-1' });
    await expect(run.handle.done).resolves.toMatchObject({ status: 'succeeded', sessionId: 'fake-stream-session' });
    expect(run.events).toContainEqual({ kind: 'text', text: 'got mid-turn: the blue logo' });
    const r = await run.received();
    expect(r.lines).toEqual([
      { type: 'user', message: { role: 'user', content: 'first' } },
      { type: 'user', message: { role: 'user', content: 'the blue logo' }, parent_tool_use_id: null },
    ]);
    expect(r.eof).toBe(true);
    expect(run.spy.ends).toEqual([undefined]);
    expect(run.spy.afterClose).toEqual([]);
    await expectNoOrphans(run);
  });

  it('consumes only after the result: the message written mid-turn gets its own turn before the CLI exits', async () => {
    const run = await startFake('after-result', { capabilities: ON });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.send!({ text: 'second', clientId: 'c-2' })).resolves.toBe('written');
    await expect(run.handle.done).resolves.toMatchObject({ status: 'succeeded' });
    const results = run.events.filter((e) => e.kind === 'result');
    expect(results.map((e) => e.kind === 'result' && e.text)).toEqual(['done: first', 'done: second']);
    expect(run.spy.afterClose).toEqual([]);
    await expectNoOrphans(run);
  });

  it('ignores: a CLI that never answers the message still ends the turn and exits', async () => {
    const run = await startFake('ignores', { capabilities: ON });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.send!({ text: 'ignored', clientId: 'c-3' })).resolves.toBe('written');
    await expect(run.handle.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(run.events.filter((e) => e.kind === 'result')).toHaveLength(1);
    expect((await run.received()).eof).toBe(true);
    await expectNoOrphans(run);
  });

  it('a send after the final result resolves closed and writes nothing', async () => {
    const run = await startFake('mid-turn', { capabilities: ON, toolMs: 50 });
    await waitForEvent(run.events, (e) => e.kind === 'result');
    await expect(run.handle.send!({ text: 'late', clientId: 'c-4' })).resolves.toBe('closed');
    await run.handle.done;
    await expect(run.handle.send!({ text: 'later', clientId: 'c-5' })).resolves.toBe('closed');
    expect(run.spy.writes).toHaveLength(1); // only the prompt
    expect(run.spy.afterClose).toEqual([]);
    expect(run.events.some((e) => e.kind === 'user_message_delivered')).toBe(false);
  });

  it('exits early: send after the process is gone resolves closed, no write after close, the run fails', async () => {
    const run = await startFake('exits-early', { capabilities: ON });
    const done = await run.handle.done;
    expect(done.status).toBe('failed');
    await expect(run.handle.send!({ text: 'too late', clientId: 'c-6' })).resolves.toBe('closed');
    expect(run.spy.writes).toHaveLength(1); // only the prompt
    expect(run.spy.afterClose).toEqual([]);
    await expectNoOrphans(run);
  });

  it('a send after cancel resolves closed and writes nothing', async () => {
    const run = await startFake('interrupt-no-ack', { capabilities: ON, toolMs: 60_000 });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    run.handle.cancel();
    await expect(run.handle.send!({ text: 'after cancel', clientId: 'c-7' })).resolves.toBe('closed');
    await expect(run.handle.done).resolves.toMatchObject({ status: 'cancelled' });
    expect(run.spy.writes).toHaveLength(1); // only the prompt
    expect(run.spy.afterClose).toEqual([]);
    await expectNoOrphans(run);
  });

  it('two sends keep their order', async () => {
    const run = await startFake('ignores', { capabilities: ON });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    const a = run.handle.send!({ text: 'one', clientId: 'a' });
    const b = run.handle.send!({ text: 'two', clientId: 'b' });
    await expect(Promise.all([a, b])).resolves.toEqual(['written', 'written']);
    await run.handle.done;
    const delivered = run.events.filter((e) => e.kind === 'user_message_delivered').map((e) => e.kind === 'user_message_delivered' && e.clientId);
    expect(delivered).toEqual(['a', 'b']);
    expect((await run.received()).lines.slice(1).map((l) => (l as { message: { content: string } }).message.content)).toEqual(['one', 'two']);
  });
});

describe('ClaudeCodeRunner process group with an open stdin', () => {
  it('cancel kills a child that ignores SIGTERM and the leader that ignores it too: no orphan PIDs', async () => {
    const run = await startFake('child-ignores-term', { capabilities: ON });
    await waitForEvent(run.events, (e) => e.kind === 'stderr' && e.text.startsWith('child-pid: '));
    const pids = run.pids();
    expect(pids).toHaveLength(2);
    for (const p of pids) expect(alive(p)).toBe(true);
    run.handle.cancel();
    await expect(run.handle.done).resolves.toMatchObject({ status: 'cancelled' });
    await expectNoOrphans(run);
    expect(run.spy.afterClose).toEqual([]);
  });

  it('the same with the capability off', async () => {
    const run = await startFake('child-ignores-term');
    await waitForEvent(run.events, (e) => e.kind === 'stderr' && e.text.startsWith('child-pid: '));
    run.handle.cancel();
    await expect(run.handle.done).resolves.toMatchObject({ status: 'cancelled' });
    await expectNoOrphans(run);
  });
});

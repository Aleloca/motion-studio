import { afterEach, describe, expect, it } from 'vitest';
import { alive, expectNoOrphans, killStarted, line, scriptedRun, startFake, tick, waitForEvent } from './helpers/fake-stream-runner.ts';

// Phase 13 Task 1: live input on the Claude Code runner, against the fake CLI only (never a real claude; decision 804).
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

describe('ClaudeCodeRunner live input: capability on', () => {
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

// Decision 804: "read" only on the CLI's evidence. Claude Code 2.1.301 answered a second message with its own result
// (the user's probe); a message is read once the result before its turn came and the agent then produced new output.
describe('ClaudeCodeRunner live input: the "read" evidence (decision 804)', () => {
  const kinds = (events: { kind: string }[]) => events.filter((e) => e.kind === 'user_message_read' || e.kind === 'result' || (e.kind === 'text' && 'text' in e && String(e.text).startsWith('working on:')));

  it('a message that gets its own turn is read when that turn starts: after the previous result, before its first output', async () => {
    const run = await startFake('after-result', { capabilities: ON });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.send!({ text: 'second', clientId: 'c-2' })).resolves.toBe('written');
    // Written, not read yet: the first turn is still running.
    expect(run.events.some((e) => e.kind === 'user_message_read')).toBe(false);
    await expect(run.handle.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(kinds(run.events)).toEqual([
      { kind: 'text', text: 'working on: first' },
      expect.objectContaining({ kind: 'result', text: 'done: first' }),
      { kind: 'user_message_read', clientId: 'c-2' },
      { kind: 'text', text: 'working on: second' },
      expect.objectContaining({ kind: 'result', text: 'done: second' }),
    ]);
    await expectNoOrphans(run);
  });

  it('never on a guess: a message folded into the running turn, or one the CLI ignores, stays "sent"', async () => {
    for (const mode of ['mid-turn', 'ignores']) {
      const run = await startFake(mode, { capabilities: ON });
      await waitForEvent(run.events, (e) => e.kind === 'tool_use');
      await expect(run.handle.send!({ text: 'more', clientId: 'c-m' })).resolves.toBe('written');
      await expect(run.handle.done).resolves.toMatchObject({ status: 'succeeded' });
      expect(run.events, mode).toContainEqual({ kind: 'user_message_delivered', clientId: 'c-m' });
      expect(run.events.some((e) => e.kind === 'user_message_read'), mode).toBe(false);
    }
  });

  it('with the capability off nothing is read (nothing is written)', async () => {
    const run = await startFake('after-result');
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.send!({ text: 'x', clientId: 'c-off' })).resolves.toBe('closed');
    await run.handle.done;
    expect(run.events.some((e) => e.kind === 'user_message_read')).toBe(false);
  });
});

describe('ClaudeCodeRunner live input: "read" after an interrupt (review fix)', () => {
  it('a message written before an acknowledged interrupt is never marked read; the redirect is, on its turn\'s first output', async () => {
    const r = await scriptedRun({ liveInput: true, interrupt: true });
    r.out(line.text('turn 0'));
    await tick();
    await expect(r.handle.send!({ text: 'in1', clientId: 'in1' })).resolves.toBe('written');
    const pending = r.handle.interrupt!();
    await tick();
    r.out(line.ack(r.lastRequestId()));
    await expect(pending).resolves.toBe('interrupted');
    r.out(line.result('error_during_execution'));
    await tick();
    await expect(r.handle.send!({ text: 'in2', clientId: 'in2' })).resolves.toBe('written');
    expect(r.events.some((e) => e.kind === 'user_message_read')).toBe(false);
    r.out(line.text('redirect turn'));
    await tick();
    r.out(line.result('success', 'done'));
    await tick();
    r.exit(0);
    r.close(0);
    await expect(r.handle.done).resolves.toMatchObject({ status: 'succeeded' });
    const reads = r.events.filter((e) => e.kind === 'user_message_read');
    expect(reads).toEqual([{ kind: 'user_message_read', clientId: 'in2' }]);
    // Right before the redirect turn's first output.
    const i = r.events.findIndex((e) => e.kind === 'user_message_read');
    expect(r.events[i + 1]).toEqual({ kind: 'text', text: 'redirect turn' });
  });

  it('the same when the stopped turn\'s result comes before the ack (it is held): the redirect written after counts from the next result', async () => {
    const r = await scriptedRun({ liveInput: true, interrupt: true }, { runner: { redirectBackstopMs: 30_000 } });
    r.out(line.text('turn 0'));
    await tick();
    await expect(r.handle.send!({ text: 'in1', clientId: 'in1' })).resolves.toBe('written');
    const pending = r.handle.interrupt!();
    await tick();
    r.out(line.result('error_during_execution'), line.ack(r.lastRequestId()));
    await expect(pending).resolves.toBe('interrupted');
    // The result came first and closed stdin: no redirect can be written, and nothing was read.
    await expect(r.handle.send!({ text: 'in2', clientId: 'in2' })).resolves.toBe('closed');
    r.out(line.text('anything'));
    await tick();
    r.exit(1);
    r.close(1);
    await expect(r.handle.done).resolves.toMatchObject({ status: 'cancelled' });
    expect(r.events.some((e) => e.kind === 'user_message_read')).toBe(false);
  });
});

describe('ClaudeCodeRunner live input: "read" is off after an unprovable stop (review round 2)', () => {
  /** Turn 0 running with in1 written, interrupt acked with `stillQueued`, stopped result, redirect in2, then a CLI turn. */
  const scenario = async (stillQueued: unknown[] | null, opts: { holdIn1?: boolean } = {}) => {
    const r = await scriptedRun({ liveInput: true, interrupt: true });
    r.out(line.text('turn 0'));
    await tick();
    const releaseIn1 = opts.holdIn1 ? r.holdStdinCallbacks() : null;
    const in1 = r.handle.send!({ text: 'in1', clientId: 'in1' });
    if (!releaseIn1) await expect(in1).resolves.toBe('written');
    const pending = r.handle.interrupt!();
    await tick();
    r.out(line.ack(r.lastRequestId(), stillQueued));
    await expect(pending).resolves.toBe('interrupted');
    if (releaseIn1) { releaseIn1(); await expect(in1).resolves.toBe('written'); }
    r.out(line.result('error_during_execution'));
    await tick();
    await expect(r.handle.send!({ text: 'in2', clientId: 'in2' })).resolves.toBe('written');
    // The CLI may run in1's turn first, then in2's.
    r.out(line.text('next turn'));
    await tick();
    r.out(line.result('success', 'one'));
    await tick();
    r.out(line.text('another turn'));
    await tick();
    r.out(line.result('success', 'two'));
    await tick();
    r.exit(0);
    r.close(0);
    await expect(r.handle.done).resolves.toMatchObject({ status: 'succeeded' });
    return r.events.filter((e) => e.kind === 'user_message_read');
  };

  it('still_queued not empty: no message is ever marked read', async () => {
    expect(await scenario(['x'])).toEqual([]);
  });
  it('still_queued empty (2.1.301) and nothing in flight: the redirect is marked', async () => {
    expect(await scenario([])).toEqual([{ kind: 'user_message_read', clientId: 'in2' }]);
  });
  it('a send whose write callback comes after the ack: no read marks afterwards', async () => {
    expect(await scenario([], { holdIn1: true })).toEqual([]);
  });
  it('an ack that does not say still_queued (unknown): no read marks', async () => {
    expect(await scenario(null)).toEqual([]);
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

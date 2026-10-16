import { afterEach, describe, expect, it } from 'vitest';
import { INTERRUPT_TIMEOUT_MS, REDIRECT_BACKSTOP_MS } from '../src/agent/claude-code-runner.ts';
import { expectNoOrphans, killStarted, line, scriptedRun, startFake, tick, waitForEvent } from './helpers/fake-stream-runner.ts';

// Phase 13 Task 1: interrupt on the Claude Code runner, against the fake CLI only (never a real claude; decision 804).
const BOTH = { liveInput: true, interrupt: true };
const controlRequests = (lines: unknown[]) => lines.filter((l) => (l as { type?: string }).type === 'control_request') as { type: string; request_id: string; request: { subtype: string } }[];

afterEach(() => killStarted());

describe('ClaudeCodeRunner interrupt: capability off', () => {
  it('resolves unsupported without writing (capability off, the default)', async () => {
    const run = await startFake('interrupt-ack');
    await expect(run.handle.interrupt!()).resolves.toBe('unsupported');
    await run.handle.done;
    expect(run.spy.writes).toEqual([]);
    expect(run.spy.afterClose).toEqual([]);
    expect(controlRequests((await run.received()).lines)).toEqual([]);
  });

  it('resolves unsupported without writing when only live input is on', async () => {
    const run = await startFake('interrupt-ack', { capabilities: { liveInput: true, interrupt: false } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.interrupt!()).resolves.toBe('unsupported');
    await run.handle.done;
    expect(run.spy.writes).toHaveLength(1); // only the prompt
    expect(run.events.some((e) => e.kind === 'interrupted')).toBe(false);
  });
});

describe('ClaudeCodeRunner interrupt: capability on', () => {
  it('waits 5 s for the acknowledgement by default; the redirect backstop is 45 s', () => {
    expect(INTERRUPT_TIMEOUT_MS).toBe(5000);
    expect(REDIRECT_BACKSTOP_MS).toBe(45_000);
  });

  it('interrupt ack: writes the control_request, matches the control_response by request_id, emits interrupted', async () => {
    const run = await startFake('interrupt-ack', { capabilities: BOTH, toolMs: 60_000, runner: { redirectBackstopMs: 30_000 } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.interrupt!()).resolves.toBe('interrupted');
    expect(run.events).toContainEqual({ kind: 'interrupted' });
    const [req] = controlRequests((await run.received()).lines);
    expect(req).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
    expect(typeof req!.request_id).toBe('string');
    run.handle.cancel();
    await run.handle.done;
    await expectNoOrphans(run);
  });

  it('no decision after the ack: stdin stays open past the interrupted result until the backstop, then the run is cancelled', async () => {
    const run = await startFake('interrupt-ack', { capabilities: BOTH, toolMs: 60_000, runner: { redirectBackstopMs: 600 } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    const t0 = Date.now();
    await expect(run.handle.interrupt!()).resolves.toBe('interrupted');
    await waitForEvent(run.events, (e) => e.kind === 'result');
    expect(run.spy.ends).toEqual([]); // the interrupted turn's result does not close stdin
    await expect(run.handle.done).resolves.toMatchObject({ status: 'cancelled' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    expect(run.spy.ends).toEqual([undefined]);
    expect(run.spy.afterClose).toEqual([]);
    await expectNoOrphans(run);
  });

  it('plan order: interrupt then send(redirect) before the interrupted result; stdin stays open through the redirect turn and a live send there is written', async () => {
    const run = await startFake('interrupt-ack', { capabilities: BOTH, toolMs: 800, ackGapMs: 300, runner: { redirectBackstopMs: 400 } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.interrupt!()).resolves.toBe('interrupted');
    expect(run.events.some((e) => e.kind === 'result')).toBe(false); // the ack came first
    await expect(run.handle.send!({ text: 'redirect', clientId: 'r-1' })).resolves.toBe('written');
    await waitForEvent(run.events, (e) => e.kind === 'text' && e.text === 'working on: redirect');
    // Well past the 400 ms backstop: a decision was taken, so the backstop never closes stdin.
    await new Promise((r) => setTimeout(r, 500));
    expect(run.spy.ends).toEqual([]);
    await expect(run.handle.send!({ text: 'also this', clientId: 'l-1' })).resolves.toBe('written');
    await expect(run.handle.done).resolves.toMatchObject({ status: 'succeeded' });
    const results = run.events.filter((e) => e.kind === 'result').map((e) => e.kind === 'result' && e.text);
    expect(results).toEqual(['interrupted', 'done: redirect', 'done: also this']);
    expect(run.spy.ends).toEqual([undefined]);
    expect(run.spy.afterClose).toEqual([]);
    await expectNoOrphans(run);
  });

  it('redirect after the interrupted result: the next message runs in the same process and succeeds', async () => {
    const run = await startFake('interrupt-ack', { capabilities: BOTH, toolMs: 300, runner: { redirectBackstopMs: 30_000 } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.interrupt!()).resolves.toBe('interrupted');
    await waitForEvent(run.events, (e) => e.kind === 'result');
    expect(run.spy.ends).toEqual([]);
    await expect(run.handle.send!({ text: 'go right', clientId: 'r-2' })).resolves.toBe('written');
    await expect(run.handle.done).resolves.toMatchObject({ status: 'succeeded' });
    const results = run.events.filter((e) => e.kind === 'result').map((e) => e.kind === 'result' && e.text);
    expect(results).toEqual(['interrupted', 'done: go right']);
    expect(run.spy.afterClose).toEqual([]);
    await expectNoOrphans(run);
  });

  it('endInput() after the ack closes stdin at once: the CLI exits, the run is cancelled, later sends are closed', async () => {
    const run = await startFake('interrupt-ack', { capabilities: BOTH, toolMs: 60_000, runner: { redirectBackstopMs: 30_000 } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.interrupt!()).resolves.toBe('interrupted');
    await waitForEvent(run.events, (e) => e.kind === 'result');
    const t0 = Date.now();
    run.handle.endInput!();
    await expect(run.handle.done).resolves.toMatchObject({ status: 'cancelled' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(run.spy.ends).toEqual([undefined]);
    await expect(run.handle.send!({ text: 'late', clientId: 'x' })).resolves.toBe('closed');
    expect(run.spy.afterClose).toEqual([]);
    await expectNoOrphans(run);
  });

  it('endInput() with the capability off is a no-op (stdin was closed with the prompt)', async () => {
    const run = await startFake('mid-turn');
    run.handle.endInput!();
    await expect(run.handle.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(run.spy.ends).toHaveLength(1);
    expect(run.spy.writes).toEqual([]);
    expect(run.spy.afterClose).toEqual([]);
  });

  it('a redirect turn that genuinely fails is failed, not cancelled', async () => {
    const run = await startFake('interrupt-ack', { capabilities: BOTH, toolMs: 300, runner: { redirectBackstopMs: 30_000 } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.interrupt!()).resolves.toBe('interrupted');
    await expect(run.handle.send!({ text: 'fail: please', clientId: 'r-3' })).resolves.toBe('written');
    await expect(run.handle.done).resolves.toMatchObject({ status: 'failed', error: 'failed: fail: please' });
    await expectNoOrphans(run);
  });

  it('the interrupted turn\'s result arriving before the ack ends as cancelled, not failed; a later send is closed', async () => {
    const run = await startFake('interrupt-result-first', { capabilities: BOTH, toolMs: 60_000, runner: { redirectBackstopMs: 30_000 } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.interrupt!()).resolves.toBe('interrupted');
    expect(run.events).toContainEqual({ kind: 'interrupted' });
    // The result closed stdin first: a redirect cannot be written, the core falls back to the queue.
    await expect(run.handle.send!({ text: 'too late', clientId: 'r-late' })).resolves.toBe('closed');
    await expect(run.handle.done).resolves.toMatchObject({ status: 'cancelled' });
    expect(run.spy.afterClose).toEqual([]);
    await expectNoOrphans(run);
  });

  it('interrupt no ack: resolves timeout after the timeout, never hangs; cancel then leaves no PID', async () => {
    const run = await startFake('interrupt-no-ack', { capabilities: BOTH, toolMs: 60_000, runner: { interruptTimeoutMs: 300 } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    const t0 = Date.now();
    await expect(run.handle.interrupt!()).resolves.toBe('timeout');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(run.events.some((e) => e.kind === 'interrupted')).toBe(false);
    run.handle.cancel();
    await expect(run.handle.done).resolves.toMatchObject({ status: 'cancelled' });
    await expectNoOrphans(run);
  });

  it('an error control_response resolves unsupported', async () => {
    const run = await startFake('interrupt-error', { capabilities: BOTH, toolMs: 1500 });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.interrupt!()).resolves.toBe('unsupported');
    expect(run.events.some((e) => e.kind === 'interrupted')).toBe(false);
    await expect(run.handle.done).resolves.toMatchObject({ status: 'succeeded' });
    await expectNoOrphans(run);
  });

  it('a pending interrupt resolves timeout at once when the process goes away (cancel)', async () => {
    const run = await startFake('interrupt-no-ack', { capabilities: BOTH, toolMs: 60_000, runner: { interruptTimeoutMs: 30_000 } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    const pending = run.handle.interrupt!();
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    run.handle.cancel();
    await expect(pending).resolves.toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(5000);
    await run.handle.done;
    await expectNoOrphans(run);
  });

  it('after the final result or after exit: unsupported, nothing written', async () => {
    const run = await startFake('mid-turn', { capabilities: BOTH, toolMs: 50 });
    await waitForEvent(run.events, (e) => e.kind === 'result');
    await expect(run.handle.interrupt!()).resolves.toBe('unsupported');
    await run.handle.done;
    await expect(run.handle.interrupt!()).resolves.toBe('unsupported');
    expect(run.spy.writes).toHaveLength(1); // only the prompt
    expect(run.spy.afterClose).toEqual([]);

    const early = await startFake('exits-early', { capabilities: BOTH });
    await early.handle.done;
    await expect(early.handle.interrupt!()).resolves.toBe('unsupported');
    expect(early.spy.writes).toHaveLength(1); // only the prompt
    expect(early.spy.afterClose).toEqual([]);
  });
});

// Decision 804: the shape the user's probe measured on Claude Code 2.1.301. The fake emits exactly it: control_response
// { subtype: 'success', request_id, response: { still_queued: [] } }, then a result `error_during_execution`, then exit 1.
describe('ClaudeCodeRunner interrupt: the 2.1.301 shape (decision 804)', () => {
  const EXIT_1 = { FAKE_STREAM_INTERRUPTED_EXIT: '1' };
  const resultOf = (events: unknown[]) => events.filter((e) => (e as { kind: string }).kind === 'result') as Extract<import('@motion-studio/shared').AgentEvent, { kind: 'result' }>[];

  it('acknowledged, error_during_execution, exit 1, no redirect: cancelled (a stop, not a failure); the result is marked interrupted, without an error', async () => {
    const run = await startFake('interrupt-ack', { capabilities: BOTH, toolMs: 60_000, env: EXIT_1, runner: { redirectBackstopMs: 30_000 } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.interrupt!()).resolves.toBe('interrupted');
    await waitForEvent(run.events, (e) => e.kind === 'result');
    run.handle.endInput!();
    await expect(run.handle.done).resolves.toMatchObject({ status: 'cancelled' });
    const [r] = resultOf(run.events);
    expect(r).toMatchObject({ kind: 'result', ok: false, interrupted: true });
    expect(r).not.toHaveProperty('error');
    await expectNoOrphans(run);
  });

  it('the same through the backstop (no decision at all): cancelled', async () => {
    const run = await startFake('interrupt-ack', { capabilities: BOTH, toolMs: 60_000, env: EXIT_1, runner: { redirectBackstopMs: 300 } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.interrupt!()).resolves.toBe('interrupted');
    await expect(run.handle.done).resolves.toMatchObject({ status: 'cancelled' });
    await expectNoOrphans(run);
  });

  it('a redirect after it still runs in the same process and its own result decides (exit 1 after an interrupted session)', async () => {
    const run = await startFake('interrupt-ack', { capabilities: BOTH, toolMs: 300, env: EXIT_1, runner: { redirectBackstopMs: 30_000 } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.interrupt!()).resolves.toBe('interrupted');
    await expect(run.handle.send!({ text: 'go left', clientId: 'r-804' })).resolves.toBe('written');
    await expect(run.handle.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(resultOf(run.events).map((e) => [e.ok, e.interrupted ?? false])).toEqual([[false, true], [true, false]]);
    // The redirect's turn started after the interrupted result: the CLI took it.
    expect(run.events).toContainEqual({ kind: 'user_message_read', clientId: 'r-804' });
    await expectNoOrphans(run);
  });

  it('without the acknowledgement the same result and exit 1 are a failure', async () => {
    const run = await startFake('mid-turn', { capabilities: BOTH, prompt: 'abort: now', env: EXIT_1 });
    await expect(run.handle.done).resolves.toMatchObject({ status: 'failed', error: 'aborted: abort: now' });
    const [r] = resultOf(run.events);
    expect(r).toMatchObject({ ok: false, error: 'aborted: abort: now' });
    expect(r).not.toHaveProperty('interrupted');
    await expectNoOrphans(run);
  });

  it('an acknowledgement for another request_id is not ours: the interrupt times out and the run fails', async () => {
    const run = await startFake('interrupt-ack', { capabilities: BOTH, toolMs: 60_000, env: { ...EXIT_1, FAKE_STREAM_ACK_ID: 'someone-else' }, runner: { interruptTimeoutMs: 400 } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.interrupt!()).resolves.toBe('timeout');
    expect(run.events.some((e) => e.kind === 'interrupted')).toBe(false);
    await expect(run.handle.done).resolves.toMatchObject({ status: 'failed', error: 'interrupted' });
    expect(resultOf(run.events)[0]).not.toHaveProperty('interrupted');
    await expectNoOrphans(run);
  });

  it('result before the ack: the result is held until the ack, then marked interrupted, and keeps its place before the marker', async () => {
    const run = await startFake('interrupt-result-first', { capabilities: BOTH, toolMs: 60_000, env: EXIT_1, runner: { redirectBackstopMs: 30_000 } });
    await waitForEvent(run.events, (e) => e.kind === 'tool_use');
    await expect(run.handle.interrupt!()).resolves.toBe('interrupted');
    await expect(run.handle.done).resolves.toMatchObject({ status: 'cancelled' });
    const tail = run.events.filter((e) => e.kind === 'result' || e.kind === 'interrupted');
    expect(tail).toEqual([expect.objectContaining({ kind: 'result', ok: false, interrupted: true }), { kind: 'interrupted' }]);
    expect(tail[0]).not.toHaveProperty('error');
    await expectNoOrphans(run);
  });
});

// Runner review fixes (scripted child: exact orderings of stdout lines, exit and close).
describe('ClaudeCodeRunner interrupt: review fixes', () => {
  const results = (events: unknown[]) => events.filter((e) => (e as { kind: string }).kind === 'result') as Extract<import('@motion-studio/shared').AgentEvent, { kind: 'result' }>[];

  it('an ack still in the stdout pipe when `exit` comes is not lost: interrupted, marked, cancelled', async () => {
    const r = await scriptedRun(BOTH);
    r.out(line.text('working'));
    await tick();
    const pending = r.handle.interrupt!();
    await tick();
    r.out(line.result('error_during_execution'));
    await tick();
    r.exit(1);
    r.out(line.ack(r.lastRequestId()));
    r.close(1);
    await expect(pending).resolves.toBe('interrupted');
    await expect(r.handle.done).resolves.toMatchObject({ status: 'cancelled' });
    expect(results(r.events)).toEqual([expect.objectContaining({ ok: false, interrupted: true })]);
    expect(results(r.events)[0]).not.toHaveProperty('error');
  });

  it('every ok ack marks the next result: an unrelated error first (stdin closed), then the stopped turn\'s result is interrupted', async () => {
    const r = await scriptedRun(BOTH);
    r.out(line.text('working'));
    await tick();
    const pending = r.handle.interrupt!();
    await tick();
    r.out(line.result('error_max_turns', 'max turns'));
    await tick();
    r.out(line.ack(r.lastRequestId()));
    await expect(pending).resolves.toBe('interrupted');
    r.out(line.result('error_during_execution'));
    await tick();
    r.exit(1);
    r.close(1);
    await expect(r.handle.done).resolves.toMatchObject({ status: 'cancelled' });
    expect(results(r.events).map((e) => [e.ok, e.interrupted ?? false, e.error ?? null])).toEqual([[false, false, 'max turns'], [false, true, null]]);
  });

  it('two results in one stdout chunk keep their own subtypes: the first (the stopped turn) is marked, the second is not', async () => {
    const r = await scriptedRun(BOTH);
    r.out(line.text('working'));
    await tick();
    const pending = r.handle.interrupt!();
    await tick();
    r.out(line.ack(r.lastRequestId()));
    await expect(pending).resolves.toBe('interrupted');
    await expect(r.handle.send!({ text: 'redirect', clientId: 'r1' })).resolves.toBe('written');
    r.out(line.result('error_during_execution'), line.result('error_max_turns', 'redirect failed'));
    await tick();
    r.exit(1);
    r.close(1);
    await expect(r.handle.done).resolves.toMatchObject({ status: 'failed', error: 'redirect failed' });
    expect(results(r.events).map((e) => e.interrupted ?? false)).toEqual([true, false]);
  });

  it('a listener that cancels while held events are released cannot reorder them', async () => {
    const r = await scriptedRun(BOTH, { onEvent: (e, h) => { if (e.kind === 'result') h.cancel(); } });
    r.out(line.text('working'));
    await tick();
    const pending = r.handle.interrupt!();
    await tick();
    r.out(line.result('error_during_execution'));
    await tick();
    r.exit(1);
    // The ack, then a line left without its newline: the cancel inside the listener flushes it.
    r.out(line.ack(r.lastRequestId()), JSON.stringify(line.text('late')));
    await expect(pending).resolves.toBe('interrupted');
    await r.handle.done;
    const tail = r.events.filter((e) => e.kind === 'result' || e.kind === 'interrupted' || (e.kind === 'text' && e.text === 'late')).map((e) => e.kind);
    expect(tail).toEqual(['result', 'interrupted', 'text']);
  });

  it('two failing redirect writes after one ack: still a stop (review round 2)', async () => {
    const r = await scriptedRun(BOTH);
    r.out(line.text('working'));
    await tick();
    const pending = r.handle.interrupt!();
    await tick();
    r.out(line.ack(r.lastRequestId()));
    await expect(pending).resolves.toBe('interrupted');
    r.out(line.result('error_during_execution'));
    await tick();
    r.breakStdin();
    const a = r.handle.send!({ text: 'one', clientId: 'f1' });
    const b = r.handle.send!({ text: 'two', clientId: 'f2' });
    await expect(Promise.all([a, b])).resolves.toEqual(['closed', 'closed']);
    r.exit(1);
    r.close(1);
    await expect(r.handle.done).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('a redirect whose write fails is no redirect: the stopped turn stays a stop', async () => {
    const r = await scriptedRun(BOTH);
    r.out(line.text('working'));
    await tick();
    const pending = r.handle.interrupt!();
    await tick();
    r.out(line.ack(r.lastRequestId()));
    await expect(pending).resolves.toBe('interrupted');
    r.out(line.result('error_during_execution'));
    await tick();
    r.breakStdin(); // the pipe breaks under the write
    await expect(r.handle.send!({ text: 'redirect', clientId: 'r2' })).resolves.toBe('closed');
    r.exit(1);
    r.close(1);
    await expect(r.handle.done).resolves.toMatchObject({ status: 'cancelled' });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { INTERRUPT_TIMEOUT_MS, REDIRECT_BACKSTOP_MS } from '../src/agent/claude-code-runner.ts';
import { expectNoOrphans, killStarted, startFake, waitForEvent } from './helpers/fake-stream-runner.ts';

// Phase 13 Task 1: interrupt on the Claude Code runner, against the fake CLI only (decisions log 610).
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

describe('ClaudeCodeRunner interrupt: capability on (opt-in, unverified live)', () => {
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

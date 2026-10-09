import { readFile } from 'node:fs/promises';
import type { AgentEvent } from '@motion-studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeStreamParser, parseClaudeLine } from '../src/agent/claude-stream-parser.ts';

type Usage = Extract<AgentEvent, { kind: 'usage' }>;
const sample = async () => (await readFile(new URL('./fixtures/claude-stream-usage-sample.jsonl', import.meta.url), 'utf8')).split('\n').filter(Boolean);
const usages = (events: AgentEvent[]) => events.filter((e): e is Usage => e.kind === 'usage');

describe('usage from the stream (Task 1 sample)', () => {
  it('sums assistant usage once per message id and reads the final usage from result', async () => {
    // No throttling here: every assistant line may emit, so the last live event is the full sum.
    const p = new ClaudeStreamParser({ liveIntervalMs: 0 });
    const events = (await sample()).flatMap((l) => p.parse(l));
    const live = usages(events).filter((u) => u.live);
    // msg_ANON0001 appears twice with the same usage: counted once.
    expect(live.at(-1)).toEqual({ kind: 'usage', live: true, tokens: { input: 6, output: 29, cacheRead: 75894, cacheWrite: 15631 }, costUsd: null });
    // The repeated id neither grows the running total nor emits an unchanged one again.
    expect(live.map((u) => u.tokens.cacheWrite)).toEqual([14768, 15346, 15631]);
    const final = usages(events).filter((u) => !u.live);
    expect(final).toEqual([{
      kind: 'usage', live: false,
      tokens: { input: 6, output: 634, cacheRead: 75894, cacheWrite: 15631 },
      costUsd: 0.004202740000000001,
      models: [{ model: 'claude-haiku-5-5', tokens: { input: 6, output: 634, cacheRead: 75894, cacheWrite: 15631 }, costUsd: 0.004202740000000001 }],
    }]);
    expect(events.find((e) => e.kind === 'result')).toMatchObject({ kind: 'result', ok: true, durationMs: 13597, numTurns: 3 });
    expect(p.end()).toEqual([]);
  });

  it('throttles live usage to one event per interval and flushes the latest sum at the end', async () => {
    let now = 1000;
    const p = new ClaudeStreamParser({ now: () => now, liveIntervalMs: 1000 });
    const assistant = (id: string, out: number) => JSON.stringify({ type: 'assistant', message: { id, content: [], usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 10 } } });
    expect(usages(p.parse(assistant('m1', 5)))).toHaveLength(1);
    now += 200;
    expect(usages(p.parse(assistant('m2', 7)))).toHaveLength(0); // within the interval: held back
    now += 200;
    expect(usages(p.parse(assistant('m2', 9)))).toHaveLength(0); // same id: last value wins
    now += 700;
    // Any later line (here a tool result) releases the held sum once the interval passed.
    const released = usages(p.parse(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } })));
    expect(released).toEqual([{ kind: 'usage', live: true, tokens: { input: 2, output: 14, cacheRead: 0, cacheWrite: 20 }, costUsd: null }]);
    now += 100;
    p.parse(assistant('m3', 1));
    // The end of the stream flushes what the throttle held back, so a cancelled run keeps its latest estimate.
    expect(p.end()).toEqual([{ kind: 'usage', live: true, tokens: { input: 3, output: 15, cacheRead: 0, cacheWrite: 30 }, costUsd: null }]);
    expect(p.end()).toEqual([]);
  });

  it('flushes a held-back sum from a trailing timer, at most once per interval, and stops on end', () => {
    vi.useFakeTimers();
    try {
      const timed: AgentEvent[] = [];
      const p = new ClaudeStreamParser({ liveIntervalMs: 1000, onLive: (e) => timed.push(e) });
      const assistant = (id: string) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 1, output_tokens: 1 } } });
      expect(usages(p.parse(assistant('a')))).toHaveLength(1);
      vi.advanceTimersByTime(100);
      expect(usages(p.parse(assistant('b')))).toHaveLength(0);
      vi.advanceTimersByTime(800);
      expect(timed).toEqual([]); // still within the interval
      vi.advanceTimersByTime(100);
      expect(timed).toEqual([{ kind: 'usage', live: true, tokens: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 }, costUsd: null }]);
      vi.advanceTimersByTime(5000);
      expect(timed).toHaveLength(1); // nothing new: no further event
      p.parse(assistant('c'));
      vi.advanceTimersByTime(100);
      p.parse(assistant('d'));
      expect(p.end()).toHaveLength(1); // end flushes and clears the timer
      vi.advanceTimersByTime(5000);
      expect(timed).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not flush a held live estimate once the final usage arrived', () => {
    let now = 0;
    const p = new ClaudeStreamParser({ now: () => now, liveIntervalMs: 1000 });
    p.parse(JSON.stringify({ type: 'assistant', message: { id: 'a', usage: { input_tokens: 1, output_tokens: 1 } } }));
    now += 10;
    p.parse(JSON.stringify({ type: 'assistant', message: { id: 'b', usage: { input_tokens: 1, output_tokens: 1 } } }));
    p.parse(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 2, output_tokens: 9 } }));
    expect(p.end()).toEqual([]);
  });

  it('ignores malformed usage numbers instead of inventing them', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 'x', output_tokens: -3, cache_read_input_tokens: 1.5, cache_creation_input_tokens: 4 }, modelUsage: { m: { inputTokens: 1, costUSD: 'free' }, '': {} } });
    expect(usages(parseClaudeLine(line))).toEqual([{
      kind: 'usage', live: false, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 4 }, costUsd: null,
      models: [{ model: 'm', tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: null }],
    }]);
  });

  it('emits no usage event for a result without usage', () => {
    expect(usages(parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0 })))).toEqual([]);
  });
});

describe('usage through the launcher (fake claude, usage_stream)', { timeout: 20_000 }, () => {
  it('forwards the live estimate and re-emits the final usage with the per-run cost after the result', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { ClaudeCodeRunner } = await import('../src/agent/claude-code-runner.ts');
    const { testLauncher } = await import('./helpers/launcher.ts');
    const { UsageLedger } = await import('../src/usage/usage-ledger.ts');
    const fake = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
    const projectDir = await mkdtemp(join(tmpdir(), 'ms-usage-launch-'));
    process.env.FAKE_CLAUDE_SCENARIO = 'usage_stream';
    try {
      const events: AgentEvent[] = [];
      const run = await testLauncher(new ClaudeCodeRunner([process.execPath, fake], { killGraceMs: 200 })).start({
        kind: 'console', jobId: 'j1', projectSlug: 'p', projectDir, request: { prompt: 'hi' }, onEvent: (e) => events.push(e),
      });
      const outcome = await run.done;
      expect(outcome.status).toBe('succeeded');
      const u = usages(events);
      // Two assistant events share one message id: one live estimate, not two.
      expect(u.filter((e) => e.live)).toEqual([{ kind: 'usage', live: true, tokens: { input: 10, output: 40, cacheRead: 1000, cacheWrite: 200 }, costUsd: null }]);
      expect(events.map((e) => e.kind).slice(-2)).toEqual(['result', 'usage']);
      expect(u.at(-1)).toMatchObject({ live: false, tokens: { input: 10, output: 100, cacheRead: 1000, cacheWrite: 200 }, costUsd: 0.01 });
      expect(outcome.usage).toMatchObject({ kind: 'console', jobId: 'j1', outcome: 'ok', costUsd: 0.01, sessionId: 'fake-session-1' });
      expect(await new UsageLedger().read(projectDir)).toEqual([outcome.usage]);
    } finally {
      delete process.env.FAKE_CLAUDE_SCENARIO;
    }
  });
});

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@motion-studio/shared';
import { vi } from 'vitest';
import { ClaudeCodeRunner } from '../../src/agent/claude-code-runner.ts';
import type { AgentRun, AgentTurnRequest } from '../../src/agent/runner.ts';

/** Phase 13 Task 1: helpers for the runner tests against `fake-claude-stream.mjs` (never a real `claude`). */
export const FAKE_STREAM = fileURLToPath(new URL('../fixtures/fake-claude-stream.mjs', import.meta.url));

/** Every PID a test started (fake leader and its children, read from the fake's stderr). Only these are ever signalled. */
export const startedPids = new Set<number>();

export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export interface StdinSpy { writes: string[]; ends: (string | undefined)[]; afterClose: string[] }

export interface FakeRun {
  handle: AgentRun;
  events: AgentEvent[];
  spy: StdinSpy;
  /** Lines the fake read from stdin, and whether it saw EOF. */
  received(): Promise<{ lines: unknown[]; eof: boolean; eofAfterLines: number }>;
  pids(): number[];
}

/** Starts the runner on the fake with `mode`; `stdin.write`/`end` of the child are spied (a write after end is recorded). */
export async function startFake(
  mode: string,
  opts: {
    capabilities?: AgentTurnRequest['capabilities'];
    prompt?: string;
    toolMs?: number;
    runner?: { killGraceMs?: number; interruptTimeoutMs?: number; redirectWindowMs?: number };
  } = {},
): Promise<FakeRun> {
  const dir = await mkdtemp(join(tmpdir(), 'ms-stream-'));
  const logFile = join(dir, 'stdin.jsonl');
  const spy: StdinSpy = { writes: [], ends: [], afterClose: [] };
  const spawnSpy = ((cmd: string, args: string[], o: Parameters<typeof spawn>[2]) => {
    const child = spawn(cmd, args, {
      ...o,
      env: { ...o?.env, FAKE_STREAM_MODE: mode, FAKE_STREAM_LOG: logFile, FAKE_STREAM_TOOL_MS: String(opts.toolMs ?? 400) },
    }) as ChildProcess;
    if (child.pid) startedPids.add(child.pid);
    const stdin = child.stdin!;
    let ended = false;
    const write = stdin.write.bind(stdin) as (...a: unknown[]) => boolean;
    const end = stdin.end.bind(stdin) as (...a: unknown[]) => unknown;
    stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      (ended ? spy.afterClose : spy.writes).push(String(chunk));
      return write(chunk, ...rest);
    }) as typeof stdin.write;
    stdin.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (ended && chunk !== undefined && typeof chunk !== 'function') spy.afterClose.push(String(chunk));
      spy.ends.push(typeof chunk === 'string' ? chunk : undefined);
      ended = true;
      return end(chunk, ...rest);
    }) as typeof stdin.end;
    return child;
  }) as unknown as typeof spawn;
  const runner = new ClaudeCodeRunner([process.execPath, FAKE_STREAM], { killGraceMs: 200, ...opts.runner, spawn: spawnSpy });
  const events: AgentEvent[] = [];
  const cwd = await mkdtemp(join(tmpdir(), 'ms-stream-cwd-'));
  const handle = runner.start({ cwd, prompt: opts.prompt ?? 'first', ...(opts.capabilities ? { capabilities: opts.capabilities } : {}) }, (e) => {
    events.push(e);
    if (e.kind === 'stderr') {
      const m = /^(?:fake|child)-pid: (\d+)$/.exec(e.text);
      if (m) startedPids.add(Number(m[1]));
    }
  });
  const pids = () => events.flatMap((e) => {
    const m = e.kind === 'stderr' ? /^(?:fake|child)-pid: (\d+)$/.exec(e.text) : null;
    return m ? [Number(m[1])] : [];
  });
  const received = async () => {
    const raw = await readFile(logFile, 'utf8').catch(() => '');
    const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { line?: string; eof?: boolean });
    const lines = rows.filter((r) => r.line !== undefined).map((r) => JSON.parse(r.line!));
    const eofAt = rows.findIndex((r) => r.eof);
    return { lines, eof: eofAt >= 0, eofAfterLines: eofAt >= 0 ? rows.slice(0, eofAt).filter((r) => r.line !== undefined).length : -1 };
  };
  return { handle, events, spy, received, pids };
}

export const waitForEvent = (events: AgentEvent[], pred: (e: AgentEvent) => boolean, timeout = 10_000) =>
  vi.waitFor(() => { if (!events.some(pred)) throw new Error('event not yet'); }, { timeout, interval: 10 });

/** No orphans: every PID this run started is gone (polled: SIGKILL escalation takes killGraceMs). */
export async function expectNoOrphans(run: FakeRun, timeout = 5_000) {
  const pids = run.pids();
  if (pids.length === 0) throw new Error('the fake reported no pid');
  await vi.waitFor(() => { for (const p of pids) if (alive(p)) throw new Error(`pid ${p} still alive`); }, { timeout, interval: 25 });
}

/** afterEach: SIGKILL only the PIDs the tests started (never by pattern). */
export function killStarted() {
  for (const pid of startedPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  startedPids.clear();
}

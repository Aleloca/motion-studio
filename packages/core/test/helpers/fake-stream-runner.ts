import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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

/**
 * Every PID a test started (fake leader and its children, read from the fake's stderr), mapped to the leader whose
 * process group it belongs to. Only these are ever signalled, and only while verified alive and still in that group.
 */
export const startedPids = new Map<number, number>();

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
    ackGapMs?: number;
    /** Extra FAKE_STREAM_* variables (e.g. FAKE_STREAM_INTERRUPTED_EXIT, FAKE_STREAM_ACK_ID). */
    env?: Record<string, string>;
    runner?: { killGraceMs?: number; interruptTimeoutMs?: number; redirectBackstopMs?: number };
  } = {},
): Promise<FakeRun> {
  const dir = await mkdtemp(join(tmpdir(), 'ms-stream-'));
  const logFile = join(dir, 'stdin.jsonl');
  const spy: StdinSpy = { writes: [], ends: [], afterClose: [] };
  let leader = 0;
  const spawnSpy = ((cmd: string, args: string[], o: Parameters<typeof spawn>[2]) => {
    const child = spawn(cmd, args, {
      ...o,
      env: { ...o?.env, FAKE_STREAM_MODE: mode, FAKE_STREAM_LOG: logFile, FAKE_STREAM_TOOL_MS: String(opts.toolMs ?? 400), FAKE_STREAM_ACK_GAP_MS: String(opts.ackGapMs ?? 0), ...opts.env },
    }) as ChildProcess;
    if (child.pid) { leader = child.pid; startedPids.set(child.pid, child.pid); }
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
      if (m && leader) startedPids.set(Number(m[1]), leader);
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
  // Confirmed gone: never signalled again (the number may be reused by another process).
  for (const p of pids) startedPids.delete(p);
}

/** Process group of a live pid, or null (gone or unreadable). */
function groupOf(pid: number): number | null {
  const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const g = Number.parseInt(r.stdout.trim(), 10);
  return r.status === 0 && Number.isSafeInteger(g) ? g : null;
}

/**
 * afterEach: SIGKILL a recorded own PID only when it is verified alive at that moment and still in the process group of
 * the fake leader that started it (never by pattern, never a PID already confirmed dead).
 */
export function killStarted() {
  for (const [pid, leaderPid] of startedPids) {
    if (alive(pid) && groupOf(pid) === leaderPid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  startedPids.clear();
}

/**
 * Runner review fixes: a scripted child for orderings a real process cannot be made to produce on demand (an `exit`
 * before the last stdout lines, two results in one chunk). Nothing is spawned: the test writes the CLI's stdout lines
 * and emits `exit`/`close` itself, and reads what the runner wrote to stdin.
 */
export interface ScriptedRun {
  handle: AgentRun;
  events: AgentEvent[];
  /** Writes these stream-json objects (or raw text) to stdout in ONE chunk. */
  out(...items: (object | string)[]): void;
  /** What the runner wrote to stdin, parsed. */
  stdin(): Array<{ type?: string; request_id?: string; message?: { content?: unknown } }>;
  /** The request_id of the last control_request written. */
  lastRequestId(): string;
  exit(code: number): void;
  close(code: number): void;
  /** From now on every stdin write fails (EPIPE), as when the pipe breaks. */
  breakStdin(): void;
  /** Holds the callbacks of the next stdin writes (still written) until the returned function is called. */
  holdStdinCallbacks(): () => void;
}

export async function scriptedRun(capabilities: AgentTurnRequest['capabilities'], opts: { onEvent?: (e: AgentEvent, handle: AgentRun) => void; runner?: { interruptTimeoutMs?: number; drainMs?: number; redirectBackstopMs?: number } } = {}): Promise<ScriptedRun> {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const written: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: undefined, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
  });
  child.stdin.setEncoding('utf8').on('data', (c: string) => { written.push(c); });
  const runner = new ClaudeCodeRunner(['fake-claude'], { killGraceMs: 50, drainMs: 2000, ...opts.runner, spawn: (() => child) as unknown as typeof spawn });
  const events: AgentEvent[] = [];
  const cwd = await mkdtemp(join(tmpdir(), 'ms-scripted-cwd-'));
  let handle!: AgentRun;
  handle = runner.start({ cwd, prompt: 'first', ...(capabilities ? { capabilities } : {}) }, (e) => { events.push(e); opts.onEvent?.(e, handle); });
  const stdin = () => written.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    handle, events, stdin,
    out: (...items) => { child.stdout.write(items.map((i) => (typeof i === 'string' ? i : `${JSON.stringify(i)}\n`)).join('')); },
    lastRequestId: () => stdin().filter((l) => l.type === 'control_request').at(-1)!.request_id!,
    exit: (code) => { child.emit('exit', code, null); },
    close: (code) => { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', code, null)); },
    holdStdinCallbacks: () => {
      const original = child.stdin.write.bind(child.stdin) as (chunk: unknown, cb?: (err?: Error | null) => void) => boolean;
      const held: Array<() => void> = [];
      (child.stdin as unknown as { write: unknown }).write = (chunk: unknown, cb?: (err?: Error | null) => void) => original(chunk, (err) => { held.push(() => cb?.(err)); });
      return () => {
        (child.stdin as unknown as { write: unknown }).write = original;
        for (const f of held.splice(0)) f();
      };
    },
    breakStdin: () => {
      (child.stdin as unknown as { write: unknown }).write = (_chunk: unknown, cb?: (err?: Error) => void) => { process.nextTick(() => cb?.(new Error('EPIPE'))); return false; };
    },
  };
}

/** Stream-json lines of the real CLI (2.1.301 shapes) for scripted runs. */
export const line = {
  text: (text: string) => ({ type: 'assistant', message: { id: `m-${text}`, content: [{ type: 'text', text }] } }),
  result: (subtype: string, text = subtype) => ({ type: 'result', subtype, is_error: subtype !== 'success', session_id: 'scripted', result: text }),
  /** `stillQueued` null: the ack does not say. */
  ack: (requestId: string, stillQueued: unknown[] | null = []) => ({ type: 'control_response', response: { subtype: 'success', request_id: requestId, ...(stillQueued ? { response: { still_queued: stillQueued } } : {}) } }),
};
/** Lets pending stream callbacks run (stdin writes, stdout data). */
export const tick = () => new Promise((r) => setTimeout(r, 20));

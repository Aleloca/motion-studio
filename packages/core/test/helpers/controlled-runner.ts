import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@motion-studio/shared';
import type { AgentRun, AgentRunner, AgentRunResult, AgentTurnRequest } from '../../src/agent/runner.ts';
import { parseStudioBlock } from '../../src/creatives/prompt.ts';

/**
 * Phase 13 test double: an in-process AgentRunner whose runs the test drives step by step (Review Focus 1: controllable
 * timing). Each run emits its `session` event at start (unless its resumed session is in `missingSessions`: then it fails at
 * once, like Claude Code with an unknown `--resume` id), takes `send`/`interrupt` only when the launcher passed the
 * capabilities, and ends only when the test calls `finish` (or the core cancels it). No process, no network.
 */
export interface ControlledRun {
  req: AgentTurnRequest;
  sessionId: string;
  sent: Array<{ text: string; clientId: string }>;
  interrupts: number;
  cancelled: boolean;
  /** The input is closed (a result came, or the run ended): `send` answers 'closed'. */
  inputClosed: boolean;
  emit(e: AgentEvent): void;
  /** Writes the media outputs the prompt asks for (`write`, default true), emits an ok result and ends the run. */
  finish(o?: { write?: boolean; ok?: boolean; error?: string }): void;
  /** Emits the final result now (closing the input) but ends the run only later with `end()`: the edge of the turn. */
  resultOnly(o?: { write?: boolean }): void;
  end(): void;
  done: Promise<AgentRunResult>;
}

export class ControlledRunner implements AgentRunner {
  readonly runs: ControlledRun[] = [];
  /** What `interrupt` answers when the capability is on. */
  interruptAnswer: 'interrupted' | 'unsupported' | 'timeout' = 'interrupted';
  /** Resumed sessions that "no longer exist": a run resuming one fails before any session event. */
  readonly missingSessions = new Set<string>();
  /**
   * Fix round 1: decides, per started run, an immediate failure (`null`: none). `output`: the run first writes some text as
   * the agent; `session`: it first reports its session; `startFailed`: the CLI could not even start.
   */
  failStart: ((req: AgentTurnRequest) => { error: string; startFailed?: boolean; output?: boolean; session?: boolean } | null) | null = null;
  /**
   * Each session's messages, as Claude Code keeps them (final wave P4): a resume without a fork appends to the same session
   * (the id stays), a fork copies the parent's messages into a new session, no resume starts a new one. Prompts and the
   * messages written with `send` are recorded; a run that fails before its session event records nothing.
   */
  readonly transcripts = new Map<string, string[]>();
  /** Final wave P3: runs that start without reporting their session (as a CLI cut before it read its prompt). */
  quietStart: ((req: AgentTurnRequest) => boolean) | null = null;
  private waiters: Array<(r: ControlledRun) => void> = [];
  private counter = 0;

  /** The next run (already started, or the next one to start). */
  next(index = this.runs.length): Promise<ControlledRun> {
    const have = this.runs[index];
    if (have) return Promise.resolve(have);
    return new Promise((resolve) => {
      const check = (r: ControlledRun) => { if (this.runs.indexOf(r) === index) resolve(r); else this.waiters.push(check); };
      this.waiters.push(check);
    });
  }

  start(req: AgentTurnRequest, onEvent: (e: AgentEvent) => void): AgentRun {
    let settle!: (r: AgentRunResult) => void;
    const done = new Promise<AgentRunResult>((r) => { settle = r; });
    const id = ++this.counter;
    const sessionId = req.resumeSessionId ? (req.forkSession ? `${req.resumeSessionId}-fork${id}` : req.resumeSessionId) : `session-${id}`;
    let ended = false;
    const caps = req.capabilities ?? { liveInput: false, interrupt: false };
    const write = () => {
      const block = parseStudioBlock(req.prompt);
      if (!block) return;
      const out = join(req.cwd, block.outputDir);
      mkdirSync(out, { recursive: true });
      const files = block.formats.map((f) => {
        const file = `${f.id}.${f.extensions[0]}`;
        writeFileSync(join(out, file), `fake-media:${f.id}:${id}`);
        return { format: f.id, file, width: f.width, height: f.height, ...(f.kind === 'video' ? { durationSec: block.durationSec ?? 10 } : {}) };
      });
      writeFileSync(join(out, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files, tools: ['fake'], renderCommand: 'node render.js' }));
    };
    const finishWith = (r: AgentRunResult) => { if (ended) return; ended = true; run.inputClosed = true; settle(r); };
    const run: ControlledRun = {
      req, sessionId, sent: [], interrupts: 0, cancelled: false, inputClosed: !caps.liveInput, done,
      emit: (e) => { if (!ended) onEvent(e); },
      finish: (o = {}) => {
        if (ended) return;
        if (o.write !== false) write();
        onEvent({ kind: 'result', ok: o.ok !== false, sessionId, ...(o.error ? { error: o.error } : {}) });
        finishWith(o.ok === false ? { status: 'failed', sessionId, error: o.error ?? 'failed' } : { status: 'succeeded', sessionId });
      },
      resultOnly: (o = {}) => {
        if (o.write !== false) write();
        onEvent({ kind: 'result', ok: true, sessionId });
        run.inputClosed = true;
      },
      end: () => finishWith({ status: 'succeeded', sessionId }),
    };
    this.runs.push(run);
    const failure = this.failStart?.(req) ?? null;
    if (failure) {
      queueMicrotask(() => {
        if (failure.session) onEvent({ kind: 'session', sessionId });
        if (failure.output) onEvent({ kind: 'text', text: 'working' });
        finishWith({ status: 'failed', error: failure.error, ...(failure.startFailed ? { startFailed: true } : {}) });
      });
    } else if (req.resumeSessionId && this.missingSessions.has(req.resumeSessionId)) {
      queueMicrotask(() => finishWith({ status: 'failed', error: `No conversation found with session ID: ${req.resumeSessionId}` }));
    } else if (this.quietStart?.(req)) {
      // Started, but no session event yet: the test cuts it or emits one itself.
    } else {
      const parent = req.resumeSessionId ? this.transcripts.get(req.resumeSessionId) ?? [] : [];
      const transcript = req.resumeSessionId && !req.forkSession ? parent : [...parent];
      transcript.push(req.prompt);
      this.transcripts.set(sessionId, transcript);
      queueMicrotask(() => onEvent({ kind: 'session', sessionId }));
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(run);
    return {
      done,
      cancel: () => { if (ended) return; run.cancelled = true; finishWith({ status: 'cancelled', sessionId }); },
      killGroup: () => {},
      send: async (m) => {
        if (!caps.liveInput || run.inputClosed || ended) return 'closed';
        run.sent.push(m);
        this.transcripts.get(sessionId)?.push(m.text);
        onEvent({ kind: 'user_message_delivered', clientId: m.clientId });
        return 'written';
      },
      interrupt: async () => {
        if (!caps.interrupt || run.inputClosed || ended) return 'unsupported';
        run.interrupts++;
        if (this.interruptAnswer === 'interrupted') onEvent({ kind: 'interrupted' });
        return this.interruptAnswer;
      },
      endInput: () => { run.inputClosed = true; },
    };
  }
}

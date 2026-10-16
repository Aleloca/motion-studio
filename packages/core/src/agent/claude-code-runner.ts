import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isSessionId, type AgentEvent } from '@motion-studio/shared';
import { ClaudeStreamParser, LineSplitter, type ControlResponse } from './claude-stream-parser.ts';
import type { AgentRun, AgentRunner, AgentRunResult, AgentTurnRequest } from './runner.ts';
import { t } from '../i18n.ts';

export function buildClaudeArgs(req: AgentTurnRequest): string[] {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
  ];
  // Without a prompt tool anything that would prompt is denied; with one, prompts reach the app (phase 4 approvals).
  if (req.permissionPromptTool) args.push('--permission-prompt-tool', req.permissionPromptTool);
  else args.push('--permission-prompts', 'none');
  // Final review I1: a stored session id reaches argv only when it is a plain id (never starting with '-', so it can never be
  // read as a flag). Anything else is ignored (a new session starts). Ruling Y: the verified two-argument form.
  if (isSessionId(req.resumeSessionId)) {
    args.push('--resume', req.resumeSessionId);
    if (req.forkSession) args.push('--fork-session');
  }
  for (const d of req.addDirs ?? []) args.push('--add-dir', d);
  if (req.model) args.push('--model', req.model);
  if (req.settings) args.push('--settings', JSON.stringify(req.settings));
  if (req.mcpConfigPath) args.push('--strict-mcp-config', '--mcp-config', req.mcpConfigPath);
  // Both rule flags are variadic: deny first, allow last, so each group is ended by the next flag and cannot swallow others.
  if (req.disallowedTools?.length) args.push('--disallowedTools', ...req.disallowedTools);
  // Variadic flag: kept last so it cannot swallow other flags (the prompt travels on stdin, there are no positionals).
  if (req.allowedTools?.length) args.push('--allowedTools', ...req.allowedTools);
  return args;
}

export function claudeCommandFromEnv(): string[] {
  const raw = process.env.MOTION_STUDIO_CLAUDE_COMMAND;
  if (!raw) return ['claude'];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(t().errors.claudeCommandInvalidJson({ detail: (err as Error).message }));
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((p) => typeof p === 'string')) {
    throw new Error(t().errors.claudeCommandNotArray);
  }
  return parsed;
}

const STDERR_TAIL = 20;

/** How long `interrupt()` waits for the matching `control_response` (plan Task 1: 5 s). */
export const INTERRUPT_TIMEOUT_MS = 5000;
/**
 * After an acknowledged interrupt stdin stays open until the core decides: a redirect message (`send`), `endInput()`
 * or cancel. This backstop closes it when no decision came, so a crashed caller cannot leave the CLI idling forever.
 */
export const REDIRECT_BACKSTOP_MS = 45_000;

/*
 * Phase 13 message shapes, from the public docs, measured on Claude Code 2.1.301 by the user's probe (decision 804;
 * docs/superpowers/notes/2026-10-16-stream-input-probe.md):
 * - user message on stdin (SDKUserMessage): { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
 *   https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode , https://code.claude.com/docs/en/agent-sdk/typescript
 *   A second message written mid-turn was accepted and answered with its own `result` (two inputs, two results).
 * - interrupt: { type: 'control_request', request_id, request: { subtype: 'interrupt' } }, answered by
 *   { type: 'control_response', response: { subtype: 'success', request_id, response: { still_queued: [] } } }; the turn then
 *   ends with a `result` of subtype `error_during_execution` and the process exits with code 1.
 * `user_message_delivered` is emitted once the write is flushed and means "sent"; `user_message_read` only on the CLI's
 * evidence (see `user_message_read` in shared/events.ts).
 */
const userMessageLine = (text: string) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })}\n`;
const interruptLine = (requestId: string) => `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } })}\n`;

/** The `result` subtype of a turn the CLI stopped on our interrupt (measured on 2.1.301, decision 804). */
export const INTERRUPTED_RESULT_SUBTYPE = 'error_during_execution';

/** The interrupted turn's result as the core sees it: not ok, not a failure (no `error`), marked `interrupted`. */
const asInterrupted = (e: Extract<AgentEvent, { kind: 'result' }>): AgentEvent => {
  const { error: _error, ...rest } = e;
  return { ...rest, ok: false, interrupted: true };
};

/** Windows: the command that force-kills `pid` and all its descendants. */
export const treeKillCommand = (pid: number): [string, string[]] => ['taskkill', ['/PID', String(pid), '/T', '/F']];

export class ClaudeCodeRunner implements AgentRunner {
  private readonly killGraceMs: number;
  private readonly drainMs: number;
  private readonly interruptTimeoutMs: number;
  private readonly redirectBackstopMs: number;
  private readonly spawnFn: typeof spawn;
  /**
   * killGraceMs: SIGTERM → SIGKILL delay on cancel.
   * drainMs: how long to wait for stdout/stderr to close after claude exited before giving up on them
   * (a descendant that inherited the pipes can keep them open forever).
   * interruptTimeoutMs / redirectBackstopMs: see INTERRUPT_TIMEOUT_MS / REDIRECT_BACKSTOP_MS. spawn: test seam (stdin spy).
   */
  constructor(
    private readonly claudeCommand: string[] = ['claude'],
    opts: { killGraceMs?: number; drainMs?: number; interruptTimeoutMs?: number; redirectBackstopMs?: number; spawn?: typeof spawn } = {},
  ) {
    this.killGraceMs = opts.killGraceMs ?? 3000;
    this.drainMs = opts.drainMs ?? 1500;
    this.interruptTimeoutMs = opts.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS;
    this.redirectBackstopMs = opts.redirectBackstopMs ?? REDIRECT_BACKSTOP_MS;
    this.spawnFn = opts.spawn ?? spawn;
  }

  start(req: AgentTurnRequest, onEvent: (e: AgentEvent) => void): AgentRun {
    const [bin, ...prefix] = this.claudeCommand;
    if (!bin) throw new Error(t().errors.claudeCommandEmpty);
    let cwdIsDir = false;
    try { cwdIsDir = statSync(req.cwd).isDirectory(); } catch { /* reported below */ }
    if (!cwdIsDir) {
      return {
        done: Promise.resolve({ status: 'failed', error: t().providers.projectFolderMissing({ path: req.cwd }), startFailed: true }),
        cancel: () => {},
        send: async () => 'closed',
        interrupt: async () => 'unsupported',
        endInput: () => {},
      };
    }
    const posix = process.platform !== 'win32';
    // Own process group on POSIX so cancel can reach descendants (tool commands, MCP servers).
    const env: NodeJS.ProcessEnv = { ...process.env, ...req.env };
    for (const k of req.unsetEnv ?? []) delete env[k];
    const child = this.spawnFn(bin, [...prefix, ...buildClaudeArgs(req)], { cwd: req.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: posix, env });
    const signal = (sig: NodeJS.Signals) => {
      try {
        // The group outlives its leader: this still reaches descendants after claude itself exited.
        if (posix && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* group already gone (ESRCH) */ }
    };
    let cancelled = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;
    let sessionId = req.resumeSessionId;
    let result: Extract<AgentEvent, { kind: 'result' }> | undefined;
    const stderrTail: string[] = [];
    const stdout = new LineSplitter();
    // Per run: keeps the live usage estimate (sum per message id, throttled, with a trailing flush).
    // The timer only fires after this function returned, when `emit` (declared below) exists.
    /**
     * The raw subtype of the result line being handled: the parser reports it just before that line's events, and stdout
     * is parsed and emitted line by line, so two results in one chunk never mix their subtypes.
     */
    let resultSubtype: string | null = null;
    const parser = new ClaudeStreamParser({ onLive: (e) => emit(e), onControlResponse: (r) => onControl(r), onResult: (st) => { resultSubtype = st; } });
    const stderr = new LineSplitter();

    // Phase 13 (decision 804): stdin stays open only with live input on; otherwise the prompt is written with end()
    // and nothing else is ever written, exactly as before.
    const liveInput = req.capabilities?.liveInput === true;
    const canInterrupt = liveInput && req.capabilities?.interrupt === true;
    let stdinOpen = false;
    /** An interrupt was acknowledged in this run. */
    let interruptAcked = false;
    /** A user message was written after the last acknowledgement (a redirect): its turn's outcome is the real one. */
    let redirectWritten = false;
    /** Acknowledged, and the core has not decided yet (send, endInput, cancel): no result closes stdin. */
    let awaitingDecision = false;
    /** The next result is the interrupted turn's own: it never closes stdin (the decision, if any, follows it). */
    let interruptedResultPending = false;
    /** The last result is an interrupted turn's (error_during_execution): with the ack, a stop, not a failure. */
    let lastResultInterruptedShape = false;
    let backstopTimer: NodeJS.Timeout | undefined;
    /**
     * Decision 804: the interrupted turn's result can come before the acknowledgement. While an interrupt is pending, such
     * a result (and every event after it) is held, and released when the interrupt is answered: marked `interrupted`
     * on the ack, unchanged otherwise (no ack, an error ack, the process gone). The bookkeeping (stdin, outcome) is not held.
     */
    let held: AgentEvent[] | null = null;
    let heldResult: AgentEvent | null = null;
    // One outgoing queue, drained in order: an event emitted while a listener runs (e.g. a listener that cancels, which
    // flushes stdout) goes after the events already on their way, never between them.
    const outbox: AgentEvent[] = [];
    let draining = false;
    const dispatch = (...list: AgentEvent[]) => {
      outbox.push(...list);
      if (draining) return;
      draining = true;
      try {
        while (outbox.length > 0) {
          const x = outbox.shift()!;
          try {
            onEvent(x);
          } catch { /* a faulty listener must not crash the process nor lose the turn outcome */ }
        }
      } finally { draining = false; }
    };
    const release = (interrupted: boolean) => {
      if (!held) return;
      const list = held;
      const r = heldResult;
      held = null;
      heldResult = null;
      // All at once into the queue, so an event a listener causes meanwhile goes after the whole released list.
      dispatch(...list.map((x) => (x === r && interrupted && x.kind === 'result' ? asInterrupted(x) : x)));
    };
    /**
     * Decision 804, "read" evidence: the inputs written after the prompt (input 0), in order, with their input number.
     * Input k is read once the k-th result came and the agent produced new output after it (its turn started).
     */
    const writtenInputs: { clientId: string; input: number }[] = [];
    let inputsWritten = 1;
    let resultsSeen = 0;
    /** Bumped by each acknowledged interrupt: a write still in flight from before it is not tracked (see onControl). */
    let inputEpoch = 0;
    const pendingInterrupts = new Map<string, (r: 'interrupted' | 'unsupported' | 'timeout') => void>();
    const closeStdin = () => {
      awaitingDecision = false;
      if (backstopTimer) { clearTimeout(backstopTimer); backstopTimer = undefined; }
      if (!stdinOpen) return;
      stdinOpen = false;
      try { child.stdin.end(); } catch { /* already gone */ }
    };
    const dropPendingInterrupts = () => { for (const r of [...pendingInterrupts.values()]) r('timeout'); };

    const emit = (e: AgentEvent) => {
      if (e.kind === 'session') sessionId = e.sessionId;
      let out = e;
      let ofInterrupted = false;
      if (e.kind === 'result') {
        result = e;
        if (e.sessionId) sessionId = e.sessionId;
        resultsSeen++;
        ofInterrupted = interruptedResultPending;
        interruptedResultPending = false;
        lastResultInterruptedShape = !e.ok && resultSubtype === INTERRUPTED_RESULT_SUBTYPE;
        resultSubtype = null;
        // The ack came first: this is the stopped turn's result. Otherwise, with an interrupt pending, wait for its answer.
        if (lastResultInterruptedShape && ofInterrupted) out = asInterrupted(e);
        else if (lastResultInterruptedShape && pendingInterrupts.size > 0 && !held) { held = []; heldResult = e; }
      } else if ((e.kind === 'text' || e.kind === 'tool_use') && writtenInputs.length > 0) {
        // New output after the k-th result: the turn of input k started, so the CLI took it (and every input before it).
        while (writtenInputs.length > 0 && writtenInputs[0]!.input <= resultsSeen) {
          const read: AgentEvent = { kind: 'user_message_read', clientId: writtenInputs.shift()!.clientId };
          if (held) held.push(read); else dispatch(read);
        }
      }
      if (held) held.push(out); else dispatch(out);
      // The final result closes stdin (a message written before it is already in the pipe and is still read). After an
      // acknowledged interrupt, the interrupted turn's own result never closes it, and no result does until the core
      // decides (a redirect `send`, `endInput()`, cancel) or the backstop fires: then the redirect turn's result closes it.
      if (e.kind === 'result' && stdinOpen && !ofInterrupted && !awaitingDecision) closeStdin();
    };
    const onControl = (r: ControlResponse) => {
      const pending = pendingInterrupts.get(r.requestId);
      if (!pending) return;
      // The stop is acknowledged even when the interrupted turn's result came first and already closed stdin: that turn
      // then ends as cancelled, not failed (no redirect can follow it).
      if (r.ok) {
        interruptAcked = true;
        redirectWritten = false;
        // Unless the stopped turn's result already came (held, released below as interrupted), the next result is that
        // turn's own, also when stdin was closed meanwhile (e.g. by an earlier, unrelated error result).
        if (!heldResult) interruptedResultPending = true;
        // "Read" evidence after a stop: whether the CLI still runs the inputs written before the interrupt is not
        // measured (2.1.301 answered `still_queued: []`, whose items' shape is unknown), so they stop being tracked and
        // stay "sent". Inputs written from now on count from the result after the stopped turn's.
        writtenInputs.length = 0;
        inputEpoch++;
        inputsWritten = heldResult ? resultsSeen : resultsSeen + 1;
      }
      if (r.ok && stdinOpen) {
        awaitingDecision = true;
        if (backstopTimer) clearTimeout(backstopTimer);
        backstopTimer = setTimeout(closeStdin, this.redirectBackstopMs);
      }
      if (r.ok) emit({ kind: 'interrupted' });
      pending(r.ok ? 'interrupted' : 'unsupported');
    };
    // Line by line: each line's events are emitted before the next line is parsed (the result subtype above relies on it).
    const parseLines = (lines: string[]) => { for (const l of lines) parser.parse(l).forEach(emit); };
    child.stdout.setEncoding('utf8').on('data', (c: string) => parseLines(stdout.push(c)));
    child.stderr.setEncoding('utf8').on('data', (c: string) => {
      for (const text of stderr.push(c)) {
        stderrTail.push(text);
        if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
        emit({ kind: 'stderr', text });
      }
    });
    // The process may exit before reading stdin: an errored or closed stdin is never written again.
    child.stdin.on('error', () => { closeStdin(); });
    child.stdin.on('close', () => { closeStdin(); });
    const firstLine = `${JSON.stringify({ type: 'user', message: { role: 'user', content: req.prompt } })}\n`;
    if (liveInput) { stdinOpen = true; child.stdin.write(firstLine); } else child.stdin.end(firstLine);

    let finish: (opts?: { abandonPipes?: boolean }) => void = () => {};
    const done = new Promise<AgentRunResult>((resolve) => {
      const settle = (r: AgentRunResult) => {
        if (settled) return;
        settled = true;
        parser.stop();
        closeStdin();
        dropPendingInterrupts();
        release(false);
        if (drainTimer) clearTimeout(drainTimer);
        resolve(sessionId ? { ...r, sessionId } : r);
      };
      // Single outcome logic for 'close', the post-exit drain timeout and a cancel after exit.
      finish = ({ abandonPipes = false } = {}) => {
        if (settled) return;
        parseLines(stdout.flush());
        parser.end().forEach(emit);
        if (abandonPipes) { child.stdout.destroy(); child.stderr.destroy(); }
        // An ok result is the real outcome even if a cancel arrived afterwards.
        if (result?.ok) return settle({ status: 'succeeded' });
        if (cancelled) return settle({ status: 'cancelled' });
        // The user stopped the step and no redirect followed: the CLI acknowledged our interrupt and ended the turn with
        // error_during_execution (2.1.301 then exits with code 1, decision 804): a stop, not a failure. Without the ack,
        // or with any other error, the turn failed. A redirect turn's failure is its own.
        if (interruptAcked && !redirectWritten && result && lastResultInterruptedShape) return settle({ status: 'cancelled' });
        if (result) return settle({ status: 'failed', error: result.error ?? t().errors.turnFailed });
        const tail = stderrTail.join('\n');
        settle({ status: 'failed', error: `${t().providers.claudeExited({ code: String(exited?.code ?? exited?.signal) })}${tail ? `: ${tail}` : ''}` });
      };
      child.on('exit', (code, sig) => {
        exited = { code, signal: sig };
        // Nothing can read stdin any more: later sends resolve 'closed'. A pending interrupt is NOT dropped here: its ack
        // may still sit in the stdout pipe (stdio can outlive 'exit'); it resolves on its own timer or in settle, which
        // comes only after stdout and the parser are flushed.
        closeStdin();
        // Descendants may keep the pipes open, so 'close' may never come: after a cancel resolve now,
        // otherwise give the pipes a short drain window.
        if (cancelled) return finish({ abandonPipes: true });
        drainTimer = setTimeout(() => finish({ abandonPipes: true }), this.drainMs);
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        settle(err.code === 'ENOENT'
          ? { status: 'failed', error: t().providers.claudeNotFound({ bin }), startFailed: true }
          : { status: 'failed', error: t().providers.claudeCannotStart({ detail: err.message }), startFailed: true });
      });
      child.on('close', (code, sig) => { exited ??= { code, signal: sig }; finish(); });
    });

    return {
      done,
      cancel: () => {
        if (cancelled || settled) return;
        cancelled = true;
        closeStdin();
        dropPendingInterrupts();
        signal('SIGTERM');
        // Unconditional: descendants can ignore SIGTERM even when the leader is gone.
        setTimeout(() => signal('SIGKILL'), this.killGraceMs).unref();
        if (exited) finish({ abandonPipes: true });
      },
      // POSIX: the whole group, also after the leader exited. Windows has no groups: a tree kill reaches the descendants
      // only while the leader is alive (after it exits they are orphaned and out of reach; documented limit).
      killGroup: () => {
        if (posix) return signal('SIGKILL');
        if (!child.pid || exited) return;
        const [cmd, args] = treeKillCommand(child.pid);
        try { spawn(cmd, args, { stdio: 'ignore', windowsHide: true }).on('error', () => {}); } catch { /* best effort */ }
      },
      // Phase 13: the core's "no redirect" decision after an interrupt (or any time): close stdin now. No-op when off.
      endInput: () => { if (liveInput) closeStdin(); },
      send: ({ text, clientId }) => {
        if (!liveInput || !stdinOpen || exited || settled || cancelled) return Promise.resolve('closed' as const);
        // After an acknowledged interrupt this is the core's decision (a redirect): the backstop is off, and the redirect
        // turn's result closes stdin as usual (live sends during that turn are still written).
        const redirectBefore = redirectWritten;
        if (awaitingDecision) {
          awaitingDecision = false;
          redirectWritten = true;
          if (backstopTimer) { clearTimeout(backstopTimer); backstopTimer = undefined; }
        } else if (interruptAcked) redirectWritten = true;
        // A write that failed was no redirect: the stopped turn's outcome stays a stop.
        const failed = () => { stdinOpen = false; redirectWritten = redirectBefore; };
        return new Promise<'written' | 'closed'>((resolve) => {
          try {
            const input = inputsWritten++;
            const epoch = inputEpoch;
            child.stdin.write(userMessageLine(text), (err) => {
              if (err) { failed(); return resolve('closed'); }
              if (epoch === inputEpoch) writtenInputs.push({ clientId, input });
              emit({ kind: 'user_message_delivered', clientId });
              resolve('written');
            });
          } catch { failed(); resolve('closed'); }
        });
      },
      interrupt: () => {
        if (!canInterrupt || !stdinOpen || exited || settled || cancelled) return Promise.resolve('unsupported' as const);
        const requestId = `ms-interrupt-${randomUUID()}`;
        return new Promise<'interrupted' | 'unsupported' | 'timeout'>((resolve) => {
          const timer = setTimeout(() => answer('timeout'), this.interruptTimeoutMs);
          const answer = (r: 'interrupted' | 'unsupported' | 'timeout') => {
            if (!pendingInterrupts.delete(requestId)) return;
            clearTimeout(timer);
            release(r === 'interrupted');
            resolve(r);
          };
          pendingInterrupts.set(requestId, answer);
          try {
            child.stdin.write(interruptLine(requestId), (err) => { if (err) answer('unsupported'); });
          } catch { answer('unsupported'); }
        });
      },
    };
  }
}

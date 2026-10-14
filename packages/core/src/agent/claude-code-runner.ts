import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { AgentEvent } from '@motion-studio/shared';
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
  if (req.resumeSessionId) {
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
 * Phase 13 message shapes, from the public docs and UNVERIFIED LIVE for the installed CLI (the spike was suspended,
 * decisions log 610; docs/superpowers/notes/2026-10-14-phase13-stream-input-spike.md):
 * - user message on stdin (SDKUserMessage): { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
 *   https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode , https://code.claude.com/docs/en/agent-sdk/typescript
 * - interrupt: { type: 'control_request', request_id, request: { subtype: 'interrupt' } }, answered by a
 *   { type: 'control_response', response: { subtype: 'success' | 'error', request_id, … } } echoing request_id
 *   https://code.claude.com/docs/en/agent-sdk/typescript (the envelope; the response wrapper is the SDK's, not quoted there)
 * There is no verified evidence that the CLI consumed a written message, so `user_message_delivered` is emitted once
 * the write is flushed and means "sent".
 */
const userMessageLine = (text: string) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })}\n`;
const interruptLine = (requestId: string) => `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } })}\n`;

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
        done: Promise.resolve({ status: 'failed', error: t().providers.projectFolderMissing({ path: req.cwd }) }),
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
    const parser = new ClaudeStreamParser({ onLive: (e) => emit(e), onControlResponse: (r) => onControl(r) });
    const stderr = new LineSplitter();

    // Phase 13 (decisions log 610): stdin stays open only with live input on; otherwise the prompt is written with end()
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
    let backstopTimer: NodeJS.Timeout | undefined;
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
      if (e.kind === 'result') { result = e; if (e.sessionId) sessionId = e.sessionId; }
      try {
        onEvent(e);
      } catch { /* a faulty listener must not crash the process nor lose the turn outcome */ }
      // The final result closes stdin (a message written before it is already in the pipe and is still read). After an
      // acknowledged interrupt, the interrupted turn's own result never closes it, and no result does until the core
      // decides (a redirect `send`, `endInput()`, cancel) or the backstop fires: then the redirect turn's result closes it.
      if (e.kind === 'result' && stdinOpen) {
        if (interruptedResultPending) interruptedResultPending = false;
        else if (!awaitingDecision) closeStdin();
      }
    };
    const onControl = (r: ControlResponse) => {
      const pending = pendingInterrupts.get(r.requestId);
      if (!pending) return;
      if (r.ok && stdinOpen) {
        interruptAcked = true;
        redirectWritten = false;
        awaitingDecision = true;
        interruptedResultPending = true;
        if (backstopTimer) clearTimeout(backstopTimer);
        backstopTimer = setTimeout(closeStdin, this.redirectBackstopMs);
      }
      if (r.ok) emit({ kind: 'interrupted' });
      pending(r.ok ? 'interrupted' : 'unsupported');
    };
    child.stdout.setEncoding('utf8').on('data', (c: string) => stdout.push(c).flatMap((l) => parser.parse(l)).forEach(emit));
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
        if (drainTimer) clearTimeout(drainTimer);
        resolve(sessionId ? { ...r, sessionId } : r);
      };
      // Single outcome logic for 'close', the post-exit drain timeout and a cancel after exit.
      finish = ({ abandonPipes = false } = {}) => {
        if (settled) return;
        stdout.flush().flatMap((l) => parser.parse(l)).forEach(emit);
        parser.end().forEach(emit);
        if (abandonPipes) { child.stdout.destroy(); child.stderr.destroy(); }
        // An ok result is the real outcome even if a cancel arrived afterwards.
        if (result?.ok) return settle({ status: 'succeeded' });
        if (cancelled) return settle({ status: 'cancelled' });
        // The user stopped the step and no redirect followed: a stop, not a failure. A redirect turn's failure is its own.
        if (interruptAcked && !redirectWritten && result) return settle({ status: 'cancelled' });
        if (result) return settle({ status: 'failed', error: result.error ?? t().errors.turnFailed });
        const tail = stderrTail.join('\n');
        settle({ status: 'failed', error: `${t().providers.claudeExited({ code: String(exited?.code ?? exited?.signal) })}${tail ? `: ${tail}` : ''}` });
      };
      child.on('exit', (code, sig) => {
        exited = { code, signal: sig };
        // Nothing can read stdin any more: later sends resolve 'closed', a pending interrupt 'timeout' (no ack came).
        closeStdin();
        dropPendingInterrupts();
        // Descendants may keep the pipes open, so 'close' may never come: after a cancel resolve now,
        // otherwise give the pipes a short drain window.
        if (cancelled) return finish({ abandonPipes: true });
        drainTimer = setTimeout(() => finish({ abandonPipes: true }), this.drainMs);
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        settle(err.code === 'ENOENT'
          ? { status: 'failed', error: t().providers.claudeNotFound({ bin }) }
          : { status: 'failed', error: t().providers.claudeCannotStart({ detail: err.message }) });
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
        if (awaitingDecision) {
          awaitingDecision = false;
          redirectWritten = true;
          if (backstopTimer) { clearTimeout(backstopTimer); backstopTimer = undefined; }
        } else if (interruptAcked) redirectWritten = true;
        return new Promise<'written' | 'closed'>((resolve) => {
          try {
            child.stdin.write(userMessageLine(text), (err) => {
              if (err) { stdinOpen = false; return resolve('closed'); }
              emit({ kind: 'user_message_delivered', clientId });
              resolve('written');
            });
          } catch { stdinOpen = false; resolve('closed'); }
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

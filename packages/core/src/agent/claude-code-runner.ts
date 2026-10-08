import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import type { AgentEvent } from '@motion-studio/shared';
import { LineSplitter, parseClaudeLine } from './claude-stream-parser.ts';
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

export class ClaudeCodeRunner implements AgentRunner {
  private readonly killGraceMs: number;
  private readonly drainMs: number;
  /**
   * killGraceMs: SIGTERM → SIGKILL delay on cancel.
   * drainMs: how long to wait for stdout/stderr to close after claude exited before giving up on them
   * (a descendant that inherited the pipes can keep them open forever).
   */
  constructor(private readonly claudeCommand: string[] = ['claude'], opts: { killGraceMs?: number; drainMs?: number } = {}) {
    this.killGraceMs = opts.killGraceMs ?? 3000;
    this.drainMs = opts.drainMs ?? 1500;
  }

  start(req: AgentTurnRequest, onEvent: (e: AgentEvent) => void): AgentRun {
    const [bin, ...prefix] = this.claudeCommand;
    if (!bin) throw new Error(t().errors.claudeCommandEmpty);
    let cwdIsDir = false;
    try { cwdIsDir = statSync(req.cwd).isDirectory(); } catch { /* reported below */ }
    if (!cwdIsDir) {
      return {
        done: Promise.resolve({ status: 'failed', error: `Cartella del progetto non trovata: ${req.cwd}` }),
        cancel: () => {},
      };
    }
    const posix = process.platform !== 'win32';
    // Own process group on POSIX so cancel can reach descendants (tool commands, MCP servers).
    const env: NodeJS.ProcessEnv = { ...process.env, ...req.env };
    for (const k of req.unsetEnv ?? []) delete env[k];
    const child = spawn(bin, [...prefix, ...buildClaudeArgs(req)], { cwd: req.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: posix, env });
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
    const stderr = new LineSplitter();

    const emit = (e: AgentEvent) => {
      if (e.kind === 'session') sessionId = e.sessionId;
      if (e.kind === 'result') { result = e; if (e.sessionId) sessionId = e.sessionId; }
      try {
        onEvent(e);
      } catch { /* a faulty listener must not crash the process nor lose the turn outcome */ }
    };
    child.stdout.setEncoding('utf8').on('data', (c: string) => stdout.push(c).flatMap(parseClaudeLine).forEach(emit));
    child.stderr.setEncoding('utf8').on('data', (c: string) => {
      for (const text of stderr.push(c)) {
        stderrTail.push(text);
        if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
        emit({ kind: 'stderr', text });
      }
    });
    child.stdin.on('error', () => { /* process may exit before reading stdin */ });
    child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: req.prompt } })}\n`);

    let finish: (opts?: { abandonPipes?: boolean }) => void = () => {};
    const done = new Promise<AgentRunResult>((resolve) => {
      const settle = (r: AgentRunResult) => {
        if (settled) return;
        settled = true;
        if (drainTimer) clearTimeout(drainTimer);
        resolve(sessionId ? { ...r, sessionId } : r);
      };
      // Single outcome logic for 'close', the post-exit drain timeout and a cancel after exit.
      finish = ({ abandonPipes = false } = {}) => {
        if (settled) return;
        stdout.flush().flatMap(parseClaudeLine).forEach(emit);
        if (abandonPipes) { child.stdout.destroy(); child.stderr.destroy(); }
        // An ok result is the real outcome even if a cancel arrived afterwards.
        if (result?.ok) return settle({ status: 'succeeded' });
        if (cancelled) return settle({ status: 'cancelled' });
        if (result) return settle({ status: 'failed', error: result.error ?? 'Turno non riuscito' });
        const tail = stderrTail.join('\n');
        settle({ status: 'failed', error: `claude è terminato con codice ${exited?.code ?? exited?.signal} senza risultato${tail ? `: ${tail}` : ''}` });
      };
      child.on('exit', (code, sig) => {
        exited = { code, signal: sig };
        // Descendants may keep the pipes open, so 'close' may never come: after a cancel resolve now,
        // otherwise give the pipes a short drain window.
        if (cancelled) return finish({ abandonPipes: true });
        drainTimer = setTimeout(() => finish({ abandonPipes: true }), this.drainMs);
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        settle(err.code === 'ENOENT'
          ? { status: 'failed', error: `Comando claude non trovato (${bin}). Installa Claude Code o controlla il Doctor.` }
          : { status: 'failed', error: `Impossibile avviare claude: ${err.message}` });
      });
      child.on('close', (code, sig) => { exited ??= { code, signal: sig }; finish(); });
    });

    return {
      done,
      cancel: () => {
        if (cancelled || settled) return;
        cancelled = true;
        signal('SIGTERM');
        // Unconditional: descendants can ignore SIGTERM even when the leader is gone.
        setTimeout(() => signal('SIGKILL'), this.killGraceMs).unref();
        if (exited) finish({ abandonPipes: true });
      },
    };
  }
}

import { spawn } from 'node:child_process';
import type { AgentEvent } from '@motion-studio/shared';
import { LineSplitter, parseClaudeLine } from './claude-stream-parser.ts';
import type { AgentRun, AgentRunner, AgentRunResult, AgentTurnRequest } from './runner.ts';

export function buildClaudeArgs(req: AgentTurnRequest): string[] {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    // Phase 1: edits auto-accepted, anything that would prompt is denied. Phase 4 replaces this with UI approvals.
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
  ];
  if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
  for (const d of req.addDirs ?? []) args.push('--add-dir', d);
  if (req.model) args.push('--model', req.model);
  if (req.mcpConfigPath) args.push('--mcp-config', req.mcpConfigPath);
  return args;
}

export function claudeCommandFromEnv(): string[] {
  const raw = process.env.MOTION_STUDIO_CLAUDE_COMMAND;
  if (!raw) return ['claude'];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((p) => typeof p === 'string')) {
    throw new Error('MOTION_STUDIO_CLAUDE_COMMAND deve essere un array JSON di stringhe');
  }
  return parsed;
}

const STDERR_TAIL = 20;

export class ClaudeCodeRunner implements AgentRunner {
  private readonly killGraceMs: number;
  constructor(private readonly claudeCommand: string[] = ['claude'], opts: { killGraceMs?: number } = {}) {
    this.killGraceMs = opts.killGraceMs ?? 3000;
  }

  start(req: AgentTurnRequest, onEvent: (e: AgentEvent) => void): AgentRun {
    const [bin, ...prefix] = this.claudeCommand;
    if (!bin) throw new Error('claudeCommand vuoto');
    const child = spawn(bin, [...prefix, ...buildClaudeArgs(req)], { cwd: req.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let cancelled = false;
    let sessionId = req.resumeSessionId;
    let result: Extract<AgentEvent, { kind: 'result' }> | undefined;
    const stderrTail: string[] = [];
    const stdout = new LineSplitter();
    const stderr = new LineSplitter();

    const emit = (e: AgentEvent) => {
      if (e.kind === 'session') sessionId = e.sessionId;
      if (e.kind === 'result') { result = e; if (e.sessionId) sessionId = e.sessionId; }
      onEvent(e);
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

    const done = new Promise<AgentRunResult>((resolve) => {
      child.on('error', (err: NodeJS.ErrnoException) => {
        resolve(err.code === 'ENOENT'
          ? { status: 'failed', error: `Comando claude non trovato (${bin}). Installa Claude Code o controlla il Doctor.` }
          : { status: 'failed', error: `Impossibile avviare claude: ${err.message}` });
      });
      child.on('close', (code, signal) => {
        stdout.flush().flatMap(parseClaudeLine).forEach(emit);
        const withSession = <T extends AgentRunResult>(r: T): T => (sessionId ? { ...r, sessionId } : r);
        if (cancelled) return resolve(withSession({ status: 'cancelled' }));
        if (result?.ok) return resolve(withSession({ status: 'succeeded' }));
        if (result) return resolve(withSession({ status: 'failed', error: result.error ?? 'Turno non riuscito' }));
        const tail = stderrTail.join('\n');
        resolve(withSession({ status: 'failed', error: `claude è terminato con codice ${code ?? signal} senza risultato${tail ? `: ${tail}` : ''}` }));
      });
    });

    return {
      done,
      cancel: () => {
        if (cancelled || child.exitCode !== null) return;
        cancelled = true;
        child.kill('SIGTERM');
        const t = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, this.killGraceMs);
        t.unref();
      },
    };
  }
}

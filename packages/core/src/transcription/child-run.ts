import { spawn, type ChildProcess } from 'node:child_process';

/** Output kept per stream; past it the rest is dropped (an engine's progress chatter must not grow without bound). */
const MAX_OUTPUT = 10 * 1024 * 1024;
/** After SIGTERM, how long a child gets before SIGKILL. */
const KILL_GRACE_MS = 3000;

export interface ChildResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean }

/**
 * Runs a program (a Whisper engine, spec §7) with no shell, its output capped, a deadline and a cancel signal. On timeout or
 * abort it kills ONLY its own child, by its PID (SIGTERM, then SIGKILL after 3 s): never a name or a pattern. A program
 * that cannot start resolves with `code: null` and the reason in `stderr`; it never throws.
 */
export function runChild(cmd: string, args: string[], o: { timeoutMs: number; signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv }): Promise<ChildResult> {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let timedOut = false, cancelled = false, settled = false;
    let child: ChildProcess;
    let killTimer: NodeJS.Timeout | null = null;
    const finish = (code: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr: stderr + extra, timedOut, cancelled });
    };
    const stop = () => {
      const pid = child?.pid;
      if (!pid || child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } } }, KILL_GRACE_MS);
    };
    const onAbort = () => { cancelled = true; stop(); };
    const deadline = setTimeout(() => { timedOut = true; stop(); }, o.timeoutMs);
    try {
      child = spawn(cmd, args, { shell: false, cwd: o.cwd, env: o.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      finish(null, String((e as Error).message));
      return;
    }
    child.stdout!.setEncoding('utf8').on('data', (d: string) => { if (stdout.length < MAX_OUTPUT) stdout += d.slice(0, MAX_OUTPUT - stdout.length); });
    child.stderr!.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < MAX_OUTPUT) stderr += d.slice(0, MAX_OUTPUT - stderr.length); });
    child.on('error', (e) => finish(null, (stderr ? '\n' : '') + e.message));
    child.on('close', (code) => finish(code));
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The last non-empty line of an engine's stderr (what an error shows), at most 300 characters. */
export const lastLine = (text: string): string => (text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? '').slice(0, 300);

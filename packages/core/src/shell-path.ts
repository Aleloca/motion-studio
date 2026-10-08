import { spawn } from 'node:child_process';
import type { CommandExec } from './exec.ts';

const MAX_OUTPUT = 64 * 1024;

/**
 * Runs the shell in its own process group and bounds the wait: on timeout the whole group is killed, so a background child
 * started by an rc file (ssh-agent, nvm…) that keeps the pipes open cannot stall the caller. stdin is closed (no rc prompt).
 */
export const spawnBounded: CommandExec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 5000;
    let out = '';
    let err = '';
    let done = false;
    let child: ReturnType<typeof spawn>;
    const finish = (r: { code: number; stderr?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(hard);
      try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({ code: r.code, stdout: out, stderr: r.stderr ?? err.slice(0, 500), notFound: false });
    };
    const timeoutMsg = `timeout dopo ${Math.round(timeoutMs / 100) / 10} s`;
    const timer = setTimeout(() => finish({ code: -1, stderr: timeoutMsg }), timeoutMs);
    // Last-resort bound, independent of the child's events.
    const hard = setTimeout(() => finish({ code: -1, stderr: timeoutMsg }), timeoutMs + 500);
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ code: -1, stderr: String((e as Error).message) });
      return;
    }
    child.stdout!.setEncoding('utf8').on('data', (d: string) => { if (out.length < MAX_OUTPUT) out += d; if (out.includes('__MS_END__')) finish({ code: 0 }); });
    child.stderr!.setEncoding('utf8').on('data', (d: string) => { if (err.length < MAX_OUTPUT) err += d; });
    child.on('error', (e) => finish({ code: -1, stderr: String(e.message) }));
    child.on('close', (code) => finish({ code: code ?? 1 }));
  });

const merge = (...parts: string[]) => [...new Set(parts.join(':').split(':').filter(Boolean))].join(':');

export interface LoginShellPath { path: string; source: 'login-shell' | 'fallback'; error?: string }

/**
 * The PATH of the user's login shell, merged before the current one: apps launched from the Finder/Dock get a minimal PATH
 * that misses Homebrew and npm-global (where `claude` lives). Never throws nor hangs: on any failure a safe fallback is returned.
 */
export async function resolveLoginShellPath(
  opts: { shell?: string; timeoutMs?: number; exec?: CommandExec; platform?: NodeJS.Platform; current?: string } = {},
): Promise<LoginShellPath> {
  const platform = opts.platform ?? process.platform;
  const current = opts.current ?? process.env.PATH ?? '';
  if (platform === 'win32') return { path: current, source: 'fallback' };
  const exec = opts.exec ?? spawnBounded;
  const shell = opts.shell ?? process.env.SHELL ?? '/bin/zsh';
  const r = await exec(shell, ['-ilc', 'printf "__MS_PATH__%s__MS_END__" "$PATH"'], { timeoutMs: opts.timeoutMs ?? 5000 });
  const found = r.code === 0 ? r.stdout.match(/__MS_PATH__([\s\S]*?)__MS_END__/)?.[1]?.trim() : undefined;
  if (found) return { path: merge(found, current), source: 'login-shell' };
  return { path: merge(current, '/opt/homebrew/bin', '/usr/local/bin'), source: 'fallback', error: r.code === 0 ? 'marcatore non trovato' : r.stderr.trim() || `codice ${r.code}` };
}

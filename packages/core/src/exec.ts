import { execFile } from 'node:child_process';

export interface CommandResult {
  code: number; stdout: string; stderr: string; notFound: boolean;
  /** The binary exists but cannot start on this CPU (EBADARCH, errno -86: an Intel build on a Mac without Rosetta). */
  badArch?: boolean;
}

/** Whether a spawn error means "wrong CPU architecture" (macOS EBADARCH is errno -86; Node reports it as an unknown system error). */
export const isBadArchError = (e: unknown): boolean => {
  const x = e as { errno?: unknown; code?: unknown; message?: unknown } | null;
  return x?.errno === -86 || x?.code === 'EBADARCH' || /EBADARCH|error -86\b/.test(String(x?.message ?? ''));
};
export type CommandExec = (
  cmd: string,
  args: string[],
  /** `env`, when given, replaces the child's environment outright (the caller composes it, e.g. a hardened git env). */
  opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export const execCommand: CommandExec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    // execFile can throw synchronously (e.g. "spawn Unknown system error -86"): a tool that cannot start is "not usable", never a crash.
    try { execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8', ...(opts.env ? { env: opts.env } : {}) },
      (error, stdout, stderr) => {
        if (error && isBadArchError(error)) {
          resolve({ code: -1, stdout: '', stderr: String(error.message), notFound: false, badArch: true });
          return;
        }
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ code: -1, stdout: '', stderr: String(error.message), notFound: true });
          return;
        }
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', notFound: false });
      },
    ); } catch (e) { resolve({ code: -1, stdout: '', stderr: String((e as Error).message), notFound: (e as NodeJS.ErrnoException).code === 'ENOENT', ...(isBadArchError(e) ? { badArch: true } : {}) }); }
  });

import { execFile } from 'node:child_process';

export interface CommandResult { code: number; stdout: string; stderr: string; notFound: boolean }
export type CommandExec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>;

export const execCommand: CommandExec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ code: -1, stdout: '', stderr: String(error.message), notFound: true });
          return;
        }
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', notFound: false });
      },
    );
  });

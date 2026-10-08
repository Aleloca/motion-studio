import { execCommand, type CommandExec } from './exec.ts';

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
  const exec = opts.exec ?? execCommand;
  const shell = opts.shell ?? process.env.SHELL ?? '/bin/zsh';
  const r = await exec(shell, ['-ilc', 'printf "__MS_PATH__%s__MS_END__" "$PATH"'], { timeoutMs: opts.timeoutMs ?? 5000 });
  const found = r.code === 0 ? r.stdout.match(/__MS_PATH__([\s\S]*?)__MS_END__/)?.[1]?.trim() : undefined;
  if (found) return { path: merge(found, current), source: 'login-shell' };
  return { path: merge(current, '/opt/homebrew/bin', '/usr/local/bin'), source: 'fallback', error: r.stderr.trim() || `codice ${r.code}` };
}

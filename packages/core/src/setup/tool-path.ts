import { join } from 'node:path';
import type { CommandExec } from '../exec.ts';

/**
 * User report 91: where the tools a non-technical user installs from the setup end up, and how the running app finds them
 * without a restart.
 *
 * - Claude Code's native installer puts `claude` in `~/.local/bin` (Windows `%USERPROFILE%\.local\bin\claude.exe`), which
 *   is often not on the app's PATH until a new terminal (or never, for an app started from the Finder).
 * - The FFmpeg the setup downloads goes to `<configDir>/tools/ffmpeg/bin`.
 * - On Windows an installer (Git for Windows, winget, Claude Code) writes the new PATH to the registry; a running process
 *   keeps its old copy. Each check reads the user and machine PATH again.
 *
 * The folders are appended (never put first): a tool the user installed elsewhere keeps winning.
 */

export const ffmpegBinDir = (configDir: string) => join(configDir, 'tools', 'ffmpeg', 'bin');
export const claudeLocalBin = (home: string) => join(home, '.local', 'bin');

const delimiterOf = (platform: NodeJS.Platform) => (platform === 'win32' ? ';' : ':');

/** `current` with `extra` appended, skipping empty entries and those already present (case-insensitive on Windows). */
export function mergePath(current: string, extra: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const sep = delimiterOf(platform);
  const key = (p: string) => {
    const t = p.trim().replace(/[\\/]+$/, '');
    return platform === 'win32' ? t.toLowerCase() : t;
  };
  const parts = current.split(sep).filter((p) => p.trim() !== '');
  const seen = new Set(parts.map(key));
  for (const p of extra) {
    if (!p || p.trim() === '' || seen.has(key(p))) continue;
    seen.add(key(p));
    parts.push(p);
  }
  return parts.join(sep);
}

/** Expands `%NAME%` with `env` (Windows names are case-insensitive); unknown names stay as they are. */
export function expandWindowsVars(value: string, env: NodeJS.ProcessEnv): string {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => lower.get(name.toLowerCase()) ?? whole);
}

const REG_KEYS = [
  'HKCU\\Environment',
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
] as const;

/** The value of `Path` in one `reg query <key> /v Path` output (REG_SZ or REG_EXPAND_SZ), or null. */
export function parseRegPath(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
    if (m) return m[1]!.trim();
  }
  return null;
}

/**
 * Windows: the machine and user PATH as the registry holds them now (machine first, as Windows composes it), with the
 * `%VARS%` expanded. Never throws: a missing key or a failing `reg` gives nothing.
 */
export async function readWindowsRegistryPath(exec: CommandExec, env: NodeJS.ProcessEnv): Promise<string[]> {
  const out: string[] = [];
  for (const key of [REG_KEYS[1], REG_KEYS[0]]) {
    const r = await exec('reg', ['query', key, '/v', 'Path'], { timeoutMs: 5000 }).catch(() => null);
    const value = r && r.code === 0 ? parseRegPath(r.stdout) : null;
    if (value) out.push(...expandWindowsVars(value, env).split(';').filter((p) => p.trim() !== ''));
  }
  return out;
}

export interface RefreshToolPathOptions {
  /** The environment whose PATH is updated (the process's: every later spawn of `claude`, `git`, `ffmpeg` uses it). */
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home: string;
  configDir: string;
  /** Runs `reg` on Windows (tests: a fake; never called elsewhere). */
  exec: CommandExec;
}

/**
 * Brings `env.PATH` up to date before a check or after an install: on Windows the registry's user and machine PATH, then
 * (everywhere) the Claude Code and FFmpeg folders of the setup, all appended. Returns the new PATH.
 */
export async function refreshToolPath(o: RefreshToolPathOptions): Promise<string> {
  const platform = o.platform ?? process.platform;
  const registry = platform === 'win32' ? await readWindowsRegistryPath(o.exec, o.env) : [];
  const next = mergePath(o.env.PATH ?? '', [...registry, claudeLocalBin(o.home), ffmpegBinDir(o.configDir)], platform);
  o.env.PATH = next;
  return next;
}

import { spawn, type ChildProcess } from 'node:child_process';
import type { SetupStatus, SetupTaskState } from '@motion-studio/shared';
import type { CommandExec } from '../exec.ts';
import { killGroup } from '../render/watchdog.ts';
import { t } from '../i18n.ts';
import { ffmpegBuildSize, installFfmpeg, type FfmpegBuild } from './ffmpeg-download.ts';

/**
 * User report 91: the setup's one-click tasks for a non-technical user. Each runs only from an explicit click that went
 * through a confirmation (the routes ask for `consent: true`), never by itself; the commands are constants (no user input
 * reaches a shell), and the routes refuse them when the server answers on a network address.
 *
 * - Install Claude Code: Anthropic's official native installer (https://code.claude.com/docs/en/setup): on Windows
 *   PowerShell `irm https://claude.ai/install.ps1 | iex` (no profile, execution policy bypassed for that process only, no
 *   window); elsewhere `curl -fsSL https://claude.ai/install.sh | bash`. It installs for this user only, no admin rights.
 * - Sign in to Claude: `claude auth login` (it opens the browser), then `claude auth status --json` every few seconds until
 *   signed in, with a time limit and Cancel. Only `loggedIn` is read.
 * - Install FFmpeg: the pinned build of ffmpeg-download.ts into Motion Studio's data folder.
 *
 * Each task, once finished, calls `onChanged` (the server drops its cached Claude version and billing) and the caller
 * refreshes the tool PATH; the UI then runs the checks again.
 */

export const CLAUDE_INSTALL_PS = 'irm https://claude.ai/install.ps1 | iex';
export const CLAUDE_INSTALL_SH = 'curl -fsSL https://claude.ai/install.sh | bash';

/** The official command a user runs by hand (PowerShell on Windows, a terminal elsewhere). */
export const claudeManualCommand = (platform: NodeJS.Platform) => (platform === 'win32' ? CLAUDE_INSTALL_PS : CLAUDE_INSTALL_SH);

/** The installer as the core runs it. `pipefail`: a failed download is a failed install, not an empty script run. */
export function claudeInstallerCommand(platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CLAUDE_INSTALL_PS]
    : ['bash', '-c', `set -o pipefail; ${CLAUDE_INSTALL_SH}`];
}

/**
 * Tests and development: `MOTION_STUDIO_CLAUDE_INSTALLER_COMMAND` (a JSON array of strings, like
 * `MOTION_STUDIO_CLAUDE_COMMAND`) replaces the real installer. Null when unset; throws when malformed.
 */
export function installerCommandFromEnv(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env.MOTION_STUDIO_CLAUDE_INSTALLER_COMMAND;
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('MOTION_STUDIO_CLAUDE_INSTALLER_COMMAND is not valid JSON'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((p) => typeof p === 'string')) {
    throw new Error('MOTION_STUDIO_CLAUDE_INSTALLER_COMMAND must be a non-empty JSON array of strings');
  }
  return parsed;
}

const LOGIN_HOSTS = /^(?:[a-z0-9-]+\.)*(?:claude\.ai|claude\.com|anthropic\.com)$/i;

/** The first https address on an Anthropic host in the login's output (shown when the browser did not open), or null. */
export function loginUrlIn(text: string): string | null {
  for (const m of text.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const u = new URL(m[0]);
      if (u.protocol === 'https:' && !u.username && !u.password && LOGIN_HOSTS.test(u.hostname)) return u.href;
    } catch { /* not a URL */ }
  }
  return null;
}

export type SetupTask = 'claudeInstall' | 'claudeLogin' | 'ffmpegInstall';

export interface SetupServiceOptions {
  platform?: NodeJS.Platform;
  /** The `claude` command (MOTION_STUDIO_CLAUDE_COMMAND or `claude`). */
  claudeCommand: () => string[];
  /** The installer (default: the official one for `platform`, or MOTION_STUDIO_CLAUDE_INSTALLER_COMMAND). */
  installerCommand?: string[];
  exec: CommandExec;
  /** Spawns a task's process (test seam; default node's `spawn`). */
  spawnImpl?: typeof spawn;
  configDir: string;
  /** The FFmpeg build for this computer (null: no button). */
  ffmpegBuild: FfmpegBuild | null;
  /** Test seam: the FFmpeg install (default: the real download). */
  installFfmpegImpl?: typeof installFfmpeg;
  /** False when the server is reachable from the network: every task is refused. */
  allowed: boolean;
  /** Told after every task that ended (PATH refresh, caches). */
  onChanged?: () => Promise<void> | void;
  installTimeoutMs?: number;
  loginTimeoutMs?: number;
  loginPollMs?: number;
  ffmpegTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface Running { cancel(): void }

const idle = (): SetupTaskState => ({ state: 'idle' });

export class SetupRefused extends Error {
  constructor(readonly code: 'not-loopback' | 'busy' | 'unavailable') { super(code); this.name = 'SetupRefused'; }
}

export class SetupService {
  private readonly tasks: Record<SetupTask, SetupTaskState> = { claudeInstall: idle(), claudeLogin: idle(), ffmpegInstall: idle() };
  private readonly running = new Map<SetupTask, Running>();
  private readonly platform: NodeJS.Platform;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly o: SetupServiceOptions) {
    this.platform = o.platform ?? process.platform;
  }

  status(): SetupStatus {
    const p = this.platform;
    const b = this.o.ffmpegBuild;
    return {
      platform: p === 'win32' ? 'windows' : p === 'darwin' ? 'mac' : p === 'linux' ? 'linux' : 'other',
      allowed: this.o.allowed,
      claudeManual: claudeManualCommand(p),
      ffmpeg: b ? { version: b.version, source: b.source, sizeBytes: ffmpegBuildSize(b), license: b.license } : null,
      tasks: { claudeInstall: { ...this.tasks.claudeInstall }, claudeLogin: { ...this.tasks.claudeLogin }, ffmpegInstall: { ...this.tasks.ffmpegInstall } },
    };
  }

  /** Told after `onChanged`, once a task ended (the server drops its cached Claude version and billing). */
  onEnded(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  cancel(task: SetupTask): void {
    this.running.get(task)?.cancel();
  }

  /** Cancels everything (server close). */
  close(): void {
    for (const r of this.running.values()) r.cancel();
  }

  private claim(task: SetupTask): void {
    if (!this.o.allowed) throw new SetupRefused('not-loopback');
    if (this.running.has(task)) throw new SetupRefused('busy');
  }

  private async finish(task: SetupTask, state: SetupTaskState): Promise<void> {
    this.running.delete(task);
    try { await this.o.onChanged?.(); } catch { /* the checks run again anyway */ }
    for (const fn of this.listeners) { try { fn(); } catch { /* a listener's problem */ } }
    this.tasks[task] = state;
  }

  /** Starts a process in its own group (killed as a whole), no window on Windows, stdin closed unless asked. */
  private start(cmd: string[], opts: { stdinPipe?: boolean } = {}): ChildProcess {
    const [bin, ...args] = cmd;
    return (this.o.spawnImpl ?? spawn)(bin!, args, {
      stdio: [opts.stdinPipe ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: this.platform !== 'win32',
      env: this.o.env ?? process.env,
    });
  }

  private static kill(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.pid) killGroup(child.pid); else child.kill('SIGKILL');
  }

  /** Runs the official Claude Code installer. */
  installClaude(): SetupTaskState {
    this.claim('claudeInstall');
    const cmd = this.o.installerCommand ?? installerCommandFromEnv(this.o.env) ?? claudeInstallerCommand(this.platform);
    let child: ChildProcess;
    try { child = this.start(cmd); } catch {
      this.tasks.claudeInstall = { state: 'failed', error: 'start' };
      return { ...this.tasks.claudeInstall };
    }
    this.tasks.claudeInstall = { state: 'running' };
    let ended: SetupTaskState | null = null;
    const timer = setTimeout(() => { ended = { state: 'failed', error: 'timeout' }; SetupService.kill(child); }, this.o.installTimeoutMs ?? 10 * 60_000);
    this.running.set('claudeInstall', { cancel: () => { ended ??= { state: 'cancelled' }; SetupService.kill(child); } });
    child.stdout?.resume();
    child.stderr?.on('data', (d: Buffer) => { console.warn(`Motion Studio: Claude Code installer: ${d.toString('utf8').trim().slice(0, 500)}`); });
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void this.finish('claudeInstall', ended ?? (code === 0 ? { state: 'done' } : { state: 'failed', error: 'exit' }));
    };
    child.once('error', () => { ended ??= { state: 'failed', error: 'start' }; done(null); });
    child.once('close', (code) => done(code));
    return { ...this.tasks.claudeInstall };
  }

  private async loggedIn(): Promise<boolean> {
    const [bin, ...prefix] = this.o.claudeCommand();
    if (!bin) return false;
    const r = await this.o.exec(bin, [...prefix, 'auth', 'status', '--json'], { timeoutMs: 15_000 }).catch(() => null);
    if (!r) return false;
    try { return (JSON.parse(r.stdout) as { loggedIn?: unknown }).loggedIn === true; } catch { return false; }
  }

  /** Starts `claude auth login` and waits for `claude auth status` to say signed in. */
  signIn(): SetupTaskState {
    this.claim('claudeLogin');
    const [bin, ...prefix] = this.o.claudeCommand();
    let child: ChildProcess;
    try { child = this.start([bin!, ...prefix, 'auth', 'login'], { stdinPipe: true }); } catch {
      this.tasks.claudeLogin = { state: 'failed', error: 'start' };
      return { ...this.tasks.claudeLogin };
    }
    this.tasks.claudeLogin = { state: 'running' };
    let ended: SetupTaskState | null = null;
    let exited = false;
    let output = '';
    const onOutput = (d: Buffer) => {
      output = (output + d.toString('utf8')).slice(-8000);
      const url = loginUrlIn(output);
      if (url && this.tasks.claudeLogin.state === 'running' && !this.tasks.claudeLogin.loginUrl) this.tasks.claudeLogin = { state: 'running', loginUrl: url };
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.once('error', () => { exited = true; ended ??= { state: 'failed', error: 'start' }; });
    child.once('close', () => { exited = true; });
    const deadline = Date.now() + (this.o.loginTimeoutMs ?? 5 * 60_000);
    const pollMs = this.o.loginPollMs ?? 2000;
    this.running.set('claudeLogin', { cancel: () => { ended ??= { state: 'cancelled' }; SetupService.kill(child); } });
    void (async () => {
      for (;;) {
        await new Promise((r) => setTimeout(r, pollMs));
        if (ended) break;
        if (await this.loggedIn()) { ended = { state: 'done' }; break; }
        if (ended) break;
        if (exited) {
          // The login ended by itself: one last look, then its exit code decides.
          ended = (await this.loggedIn()) ? { state: 'done' } : { state: 'failed', error: 'exit' };
          break;
        }
        if (Date.now() >= deadline) { ended = { state: 'failed', error: 'timeout' }; break; }
      }
      SetupService.kill(child);
      await this.finish('claudeLogin', ended);
    })();
    return { ...this.tasks.claudeLogin };
  }

  /** Downloads and installs the pinned FFmpeg build. */
  installFfmpeg(): SetupTaskState {
    this.claim('ffmpegInstall');
    const build = this.o.ffmpegBuild;
    if (!build) throw new SetupRefused('unavailable');
    const total = ffmpegBuildSize(build);
    const ac = new AbortController();
    let ended: SetupTaskState | null = null;
    this.tasks.ffmpegInstall = { state: 'running', bytes: 0, total };
    const timer = setTimeout(() => { ended ??= { state: 'failed', error: 'timeout' }; ac.abort(new Error('timeout')); }, this.o.ffmpegTimeoutMs ?? 30 * 60_000);
    this.running.set('ffmpegInstall', { cancel: () => { ended ??= { state: 'cancelled' }; ac.abort(new Error('cancelled')); } });
    void (async () => {
      try {
        await (this.o.installFfmpegImpl ?? installFfmpeg)({
          configDir: this.o.configDir, build, platform: this.platform, signal: ac.signal,
          onProgress: (p) => { if (this.tasks.ffmpegInstall.state === 'running') this.tasks.ffmpegInstall = { state: 'running', bytes: p.bytes, total }; },
        });
        ended ??= { state: 'done' };
      } catch (e) {
        console.warn(`Motion Studio: FFmpeg install failed: ${(e as Error)?.message ?? String(e)}`);
        ended ??= { state: 'failed', error: 'download' };
      } finally {
        clearTimeout(timer);
      }
      await this.finish('ffmpegInstall', ended);
    })();
    return { ...this.tasks.ffmpegInstall };
  }
}

/** The message the UI shows for a refusal. */
export function setupRefusedMessage(e: SetupRefused): string {
  const s = t().errors;
  return e.code === 'not-loopback' ? s.setupNotLoopback : e.code === 'busy' ? s.setupBusy : s.setupUnavailable;
}

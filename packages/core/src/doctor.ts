import type { DoctorCheck, UsageBilling } from '@motion-studio/shared';
import type { SandboxSupport } from './agent/sandbox.ts';
import type { CommandExec, CommandResult } from './exec.ts';
import { t } from './i18n.ts';

const versionIn = (s: string) => s.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find(Boolean);

/** Message for a tool that exists but exited with an error (no install fix: reinstalling may not help). */
const brokenMessage = (r: CommandResult) => {
  const detail = firstLine(r.stderr) ?? firstLine(r.stdout);
  return detail ? t().doctor.brokenDetail({ detail }) : t().doctor.broken;
};

/** Where the process PATH came from (desktop only: an app started from the Finder has to read it from the login shell). */
export interface ShellPathOrigin { source: 'login-shell' | 'fallback'; error?: string }

export async function runDoctor(opts: {
  exec: CommandExec; claudeCommand: string[]; nodeVersion?: string; sandbox?: () => Promise<SandboxSupport>; shellPath?: ShellPathOrigin;
}): Promise<DoctorCheck[]> {
  const { exec } = opts;
  const [claudeBin, ...claudePrefix] = opts.claudeCommand;
  if (!claudeBin) throw new Error(t().errors.claudeCommandEmpty);
  const checks: DoctorCheck[] = [];
  const d = t().doctor;

  const nodeVersion = (opts.nodeVersion ?? process.version).replace(/^v/, '');
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  checks.push({
    id: 'node', label: 'Node.js', required: true, version: nodeVersion, ok: nodeMajor >= 22,
    message: nodeMajor >= 22 ? d.supportedVersion : d.nodeTooOld,
    fix: nodeMajor >= 22 ? undefined : d.nodeFix,
  });

  const git = await exec('git', ['--version']);
  checks.push(git.code === 0
    ? { id: 'git', label: 'Git', required: true, ok: true, version: versionIn(git.stdout), message: d.installed }
    : git.notFound
      ? { id: 'git', label: 'Git', required: true, ok: false, message: d.gitMissing, fix: d.gitFix }
      : { id: 'git', label: 'Git', required: true, ok: false, message: brokenMessage(git) });

  const ffmpeg = await exec('ffmpeg', ['-version']);
  checks.push(ffmpeg.code === 0
    ? { id: 'ffmpeg', label: 'FFmpeg', required: false, ok: true, version: versionIn(ffmpeg.stdout), message: d.installed }
    : ffmpeg.notFound
      ? { id: 'ffmpeg', label: 'FFmpeg', required: false, ok: false, message: d.ffmpegRecommended, fix: d.ffmpegFix }
      : { id: 'ffmpeg', label: 'FFmpeg', required: false, ok: false, message: brokenMessage(ffmpeg) });

  const claude = await exec(claudeBin, [...claudePrefix, '--version']);
  const claudeOk = claude.code === 0;
  checks.push(claudeOk
    ? { id: 'claude', label: 'Claude Code', required: true, ok: true, version: versionIn(claude.stdout), message: d.installed }
    : claude.notFound
      ? { id: 'claude', label: 'Claude Code', required: true, ok: false, message: d.claudeMissing, fix: 'npm install -g @anthropic-ai/claude-code' }
      : { id: 'claude', label: 'Claude Code', required: true, ok: false, message: brokenMessage(claude) });

  if (!claudeOk) {
    checks.push({
      id: 'claude-auth', label: d.claudeAuthLabel, required: true, ok: false,
      message: claude.notFound ? d.installClaudeFirst : d.claudeMustRespond,
    });
  } else {
    const auth = await exec(claudeBin, [...claudePrefix, 'auth', 'status', '--json']);
    let loggedIn = false;
    try { loggedIn = JSON.parse(auth.stdout).loggedIn === true; } catch { loggedIn = false; }
    checks.push(loggedIn
      ? { id: 'claude-auth', label: d.claudeAuthLabel, required: true, ok: true, message: d.authenticated }
      : { id: 'claude-auth', label: d.claudeAuthLabel, required: true, ok: false, message: d.notAuthenticated, fix: 'claude auth login' });
  }
  if (opts.sandbox) {
    const s = await opts.sandbox();
    checks.push(s.disabled
      ? { id: 'sandbox', label: d.sandboxLabel, required: false, ok: false, message: s.reason }
      : s.available
      ? { id: 'sandbox', label: d.sandboxLabel, required: false, ok: true, message: d.sandboxAvailable }
      : { id: 'sandbox', label: d.sandboxLabel, required: false, ok: false, message: s.reason, fix: d.sandboxFix });
  }
  if (opts.shellPath) {
    const ok = opts.shellPath.source === 'login-shell';
    checks.push(ok
      ? { id: 'shell-path', label: d.shellPathLabel, required: false, ok, message: d.shellPathLoaded }
      : {
        id: 'shell-path', label: d.shellPathLabel, required: false, ok, message: d.shellPathFallback({ reason: opts.shellPath.error ?? d.unknownReason }),
        fix: d.shellPathFix,
      });
  }
  return checks;
}

export const hasBlockingFailure = (checks: DoctorCheck[]) => checks.some((c) => c.required && !c.ok);

/**
 * How Claude Code is paid for, from `claude auth status --json`: only the `loggedIn` and `authMethod` fields are read
 * (the output also holds email and organisation, which are never read nor logged). `authMethod: "claude.ai"` is a
 * Claude subscription login; a method naming an API key is billed per token; anything else is unknown.
 */
export function billingFromAuthStatus(stdout: string): UsageBilling {
  let data: unknown;
  try { data = JSON.parse(stdout); } catch { return 'unknown'; }
  if (typeof data !== 'object' || data === null) return 'unknown';
  const { loggedIn, authMethod } = data as { loggedIn?: unknown; authMethod?: unknown };
  if (loggedIn !== true || typeof authMethod !== 'string') return 'unknown';
  if (authMethod === 'claude.ai') return 'subscription';
  return /api[\s_-]?key/i.test(authMethod) ? 'api' : 'unknown';
}

/** Billing method of the configured `claude` (never throws: 'unknown' when it cannot be read). */
export async function readBilling(opts: { exec: CommandExec; claudeCommand: string[] }): Promise<UsageBilling> {
  const [bin, ...prefix] = opts.claudeCommand;
  if (!bin) return 'unknown';
  try {
    const r = await opts.exec(bin, [...prefix, 'auth', 'status', '--json']);
    return billingFromAuthStatus(r.stdout);
  } catch {
    return 'unknown';
  }
}

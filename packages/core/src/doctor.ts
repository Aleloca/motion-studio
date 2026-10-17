import type { DoctorCheck, UsageBilling } from '@motion-studio/shared';
import type { BinaryArch } from './render/arch.ts';
import type { SandboxSupport } from './agent/sandbox.ts';
import { isBadArchError, type CommandExec, type CommandResult } from './exec.ts';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { t } from './i18n.ts';
import { folderWithGlobChars, SLUG_RE } from './workspace-store.ts';
import { execFfVia } from './media/ffmpeg-exec.ts';
import { capabilitiesFor, parseClaudeVersion, verifiedFor, type CapabilityOptIn } from './agent/agent-capabilities.ts';

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
  /** The chosen workspace folder: a path (or a project folder's real path) with glob characters gets a warning row (decision 790). */
  workspacePath?: string | null;
  /**
   * Decision 791: Motion Studio's config folder and the home folder. They are not refused when their path holds glob
   * characters, but the agent's deny rules on them (tokens, secrets) may not apply: one warning row names them.
   */
  configDir?: string;
  home?: string;
  /**
   * The ffmpeg build's architecture (render/encode.ts `findFfmpeg`): shown next to its version, and an x86_64 build under
   * Rosetta on Apple Silicon is named (it renders, slower). Absent or failing: the plain version.
   */
  ffmpegInfo?: () => Promise<{ arch: BinaryArch; hostArch: string; translated: boolean; version?: string } | null>;
  /**
   * Phase 13: the workspace settings for live messages and interrupt. When given (even `{}`), the report says which path
   * is active: live for a verified version with the settings on (decision 804), otherwise the fallback (queued only, stop
   * and resume), saying whether the settings or the version is the reason.
   */
  agentOptIn?: CapabilityOptIn;
  /** Decision 802: the desktop's updater is off (development run, unsigned build): one informational row (ok, so it neither counts as a recommendation nor blocks). */
  updatesOff?: boolean;
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

  let ffmpeg = await execFfVia(exec, 'ffmpeg', ['-version']).catch((e): CommandResult => ({ code: -1, stdout: '', stderr: String((e as Error).message), notFound: false, badArch: isBadArchError(e) }));
  let arch = ffmpeg.code === 0 && opts.ffmpegInfo ? await opts.ffmpegInfo().catch(() => null) : null;
  if (ffmpeg.code !== 0 && ffmpeg.badArch && opts.ffmpegInfo) {
    // The first ffmpeg on PATH is Intel-only and there is no Rosetta: another build (e.g. /opt/homebrew/bin) may still run.
    const other = await opts.ffmpegInfo().catch(() => null);
    if (other) { arch = other; ffmpeg = { code: 0, stdout: other.version ? `ffmpeg version ${other.version}` : '', stderr: '', notFound: false }; }
  }
  const archText = arch && arch.arch !== 'unknown' ? d.ffmpegArch({ arch: arch.arch === 'universal' ? d.ffmpegUniversal : arch.arch, translated: arch.translated }) : null;
  const ffmpegVersion = versionIn(ffmpeg.stdout);
  checks.push(ffmpeg.code === 0
    ? {
      id: 'ffmpeg', label: 'FFmpeg', required: false, ok: true,
      version: ffmpegVersion !== undefined && archText ? `${ffmpegVersion} · ${archText}` : ffmpegVersion,
      message: arch?.translated ? d.ffmpegRosetta : d.installed,
    }
    : ffmpeg.notFound
      ? { id: 'ffmpeg', label: 'FFmpeg', required: false, ok: false, message: d.ffmpegRecommended, fix: d.ffmpegFix }
      : ffmpeg.badArch
        ? { id: 'ffmpeg', label: 'FFmpeg', required: false, ok: false, message: d.ffmpegWrongArch, fix: d.ffmpegFix }
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
  if (opts.agentOptIn) {
    // Informational rows (ok, optional): the fallback is a working path, not a problem.
    // Same parsing as the route and the launcher (x.y.z), so the reports cannot disagree.
    const version = claudeOk ? parseClaudeVersion(claude.stdout) : null;
    // Decision 804: on for a verified version unless the workspace settings switch it off.
    const effective = capabilitiesFor(version, opts.agentOptIn);
    const verified = verifiedFor(version);
    checks.push({
      id: 'live-messages', label: d.liveMessagesLabel, required: false, ok: true,
      message: effective.liveInput ? d.liveMessagesSupported : verified.liveInput ? d.liveMessagesOff : d.liveMessagesQueued,
    });
    checks.push({
      id: 'interrupt', label: d.interruptLabel, required: false, ok: true,
      message: effective.interrupt ? d.interruptSupported : verified.interrupt ? d.interruptOff : d.interruptStopResume,
    });
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
  const globFolder = opts.workspacePath ? await agentFolderWithGlobChars(opts.workspacePath) : null;
  if (globFolder) {
    // Decision 790: every agent run there is refused; the row names the path to rename.
    checks.push({ id: 'workspace-path', label: d.workspacePathLabel, required: false, ok: false, message: d.folderGlobChars({ path: globFolder }), fix: d.folderGlobFix });
  } else if (opts.workspacePath && /[[\]*?]/.test(opts.workspacePath)) {
    // Decisions log 141 (unreachable while GLOB_PATH_CHARS holds these characters; kept for the day the refused set shrinks).
    checks.push({ id: 'workspace-path', label: d.workspacePathLabel, required: false, ok: false, message: d.workspacePathGlob, fix: d.workspacePathFix });
  }
  const denyPaths: string[] = [];
  for (const p of [opts.home, opts.configDir]) {
    if (!p) continue;
    const hit = await folderWithGlobChars([p]).catch(() => null);
    if (hit && !denyPaths.includes(hit)) denyPaths.push(hit);
  }
  if (denyPaths.length > 0) {
    checks.push({ id: 'agent-deny-paths', label: d.denyPathsLabel, required: false, ok: false, message: d.denyPathsGlob({ paths: denyPaths.join(', '), count: denyPaths.length }) });
  }
  if (opts.updatesOff) checks.push({ id: 'updates', label: d.updatesLabel, required: false, ok: true, info: true, message: d.updatesOff });
  return checks;
}

/**
 * Decision 790: the workspace folder, or a project folder in it (a project folder may be a link elsewhere), whose path or
 * real path holds a glob metacharacter: the first such spelling, or null. Never throws (an unreadable folder: null).
 */
export async function agentFolderWithGlobChars(workspacePath: string): Promise<string | null> {
  const root = await folderWithGlobChars([workspacePath]).catch(() => null);
  if (root) return root;
  const entries = await readdir(workspacePath, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!SLUG_RE.test(e.name) || !(e.isDirectory() || e.isSymbolicLink())) continue;
    const hit = await folderWithGlobChars([join(workspacePath, e.name)]).catch(() => null);
    if (hit) return hit;
  }
  return null;
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

import type { DoctorCheck } from '@motion-studio/shared';
import type { SandboxSupport } from './agent/sandbox.ts';
import type { CommandExec, CommandResult } from './exec.ts';

const versionIn = (s: string) => s.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find(Boolean);

/** Message for a tool that exists but exited with an error (no install fix: reinstalling may not help). */
const brokenMessage = (r: CommandResult) => {
  const detail = firstLine(r.stderr) ?? firstLine(r.stdout);
  return `Installato ma non risponde correttamente${detail ? `: ${detail}` : ''}`;
};

export async function runDoctor(opts: { exec: CommandExec; claudeCommand: string[]; nodeVersion?: string; sandbox?: () => Promise<SandboxSupport> }): Promise<DoctorCheck[]> {
  const { exec } = opts;
  const [claudeBin, ...claudePrefix] = opts.claudeCommand;
  if (!claudeBin) throw new Error('claudeCommand vuoto');
  const checks: DoctorCheck[] = [];

  const nodeVersion = (opts.nodeVersion ?? process.version).replace(/^v/, '');
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  checks.push({
    id: 'node', label: 'Node.js', required: true, version: nodeVersion, ok: nodeMajor >= 22,
    message: nodeMajor >= 22 ? 'Versione supportata' : 'Serve Node.js 22 o superiore',
    fix: nodeMajor >= 22 ? undefined : 'Installa Node.js 22+ da https://nodejs.org',
  });

  const git = await exec('git', ['--version']);
  checks.push(git.code === 0
    ? { id: 'git', label: 'Git', required: true, ok: true, version: versionIn(git.stdout), message: 'Installato' }
    : git.notFound
      ? { id: 'git', label: 'Git', required: true, ok: false, message: 'Git non trovato', fix: 'Installa Git da https://git-scm.com' }
      : { id: 'git', label: 'Git', required: true, ok: false, message: brokenMessage(git) });

  const ffmpeg = await exec('ffmpeg', ['-version']);
  checks.push(ffmpeg.code === 0
    ? { id: 'ffmpeg', label: 'FFmpeg', required: false, ok: true, version: versionIn(ffmpeg.stdout), message: 'Installato' }
    : ffmpeg.notFound
      ? { id: 'ffmpeg', label: 'FFmpeg', required: false, ok: false, message: 'Consigliato per montaggio e conversioni video', fix: 'Installa FFmpeg da https://ffmpeg.org (macOS: brew install ffmpeg)' }
      : { id: 'ffmpeg', label: 'FFmpeg', required: false, ok: false, message: brokenMessage(ffmpeg) });

  const claude = await exec(claudeBin, [...claudePrefix, '--version']);
  const claudeOk = claude.code === 0;
  checks.push(claudeOk
    ? { id: 'claude', label: 'Claude Code', required: true, ok: true, version: versionIn(claude.stdout), message: 'Installato' }
    : claude.notFound
      ? { id: 'claude', label: 'Claude Code', required: true, ok: false, message: 'Claude Code non trovato', fix: 'npm install -g @anthropic-ai/claude-code' }
      : { id: 'claude', label: 'Claude Code', required: true, ok: false, message: brokenMessage(claude) });

  if (!claudeOk) {
    checks.push({
      id: 'claude-auth', label: 'Accesso a Claude', required: true, ok: false,
      message: claude.notFound ? 'Installa prima Claude Code' : 'Claude Code deve prima rispondere correttamente',
    });
  } else {
    const auth = await exec(claudeBin, [...claudePrefix, 'auth', 'status', '--json']);
    let loggedIn = false;
    try { loggedIn = JSON.parse(auth.stdout).loggedIn === true; } catch { loggedIn = false; }
    checks.push(loggedIn
      ? { id: 'claude-auth', label: 'Accesso a Claude', required: true, ok: true, message: 'Autenticato' }
      : { id: 'claude-auth', label: 'Accesso a Claude', required: true, ok: false, message: 'Claude Code non è autenticato', fix: 'claude auth login' });
  }
  if (opts.sandbox) {
    const s = await opts.sandbox();
    checks.push(s.available
      ? { id: 'sandbox', label: 'Sandbox dell\'agente', required: false, ok: true, message: 'Disponibile: l\'agente lavora isolato nella cartella del progetto' }
      : { id: 'sandbox', label: 'Sandbox dell\'agente', required: false, ok: false, message: s.reason, fix: 'Senza sandbox Motion Studio usa permessi più ristretti; vedi il README' });
  }
  return checks;
}

export const hasBlockingFailure = (checks: DoctorCheck[]) => checks.some((c) => c.required && !c.ok);

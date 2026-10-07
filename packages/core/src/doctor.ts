import type { DoctorCheck } from '@motion-studio/shared';
import type { CommandExec } from './exec.ts';

const versionIn = (s: string) => s.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];

export async function runDoctor(opts: { exec: CommandExec; claudeCommand: string[]; nodeVersion?: string }): Promise<DoctorCheck[]> {
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
    : { id: 'git', label: 'Git', required: true, ok: false, message: 'Git non trovato', fix: 'Installa Git da https://git-scm.com' });

  const ffmpeg = await exec('ffmpeg', ['-version']);
  checks.push(ffmpeg.code === 0
    ? { id: 'ffmpeg', label: 'FFmpeg', required: false, ok: true, version: versionIn(ffmpeg.stdout), message: 'Installato' }
    : { id: 'ffmpeg', label: 'FFmpeg', required: false, ok: false, message: 'Consigliato per montaggio e conversioni video', fix: 'Installa FFmpeg da https://ffmpeg.org (macOS: brew install ffmpeg)' });

  const claude = await exec(claudeBin, [...claudePrefix, '--version']);
  const claudeOk = claude.code === 0;
  checks.push(claudeOk
    ? { id: 'claude', label: 'Claude Code', required: true, ok: true, version: versionIn(claude.stdout), message: 'Installato' }
    : { id: 'claude', label: 'Claude Code', required: true, ok: false, message: 'Claude Code non trovato', fix: 'npm install -g @anthropic-ai/claude-code' });

  if (!claudeOk) {
    checks.push({ id: 'claude-auth', label: 'Accesso a Claude', required: true, ok: false, message: 'Installa prima Claude Code' });
  } else {
    const auth = await exec(claudeBin, [...claudePrefix, 'auth', 'status', '--json']);
    let loggedIn = false;
    try { loggedIn = JSON.parse(auth.stdout).loggedIn === true; } catch { loggedIn = false; }
    checks.push(loggedIn
      ? { id: 'claude-auth', label: 'Accesso a Claude', required: true, ok: true, message: 'Autenticato' }
      : { id: 'claude-auth', label: 'Accesso a Claude', required: true, ok: false, message: 'Claude Code non è autenticato', fix: 'claude auth login' });
  }
  return checks;
}

export const hasBlockingFailure = (checks: DoctorCheck[]) => checks.some((c) => c.required && !c.ok);

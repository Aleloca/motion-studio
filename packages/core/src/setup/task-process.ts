import { spawn, type ChildProcess } from 'node:child_process';
import { killGroup } from '../render/watchdog.ts';

/**
 * The setup's processes (the Claude Code installer and sign-in), apart from setup-service.ts: a module that can spawn
 * has nothing to do with the media binaries (test/ffmpeg-exec.test.ts, source scan).
 */
export type SpawnFn = typeof spawn;
export type { ChildProcess };

/** Starts a process in its own group (killed as a whole), no window on Windows, stdin closed unless asked. */
export function startTaskProcess(cmd: string[], o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; stdinPipe?: boolean; spawnImpl?: SpawnFn }): ChildProcess {
  const [bin, ...args] = cmd;
  return (o.spawnImpl ?? spawn)(bin!, args, {
    stdio: [o.stdinPipe ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: o.platform !== 'win32',
    env: o.env,
  });
}

export function killTaskProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid) killGroup(child.pid); else child.kill('SIGKILL');
}

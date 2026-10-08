import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import open from 'open';
import { sweepRunDir } from '../agent/launcher.ts';
import { ClaudeCodeRunner, claudeCommandFromEnv } from '../agent/claude-code-runner.ts';
import { cachedSandboxDetection } from '../agent/sandbox.ts';
import { AppConfigStore, defaultConfigDir } from '../app-config.ts';
import { AgentBridge } from '../bridge/bridge.ts';
import { runDoctor, type ShellPathOrigin } from '../doctor.ts';
import { execCommand } from '../exec.ts';
import { Git } from '../git.ts';
import { createFfmpegTools } from '../media/media-tools.ts';
import { KeyringVault, type SecretsVault } from '../secrets/vault.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { buildServer } from './app.ts';
import { acquireBootLock, type BootLock } from './boot-lock.ts';
import { findRunningInstance, type RunningInstance } from './running-instance.ts';
import { loadOrCreateUiToken, removeServerInfo, uiUrl, writeServerInfo } from './ui-token.ts';

/** The `studio` MCP server in the source tree (dev); packaged builds pass their own path. */
const DEV_MCP_SERVER = fileURLToPath(new URL('../../../mcp-studio/src/server.mjs', import.meta.url));

/** Shows a folder to the user: selected in the Finder on macOS (never "opened" as an app bundle), opened elsewhere. */
async function revealFolder(p: string): Promise<void> {
  if (process.platform === 'darwin') {
    const r = await execCommand('open', ['-R', p]);
    if (r.code !== 0) throw new WorkspaceError(500, 'Impossibile mostrare la cartella degli output nel Finder');
    return;
  }
  await open(p);
}

/** 4318 first (stable between runs), any free port when it is taken. */
async function listenAuto(app: FastifyInstance, host: string): Promise<string> {
  try {
    return await app.listen({ port: 4318, host });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    return app.listen({ port: 0, host });
  }
}

/** Thrown by startServer when another live Motion Studio already serves the same config folder: open its address instead. */
export class AlreadyRunningError extends Error {
  constructor(readonly alreadyRunning: RunningInstance) {
    super(`Motion Studio è già avviato (porta ${alreadyRunning.port})`);
    this.name = 'AlreadyRunningError';
  }
}

export interface StartServerOptions {
  /** 'auto': 4318, or a free port when busy. Default 4317. */
  port?: number | 'auto'; host?: string; configDir?: string; webDir?: string; claudeCommand?: string[]; mcpServerPath?: string;
  /** Extra env for the MCP server process (Electron passes { ELECTRON_RUN_AS_NODE: '1' }). */
  mcpEnv?: Record<string, string>;
  /** Defaults to the OS keychain. */
  vault?: SecretsVault;
  /** Where PATH came from (desktop): adds the optional `shell-path` Doctor check. */
  shellPath?: ShellPathOrigin;
  /** How long a live instance recorded in run/server.json gets to answer /api/health. Default 3 s. */
  healthTimeoutMs?: number;
  /** How long to wait for another boot holding run/boot.lock. Default 5 s. */
  bootLockWaitMs?: number;
}

export async function startServer(opts: StartServerOptions = {}) {
  const configDir = opts.configDir ?? defaultConfigDir();
  // One running instance per config folder: two cores would share workspace, jobs and run/ files. The boot lock makes
  // "check, then start and write server.json" atomic between two launches.
  const lock = await lockAndCheck(configDir, opts);
  try {
    return await startLocked(configDir, opts);
  } finally {
    await lock.release();
  }
}

const BOOT_BUSY = 'Un altro Motion Studio si sta avviando con la stessa configurazione: riprova tra poco';

/** Takes the boot lock and confirms no other instance runs; throws AlreadyRunningError when one does. */
async function lockAndCheck(configDir: string, opts: StartServerOptions): Promise<BootLock> {
  const check = async () => {
    const running = await findRunningInstance(configDir, { healthTimeoutMs: opts.healthTimeoutMs });
    if (running) throw new AlreadyRunningError(running);
  };
  let lock = await acquireBootLock(configDir, { waitMs: opts.bootLockWaitMs });
  if (lock === 'waited') {
    // The other boot has likely started by now.
    await check();
    lock = await acquireBootLock(configDir, { waitMs: 0 });
    if (lock === 'waited') throw new Error(BOOT_BUSY);
  }
  try {
    await check();
  } catch (err) {
    await lock.release();
    throw err;
  }
  return lock;
}

async function startLocked(configDir: string, opts: StartServerOptions) {
  const claudeCommand = opts.claudeCommand ?? claudeCommandFromEnv();
  // Leftovers (config and token files) of a run that was killed with the app; no other instance is alive here.
  await sweepRunDir(configDir).catch(() => {});
  const bridge = new AgentBridge();
  const mcpServerPath = opts.mcpServerPath ?? DEV_MCP_SERVER;
  // Without the server file the agent runs as in phase 3 (anything that would prompt is denied) instead of failing to start.
  const mcpCommand = existsSync(mcpServerPath) ? [process.execPath, mcpServerPath] : null;
  // One detection shared by the agent launcher and the Doctor.
  const sandbox = cachedSandboxDetection();
  const uiToken = await loadOrCreateUiToken(configDir);
  const app = await buildServer({
    uiToken,
    appConfig: new AppConfigStore(configDir),
    configDir,
    git: new Git(),
    runner: new ClaudeCodeRunner(claudeCommand),
    bridge, mcpCommand, sandbox, ...(opts.mcpEnv ? { mcpEnv: opts.mcpEnv } : {}),
    doctor: (extra) => runDoctor({ exec: execCommand, claudeCommand, sandbox: extra.sandbox, ...(opts.shellPath ? { shellPath: opts.shellPath } : {}) }),
    webDir: opts.webDir,
    vault: opts.vault ?? new KeyringVault(),
    media: await createFfmpegTools(),
    openPath: revealFolder,
  });
  const host = opts.host ?? '127.0.0.1';
  const url = opts.port === 'auto' ? await listenAuto(app, host) : await app.listen({ port: opts.port ?? 4317, host });
  bridge.setOrigin(url);
  const port = Number(new URL(url).port);
  // For `motion-studio --print-url`; removed on a clean shutdown.
  await writeServerInfo(configDir, { port, pid: process.pid, startedAt: new Date().toISOString() }).catch(() => {});
  return {
    url, port,
    /** The address to open: it carries the UI token in the fragment. */
    appUrl: uiUrl(port, uiToken),
    // server.json is removed only when it is still this process's.
    close: async () => { await app.close(); await removeServerInfo(configDir, process.pid); },
  };
}

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { ClaudeCodeRunner, claudeCommandFromEnv } from '../agent/claude-code-runner.ts';
import { cachedSandboxDetection } from '../agent/sandbox.ts';
import { AppConfigStore, defaultConfigDir } from '../app-config.ts';
import { AgentBridge } from '../bridge/bridge.ts';
import { runDoctor } from '../doctor.ts';
import { execCommand } from '../exec.ts';
import { Git } from '../git.ts';
import { createFfmpegTools } from '../media/media-tools.ts';
import { KeyringVault } from '../secrets/vault.ts';
import { buildServer } from './app.ts';

/** The `studio` MCP server in the source tree (dev); packaged builds pass their own path. */
const DEV_MCP_SERVER = fileURLToPath(new URL('../../../mcp-studio/src/server.mjs', import.meta.url));

export async function startServer(opts: { port?: number; host?: string; configDir?: string; webDir?: string; claudeCommand?: string[]; mcpServerPath?: string } = {}) {
  const claudeCommand = opts.claudeCommand ?? claudeCommandFromEnv();
  const configDir = opts.configDir ?? defaultConfigDir();
  const bridge = new AgentBridge();
  const mcpServerPath = opts.mcpServerPath ?? DEV_MCP_SERVER;
  // Without the server file the agent runs as in phase 3 (anything that would prompt is denied) instead of failing to start.
  const mcpCommand = existsSync(mcpServerPath) ? [process.execPath, mcpServerPath] : null;
  // One detection shared by the agent launcher and the Doctor.
  const sandbox = cachedSandboxDetection();
  const app = await buildServer({
    appConfig: new AppConfigStore(configDir),
    configDir,
    git: new Git(),
    runner: new ClaudeCodeRunner(claudeCommand),
    bridge, mcpCommand, sandbox,
    doctor: (extra) => runDoctor({ exec: execCommand, claudeCommand, sandbox: extra.sandbox }),
    webDir: opts.webDir,
    vault: new KeyringVault(),
    media: await createFfmpegTools(),
    openPath: async (p) => { await open(p); },
  });
  const url = await app.listen({ port: opts.port ?? 4317, host: opts.host ?? '127.0.0.1' });
  bridge.setOrigin(url);
  return { url, close: () => app.close() };
}

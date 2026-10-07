import open from 'open';
import { ClaudeCodeRunner, claudeCommandFromEnv } from '../agent/claude-code-runner.ts';
import { AppConfigStore, defaultConfigDir } from '../app-config.ts';
import { runDoctor } from '../doctor.ts';
import { execCommand } from '../exec.ts';
import { Git } from '../git.ts';
import { createFfmpegTools } from '../media/media-tools.ts';
import { buildServer } from './app.ts';

export async function startServer(opts: { port?: number; host?: string; configDir?: string; webDir?: string; claudeCommand?: string[] } = {}) {
  const claudeCommand = opts.claudeCommand ?? claudeCommandFromEnv();
  const app = await buildServer({
    appConfig: new AppConfigStore(opts.configDir ?? defaultConfigDir()),
    git: new Git(),
    runner: new ClaudeCodeRunner(claudeCommand),
    doctor: () => runDoctor({ exec: execCommand, claudeCommand }),
    webDir: opts.webDir,
    media: await createFfmpegTools(),
    openPath: async (p) => { await open(p); },
  });
  const url = await app.listen({ port: opts.port ?? 4317, host: opts.host ?? '127.0.0.1' });
  return { url, close: () => app.close() };
}

// The guide's demo Motion Studio: the real core and web UI, with an in-memory keychain (never the system one), the demo
// agent in place of Claude Code, and the configuration folder given in MOTION_STUDIO_CONFIG_DIR. Started by
// site/scripts/guide-shots.mjs with tsx; prints `READY <app url>` once it listens.
import { startServer } from '../../../packages/core/src/server/main.ts';
import { MemoryVault } from '../../../packages/core/src/secrets/vault.ts';

const configDir = process.env.MOTION_STUDIO_CONFIG_DIR;
const agent = process.env.GUIDE_AGENT;
const webDir = process.env.GUIDE_WEB_DIR;
if (!configDir || !agent || !webDir) throw new Error('MOTION_STUDIO_CONFIG_DIR, GUIDE_AGENT and GUIDE_WEB_DIR are required');

const server = await startServer({
  port: 'auto', configDir, webDir, claudeCommand: [agent], vault: new MemoryVault(), systemLocales: ['en-US'],
  // A deleted creative goes to a Trash folder inside the demo, never the user's.
  trash: async (p) => { const { rename, mkdir } = await import('node:fs/promises'); const { basename, join } = await import('node:path'); const bin = join(configDir, '..', 'trash'); await mkdir(bin, { recursive: true }); await rename(p, join(bin, `${Date.now()}-${basename(p)}`)); },
});
console.log(`READY ${server.appUrl}`);
const stop = () => { server.close().then(() => process.exit(0), () => process.exit(1)); };
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, stop);

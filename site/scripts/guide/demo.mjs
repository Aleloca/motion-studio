// Starts the guide's demo Motion Studio (demo-server.ts under tsx) in a folder whose path names no user, and talks to its
// API with the interface's access code. Only the process started here is ever stopped.
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const TSX = join(REPO, 'packages', 'core', 'node_modules', '.bin', 'tsx');

export async function startDemo({ root }) {
  rmSync(root, { recursive: true, force: true });
  const dirs = { config: join(root, 'config'), workspace: join(root, 'workspace'), home: join(root, 'home'), bin: join(root, 'bin'), files: join(root, 'files') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  // The agent is copied next to the demo, so any path the app shows is the demo's, never the repository's.
  const agent = join(dirs.bin, 'claude');
  copyFileSync(join(HERE, 'demo-agent.mjs'), agent);
  chmodSync(agent, 0o755);
  const hold = join(root, 'hold');
  const env = {
    ...process.env,
    HOME: dirs.home, MOTION_STUDIO_CONFIG_DIR: dirs.config, GUIDE_AGENT: agent, GUIDE_HOLD: hold, ...(process.env.GUIDE_AGENT_LOG ? { GUIDE_AGENT_LOG: process.env.GUIDE_AGENT_LOG } : {}),
    GUIDE_WEB_DIR: join(REPO, 'packages', 'web', 'dist'),
    GUIDE_COMPOSITIONS: join(REPO, 'site', 'compositions'), GUIDE_FONTS: join(REPO, 'site', 'src', 'assets', 'fonts'),
    OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '', PEXELS_API_KEY: '', UNSPLASH_ACCESS_KEY: '',
  };
  const proc = spawn(TSX, [join(HERE, 'demo-server.ts')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stderr.on('data', (d) => { log += d; });
  const appUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`demo server did not start:\n${log.slice(-2000)}`)), 60_000);
    proc.stdout.on('data', (d) => {
      log += d;
      const m = /READY (\S+)/.exec(log);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`demo server exited (${code}):\n${log.slice(-2000)}`)); });
  });
  const origin = new URL(appUrl).origin;
  const token = readFileSync(join(dirs.config, 'ui-token'), 'utf8').trim();
  const api = async (method, path, body) => {
    const res = await fetch(`${origin}${path}`, {
      method, headers: { 'x-motion-studio-ui': token, ...(body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  return {
    appUrl, origin, token, api, dirs, hold, log: () => log,
    async stop() {
      if (proc.exitCode !== null) return;
      const gone = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGTERM');
      await Promise.race([gone, new Promise((r) => setTimeout(r, 8000))]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    },
  };
}

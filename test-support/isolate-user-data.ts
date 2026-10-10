import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Global test isolation (decisions log 141, round 5): every test file runs with its own throwaway config folder and home,
 * so no code path that falls back to a default (`defaultConfigDir()`, `os.homedir()`, a `~/…` workspace) can reach the
 * user's real `~/Library/Application Support/Motion Studio` or `~/MotionStudio`. Registered in every package's vitest
 * config. `defaultConfigDir()` also refuses to return a real path under vitest (app-config.ts).
 */
const root = mkdtempSync(join(tmpdir(), 'ms-test-home-'));
const home = join(root, 'home');
const config = join(root, 'config');
for (const [k, v] of Object.entries({
  MOTION_STUDIO_CONFIG_DIR: config, HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData', 'Roaming'),
})) process.env[k] = v;

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

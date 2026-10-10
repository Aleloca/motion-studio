import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { appConfigSchema, type AppConfig, type LanguageSetting } from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from './json-file.ts';
import { KeyedMutex } from './keyed-mutex.ts';

/** Serializes the read-modify-write of each config file, across every store on it in this process. */
const writes = new KeyedMutex();

const inside = (p: string, dir: string) => { const r = resolve(p); const d = resolve(dir); return r === d || r.startsWith(d.endsWith(sep) ? d : `${d}${sep}`); };
/** The OS account's real home, from the user database (not `$HOME`, which tests replace). */
const realHome = () => { try { return userInfo().homedir; } catch { return homedir(); } };

/**
 * Under vitest, a path in the user's real data folders (the app config folder, `~/MotionStudio`) is refused: a test that
 * forgot to pass its own folder must fail, never write there (decisions log 141, round 5). Outside tests this is a no-op.
 */
export function assertNotRealUserData(path: string): void {
  if (!process.env.VITEST) return;
  const home = realHome();
  const real = [join(home, 'Library', 'Application Support', 'Motion Studio'), join(home, 'MotionStudio'), join(home, '.config', 'motion-studio'), join(home, 'AppData', 'Roaming', 'Motion Studio')];
  if (real.some((d) => inside(path, d))) throw new Error(`test isolation: refusing the real user data path ${path}`);
}

export function defaultConfigDir(): string {
  const override = process.env.MOTION_STUDIO_CONFIG_DIR;
  // Under vitest the default must come from the isolation setup (a temp folder), never from the real home.
  if (process.env.VITEST) {
    if (!override || !inside(override, tmpdir())) throw new Error('test isolation: defaultConfigDir() needs MOTION_STUDIO_CONFIG_DIR in the temp folder under vitest');
    return override;
  }
  if (override) return override;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Motion Studio');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Motion Studio');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'motion-studio');
}

export class AppConfigStore {
  private readonly file: string;
  constructor(configDir: string) { assertNotRealUserData(configDir); this.file = join(configDir, 'config.json'); }

  async read(): Promise<AppConfig> {
    try {
      return await readJsonFile(this.file, appConfigSchema);
    } catch (e) {
      if (e instanceof JsonFileError && e.reason === 'missing') return { schemaVersion: 1, workspacePath: null, language: 'system' };
      throw e;
    }
  }

  setWorkspacePath(path: string): Promise<AppConfig> {
    return this.update({ workspacePath: path });
  }

  setLanguage(setting: LanguageSetting): Promise<AppConfig> {
    return this.update({ language: setting });
  }

  private update(patch: Partial<AppConfig>): Promise<AppConfig> {
    return writes.run(this.file, async () => {
      const next: AppConfig = { ...(await this.read()), ...patch };
      await writeJsonFileAtomic(this.file, next);
      return next;
    });
  }
}

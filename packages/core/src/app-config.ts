import { homedir } from 'node:os';
import { join } from 'node:path';
import { appConfigSchema, type AppConfig, type LanguageSetting } from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from './json-file.ts';

export function defaultConfigDir(): string {
  const override = process.env.MOTION_STUDIO_CONFIG_DIR;
  if (override) return override;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Motion Studio');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Motion Studio');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'motion-studio');
}

export class AppConfigStore {
  private readonly file: string;
  constructor(configDir: string) { this.file = join(configDir, 'config.json'); }

  async read(): Promise<AppConfig> {
    try {
      return await readJsonFile(this.file, appConfigSchema);
    } catch (e) {
      if (e instanceof JsonFileError && e.reason === 'missing') return { schemaVersion: 1, workspacePath: null, language: 'system' };
      throw e;
    }
  }

  async setWorkspacePath(path: string): Promise<AppConfig> {
    const next: AppConfig = { ...(await this.read()), workspacePath: path };
    await writeJsonFileAtomic(this.file, next);
    return next;
  }

  async setLanguage(setting: LanguageSetting): Promise<AppConfig> {
    const next: AppConfig = { ...(await this.read()), language: setting };
    await writeJsonFileAtomic(this.file, next);
    return next;
  }
}

import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfigStore, assertNotRealUserData, defaultConfigDir } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { IntegrityStore } from '../src/project-integrity.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';

const underTmp = (p: string) => resolve(p).startsWith(resolve(tmpdir()) + sep);
afterEach(() => { vi.unstubAllEnvs(); });

describe('test isolation (decisions log 141, round 5)', () => {
  it('the config folder and home resolve inside the OS temp folder during tests', () => {
    expect(underTmp(defaultConfigDir())).toBe(true);
    expect(underTmp(homedir())).toBe(true);
  });
  it('defaultConfigDir() throws under vitest instead of returning a real path', () => {
    vi.stubEnv('MOTION_STUDIO_CONFIG_DIR', '');
    expect(() => defaultConfigDir()).toThrow('test isolation');
    vi.stubEnv('MOTION_STUDIO_CONFIG_DIR', join(userInfo().homedir, 'Library', 'Application Support', 'Motion Studio'));
    expect(() => defaultConfigDir()).toThrow('test isolation');
  });
  it('the real app config folder and ~/MotionStudio are refused by the stores', async () => {
    const real = userInfo().homedir;
    for (const p of [join(real, 'Library', 'Application Support', 'Motion Studio'), join(real, 'MotionStudio'), join(real, 'MotionStudio', 'p')]) {
      expect(() => assertNotRealUserData(p), p).toThrow('test isolation');
    }
    expect(() => new AppConfigStore(join(real, 'Library', 'Application Support', 'Motion Studio'))).toThrow('test isolation');
    expect(() => new IntegrityStore(join(real, 'Library', 'Application Support', 'Motion Studio'))).toThrow('test isolation');
    await expect(WorkspaceStore.open(join(real, 'MotionStudio'), new Git())).rejects.toThrow('test isolation');
  });
});

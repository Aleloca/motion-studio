import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USER_DATA_ENV, userDataDir, userDataOverride } from '../src/helpers.ts';

// B1 (final wave): MOTION_STUDIO_USER_DATA_DIR moves Electron's data (userData, sessionData, logs) for a launch that must
// never touch the real folders: refused when it is (or is inside, or contains) the default one or any "Motion Studio*"
// folder of appData, real paths resolved. Everything here is a fake appData under the OS temp folder.

let root: string;
let appData: string;
let scratch: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ms-test-userdata-')));
  appData = join(root, 'Application Support');
  for (const d of ['Motion Studio', 'Motion Studio Electron', 'Motion Studio Beta', 'Other App']) mkdirSync(join(appData, d), { recursive: true });
  scratch = join(root, 'scratch');
  mkdirSync(scratch);
  symlinkSync(join(appData, 'Motion Studio'), join(root, 'link-to-config'));
  symlinkSync(appData, join(root, 'link-to-appdata'));
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const check = (value: string | undefined) => userDataOverride({ [USER_DATA_ENV]: value }, appData);

describe('MOTION_STUDIO_USER_DATA_DIR', () => {
  it('unset or empty: no override', () => {
    expect(userDataOverride({}, appData)).toBeNull();
    expect(check('')).toBeNull();
  });
  it('a scratch folder (existing or not yet) is used as it is', () => {
    expect(check(join(scratch, 'electron'))).toEqual({ dir: join(scratch, 'electron') });
    expect(check(scratch)).toEqual({ dir: scratch });
    expect(check(join(appData, 'Other App', 'ms'))).toEqual({ dir: join(appData, 'Other App', 'ms') });
  });
  it('refuses a relative path', () => {
    expect(check('rel/dir')).toMatchObject({ error: expect.stringContaining('absolute') });
  });
  it('refuses the default folder, any Motion Studio* folder, inside one, or a folder that contains one', () => {
    for (const bad of [
      userDataDir(appData), join(appData, 'Motion Studio'), join(appData, 'Motion Studio Beta'),
      join(appData, 'Motion Studio', 'sub'), join(appData, 'Motion Studio Electron', 'x', 'y'),
      appData, root, join(appData, '..'), join(appData, 'Motion Studio', '..', 'Motion Studio'),
    ]) expect(check(bad), bad).toMatchObject({ error: expect.stringContaining(USER_DATA_ENV) });
  });
  it('resolves links: a path through a link into a real folder is refused', () => {
    expect(check(join(root, 'link-to-config'))).toMatchObject({ error: expect.any(String) });
    expect(check(join(root, 'link-to-config', 'new'))).toMatchObject({ error: expect.any(String) });
    expect(check(join(root, 'link-to-appdata', 'Motion Studio Electron'))).toMatchObject({ error: expect.any(String) });
    // A Motion Studio* folder that does not exist yet is still refused (the default one, e.g. on a fresh machine).
    rmSync(join(appData, 'Motion Studio Electron'), { recursive: true });
    expect(check(join(appData, 'Motion Studio Electron', 'x'))).toMatchObject({ error: expect.any(String) });
    mkdirSync(join(appData, 'Motion Studio Electron'));
  });
  it('case variants on macOS and Windows: MOTION STUDIO, a lowercased appData, a link into the real folder (N2)', () => {
    const ci = (value: string, platform = process.platform === 'win32' ? 'win32' : 'darwin') => userDataOverride({ [USER_DATA_ENV]: value }, appData, platform);
    for (const bad of [
      join(appData, 'MOTION STUDIO', 'sub'), join(appData, 'motion studio electron'), join(appData, 'Motion studio beta', 'x'),
      join(appData.toLowerCase(), 'motion studio electron'), join(appData.toUpperCase(), 'MOTION STUDIO'),
      join(appData, 'MOTION STUDIO NEXT', 'x'), // a Motion Studio* folder that does not exist yet, in any case
      join(root, 'LINK-TO-CONFIG', 'new'),
    ]) expect(ci(bad), bad).toMatchObject({ error: expect.stringContaining(USER_DATA_ENV) });
    expect(ci(join(scratch, 'Electron'))).toEqual({ dir: join(scratch, 'Electron') });
    // Linux volumes are case-sensitive: another case is another folder (when the volume itself is case-sensitive).
    expect(userDataOverride({ [USER_DATA_ENV]: join(appData, 'Motion Studio', 'x') }, appData, 'linux')).toMatchObject({ error: expect.any(String) });
  });
});

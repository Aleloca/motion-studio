import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { electronDataOutside } from './electron/paths.ts';
import { whisperDirOf } from '../src/helpers.ts';

// Final wave B2: before the real-Electron harness does anything, its effective data folders must be under its scratch folder.
const scratch = mkdtempSync(join(tmpdir(), 'ms-test-electron-data-'));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
const report = (over: Record<string, unknown> = {}) => ({ phase: 'paths', pid: 1, ...Object.fromEntries(['appData', 'userData', 'sessionData', 'logs', 'crashDumps'].map((k) => [k, join(scratch, k)])), ...over });

describe('electronDataOutside', () => {
  it('every folder under the scratch folder: none outside', () => {
    expect(electronDataOutside(report(), scratch)).toEqual([]);
  });
  it('a real data folder, a missing one, the scratch folder itself or a link out of it are outside', () => {
    expect(electronDataOutside(report({ userData: '/Users/x/Library/Application Support/Motion Studio Electron' }), scratch)).toEqual(['userData']);
    expect(electronDataOutside(report({ logs: undefined }), scratch)).toEqual(['logs']);
    expect(electronDataOutside(report({ appData: scratch }), scratch)).toEqual(['appData']);
    const outside = mkdtempSync(join(tmpdir(), 'ms-test-outside-'));
    try {
      mkdirSync(join(scratch, 'dir'));
      symlinkSync(outside, join(scratch, 'dir', 'link'));
      // As given it looks inside; its real path is not: outside (also for a folder not created yet behind the link).
      expect(electronDataOutside(report({ sessionData: join(scratch, 'dir', 'link') }), scratch)).toEqual(['sessionData']);
      expect(electronDataOutside(report({ sessionData: join(scratch, 'dir', 'link', 'new') }), scratch)).toEqual(['sessionData']);
      expect(electronDataOutside(report({ sessionData: `${scratch}-sibling/x` }), scratch)).toEqual(['sessionData']);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

// Task 23 (spec §7): the bundled whisper-cli's folder, passed to the core as `whisperDir`.
describe('whisperDirOf', () => {
  it('packaged: the whisper folder of the resources (extraResources), whatever is in it', () => {
    expect(whisperDirOf({ packaged: true, resourcesPath: '/Applications/Motion Studio.app/Contents/Resources', repoRoot: '/x', arch: 'arm64', exists: () => false }))
      .toBe(join('/Applications/Motion Studio.app/Contents/Resources', 'whisper'));
  });
  it('dev: apps/desktop/vendor/whisper/<arch> when scripts/build-whisper.sh built it, else none', () => {
    const dir = join('/repo', 'apps', 'desktop', 'vendor', 'whisper', 'x64');
    expect(whisperDirOf({ packaged: false, resourcesPath: '/r', repoRoot: '/repo', arch: 'x64', exists: (p) => p === dir })).toBe(dir);
    expect(whisperDirOf({ packaged: false, resourcesPath: '/r', repoRoot: '/repo', arch: 'arm64', exists: (p) => p === dir })).toBeUndefined();
  });
});

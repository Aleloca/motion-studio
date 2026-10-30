import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { patternReaches, globFull } from '../src/bridge/protected-paths.ts';
import { ruleGlob, rulePathForm } from '../src/codebases.ts';
import { normalizeCodebasePath, trimTrailingSeparators, WorkspaceError } from '../src/workspace-store.ts';

// User report 95: the Windows forms of the core's absolute-path checks, with `path.win32` / `path.posix` passed explicitly.

describe('permission rule paths (decision 1977)', () => {
  it('win32: a drive path becomes the POSIX form Claude Code matches (`C:\\x` → `/c/x`), `\\` and `/` alike', () => {
    expect(rulePathForm('C:\\Users\\me\\proj\\.studio', win32)).toBe('/c/Users/me/proj/.studio');
    expect(rulePathForm('d:/Work/proj', win32)).toBe('/d/Work/proj');
    expect(rulePathForm('C:\\', win32)).toBe('/c/');
    // The rule is `Read(/` + this: `Read(//c/Users/me/proj/**)`, glob characters still escaped.
    expect(`Read(/${ruleGlob('C:\\Users\\me\\a [b]', win32)}/**)`).toBe('Read(//c/Users/me/a \\[b\\]/**)');
  });

  it('posix: unchanged (a backslash in a name stays escaped)', () => {
    expect(rulePathForm('/Users/me/proj', posix)).toBe('/Users/me/proj');
    expect(ruleGlob('/Users/me/a\\b', posix)).toBe('/Users/me/a\\\\b');
  });
});

describe('codebase paths on Windows (decision 1978)', () => {
  const home = 'C:\\Users\\Me';
  it('trailing separators of both kinds are dropped; a disk root is empty', () => {
    expect(trimTrailingSeparators('C:\\work\\app\\/', win32)).toBe('C:\\work\\app');
    expect(trimTrailingSeparators('C:\\', win32)).toBe('');
    expect(trimTrailingSeparators('/', posix)).toBe('');
    expect(trimTrailingSeparators('/a/b\\', posix)).toBe('/a/b\\');
  });

  it('the disk root and the home (any case, trailing `\\`) are refused; a folder inside is kept', () => {
    expect(() => normalizeCodebasePath('C:\\', win32, home)).toThrow(WorkspaceError);
    expect(() => normalizeCodebasePath('C:/', win32, home)).toThrow(WorkspaceError);
    expect(() => normalizeCodebasePath('c:\\users\\me\\', win32, home)).toThrow(WorkspaceError);
    expect(() => normalizeCodebasePath('C:/Users/Me', win32, home)).toThrow(WorkspaceError);
    expect(normalizeCodebasePath('C:/Users/Me/app/', win32, home)).toBe('C:\\Users\\Me\\app');
    expect(normalizeCodebasePath('C:\\Users\\Me2', win32, home)).toBe('C:\\Users\\Me2');
    expect(() => normalizeCodebasePath('Users\\Me\\app', win32, home)).toThrow(WorkspaceError);
  });

  it('posix keeps its exact comparison', () => {
    expect(() => normalizeCodebasePath('/home/me/', posix, '/home/me')).toThrow(WorkspaceError);
    expect(normalizeCodebasePath('/home/ME', posix, '/home/me')).toBe('/home/ME');
  });
});

describe('Glob patterns toward a protected folder on Windows (decision 1979)', () => {
  const root = 'C:/Users/me/AppData/Roaming/Motion Studio';
  it('a pattern written with `\\` (or mixed) is split like one written with `/`', () => {
    for (const pattern of ['C:\\Users\\me\\AppData\\Roaming\\Motion Studio\\*', 'C:/Users/me/AppData\\Roaming/Motion Studio/*.json', 'c:\\users\\ME\\appdata\\roaming\\motion studio\\**']) {
      const full = globFull(pattern, win32);
      expect(full).not.toContain('\\');
      // The segment regex folds case on win32 and darwin (this machine's platform decides it).
      if (process.platform === 'win32' || process.platform === 'darwin' || !pattern.startsWith('c:')) expect(patternReaches(full, root)).toBe(true);
    }
  });

  it('each `..` after a wildcard climbs one level from the literal folder; a sibling folder is not reached', () => {
    expect(globFull('C:\\Users\\me\\x\\*\\..\\..\\**', win32)).toBe('C:/Users/**');
    expect(patternReaches(globFull('C:\\Users\\me\\x\\*\\..\\..\\**', win32), root)).toBe(true);
    expect(patternReaches(globFull('C:\\Users\\me\\AppData\\Roaming\\Motion Studio2\\*', win32), root)).toBe(false);
  });

  it('posix: unchanged', () => {
    expect(globFull('/a/b/./c/*', posix)).toBe('/a/b/c/*');
    expect(globFull('/a/b/*/../**', posix)).toBe('/a/**');
  });
});

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCodebases, codebaseSnapshot, normalizeCodebasePath, readOnlyRules } from '../src/codebases.ts';
import { execCommand } from '../src/exec.ts';

describe('normalizeCodebasePath', () => {
  it('expands ~, strips trailing slashes and requires absolute paths', () => {
    expect(normalizeCodebasePath(' ~/dev/app/ ')).toBe(join(homedir(), 'dev', 'app'));
    expect(normalizeCodebasePath('/Users/me/My App/')).toBe('/Users/me/My App');
    expect((() => { try { normalizeCodebasePath('dev/app'); } catch (e) { return (e as { status: number }).status; } })()).toBe(400);
  });
});

describe('readOnlyRules', () => {
  it('builds absolute Edit deny rules', () => {
    expect(readOnlyRules(['/Users/me/My App', '/opt/x'])).toEqual(['Edit(//Users/me/My App/**)', 'Edit(//opt/x/**)']);
  });
});

describe('checkCodebases', () => {
  it('flags missing folders and files, and dedupes', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ms-cb è '));
    await mkdir(join(base, 'app'));
    await writeFile(join(base, 'file.txt'), 'x');
    const r = await checkCodebases([
      { path: join(base, 'app'), note: 'iOS' }, { path: join(base, 'app') }, { path: join(base, 'missing') }, { path: join(base, 'file.txt') },
    ]);
    expect(r).toEqual([
      { path: join(base, 'app'), note: 'iOS', exists: true },
      { path: join(base, 'missing'), exists: false },
      { path: join(base, 'file.txt'), exists: false },
    ]);
  });
});

describe('codebaseSnapshot', () => {
  it('returns git status for repos and null otherwise', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ms-cb-git-'));
    await execCommand('git', ['init', '-q'], { cwd: repo });
    expect(await codebaseSnapshot(repo)).toBe('');
    await writeFile(join(repo, 'new.txt'), 'x');
    expect(await codebaseSnapshot(repo)).toContain('new.txt');
    expect(await codebaseSnapshot(await mkdtemp(join(tmpdir(), 'ms-cb-plain-')))).toBeNull();
  });
});

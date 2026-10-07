import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCodebases, codebaseSnapshot, normalizeCodebaseList, normalizeCodebasePath, readOnlyRules } from '../src/codebases.ts';
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

describe('readOnlyRules escaping', () => {
  it('escapes glob metacharacters, backslash first', () => {
    expect(readOnlyRules(['/a/cb [x]'])).toEqual(['Edit(//a/cb \\[x\\]/**)']);
    expect(readOnlyRules(['/a/s*t?'])).toEqual(['Edit(//a/s\\*t\\?/**)']);
    expect(readOnlyRules(['/a/b\\c'])).toEqual(['Edit(//a/b\\\\c/**)']);
  });
});

describe('normalizeCodebasePath root', () => {
  it('refuses the filesystem root and keeps backslashes', () => {
    for (const r of ['/', ' // ']) {
      expect((() => { try { normalizeCodebasePath(r); } catch (e) { return (e as { status: number }).status; } })()).toBe(400);
    }
    expect(normalizeCodebasePath('/a/b\\')).toBe('/a/b\\');
  });
});

describe('normalizeCodebasePath home', () => {
  it('refuses the home folder itself but not subfolders', () => {
    for (const h of ['~', '~/', homedir(), homedir() + '/']) {
      expect((() => { try { normalizeCodebasePath(h); } catch (e) { return (e as { status: number }).status; } })()).toBe(400);
    }
    expect(normalizeCodebasePath('~/dev')).toBe(join(homedir(), 'dev'));
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

const val = (s: Awaited<ReturnType<typeof codebaseSnapshot>>) => ('value' in s ? s.value : null);

describe('codebaseSnapshot', () => {
  const git = (cwd: string, ...a: string[]) => execCommand('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd });
  it('returns a snapshot for repos (also without commits) and distinguishes not-git', { timeout: 20_000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ms-cb-git-'));
    await git(repo, 'init', '-q');
    const empty = val(await codebaseSnapshot(repo));
    expect(empty).not.toBeNull();
    await writeFile(join(repo, 'new.txt'), 'x');
    expect(val(await codebaseSnapshot(repo))).not.toBe(empty);
    expect(await codebaseSnapshot(await mkdtemp(join(tmpdir(), 'ms-cb-plain-')))).toEqual({ unavailable: 'not-git' });
  });
  it('detects ignored files and a tracked file modified again', { timeout: 20_000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ms-cb-git-'));
    await git(repo, 'init', '-q');
    await writeFile(join(repo, 'a.txt'), '1');
    await writeFile(join(repo, '.gitignore'), 'ign.txt\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'init');
    const clean = val(await codebaseSnapshot(repo));
    await writeFile(join(repo, 'ign.txt'), 'x');
    const ignored = val(await codebaseSnapshot(repo));
    expect(ignored).not.toBe(clean);
    await writeFile(join(repo, 'a.txt'), '2');
    const first = val(await codebaseSnapshot(repo));
    expect(first).not.toBe(ignored);
    await writeFile(join(repo, 'a.txt'), '3');
    expect(val(await codebaseSnapshot(repo))).not.toBe(first);
  });
  it('handles a large ignored directory without failing and still detects changes', { timeout: 30_000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ms-cb-git-'));
    await git(repo, 'init', '-q');
    await writeFile(join(repo, 'a.txt'), '1');
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'init');
    const nm = join(repo, 'node_modules');
    await mkdir(nm);
    await Promise.all(Array.from({ length: 3000 }, (_, i) => writeFile(join(nm, `${'x'.repeat(120)}-${i}.js`), 'x')));
    const before = await codebaseSnapshot(repo);
    expect(val(before)).not.toBeNull();
    await writeFile(join(repo, 'a.txt'), '2');
    expect(val(await codebaseSnapshot(repo))).not.toBe(val(before));
  });
  it('reports failed on timeout or other errors', async () => {
    expect(await codebaseSnapshot('/x', async () => ({ code: -1, hash: '', stderr: '', timedOut: true }))).toEqual({ unavailable: 'failed' });
    expect(await codebaseSnapshot('/x', async () => ({ code: 1, hash: '', stderr: 'boom', timedOut: false }))).toEqual({ unavailable: 'failed' });
  });
});

describe('normalizeCodebaseList', () => {
  it('normalizes, trims notes and dedupes', () => {
    expect(normalizeCodebaseList([{ path: '/a/b/', note: ' x ' }, { path: '/a/b', note: 'y' }, { path: '/c', note: '  ' }])).toEqual([{ path: '/a/b', note: 'x' }, { path: '/c' }]);
  });
});

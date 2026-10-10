import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { execCommand, type CommandExec } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { IntegrityStore, snapshotProtected } from '../src/project-integrity.ts';

describe('Git', () => {
  it('inits a repo and commits all files, returning the sha', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms git è '));
    const git = new Git();
    await git.init(dir);
    await writeFile(join(dir, 'a.txt'), 'hello');
    const sha = await git.commitAll(dir, 'first');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const log = await execCommand('git', ['log', '--format=%s'], { cwd: dir });
    expect(log.stdout.trim()).toBe('first');
  });
  it('returns null when there is nothing to commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-git-'));
    const git = new Git();
    await git.init(dir);
    await writeFile(join(dir, 'a.txt'), 'x');
    await git.commitAll(dir, 'first');
    await expect(git.commitAll(dir, 'again')).resolves.toBeNull();
  });
  it('serializes concurrent commits on the same repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-git-'));
    const git = new Git();
    await git.init(dir);
    await writeFile(join(dir, 'a.txt'), '1');
    await writeFile(join(dir, 'b.txt'), '2');
    const results = await Promise.all([git.commitAll(dir, 'c1'), git.commitAll(dir, 'c2')]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
  it('commits only the given paths, leaving other changes (staged or not) out of the commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-git-'));
    const git = new Git();
    await git.init(dir);
    await mkdir(join(dir, 'c', 'work'), { recursive: true });
    await writeFile(join(dir, 'c', 'creative.json'), '{}');
    await git.commitAll(dir, 'first');
    await writeFile(join(dir, 'c', 'creative.json'), '{"a":1}');
    await writeFile(join(dir, 'c', 'work', 'half.ts'), 'half-written');
    await execCommand('git', ['add', '--', 'c/work/half.ts'], { cwd: dir });
    const sha = await git.commitPaths(dir, ['c/creative.json'], 'state');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const files = await execCommand('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: dir });
    expect(files.stdout.trim().split('\n')).toEqual(['c/creative.json']);
    await expect(git.commitPaths(dir, ['c/creative.json'], 'again')).resolves.toBeNull();
    // The other change is still there, for the next full commit.
    expect((await execCommand('git', ['status', '--porcelain'], { cwd: dir })).stdout).toContain('c/work/half.ts');
  });
});

describe('Git errors and locking', () => {
  it('labels a failure with the subcommand only (no identity pairs, no commit message)', async () => {
    const exec: CommandExec = async (_cmd, args) =>
      args.includes('commit') ? { code: 1, stdout: '', stderr: 'nothing\n', notFound: false }
        : { code: 0, stdout: args.includes('status') ? ' M a\n' : '', stderr: '', notFound: false };
    const err = await new Git(exec).commitAll('/r', 'Messaggio segreto').catch((e) => e);
    expect(err.message).toBe('git commit fallito: nothing');
  });
  it('serializes commits on the same folder written differently', async () => {
    let active = 0;
    let maxActive = 0;
    const exec: CommandExec = async (_cmd, args) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { code: 0, stdout: args.includes('status') ? ' M a\n' : 'sha\n', stderr: '', notFound: false };
    };
    const git = new Git(exec);
    await Promise.all([git.commitAll('/r/p', 'a'), git.commitAll('/r/p/', 'b'), git.commitAll('/r/x/../p', 'c')]);
    expect(maxActive).toBe(1);
  });
});

describe('Git hardening', () => {
  it('prefixes every git invocation with hooks and fsmonitor disabled', async () => {
    const calls: string[][] = [];
    const exec: CommandExec = async (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: args.includes('status') ? ' M a\n' : args.includes('clean') ? '' : 'abcdef1\n', stderr: '', notFound: false };
    };
    const git = new Git(exec);
    await git.init('/r');
    await git.commitAll('/r', 'm');
    await git.restorePath('/r', 'abcdef1', 'work');
    expect(calls.length).toBeGreaterThan(5);
    for (const args of calls) expect(args.slice(0, 4)).toEqual(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']);
  });
  it('never runs a hook planted in the repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-hook-'));
    const marker = join(await mkdtemp(join(tmpdir(), 'ms-hook-marker-')), 'ran');
    const git = new Git();
    await git.init(dir);
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit']) {
      await writeFile(join(dir, '.git', 'hooks', hook), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    }
    await writeFile(join(dir, 'a.txt'), 'x');
    expect(await git.commitAll(dir, 'first')).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('execCommand', () => {
  it('flags a missing binary instead of throwing', async () => {
    const r = await execCommand('definitely-not-a-binary-ms', ['--version']);
    expect(r.notFound).toBe(true);
    expect(r.code).toBe(-1);
  });
});

describe('Git.restorePath', () => {
  it('restores a folder to a past commit, removing files added later', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-restore-'));
    const git = new Git();
    await git.init(dir);
    await mkdir(join(dir, 'work'));
    await writeFile(join(dir, 'work', 'a.txt'), 'v1');
    const v1 = (await git.commitAll(dir, 'v1'))!;
    await writeFile(join(dir, 'work', 'a.txt'), 'v2');
    await writeFile(join(dir, 'work', 'b.txt'), 'new');
    await git.commitAll(dir, 'v2');
    await git.restorePath(dir, v1, 'work');
    expect(await readFile(join(dir, 'work', 'a.txt'), 'utf8')).toBe('v1');
    expect(await readdir(join(dir, 'work'))).toEqual(['a.txt']);
  });
  it('rejects unknown or malformed commits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-restore-'));
    const git = new Git();
    await git.init(dir);
    await writeFile(join(dir, 'x'), '1');
    await git.commitAll(dir, 'c');
    await expect(git.restorePath(dir, 'deadbeef', 'x')).rejects.toThrow('Versione non trovata');
    await expect(git.restorePath(dir, '--help', 'x')).rejects.toThrow('Versione non trovata');
  });
  it('treats the path literally and removes untracked files except ignored ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-restore-'));
    const git = new Git();
    await git.init(dir);
    await writeFile(join(dir, '.gitignore'), 'node_modules/\n');
    await mkdir(join(dir, 'w*'));
    await writeFile(join(dir, 'w*', 'a.txt'), 'v1');
    await mkdir(join(dir, 'wx'));
    await writeFile(join(dir, 'wx', 'a.txt'), 'other');
    const v1 = (await git.commitAll(dir, 'v1'))!;
    await writeFile(join(dir, 'w*', 'a.txt'), 'changed');
    await writeFile(join(dir, 'w*', 'loose.txt'), 'loose');
    await mkdir(join(dir, 'w*', 'node_modules'));
    await writeFile(join(dir, 'w*', 'node_modules', 'm.js'), '');
    await writeFile(join(dir, 'wx', 'a.txt'), 'other changed');
    await writeFile(join(dir, 'wx', 'loose.txt'), 'keep');
    expect(await git.restorePath(dir, v1, 'w*')).toBe(1);
    expect((await readdir(join(dir, 'w*'))).sort()).toEqual(['a.txt', 'node_modules']);
    expect(await readFile(join(dir, 'w*', 'a.txt'), 'utf8')).toBe('v1');
    // A glob-like name must not reach the sibling folder.
    expect(await readFile(join(dir, 'wx', 'a.txt'), 'utf8')).toBe('other changed');
    expect((await readdir(join(dir, 'wx'))).sort()).toEqual(['a.txt', 'loose.txt']);
  });
  it('reports a missing git instead of an unknown version', async () => {
    const exec: CommandExec = async () => ({ code: -1, stdout: '', stderr: '', notFound: true });
    await expect(new Git(exec).restorePath('/r', 'abcdef1', 'work')).rejects.toThrow('git non trovato');
  });
});

describe('Git.commitAll and the sandbox cache', () => {
  it('never commits .cache/, even when the project .gitignore lacks it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-cache-'));
    const git = new Git();
    await git.init(dir);
    await writeFile(join(dir, 'a.txt'), '1');
    await git.commitAll(dir, 'v1');
    await mkdir(join(dir, '.cache', 'npm'), { recursive: true });
    await writeFile(join(dir, '.cache', 'npm', 'blob'), 'x');
    expect(await git.commitAll(dir, 'only cache')).toBe(null);
    await writeFile(join(dir, 'a.txt'), '2');
    expect(await git.commitAll(dir, 'v2')).not.toBe(null);
    const { stdout } = await promisify(execFile)('git', ['ls-files'], { cwd: dir });
    expect(stdout.trim()).toBe('a.txt');
  });
  it('commits when .cache/ is both in .gitignore and present (git 2.50 exclude-pathspec failure)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-cache-ign-'));
    const git = new Git();
    await git.init(dir);
    await writeFile(join(dir, '.gitignore'), '.cache/\n');
    await writeFile(join(dir, 'a.txt'), '1');
    await mkdir(join(dir, '.cache', 'npm'), { recursive: true });
    await writeFile(join(dir, '.cache', 'npm', 'blob'), 'x');
    expect(await git.commitAll(dir, 'v1')).toMatch(/^[0-9a-f]{40}$/);
    await writeFile(join(dir, 'a.txt'), '2');
    expect(await git.commitAll(dir, 'v2')).toMatch(/^[0-9a-f]{40}$/);
    const { stdout } = await promisify(execFile)('git', ['ls-files'], { cwd: dir });
    expect(stdout.trim().split('\n').sort()).toEqual(['.gitignore', 'a.txt']);
  });
  it('never commits creatives/*/work/tmp/ scratch files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-work-tmp-'));
    const git = new Git();
    await git.init(dir);
    await mkdir(join(dir, 'creatives', 'sale', 'work', 'tmp'), { recursive: true });
    await writeFile(join(dir, 'creatives', 'sale', 'work', 'tmp', 'frame.png'), 'x');
    await writeFile(join(dir, 'creatives', 'sale', 'work', 'render.py'), 'print(1)');
    expect(await git.commitAll(dir, 'v1')).not.toBe(null);
    const { stdout } = await promisify(execFile)('git', ['ls-files'], { cwd: dir });
    expect(stdout.trim()).toBe('creatives/sale/work/render.py');
  });
  it('writes the exclusions into .git/info/exclude once (idempotent), keeping existing lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-exclude-'));
    const git = new Git();
    await git.init(dir);
    const path = join(dir, '.git', 'info', 'exclude');
    await writeFile(path, '# mine\nfoo');
    await writeFile(join(dir, 'a.txt'), '1');
    await git.commitAll(dir, 'v1');
    await writeFile(join(dir, 'a.txt'), '2');
    await git.commitAll(dir, 'v2');
    const lines = (await readFile(path, 'utf8')).split('\n');
    expect(lines.slice(0, 2)).toEqual(['# mine', 'foo']);
    expect(lines.filter((l) => l === '/.cache/')).toHaveLength(1);
    expect(lines.filter((l) => l === '/creatives/*/work/tmp/')).toHaveLength(1);
  });
  it('init writes the exclusions too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-exclude-init-'));
    await new Git().init(dir);
    const text = await readFile(join(dir, '.git', 'info', 'exclude'), 'utf8');
    expect(text).toContain('/.cache/\n');
    expect(text).toContain('/creatives/*/work/tmp/\n');
  });
});

describe('Git hardening (decisions log 141)', () => {
  const freshCommit = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-git-safe-'));
    const git = new Git();
    await git.init(dir);
    await writeFile(join(dir, 'a.txt'), 'x');
    return { dir, git };
  };
  it('refuses to commit when .git/config carries a key the core never sets', async () => {
    const { dir, git } = await freshCommit();
    await appendFile(join(dir, '.git', 'config'), '\n[filter "lfs"]\n\tclean = run-me\n');
    await expect(git.commitAll(dir, 'c')).rejects.toThrow();
    // Nothing was committed.
    const log = await execCommand('git', ['log', '--oneline'], { cwd: dir });
    expect(log.code).not.toBe(0);
  });
  it('refuses to commit when .gitattributes carries a filter/diff driver (but allows merge=union)', async () => {
    const ok = await freshCommit();
    await writeFile(join(ok.dir, '.gitattributes'), '.studio/usage.jsonl merge=union\n');
    await expect(ok.git.commitAll(ok.dir, 'c')).resolves.toMatch(/^[0-9a-f]{40}$/);
    const bad = await freshCommit();
    await writeFile(join(bad.dir, '.gitattributes'), '*.c filter=indent\n');
    await expect(bad.git.commitAll(bad.dir, 'c')).rejects.toThrow();
  });
  it('refuses every operation on a quarantined repo and commits again once the protected files are restored', async () => {
    const { dir, git } = await freshCommit();
    const store = new IntegrityStore(await mkdtemp(join(tmpdir(), 'ms-integrity-'))).activate();
    await writeFile(join(dir, 'CLAUDE.md'), '# ok');
    const before = await snapshotProtected(dir);
    await writeFile(join(dir, 'CLAUDE.md'), '# tampered');
    await store.quarantine(dir, 'tampered', ['CLAUDE.md'], before);
    await expect(git.commitAll(dir, 'c')).rejects.toThrow('CLAUDE.md');
    await expect(git.restorePath(dir, 'abcdef1', 'a.txt')).rejects.toThrow('CLAUDE.md');
    await writeFile(join(dir, 'CLAUDE.md'), '# ok');
    await expect(git.commitAll(dir, 'c')).resolves.toMatch(/^[0-9a-f]{40}$/);
    expect(await store.isQuarantined(dir)).toBe(false);
    new IntegrityStore(null).activate();
  });
  it('commits with the Motion Studio identity even with no global config (GIT_CONFIG_GLOBAL=/dev/null)', async () => {
    const { dir, git } = await freshCommit();
    const sha = await git.commitAll(dir, 'c');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const who = await execCommand('git', ['log', '-1', '--format=%an <%ae>'], { cwd: dir });
    expect(who.stdout.trim()).toBe('Motion Studio <motion-studio@localhost>');
  });
});

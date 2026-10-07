import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';

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
});

describe('execCommand', () => {
  it('flags a missing binary instead of throwing', async () => {
    const r = await execCommand('definitely-not-a-binary-ms', ['--version']);
    expect(r.notFound).toBe(true);
    expect(r.code).toBe(-1);
  });
});

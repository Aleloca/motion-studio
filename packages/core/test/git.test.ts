import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execCommand, type CommandExec } from '../src/exec.ts';
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

describe('execCommand', () => {
  it('flags a missing binary instead of throwing', async () => {
    const r = await execCommand('definitely-not-a-binary-ms', ['--version']);
    expect(r.notFound).toBe(true);
    expect(r.code).toBe(-1);
  });
});

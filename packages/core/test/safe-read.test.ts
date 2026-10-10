import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashRegularFile, readRegularFile } from '../src/safe-read.ts';
import { IntegrityStore, snapshotProtected } from '../src/project-integrity.ts';
import { PermissionsStore } from '../src/approvals/permissions-store.ts';
import { activeIntegrityStore } from '../src/project-integrity.ts';
import { inspectGitSafety, MAX_ATTRIBUTES_BYTES } from '../src/git-safety.ts';
import { Git } from '../src/git.ts';

/**
 * Final review B1: files the agent may shape are never read with a plain readFile. Each case below would block forever
 * (a FIFO) or read without bound (/dev/zero) with readFile; the bound here is the vitest timeout plus the size checks,
 * never a wall-clock assertion.
 */
const cleanup: string[] = [];
afterEach(async () => { for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true }); });
async function tmp(): Promise<string> { const d = await mkdtemp(join(tmpdir(), 'ms-safe-')); cleanup.push(d); return d; }
const fifo = (p: string) => execFileSync('mkfifo', [p]);

describe('readRegularFile / hashRegularFile', () => {
  it('reports a FIFO, a link to a FIFO, a device and a missing file without opening them', async () => {
    const d = await tmp();
    fifo(join(d, 'pipe'));
    await symlink(join(d, 'pipe'), join(d, 'to-pipe'));
    await symlink('/dev/zero', join(d, 'to-zero'));
    expect(await readRegularFile(join(d, 'pipe'), 100)).toEqual({ kind: 'special' });
    expect(await readRegularFile(join(d, 'to-pipe'), 100)).toEqual({ kind: 'link' });
    expect(await readRegularFile(join(d, 'to-zero'), 100)).toEqual({ kind: 'link' });
    expect(await readRegularFile('/dev/zero', 100)).toEqual({ kind: 'special' });
    expect(await readRegularFile(join(d, 'none'), 100)).toEqual({ kind: 'missing' });
    expect((await hashRegularFile(join(d, 'pipe'))).kind).toBe('special');
    expect((await hashRegularFile('/dev/zero')).kind).toBe('special');
  });
  it('caps the read: an oversized file is reported, never loaded', async () => {
    const d = await tmp();
    await writeFile(join(d, 'big'), Buffer.alloc(101, 'a'));
    await writeFile(join(d, 'ok'), 'hello');
    expect(await readRegularFile(join(d, 'big'), 100)).toEqual({ kind: 'too-large', size: 101 });
    const ok = await readRegularFile(join(d, 'ok'), 100);
    expect(ok.kind === 'file' && ok.data.toString()).toBe('hello');
  });
});

describe('inspectGitSafety never hangs on a non-regular attributes file (B1)', () => {
  async function repo() { const d = await tmp(); await new Git().init(d); await mkdir(join(d, 'sub')); return d; }
  it('an untracked FIFO named .gitattributes (which ls-files leaves out, and git add would block on) is refused', async () => {
    const d = await repo();
    await writeFile(join(d, 'sub', 'a.txt'), 'x');
    fifo(join(d, 'sub', '.gitattributes'));
    expect(await inspectGitSafety(d)).toContain('sub/.gitattributes is not a regular file');
    await expect(new Git().commitAll(d, 'c')).rejects.toThrow('sub/.gitattributes');
  });
  it('a tracked .gitattributes replaced by a FIFO is refused', async () => {
    const d = await repo();
    await writeFile(join(d, 'sub', '.gitattributes'), '*.txt text\n');
    await new Git().commitAll(d, 'c');
    await rm(join(d, 'sub', '.gitattributes'));
    fifo(join(d, 'sub', '.gitattributes'));
    expect(await inspectGitSafety(d)).toContain('sub/.gitattributes is not a regular file');
  });
  it('an in-tree symlink to a FIFO or to /dev/zero is skipped (git does not follow it either)', async () => {
    const d = await repo();
    fifo(join(d, 'pipe'));
    await symlink('../pipe', join(d, 'sub', '.gitattributes'));
    await symlink('/dev/zero', join(d, '.gitattributes'));
    expect(await inspectGitSafety(d)).toBeNull();
  });
  it('.git/info/attributes as a link to a FIFO is refused (git would follow it)', async () => {
    const d = await repo();
    fifo(join(d, 'pipe'));
    await symlink(join(d, 'pipe'), join(d, '.git', 'info', 'attributes'));
    expect(await inspectGitSafety(d)).toContain('.git/info/attributes is not a regular file');
  });
  it('an oversized attributes file is refused, not read', async () => {
    const d = await repo();
    await writeFile(join(d, 'sub', '.gitattributes'), Buffer.alloc(MAX_ATTRIBUTES_BYTES + 1, '#'));
    expect(await inspectGitSafety(d)).toContain('larger than');
  });
});

describe('integrity snapshots never hang either (B1)', () => {
  it('a FIFO and a link to /dev/zero under .claude are recorded by kind, never opened', async () => {
    const d = await tmp();
    await mkdir(join(d, '.claude'));
    fifo(join(d, '.claude', 'pipe'));
    await symlink('/dev/zero', join(d, '.claude', 'zero'));
    await writeFile(join(d, 'CLAUDE.md'), '# ok');
    const snap = await snapshotProtected(d);
    expect(snap['.claude/pipe']).toBe('o');
    expect(snap['.claude/zero']).toBe('l:/dev/zero');
    expect(snap['CLAUDE.md']).toMatch(/^f:[0-9a-f]{64}$/);
  });
});

describe('noteCoreWrite during a quarantine (review residual 6)', () => {
  it('a core write of permissions.json during a quarantine is not listed as a change, also after a restart', async () => {
    const d = await tmp();
    const configDir = await tmp();
    await writeFile(join(d, 'CLAUDE.md'), '# ok');
    await new PermissionsStore(d).add('Bash(ls:*)', 'x');
    const store = new IntegrityStore(configDir).activate();
    const before = await snapshotProtected(d);
    await writeFile(join(d, 'CLAUDE.md'), '# tampered');
    await store.quarantine(d, 'tampered', ['CLAUDE.md'], before);
    await new PermissionsStore(d).remove('Bash(ls:*)');
    const restarted = new IntegrityStore(configDir);
    expect((await restarted.status(d)).files).toEqual([{ path: 'CLAUDE.md', change: 'changed' }]);
    expect(activeIntegrityStore()).toBe(store);
    new IntegrityStore(null).activate();
  });
});

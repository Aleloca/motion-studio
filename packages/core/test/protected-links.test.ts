import { appendFile, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detachHardLink, detachLinksUnder, detachProtectedLinks } from '../src/agent/protected-links.ts';

const cleanup: string[] = [];
afterEach(async () => { for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true }); });
async function tmp() {
  const d = await mkdtemp(join(tmpdir(), 'ms-links [x] '));
  cleanup.push(d);
  return d;
}

// The sandbox refuses `ln` onto a protected file, so a link can only exist if it was made some other way (or before the
// file was protected); the tests make it with fs.link from outside, standing in for that.
describe('detachHardLink', () => {
  it('gives the protected name a fresh inode with the same bytes and mode: writes through the other name no longer reach it', async () => {
    const d = await tmp();
    const file = join(d, 'conversation.jsonl');
    await writeFile(file, '{"a":1}\n');
    await chmod(file, 0o640);
    await link(file, join(d, 'other'));
    expect(await detachHardLink(file)).toBe(true);
    expect((await stat(file)).nlink).toBe(1);
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    await appendFile(join(d, 'other'), 'forged\n');
    expect(await readFile(file, 'utf8')).toBe('{"a":1}\n');
    expect((await readdir(d)).sort()).toEqual(['conversation.jsonl', 'other']);
  });
  it('leaves single-link files, symlinks, folders and missing paths alone', async () => {
    const d = await tmp();
    await writeFile(join(d, 'one'), 'x');
    await symlink(join(d, 'one'), join(d, 'sym'));
    await mkdir(join(d, 'dir'));
    const before = (await lstat(join(d, 'one'))).ino;
    for (const n of ['one', 'sym', 'dir', 'missing']) expect(await detachHardLink(join(d, n))).toBe(false);
    expect((await lstat(join(d, 'one'))).ino).toBe(before);
  });
});

describe('detachProtectedLinks', () => {
  it('detaches the core-owned files with extra links (creatives, proposals, .studio) and lists them; the agent\'s files are untouched', async () => {
    const p = await tmp();
    const c = join(p, 'creatives', 'c1');
    await mkdir(join(c, 'work'), { recursive: true });
    await mkdir(join(p, 'brand', 'proposals', 'p1'), { recursive: true });
    await mkdir(join(p, '.studio', 'cache', 'hashes', 'c1'), { recursive: true });
    for (const f of ['conversation.jsonl', 'versions.json', 'creative.json']) await writeFile(join(c, f), f);
    await writeFile(join(p, 'brand', 'proposals', 'p1', 'log.jsonl'), 'log');
    await writeFile(join(p, '.studio', 'usage.jsonl'), 'usage');
    await writeFile(join(p, '.studio', 'cache', 'hashes', 'c1', 'v1.json'), '{}');
    await link(join(c, 'conversation.jsonl'), join(c, 'work', 'x'));
    await link(join(p, '.studio', 'usage.jsonl'), join(c, 'work', 'u'));
    await link(join(p, '.studio', 'cache', 'hashes', 'c1', 'v1.json'), join(c, 'work', 'h'));
    await link(join(p, 'brand', 'proposals', 'p1', 'log.jsonl'), join(p, 'l'));
    // An agent file with two names is not ours to touch.
    await writeFile(join(c, 'work', 'mine'), 'm');
    await link(join(c, 'work', 'mine'), join(c, 'work', 'mine2'));
    const found = await detachProtectedLinks(p);
    expect(found.sort()).toEqual([
      join('.studio', 'cache', 'hashes', 'c1', 'v1.json'), join('.studio', 'usage.jsonl'),
      join('brand', 'proposals', 'p1', 'log.jsonl'), join('creatives', 'c1', 'conversation.jsonl'),
    ]);
    for (const f of [join(c, 'conversation.jsonl'), join(p, '.studio', 'usage.jsonl'), join(p, 'brand', 'proposals', 'p1', 'log.jsonl')]) expect((await stat(f)).nlink).toBe(1);
    expect((await stat(join(c, 'work', 'mine'))).nlink).toBe(2);
    await appendFile(join(c, 'work', 'x'), 'forged');
    expect(await readFile(join(c, 'conversation.jsonl'), 'utf8')).toBe('conversation.jsonl');
    expect(await detachProtectedLinks(p)).toEqual([]);
  });
  it('does not follow a symlinked creatives folder or .studio', async () => {
    const p = await tmp();
    const outside = await tmp();
    await writeFile(join(outside, 'conversation.jsonl'), 'x');
    await link(join(outside, 'conversation.jsonl'), join(outside, 'second'));
    await mkdir(join(p, 'creatives'), { recursive: true });
    await symlink(outside, join(p, 'creatives', 'c1'));
    await symlink(outside, join(p, '.studio'));
    expect(await detachProtectedLinks(p)).toEqual([]);
    expect((await stat(join(outside, 'conversation.jsonl'))).nlink).toBe(2);
  });
});

describe('detachLinksUnder', () => {
  it('detaches every linked file of a folder tree, relative to the base', async () => {
    const c = await tmp();
    await mkdir(join(c, 'outputs', 'v1', 'sub'), { recursive: true });
    await mkdir(join(c, 'work'));
    await writeFile(join(c, 'outputs', 'v1', 'a.mp4'), 'a');
    await writeFile(join(c, 'outputs', 'v1', 'sub', 'b.png'), 'b');
    await writeFile(join(c, 'outputs', 'v1', 'c.png'), 'c');
    await link(join(c, 'outputs', 'v1', 'a.mp4'), join(c, 'work', 'pre-v1'));
    await link(join(c, 'outputs', 'v1', 'sub', 'b.png'), join(c, 'work', 'b'));
    expect((await detachLinksUnder(join(c, 'outputs', 'v1'), c)).sort()).toEqual([join('outputs', 'v1', 'a.mp4'), join('outputs', 'v1', 'sub', 'b.png')]);
    await appendFile(join(c, 'work', 'pre-v1'), 'HL5');
    expect(await readFile(join(c, 'outputs', 'v1', 'a.mp4'), 'utf8')).toBe('a');
  });
});

describe('detachProtectedLinks after review (decisions log 141)', () => {
  it('also covers CLAUDE.md, CLAUDE.local.md, .mcp.json, .claude/**, .git/config and .git/hooks/**, but not .git/objects', async () => {
    const p = await tmp();
    const outside = await tmp();
    for (const d of ['.claude/commands', '.git/hooks', '.git/objects/ab']) await mkdir(join(p, d), { recursive: true });
    const files = ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', '.claude/settings.json', '.claude/commands/x.md', '.git/config', '.git/hooks/pre-commit', '.git/objects/ab/cdef'];
    for (const [k, f] of files.entries()) {
      await writeFile(join(p, f), f);
      await link(join(p, f), join(outside, `l${k}`));
    }
    expect((await detachProtectedLinks(p)).sort()).toEqual(files.filter((f) => !f.startsWith('.git/objects')).map((f) => join(...f.split('/'))).sort());
    expect((await stat(join(p, '.git/objects/ab/cdef'))).nlink).toBe(2);
  });
  it('never walks a creatives/, brand/proposals/ or .studio that is a symlink to a real folder elsewhere', async () => {
    const p = await tmp();
    const outside = await tmp();
    await mkdir(join(outside, 'c1'), { recursive: true });
    await writeFile(join(outside, 'c1', 'conversation.jsonl'), 'x');
    await link(join(outside, 'c1', 'conversation.jsonl'), join(outside, 'second'));
    await symlink(outside, join(p, 'creatives'));
    await mkdir(join(p, 'brand'));
    await symlink(outside, join(p, 'brand', 'proposals'));
    expect(await detachProtectedLinks(p)).toEqual([]);
    expect((await stat(join(outside, 'c1', 'conversation.jsonl'))).nlink).toBe(2);
  });
  it('removes the temp files a crashed detach left behind, and only those', async () => {
    const p = await tmp();
    const c = join(p, 'creatives', 'c1');
    await mkdir(join(p, '.studio'), { recursive: true });
    await mkdir(c, { recursive: true });
    const leftovers = [join(c, '.conversation.jsonl.detach-0123456789ab'), join(p, '.studio', '.usage.jsonl.detach-abcdefabcdef')];
    for (const f of leftovers) await writeFile(f, 'half');
    await writeFile(join(c, '.notes.detach-zz'), 'keep');
    await detachProtectedLinks(p);
    expect((await readdir(c)).sort()).toEqual(['.notes.detach-zz']);
    expect(await readdir(join(p, '.studio'))).toEqual([]);
  });
});

describe('detachLinksUnder after review', () => {
  it('refuses a folder reached through a symlinked parent (outputs/ as a link)', async () => {
    const c = await tmp();
    const outside = await tmp();
    await mkdir(join(outside, 'v1'));
    await writeFile(join(outside, 'v1', 'a.mp4'), 'a');
    await link(join(outside, 'v1', 'a.mp4'), join(outside, 'b'));
    await symlink(outside, join(c, 'outputs'));
    expect(await detachLinksUnder(join(c, 'outputs', 'v1'), c)).toEqual([]);
    expect((await stat(join(outside, 'v1', 'a.mp4'))).nlink).toBe(2);
  });
  it('clones a large file (same bytes, new inode)', async () => {
    const c = await tmp();
    await mkdir(join(c, 'outputs', 'v1'), { recursive: true });
    const big = Buffer.alloc(2 * 1024 * 1024, 7);
    await writeFile(join(c, 'outputs', 'v1', 'big.mp4'), big);
    await link(join(c, 'outputs', 'v1', 'big.mp4'), join(c, 'l'));
    expect(await detachLinksUnder(join(c, 'outputs', 'v1'), c)).toEqual([join('outputs', 'v1', 'big.mp4')]);
    expect((await readFile(join(c, 'outputs', 'v1', 'big.mp4'))).equals(big)).toBe(true);
    expect((await stat(join(c, 'outputs', 'v1', 'big.mp4'))).nlink).toBe(1);
  });
});

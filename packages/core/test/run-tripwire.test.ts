import { appendFile, chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { armTripwire } from '../src/agent/run-tripwire.ts';
import { BrandStore } from '../src/brand/brand-store.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { writeJsonFileAtomic } from '../src/json-file.ts';
import { PermissionsStore } from '../src/approvals/permissions-store.ts';

const cleanup: string[] = [];
afterEach(async () => { for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true }); });
const brief = { goal: 'g', message: '', formats: ['instagram-post-1x1'], durationSec: 3, assets: [], notes: '' };
/** Folder times have sub-ms resolution but a change in the same instant as the snapshot could look unchanged. */
const tick = () => new Promise((r) => setTimeout(r, 15));

async function project() {
  const p = await mkdtemp(join(tmpdir(), 'ms-trip [x] '));
  cleanup.push(p);
  const store = new CreativeStore(p);
  const { slug } = await store.create({ title: 'uno', brief });
  return { p, store, slug, c: join(p, 'creatives', slug) };
}

describe('armTripwire (decisions log 141)', () => {
  it('sees a creative folder moved out, edited and moved back', async () => {
    const { p, c, slug } = await project();
    const trip = await armTripwire(p, { logs: false });
    await tick();
    await rename(c, join(p, 'out'));
    await appendFile(join(p, 'out', 'conversation.jsonl'), 'forged\n');
    await rename(join(p, 'out'), c);
    expect((await trip.check()).moved.sort()).toEqual(['creatives', join('creatives', slug)]);
  });
  it('sees outputs/ moved out and back through the creative folder', async () => {
    const { p, c, slug } = await project();
    await mkdir(join(c, 'outputs', 'v1'), { recursive: true });
    const trip = await armTripwire(p, { logs: false });
    await tick();
    await rename(join(c, 'outputs'), join(p, 'o'));
    await rename(join(p, 'o'), join(c, 'outputs'));
    expect((await trip.check()).moved).toContain(join('creatives', slug));
  });
  it('leaves out the core\'s own changes: atomic writes, a creative or a proposal created during the run, appends', async () => {
    const { p, store, c, slug } = await project();
    await mkdir(join(p, 'brand', 'proposals'), { recursive: true });
    const trip = await armTripwire(p, { logs: true });
    await tick();
    await writeJsonFileAtomic(join(c, 'versions.json'), { schemaVersion: 1, versions: [] });
    await store.update(slug, { status: 'ready' });
    await store.create({ title: 'due', brief });
    await new BrandStore(p).newProposalId();
    await store.appendConversation(slug, { type: 'system', at: new Date().toISOString(), level: 'info', text: 'core' });
    expect(await trip.check()).toMatchObject({ tampered: [], moved: [], rewritten: [] });
  });
  it('sees a file the core did not make at the top of a creative, and a folder replaced', async () => {
    const { p, c, slug } = await project();
    const trip = await armTripwire(p, { logs: false });
    await tick();
    await writeFile(join(c, 'stray.txt'), 'x');
    expect((await trip.check()).moved).toContain(join('creatives', slug));
  });
  it('with logs: a rewritten or cut history is reported, an append is not', async () => {
    const { p, store, c, slug } = await project();
    await store.appendConversation(slug, { type: 'system', at: new Date().toISOString(), level: 'info', text: 'one' });
    const second = (await store.create({ title: 'due', brief })).slug;
    await store.appendConversation(second, { type: 'system', at: new Date().toISOString(), level: 'info', text: 'two' });
    const trip = await armTripwire(p, { logs: true });
    await appendFile(join(c, 'conversation.jsonl'), 'appended\n');
    await writeFile(join(p, 'creatives', second, 'conversation.jsonl'), '{"forged":true}\n');
    expect((await trip.check()).rewritten).toEqual([join('creatives', second, 'conversation.jsonl')]);
    const off = await armTripwire(p, { logs: false });
    await writeFile(join(c, 'conversation.jsonl'), '');
    expect((await off.check()).rewritten).toEqual([]);
  });
});

describe('armTripwire static-file integrity (decisions log 141)', () => {
  async function withGit(): Promise<{ p: string }> {
    const p = await mkdtemp(join(tmpdir(), 'ms-trip2 [x] '));
    cleanup.push(p);
    await mkdir(join(p, '.git', 'hooks'), { recursive: true });
    await mkdir(join(p, '.git', 'info'), { recursive: true });
    await mkdir(join(p, '.claude'), { recursive: true });
    await writeFile(join(p, '.git', 'config'), '[core]\n\tfilemode = true\n');
    await writeFile(join(p, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(p, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
    await writeFile(join(p, '.mcp.json'), '{}');
    await writeFile(join(p, 'CLAUDE.md'), '# hi');
    await writeFile(join(p, '.claude', 'settings.json'), '{}');
    return { p };
  }
  it('reports a changed .git/config, hook, .claude file, .mcp.json or CLAUDE.md as tampered', async () => {
    for (const f of [['.git', 'config'], ['.git', 'hooks', 'pre-commit'], ['.claude', 'settings.json'], ['.mcp.json'], ['CLAUDE.md']]) {
      const { p } = await withGit();
      const trip = await armTripwire(p, { logs: false });
      await writeFile(join(p, ...f), 'TAMPERED');
      const r = await trip.check();
      expect(r.tampered, f.join('/')).toEqual([join(...f)]);
    }
  });
  it('stays quiet when the static files are untouched', async () => {
    const { p } = await withGit();
    const trip = await armTripwire(p, { logs: false });
    expect(await trip.check()).toMatchObject({ tampered: [], moved: [], rewritten: [] });
  });
  it('re-enumerates at check time: an added .claude/settings.json, .git/commondir, .mcp.json or .gitattributes is tampered', async () => {
    for (const f of [['.claude', 'settings.local.json'], ['.git', 'commondir'], ['.git', 'config.worktree'], ['CLAUDE.local.md'], ['.gitattributes'], ['.git', 'hooks', 'post-commit']]) {
      const { p } = await withGit();
      await rm(join(p, '.mcp.json'));
      const trip = await armTripwire(p, { logs: false });
      await writeFile(join(p, ...f), 'NEW');
      expect((await trip.check()).tampered, f.join('/')).toEqual([f.join('/')]);
    }
    const { p } = await withGit();
    await rm(join(p, '.mcp.json'));
    await rm(join(p, '.claude'), { recursive: true });
    const trip = await armTripwire(p, { logs: false });
    await mkdir(join(p, '.claude'));
    await writeFile(join(p, '.claude', 'settings.json'), '{"hooks":{}}');
    await writeFile(join(p, '.mcp.json'), '{}');
    expect((await trip.check()).tampered).toEqual(['.claude/settings.json', '.mcp.json']);
  });
  it('a removed file and a .git replaced by a gitdir: file are tampered', async () => {
    const { p } = await withGit();
    const trip = await armTripwire(p, { logs: false });
    await rm(join(p, 'CLAUDE.md'));
    await rename(join(p, '.git'), join(p, 'g'));
    await writeFile(join(p, '.git'), 'gitdir: g\n');
    const r = (await trip.check()).tampered;
    expect(r).toContain('CLAUDE.md');
    expect(r).toContain('.git');
    expect(r).toContain('.git/config');
  });
  it('.studio/permissions.json: a core write (PermissionsStore) stays quiet, a foreign write trips', async () => {
    const { p } = await withGit();
    await new PermissionsStore(p).add('Bash(ls:*)', 'x');
    const trip = await armTripwire(p, { logs: false });
    await new PermissionsStore(p).add('Bash(ffprobe:*)', 'x');
    await new PermissionsStore(p).remove('Bash(ls:*)');
    expect((await trip.check()).tampered).toEqual([]);
    const again = await armTripwire(p, { logs: false });
    await writeFile(join(p, '.studio', 'permissions.json'), JSON.stringify({ schemaVersion: 1, allow: [{ rule: 'WebFetch(domain:evil.example)', addedAt: new Date().toISOString(), label: 'x' }] }));
    expect((await again.check()).tampered).toEqual(['.studio/permissions.json']);
  });
  it('check() throws when a protected tree cannot be read (the launcher fails closed)', async () => {
    const { p } = await withGit();
    const trip = await armTripwire(p, { logs: false });
    await mkdir(join(p, '.claude', 'locked'));
    await chmod(join(p, '.claude', 'locked'), 0o000);
    try { await expect(trip.check()).rejects.toThrow(); } finally { await chmod(join(p, '.claude', 'locked'), 0o700); }
  });
});

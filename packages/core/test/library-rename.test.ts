import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { BrandStore } from '../src/brand/brand-store.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { LibraryStore, RenameInterrupted, type RenameStep } from '../src/library/library-store.ts';
import { journalPathOf } from '../src/library/rename-journal.ts';
import { recoverRenameJournal } from '../src/library/rename-recovery.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';
import { recoverWorkspace } from '../src/server/creative-routes.ts';
import { buildServer } from '../src/server/app.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const brief = (assets: string[]) => ({ goal: 'g', message: '', formats: ['16x9'], durationSec: null, assets, notes: '' });

describe('renaming an asset (store)', () => {
  let project: string;
  let lib: LibraryStore;
  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ms-ren è '));
    await mkdir(join(project, 'assets', 'brand'), { recursive: true });
    await mkdir(join(project, 'brand'), { recursive: true });
    lib = new LibraryStore(project, { ...NoMediaTools, available: true });
    await writeFile(join(project, 'assets', 'logo.png'), 'x');
    await writeFile(join(project, 'assets', 'other.png'), 'y');
    await writeFile(join(project, 'assets', 'brand', 'mark.svg'), '<svg/>');
    await writeFile(join(project, 'assets', 'font.woff2'), 'f');
    await lib.registerAssets([{ file: 'logo.png', origin: 'upload' }, { file: 'other.png', origin: 'upload' }, { file: 'brand/mark.svg', origin: 'upload' }, { file: 'font.woff2', origin: 'upload' }]);
  });

  it('open brand-analysis proposals follow a rename; applied ones stay as they were (M5)', async () => {
    const src = { kind: 'manual' as const, ref: null };
    const brand = new BrandStore(project);
    const logo = { id: 'l1', file: 'assets/logo.png', variant: 'primary', background: 'any', source: src };
    const mk = async (status: 'open' | 'applied') => {
      const id = await brand.newProposalId(new Date(status === 'open' ? 1_000_000_000_000 : 1_000_000_100_000));
      await brand.writeProposal({ schemaVersion: 1, id, createdAt: '2026-10-07T10:00:00.000Z', sourceIds: [], status, summary: 's', guidelines: null,
        changes: [{ id: 'c1', field: 'logos', op: 'add', itemId: 'l1', before: null, after: logo }, { id: 'c2', field: 'tone', op: 'update', itemId: null, before: null, after: 'warm' }],
        assetsAdded: ['logo.png', 'other.png'] });
      return id;
    };
    const open = await mk('open'), applied = await mk('applied');
    await lib.renameAsset('logo.png', 'New Logo.png');
    const o = await brand.readProposal(open), a = await brand.readProposal(applied);
    expect((o.changes[0]!.after as { file: string }).file).toBe('assets/New-Logo.png');
    expect(o.changes[1]!.after).toBe('warm');
    expect(o.assetsAdded).toEqual(['New-Logo.png', 'other.png']);
    expect((a.changes[0]!.after as { file: string }).file).toBe('assets/logo.png');
    expect(a.assetsAdded).toEqual(['logo.png', 'other.png']);
  });

  it('renames, updates the brand and every brief under their locks, and leaves staging copies alone', async () => {
    const src = { kind: 'manual' as const, ref: null };
    await new BrandStore(project).writeKit({
      schemaVersion: 1, colors: [], tone: null, dos: [], donts: [], photoStyle: null,
      logos: [{ id: 'l1', file: 'assets/logo.png', variant: 'primary', background: 'any', source: src }, { id: 'l2', file: 'assets/other.png', variant: 'mono', background: 'any', source: src }],
      fonts: [{ id: 'f1', family: 'Brand', role: 'heading', weights: [400], file: 'assets/font.woff2', source: src }],
    });
    const creatives = new CreativeStore(project);
    const a = await creatives.create({ title: 'A', brief: brief(['assets/logo.png', 'assets/other.png']) });
    const b = await creatives.create({ title: 'B', brief: brief([]) });
    const c = await creatives.create({ title: 'C', brief: brief(['assets/logo.png']) });
    const staged = join(project, '.studio', 'cache', 'editor-staging', 'x', 'tok', 'assets', 'lib', 'logo.png');
    await mkdir(join(staged, '..'), { recursive: true });
    await writeFile(staged, 'copy');

    const r = await lib.renameAsset('logo.png', 'New Logo.png');
    expect(r.entry.file).toBe('New-Logo.png');
    expect(r.brand).toBe(true);
    expect(r.creatives.sort()).toEqual([a.slug, c.slug].sort());
    expect((await lib.listAssets()).map((x) => x.file).sort()).toEqual(['New-Logo.png', 'brand/mark.svg', 'font.woff2', 'other.png']);
    expect(await readFile(join(project, 'assets', 'New-Logo.png'), 'utf8')).toBe('x');
    await expect(stat(join(project, 'assets', 'logo.png'))).rejects.toThrow();
    const kit = await new BrandStore(project).readKit();
    expect(kit.logos.map((l) => l.file)).toEqual(['assets/New-Logo.png', 'assets/other.png']);
    expect((await creatives.get(a.slug)).brief.assets).toEqual(['assets/New-Logo.png', 'assets/other.png']);
    expect((await creatives.get(b.slug)).brief.assets).toEqual([]);
    expect(await readFile(staged, 'utf8')).toBe('copy');

    const f = await lib.renameAsset('font.woff2', 'brand-font.woff2');
    expect(f.brand).toBe(true);
    expect((await new BrandStore(project).readKit()).fonts[0]!.file).toBe('assets/brand-font.woff2');
  });

  it('renames inside a subfolder and keeps the folder', async () => {
    expect((await lib.renameAsset('brand/mark.svg', 'icon.svg')).entry.file).toBe('brand/icon.svg');
    await stat(join(project, 'assets', 'brand', 'icon.svg'));
  });

  it('refuses a name that exists, in the registry or only on disk', async () => {
    await expect(lib.renameAsset('logo.png', 'other.png')).rejects.toMatchObject({ status: 409 });
    await writeFile(join(project, 'assets', 'loose.png'), 'z');
    await expect(lib.renameAsset('logo.png', 'loose.png')).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(project, 'assets', 'loose.png'), 'utf8')).toBe('z');
    expect(await readFile(join(project, 'assets', 'logo.png'), 'utf8')).toBe('x');
  });

  it('refuses another folder, traversal, reserved names, a changed type and an unknown asset', async () => {
    for (const name of ['sub/logo.png', '../logo.png', '..\\x.png', '', '   ']) await expect(lib.renameAsset('logo.png', name), name).rejects.toMatchObject({ status: 400 });
    await expect(lib.renameAsset('logo.png', 'assets.json')).rejects.toMatchObject({ status: 400 });
    await expect(lib.renameAsset('logo.png', 'ASSETS.JSON')).rejects.toMatchObject({ status: 400 });
    await expect(lib.renameAsset('logo.png', 'logo.mp4')).rejects.toMatchObject({ status: 400 });
    await expect(lib.renameAsset('nope.png', 'x.png')).rejects.toMatchObject({ status: 404 });
    expect((await lib.listAssets()).map((x) => x.file)).toContain('logo.png');
  });

  it('refuses a file or folder that is a link', async () => {
    await writeFile(join(project, 'outside.png'), 'o');
    await symlink(join(project, 'outside.png'), join(project, 'assets', 'link.png'));
    await symlink(join(project, 'assets', 'logo.png'), join(project, 'assets', 'dir-link.png'));
    // Registering a link is refused, so plant the entries by hand as an agent might.
    const meta = JSON.parse(await readFile(join(project, 'assets', 'assets.json'), 'utf8'));
    meta.assets.push({ ...meta.assets[0], file: 'link.png' });
    await writeFile(join(project, 'assets', 'assets.json'), JSON.stringify(meta));
    await expect(lib.renameAsset('link.png', 'moved.png')).rejects.toMatchObject({ status: 400 });
    await expect(stat(join(project, 'assets', 'moved.png'))).rejects.toThrow();
    // A subfolder that is a link: the file inside is reachable only through it.
    await mkdir(join(project, 'elsewhere'));
    await writeFile(join(project, 'elsewhere', 'in.png'), 'i');
    await symlink(join(project, 'elsewhere'), join(project, 'assets', 'linked'));
    meta.assets.push({ ...meta.assets[0], file: 'linked/in.png' });
    await writeFile(join(project, 'assets', 'assets.json'), JSON.stringify(meta));
    await expect(lib.renameAsset('linked/in.png', 'moved.png')).rejects.toMatchObject({ status: 400 });
    expect(await readFile(join(project, 'elsewhere', 'in.png'), 'utf8')).toBe('i');
  });

  it('undoes everything when a later step fails', async () => {
    const src = { kind: 'manual' as const, ref: null };
    await new BrandStore(project).writeKit({ schemaVersion: 1, colors: [], tone: null, dos: [], donts: [], photoStyle: null, fonts: [], logos: [{ id: 'l1', file: 'assets/logo.png', variant: 'primary', background: 'any', source: src }] });
    const creatives = new CreativeStore(project);
    const a = await creatives.create({ title: 'A', brief: brief(['assets/logo.png']) });
    // The assets.json write fails (invalid metadata): the file, the brand and the brief go back.
    const spy = vi.spyOn(LibraryStore.prototype as unknown as { writeAssets(a: unknown): Promise<void> }, 'writeAssets').mockRejectedValueOnce(new Error('disk full'));
    await expect(lib.renameAsset('logo.png', 'later.png')).rejects.toMatchObject({ status: 500 });
    spy.mockRestore();
    expect(await readFile(join(project, 'assets', 'logo.png'), 'utf8')).toBe('x');
    await expect(stat(join(project, 'assets', 'later.png'))).rejects.toThrow();
    expect((await new BrandStore(project).readKit()).logos[0]!.file).toBe('assets/logo.png');
    expect((await creatives.get(a.slug)).brief.assets).toEqual(['assets/logo.png']);
    expect((await lib.listAssets()).map((x) => x.file)).toContain('logo.png');
  });

  it('refuses when the brand kit is corrupt, before touching the file', async () => {
    await writeFile(join(project, 'brand', 'brand-kit.json'), '{bad');
    await expect(lib.renameAsset('logo.png', 'later.png')).rejects.toThrow();
    expect(await readFile(join(project, 'assets', 'logo.png'), 'utf8')).toBe('x');
  });
});

describe('renaming an asset: crash consistency and partial failures', () => {
  let project: string;
  let lib: LibraryStore;
  let slugs: string[];
  const src = { kind: 'manual' as const, ref: null };
  const exists = (rel: string) => stat(join(project, rel)).then(() => true, () => false);
  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ms-crash è '));
    await mkdir(join(project, 'assets'), { recursive: true });
    await mkdir(join(project, 'brand'), { recursive: true });
    lib = new LibraryStore(project, { ...NoMediaTools, available: true });
    await writeFile(join(project, 'assets', 'logo.png'), 'x');
    await lib.registerAssets([{ file: 'logo.png', origin: 'upload' }]);
    await new BrandStore(project).writeKit({
      schemaVersion: 1, colors: [], tone: null, dos: [], donts: [], photoStyle: null, fonts: [],
      logos: [{ id: 'l1', file: 'assets/logo.png', variant: 'primary', background: 'any', source: src }],
    });
    const creatives = new CreativeStore(project);
    slugs = [];
    for (const title of ['One', 'Two', 'Three']) slugs.push((await creatives.create({ title, brief: brief(['assets/logo.png', 'assets/keep.png']) })).slug);
  });
  /** Every registered file, brand reference and brief reference exists on disk; no journal is left. */
  const expectConsistent = async (name: string) => {
    const assets = await lib.listAssets();
    expect(assets.map((a) => a.file), name).toEqual([name]);
    expect(await exists(`assets/${name}`)).toBe(true);
    expect((await new BrandStore(project).readKit()).logos.map((l) => l.file)).toEqual([`assets/${name}`]);
    for (const slug of slugs) expect((await new CreativeStore(project).get(slug)).brief.assets).toEqual([`assets/${name}`, 'assets/keep.png']);
    expect(await exists('.studio/rename-journal.json')).toBe(false);
  };
  const crashAfter = (at: RenameStep) => lib.renameAsset('logo.png', 'new.png', { afterStep: (s) => { if (s === at) throw new RenameInterrupted(); } }).catch((e) => e);

  it('writes the journal before the file moves, with what is affected', async () => {
    const err = await crashAfter('journal');
    expect(err).toBeInstanceOf(RenameInterrupted);
    const journal = JSON.parse(await readFile(journalPathOf(project), 'utf8'));
    expect(journal).toMatchObject({ from: 'logo.png', to: 'new.png', brandRefs: true });
    expect(journal.briefSlugs.sort()).toEqual([...slugs].sort());
    expect(await exists('assets/logo.png')).toBe(true);
  });

  it.each(['file', 'assets', 'brand', 'briefs'] as const)('a crash after the %s step is finished by the next open: nothing dangles', async (step) => {
    expect(await crashAfter(step)).toBeInstanceOf(RenameInterrupted);
    expect(await exists('.studio/rename-journal.json')).toBe(true);
    expect(await recoverRenameJournal(project)).toBe('completed');
    await expectConsistent('new.png');
    expect(await recoverRenameJournal(project)).toBeNull();
  });

  it('a crash before the file moved is undone: everything keeps the old name', async () => {
    expect(await crashAfter('journal')).toBeInstanceOf(RenameInterrupted);
    expect(await recoverRenameJournal(project)).toBe('rolled-back');
    await expectConsistent('logo.png');
  });

  it('a hard link left under the old name by a crash between link and unlink is removed on completion', async () => {
    const { link } = await import('node:fs/promises');
    expect(await crashAfter('journal')).toBeInstanceOf(RenameInterrupted);
    await link(join(project, 'assets', 'logo.png'), join(project, 'assets', 'new.png'));
    expect(await recoverRenameJournal(project)).toBe('completed');
    await expectConsistent('new.png');
    expect(await exists('assets/logo.png')).toBe(false);
  });

  it('finishing commits once; an unreadable journal is discarded; a new rename settles a leftover first', async () => {
    const git = new Git();
    await git.init(project);
    await git.commitAll(project, 'base');
    expect(await crashAfter('assets')).toBeInstanceOf(RenameInterrupted);
    expect(await recoverRenameJournal(project, git)).toBe('completed');
    const log = (await execCommand('git', ['-C', project, 'log', '--format=%s'])).stdout.trim().split('\n');
    expect(log).toHaveLength(2);
    await writeFile(journalPathOf(project), '{nope');
    expect(await recoverRenameJournal(project, git)).toBe('discarded');
    expect(await exists('.studio/rename-journal.json')).toBe(false);
    // A leftover from an earlier crash is settled by the next rename itself.
    expect(await new LibraryStore(project, { ...NoMediaTools, available: true }).renameAsset('new.png', 'newer.png', { afterStep: (s) => { if (s === 'brand') throw new RenameInterrupted(); } }).catch((e) => e)).toBeInstanceOf(RenameInterrupted);
    const again = await lib.renameAsset('newer.png', 'final.png'); // the leftover new.png -> newer.png is finished first
    expect(again.entry.file).toBe('final.png');
    await expectConsistent('final.png');
  });

  it('an in-process failure leaves no journal and nothing changed', async () => {
    const spy = vi.spyOn(CreativeStore.prototype, 'renameBriefAsset').mockRejectedValueOnce(new Error('boom'));
    await expect(lib.renameAsset('logo.png', 'new.png')).rejects.toMatchObject({ status: 500 });
    spy.mockRestore();
    await expectConsistent('logo.png');
  });

  it('a creative that cannot be written restores every brief already changed, exactly, and the file goes back', async () => {
    const creatives = new CreativeStore(project);
    // One brief lists both names, so the dedupe of the rename would lose an entry unless the original array is restored.
    await creatives.update(slugs[0]!, { brief: { ...(await creatives.get(slugs[0]!)).brief, assets: ['assets/new.png', 'assets/logo.png', 'assets/keep.png'] } });
    const locked = join(project, 'creatives', slugs[2]!);
    await chmod(locked, 0o555);
    try {
      await expect(lib.renameAsset('logo.png', 'new.png')).rejects.toBeTruthy();
    } finally { await chmod(locked, 0o755); }
    expect((await creatives.get(slugs[0]!)).brief.assets).toEqual(['assets/new.png', 'assets/logo.png', 'assets/keep.png']);
    for (const slug of slugs.slice(1)) expect((await creatives.get(slug)).brief.assets).toEqual(['assets/logo.png', 'assets/keep.png']);
    expect((await new BrandStore(project).readKit()).logos[0]!.file).toBe('assets/logo.png');
    expect(await exists('assets/logo.png')).toBe(true);
    expect(await exists('assets/new.png')).toBe(false);
    expect((await lib.listAssets()).map((a) => a.file)).toEqual(['logo.png']);
    expect(await exists('.studio/rename-journal.json')).toBe(false);
  });

  it('opening the workspace finishes an interrupted rename of a project (recoverWorkspace)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ms-crash-ws '));
    const git = new Git();
    const ws = await WorkspaceStore.open(root, git, { create: true });
    await ws.createProject({ name: 'Acme' });
    const dir = ws.projectDir('acme');
    const l = new LibraryStore(dir, { ...NoMediaTools, available: true });
    await writeFile(join(dir, 'assets', 'logo.png'), 'x');
    await l.registerAssets([{ file: 'logo.png', origin: 'upload' }]);
    await git.commitAll(dir, 'base');
    await l.renameAsset('logo.png', 'new.png', { afterStep: (s) => { if (s === 'file') throw new RenameInterrupted(); } }).catch(() => {});
    await recoverWorkspace(ws, () => false, { git });
    expect((await l.listAssets()).map((a) => a.file)).toEqual(['new.png']);
    expect(await stat(journalPathOf(dir)).then(() => true, () => false)).toBe(false);
    expect((await execCommand('git', ['-C', dir, 'log', '-1', '--format=%s'])).stdout.trim()).toMatch(/interrotta|interrupted/);
  });

  it('a crash partway through the brief loop is finished from the journal: every brief ends on the new path', async () => {
    const orig = CreativeStore.prototype.renameBriefAsset;
    const spy = vi.spyOn(CreativeStore.prototype, 'renameBriefAsset').mockImplementationOnce(async function (this: CreativeStore, f, t2) {
      await orig.call(this, f, t2, [slugs[0]!]); // one brief written, then the process dies
      throw new RenameInterrupted();
    });
    expect(await lib.renameAsset('logo.png', 'new.png').catch((e) => e)).toBeInstanceOf(RenameInterrupted);
    spy.mockRestore();
    expect((await new CreativeStore(project).get(slugs[0]!)).brief.assets[0]).toBe('assets/new.png');
    expect((await new CreativeStore(project).get(slugs[1]!)).brief.assets[0]).toBe('assets/logo.png');
    expect(await recoverRenameJournal(project)).toBe('completed');
    await expectConsistent('new.png');
  });

  it('a crash during the recovery itself is repaired by the next recovery', async () => {
    expect(await crashAfter('file')).toBeInstanceOf(RenameInterrupted);
    const spy = vi.spyOn(BrandStore.prototype, 'renameFileRefs').mockRejectedValueOnce(new Error('died'));
    await expect(recoverRenameJournal(project)).rejects.toThrow('died');
    spy.mockRestore();
    expect(await exists('.studio/rename-journal.json')).toBe(true);
    expect(await recoverRenameJournal(project)).toBe('completed');
    await expectConsistent('new.png');
  });

  it('a case-only rename: a crash before the move rolls back, after it completes, and the disk name is the new case', async () => {
    const before = lib.renameAsset('logo.png', 'Logo.png', { afterStep: (s) => { if (s === 'journal') throw new RenameInterrupted(); } }).catch((e) => e);
    expect(await before).toBeInstanceOf(RenameInterrupted);
    expect(await recoverRenameJournal(project)).toBe('rolled-back');
    await expectConsistent('logo.png');
    expect((await readdir(join(project, 'assets'))).includes('logo.png')).toBe(true);
    expect(await lib.renameAsset('logo.png', 'Logo.png', { afterStep: (s) => { if (s === 'file') throw new RenameInterrupted(); } }).catch((e) => e)).toBeInstanceOf(RenameInterrupted);
    expect(await recoverRenameJournal(project)).toBe('completed');
    await expectConsistent('Logo.png');
    const names = await readdir(join(project, 'assets'));
    expect(names).toContain('Logo.png');
    expect(names).not.toContain('logo.png');
  });

  it('the journal is never committed (git exclude)', async () => {
    const git = new Git();
    await git.init(project);
    expect(await crashAfter('file')).toBeInstanceOf(RenameInterrupted);
    await git.commitAll(project, 'during the window');
    const files = (await execCommand('git', ['-C', project, 'ls-files'])).stdout;
    expect(files).not.toContain('rename-journal');
    expect(files).toContain('assets/');
  });

  describe('a hostile or damaged journal changes nothing', () => {
    const plant = (j: unknown) => mkdir(join(project, '.studio'), { recursive: true }).then(() => writeFile(journalPathOf(project), typeof j === 'string' ? j : JSON.stringify({ schemaVersion: 1, startedAt: '2026-10-13T10:00:00.000Z', brandRefs: true, briefSlugs: [], ...(j as object) })));
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => warn.mockRestore());
    const untouched = async () => {
      expect((await new BrandStore(project).readKit()).logos[0]!.file).toBe('assets/logo.png');
      for (const slug of slugs) expect((await new CreativeStore(project).get(slug)).brief.assets).toEqual(['assets/logo.png', 'assets/keep.png']);
      expect((await lib.listAssets()).map((a) => a.file)).toEqual(['logo.png']);
      expect(await exists('.studio/rename-journal.json')).toBe(false);
      expect(warn).toHaveBeenCalled();
    };

    it('a folder that is a link: nothing outside assets/ is touched', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'ms-outside '));
      await writeFile(join(outside, 'b.png'), 'o');
      const { link } = await import('node:fs/promises');
      await link(join(outside, 'b.png'), join(outside, 'a.png'));
      await symlink(outside, join(project, 'assets', 'sub'));
      await plant({ from: 'sub/a.png', to: 'sub/b.png' });
      expect(await recoverRenameJournal(project)).toBe('discarded');
      expect(await readdir(outside)).toEqual(['a.png', 'b.png']);
      await untouched();
    });

    it('from and to are two different files: the references are not redirected', async () => {
      await writeFile(join(project, 'assets', 'other.png'), 'different');
      await plant({ from: 'logo.png', to: 'other.png' });
      expect(await recoverRenameJournal(project)).toBe('discarded');
      expect(await readFile(join(project, 'assets', 'logo.png'), 'utf8')).toBe('x');
      await untouched();
    });

    it('a name that is a link is refused', async () => {
      await writeFile(join(project, 'outside.png'), 'o');
      await symlink(join(project, 'outside.png'), join(project, 'assets', 'link.png'));
      await plant({ from: 'logo.png', to: 'link.png' });
      expect(await recoverRenameJournal(project)).toBe('discarded');
      await untouched();
    });

    it.each([
      ['paths outside assets/', { from: '../project.json', to: '../x.json' }],
      ['an absolute path', { from: '/etc/hosts', to: '/etc/hosts2' }],
      ['different folders', { from: 'logo.png', to: 'sub/logo.png' }],
      ['the metadata file', { from: 'logo.png', to: 'assets.json' }],
      ['a type change', { from: 'logo.png', to: 'logo.mp4' }],
      ['the same name', { from: 'logo.png', to: 'logo.png' }],
      ['neither file existing', { from: 'ghost.png', to: 'ghost2.png' }],
      ['hostile slugs', { from: 'logo.png', to: 'new.png', briefSlugs: ['../../x'] }],
    ])('%s', async (_n, j) => {
      await plant(j);
      expect(await recoverRenameJournal(project)).toBe('discarded');
      await untouched();
    });

    it.each([['not JSON', '{nope'], ['an array', '[]'], ['wrong types', '{"schemaVersion":1,"from":1,"to":2}']])('a malformed journal: %s', async (_n, text) => {
      await plant(text);
      expect(await recoverRenameJournal(project)).toBe('discarded');
      await untouched();
    });

    it('a journal that is a folder or a link is discarded too', async () => {
      await mkdir(join(project, '.studio', 'rename-journal.json'), { recursive: true });
      expect(await recoverRenameJournal(project)).toBe('discarded');
      expect(warn).toHaveBeenCalled();
    });
  });

  it('a rename racing updates of the same creatives loses neither', async () => {
    const creatives = new CreativeStore(project);
    const bumps = slugs.flatMap((slug) => [creatives.update(slug, { status: 'ready' }), creatives.update(slug, { error: 'e' })]);
    const [renamed] = await Promise.all([lib.renameAsset('logo.png', 'new.png'), ...bumps]);
    expect(renamed.creatives.length).toBeLessThanOrEqual(3);
    await expectConsistent('new.png');
    for (const slug of slugs) expect(await creatives.get(slug)).toMatchObject({ status: 'ready', error: 'e' });
  });
});

describe('renaming an asset (API)', () => {
  let app: FastifyInstance;
  let base: string;
  const P = '/api/projects/acme';
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ms-ren-api-'));
    app = await buildServer({ uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [],
      runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }) });
    await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
  });
  afterEach(async () => { await app.close(); });

  it('PATCH { name } renames in one commit and answers the new entry; conflicts are 409', async () => {
    const dir = join(base, 'ws', 'acme');
    await writeFile(join(dir, 'assets', 'a.png'), 'a');
    await writeFile(join(dir, 'assets', 'b.png'), 'b');
    await app.inject({ method: 'POST', url: `${P}/assets/register`, payload: { files: ['a.png', 'b.png'] } });
    const count = async () => Number((await execCommand('git', ['-C', dir, 'rev-list', '--count', 'HEAD'])).stdout.trim());
    const before = await count();
    const r = await app.inject({ method: 'PATCH', url: `${P}/assets/item/a.png`, payload: { name: 'renamed.png', description: 'd' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ file: 'renamed.png', description: 'd' });
    expect((await app.inject(`${P}/files/assets/renamed.png`)).statusCode).toBe(200);
    expect((await app.inject(`${P}/files/assets/a.png`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `${P}/assets/item/renamed.png`, payload: { name: 'b.png' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url: `${P}/assets/item/renamed.png`, payload: { name: 'x/y.png' } })).statusCode).toBe(400);
    expect(await count()).toBe(before + 1);
    expect((await execCommand('git', ['-C', dir, 'log', '-1', '--format=%s'])).stdout.trim()).toMatch(/^(Rename asset a\.png to|Rinomina asset a\.png in) renamed\.png$/);
  });

  it('lists old assets with their metadata filled once', async () => {
    const dir = join(base, 'ws', 'acme');
    await writeFile(join(dir, 'assets', 'f.woff2'), 'font');
    await writeFile(join(dir, 'assets', 'assets.json'), JSON.stringify({ schemaVersion: 1, assets: [
      { file: 'f.woff2', kind: 'font', origin: 'upload', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: '2026-01-01T00:00:00.000Z', attribution: null },
    ] }));
    const l = (await app.inject(`${P}/assets`)).json();
    expect(l.assets[0]).toMatchObject({ bytes: 4, durationSec: null });
    expect(JSON.parse(await readFile(join(dir, 'assets', 'assets.json'), 'utf8')).assets[0].bytes).toBe(4);
  });

  it('GET waveform: 404 for an unknown asset, 422 for a non-audio asset', async () => {
    const dir = join(base, 'ws', 'acme');
    await writeFile(join(dir, 'assets', 'a.png'), 'a');
    await app.inject({ method: 'POST', url: `${P}/assets/register`, payload: { files: ['a.png'] } });
    expect((await app.inject(`${P}/assets/item/nope.wav/waveform`)).statusCode).toBe(404);
    expect((await app.inject(`${P}/assets/item/a.png/waveform`)).statusCode).toBe(422);
    expect((await app.inject(`${P}/assets/item/a.png`)).statusCode).toBe(404);
  });
});

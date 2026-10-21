// @vitest-environment node
/**
 * Report 62: files added from the computer in a brief, as a reference for that creative only. They stay in `assets/`, marked
 * in assets.json (`referenceFor`), are left out of the library's list, can be saved into it, and go with their last creative.
 */
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_BRIEF_FORM, type AssetEntry, type CreativeReferenceEntry } from '@motion-studio/shared';
import { sidecarPathOf } from '../src/analysis/sidecar.ts';
import { sweepCreativeReferences, REFERENCE_MAX_AGE_MS } from '../src/library/creative-references.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { Git } from '../src/git.ts';
import { recoverWorkspace } from '../src/server/creative-routes.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';
import { multipart } from './helpers/multipart.ts';
import { variantApp, variantBrief, type VariantApp } from './helpers/variant-app.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const A = '/api/projects/acme/assets';
const C = '/api/projects/acme/creatives';
let s: VariantApp;
/** What went to the (temp) Trash: base names, in order. */
const trashed: string[] = [];
let trashDir = '';
const trash = async (p: string) => { trashed.push(basename(p)); await rename(p, join(trashDir, `${trashed.length}-${basename(p)}`)); };

const start = async () => {
  trashDir = await mkdtemp(join(tmpdir(), 'ms-test-trash-'));
  trashed.length = 0;
  s = await variantApp({ trash });
};
const brandUses = async (file: string) => {
  await mkdir(join(s.projectDir, 'brand'), { recursive: true });
  await writeFile(join(s.projectDir, 'brand', 'brand-kit.json'), JSON.stringify({ schemaVersion: 1, colors: [], fonts: [], logos: [
    { id: 'logo', file, variant: 'primary', background: 'any', source: { kind: 'manual', ref: null } },
  ], tone: null, dos: [], donts: [], photoStyle: null }));
};
const age = async (keep: string[] = []) => {
  const file = join(s.projectDir, 'assets', 'assets.json');
  const json = JSON.parse(await readFile(file, 'utf8')) as { assets: AssetEntry[] };
  for (const a of json.assets) if (!keep.includes(a.file)) a.addedAt = new Date(Date.now() - REFERENCE_MAX_AGE_MS - 60_000).toISOString();
  await writeFile(file, JSON.stringify(json));
};
afterEach(async () => { await s?.close(); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const upload = async (name: string, scope?: 'reference' | 'library') => {
  const r = await s.app.inject({ method: 'POST', url: `${A}${scope ? `?scope=${scope}` : ''}`, ...multipart([{ name, content: PNG }]) });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { assets: AssetEntry[] }).assets[0]!;
};
const listing = async () => (await s.app.inject(A)).json() as { assets: AssetEntry[]; creativeReferences: CreativeReferenceEntry[] };
const meta = async () => (JSON.parse(await readFile(join(s.projectDir, 'assets', 'assets.json'), 'utf8')) as { assets: AssetEntry[] }).assets;
const create = async (assets: string[], title = 'Lancio') => {
  const r = await s.app.inject({ method: 'POST', url: C, payload: { title, brief: { ...variantBrief, assets }, generate: false } });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { slug: string }).slug;
};
const exists = (rel: string) => lstat(join(s.projectDir, rel)).then(() => true, () => false);
const git = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd: s.projectDir })).stdout;

describe('creative references (report 62)', () => {
  it('a reference upload is registered with the marker and listed apart from the library', async () => {
    await start();
    const ref = await upload('Moodboard.png', 'reference');
    expect(ref).toMatchObject({ file: 'Moodboard.png', referenceFor: [] });
    const lib = await upload('logo.png');
    expect(lib.referenceFor).toBeUndefined();
    const l = await listing();
    expect(l.assets.map((a) => a.file)).toEqual(['logo.png']);
    expect(l.creativeReferences.map((a) => [a.file, a.usedBy])).toEqual([['Moodboard.png', []]]);
    // The same name as a library file gets the same dedup rule (one folder).
    expect((await upload('logo.png', 'reference')).file).toBe('logo-2.png');
  });

  it('the creative made from the brief claims its references; the listing says which creative uses them', async () => {
    await start();
    await upload('ref.png', 'reference');
    const slug = await create(['assets/ref.png']);
    expect((await meta()).find((a) => a.file === 'ref.png')?.referenceFor).toEqual([slug]);
    expect((await listing()).creativeReferences[0]!.usedBy).toEqual([{ slug, title: 'Lancio' }]);
  });

  it('saves a reference into the library, and back only while no creative uses it', async () => {
    await start();
    await upload('a.png', 'reference');
    const saved = await s.app.inject({ method: 'PATCH', url: `${A}/item/a.png`, payload: { reference: false } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().referenceFor).toBeUndefined();
    expect((await listing()).assets.map((a) => a.file)).toEqual(['a.png']);
    const back = await s.app.inject({ method: 'PATCH', url: `${A}/item/a.png`, payload: { reference: true } });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().referenceFor).toEqual([]);
    expect(await git('log', '-1', '--format=%s', '--', 'assets/assets.json')).not.toBe('');
    // Used by a creative: it cannot go back to "only for this creative" (it is already that creative's or the library's).
    await s.app.inject({ method: 'PATCH', url: `${A}/item/a.png`, payload: { reference: false } });
    await create(['assets/a.png']);
    const refused = await s.app.inject({ method: 'PATCH', url: `${A}/item/a.png`, payload: { reference: true } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('asset-in-use');
  });

  it('deleting the creative deletes its references: file, entry, analysis file; the removal is committed', async () => {
    await start();
    await upload('ref.png', 'reference');
    await upload('kept.png', 'reference');
    await upload('lib.png');
    const sidecar = sidecarPathOf('assets/ref.png');
    await mkdir(join(s.projectDir, dirname(sidecar)), { recursive: true });
    await writeFile(join(s.projectDir, sidecar), '{}');
    const slug = await create(['assets/ref.png', 'assets/kept.png', 'assets/lib.png']);
    // Saved into the library meanwhile: it stays.
    await s.app.inject({ method: 'PATCH', url: `${A}/item/kept.png`, payload: { reference: false } });
    const r = await s.app.inject({ method: 'DELETE', url: `${C}/${slug}` });
    expect(r.statusCode, r.body).toBe(200);
    expect(await exists('assets/ref.png')).toBe(false);
    expect(await exists(sidecar)).toBe(false);
    // Decision 1582: to the Trash with the creative (the file, then its analysis file), never deleted outright.
    expect(trashed).toEqual([slug, 'ref.png', basename(sidecar)]);
    expect((await meta()).map((a) => a.file).sort()).toEqual(['kept.png', 'lib.png']);
    expect(await exists('assets/kept.png')).toBe(true);
    expect(await git('status', '--porcelain', '--', 'assets')).toBe('');
  });

  it('a reference another creative uses stays, and goes with the last one (variants share the brief)', async () => {
    await start();
    await upload('ref.png', 'reference');
    const one = await create(['assets/ref.png'], 'Uno');
    const two = await create(['assets/ref.png'], 'Due');
    expect((await s.app.inject({ method: 'DELETE', url: `${C}/${one}` })).statusCode).toBe(200);
    expect(await exists('assets/ref.png')).toBe(true);
    expect((await meta())[0]!.referenceFor).toEqual([two]);
    // A variant of `two` shares its brief: deleting the variant alone keeps the file; the whole group takes it.
    expect((await s.app.inject({ method: 'POST', url: `${C}/${two}/variants`, payload: { count: 2, directions: [null, null] } })).statusCode).toBe(201);
    const sister = `${two}~b`;
    expect((await s.app.inject({ method: 'DELETE', url: `${C}/${sister}` })).statusCode).toBe(200);
    expect(await exists('assets/ref.png')).toBe(true);
    expect((await s.app.inject({ method: 'POST', url: `${C}/${two}/variants`, payload: { count: 2, directions: [null, null] } })).statusCode).toBe(201);
    expect((await s.app.inject({ method: 'DELETE', url: `${C}/${two}?all=1` })).statusCode).toBe(200);
    expect(await exists('assets/ref.png')).toBe(false);
    expect(await meta()).toEqual([]);
  });
});

describe('abandoned brief references (report 62)', () => {
  it('removes references no creative or open brief uses, once older than 7 days', async () => {
    await start();
    for (const f of ['old.png', 'new.png', 'session.png', 'owned.png']) await upload(f, 'reference');
    const slug = await create(['assets/owned.png']);
    await age(['new.png']);
    const removed = await sweepCreativeReferences(s.projectDir, NoMediaTools, { trash, inBrief: async () => ['assets/session.png'] });
    expect(removed).toEqual(['old.png']);
    expect(trashed).toEqual(['old.png']);
    expect(await exists('assets/old.png')).toBe(false);
    expect((await meta()).map((a) => a.file).sort()).toEqual(['new.png', 'owned.png', 'session.png']);
    expect((await meta()).find((a) => a.file === 'owned.png')?.referenceFor).toEqual([slug]);
  });

  it('runs when the workspace opens: an open brief keeps its files; an unreadable session keeps everything', async () => {
    await start();
    for (const f of ['held.png', 'gone.png']) await upload(f, 'reference');
    await age();
    const ws = await WorkspaceStore.open(join(s.base, 'ws'), new Git());
    await recoverWorkspace(ws, () => false, { briefAssets: async () => { throw new Error('unreadable'); }, git: new Git(), trash });
    expect((await meta()).map((a) => a.file).sort()).toEqual(['gone.png', 'held.png']);
    await recoverWorkspace(ws, () => false, { briefAssets: async () => ['assets/held.png'], git: new Git(), trash });
    expect((await meta()).map((a) => a.file)).toEqual(['held.png']);
    expect(await exists('assets/gone.png')).toBe(false);
    expect(await git('status', '--porcelain', '--', 'assets')).toBe('');
  });

  it('the sweep keeps a file the brand uses, and everything while the brand kit cannot be read; a refused Trash keeps the file', async () => {
    await start();
    for (const f of ['logo.png', 'other.png']) await upload(f, 'reference');
    await age();
    await brandUses('assets/logo.png');
    await writeFile(join(s.projectDir, 'brand', 'brand-kit.json'), '{bad');
    expect(await sweepCreativeReferences(s.projectDir, NoMediaTools, { trash })).toEqual([]);
    await brandUses('assets/logo.png');
    const refuse = async () => { throw new Error('no Trash'); };
    expect(await sweepCreativeReferences(s.projectDir, NoMediaTools, { trash: refuse })).toEqual([]);
    expect((await meta()).map((a) => a.file).sort()).toEqual(['logo.png', 'other.png']);
    expect(await sweepCreativeReferences(s.projectDir, NoMediaTools, { trash })).toEqual(['other.png']);
    expect(await exists('assets/logo.png')).toBe(true);
  });
});

describe('deleting a creative keeps what something else holds (fix round)', () => {
  it('a reference the brand uses stays when its creative is deleted', async () => {
    await start();
    await upload('ref.png', 'reference');
    const slug = await create(['assets/ref.png']);
    await brandUses('assets/ref.png');
    expect((await s.app.inject({ method: 'DELETE', url: `${C}/${slug}` })).statusCode).toBe(200);
    expect(await exists('assets/ref.png')).toBe(true);
    expect((await meta())[0]!.referenceFor).toEqual([]);
  });

  it('a reference the open brief session holds stays when its creative is deleted', async () => {
    await start();
    await upload('ref.png', 'reference');
    const slug = await create(['assets/ref.png']);
    const form = { ...EMPTY_BRIEF_FORM, goal: 'Altro', assets: ['assets/ref.png'] };
    const started = await s.app.inject({ method: 'POST', url: '/api/projects/acme/brief-session', payload: { form, userEdited: ['assets'] } });
    expect(started.statusCode, started.body).toBe(201);
    expect((await s.app.inject({ method: 'DELETE', url: `${C}/${slug}` })).statusCode).toBe(200);
    expect(await exists('assets/ref.png')).toBe(true);
  });

  it('store pack screens are uses: claimed by the creative, refused back to brief-only, kept while another creative shows them', async () => {
    await start();
    await upload('screen.png', 'reference');
    const pack = { app: { name: 'App', tagline: '' }, stores: ['appstore'], devices: { appstore: ['iphone-69'] }, screenshots: [{ caption: 'Uno', screen: 'assets/screen.png' }], preview: false };
    const make = async (title: string) => {
      const r = await s.app.inject({ method: 'POST', url: C, payload: { title, brief: { ...variantBrief, storePack: pack }, generate: false } });
      expect(r.statusCode, r.body).toBe(201);
      return (r.json() as { slug: string }).slug;
    };
    const one = await make('Uno');
    expect((await meta())[0]!.referenceFor).toEqual([one]);
    await s.app.inject({ method: 'PATCH', url: `${A}/item/screen.png`, payload: { reference: false } });
    expect((await s.app.inject({ method: 'PATCH', url: `${A}/item/screen.png`, payload: { reference: true } })).json().code).toBe('asset-in-use');
    await s.app.inject({ method: 'PATCH', url: `${A}/item/screen.png`, payload: { reference: false } });
    // Made a reference of `one` again by hand, a second creative shows it: deleting `one` keeps it.
    const file = join(s.projectDir, 'assets', 'assets.json');
    const json = JSON.parse(await readFile(file, 'utf8')) as { assets: AssetEntry[] };
    json.assets[0]!.referenceFor = [one];
    await writeFile(file, JSON.stringify(json));
    const two = await make('Due');
    expect((await s.app.inject({ method: 'DELETE', url: `${C}/${one}` })).statusCode).toBe(200);
    expect(await exists('assets/screen.png')).toBe(true);
    expect((await meta())[0]!.referenceFor).toEqual([two]);
  });
});

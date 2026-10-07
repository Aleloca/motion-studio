import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_BRAND_KIT } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrandStore, isPrivateHost } from '../src/brand/brand-store.ts';

let dir: string;
let store: BrandStore;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ms-brand è ')); store = new BrandStore(dir); });

describe('kit and guidelines', () => {
  it('reads an empty kit without writing, then writes a validated one', async () => {
    expect(await store.readKit()).toEqual(EMPTY_BRAND_KIT);
    await expect(readFile(join(dir, 'brand', 'brand-kit.json'))).rejects.toBeTruthy();
    const kit = await store.writeKit({ schemaVersion: 1, colors: [{ id: 'b', name: 'Blu', hex: '#1e3a5f', role: 'primary', source: { kind: 'manual', ref: null } }] });
    expect(kit.colors[0]!.hex).toBe('#1E3A5F');
    expect((await store.readKit()).colors).toHaveLength(1);
    expect((await store.writeKit({ schemaVersion: 1, colors: [{ id: 'x' }] }).catch((e) => e)).status).toBe(400);
  });
  it('reports a corrupt kit without rewriting it', async () => {
    await mkdir(join(dir, 'brand'), { recursive: true });
    await writeFile(join(dir, 'brand', 'brand-kit.json'), '{oops');
    await expect(store.readKit()).rejects.toMatchObject({ reason: 'invalid-json' });
    expect(await readFile(join(dir, 'brand', 'brand-kit.json'), 'utf8')).toBe('{oops');
  });
  it('round-trips guidelines', async () => {
    expect(await store.readGuidelines()).toBe('');
    await store.writeGuidelines('# Linee guida\nTono diretto.');
    expect(await store.readGuidelines()).toBe('# Linee guida\nTono diretto.');
  });
});

describe('isPrivateHost', () => {
  it('rejects private and loopback hosts', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('[::1]')).toBe(true);
    expect(isPrivateHost('10.0.0.0')).toBe(true);
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('172.16.0.0')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    expect(isPrivateHost('169.254.1.1')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('fc00::1')).toBe(true);
    expect(isPrivateHost('fd00::1')).toBe(true);
  });
  it('accepts public hosts', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
    expect(isPrivateHost('1.1.1.1')).toBe(false);
  });
});

describe('sources', () => {
  it('adds, refuses duplicates and invalid urls, removes', async () => {
    const s = await store.addSource({ kind: 'website', url: 'https://acme.example' });
    expect(s).toMatchObject({ id: 's-1', kind: 'website', url: 'https://acme.example', file: null, lastAnalyzedAt: null });
    expect((await store.addSource({ kind: 'website', url: 'https://acme.example' }).catch((e) => e)).status).toBe(409);
    expect((await store.addSource({ kind: 'website', url: 'javascript:alert(1)' }).catch((e) => e)).status).toBe(400);
    const img = await store.addSource({ kind: 'image', file: 'references/moodboard.jpg' });
    expect(img.id).toBe('s-2');
    await store.markAnalyzed(['s-1'], '2026-10-07T10:00:00.000Z');
    expect((await store.readSources())[0]!.lastAnalyzedAt).toBe('2026-10-07T10:00:00.000Z');
    await store.removeSource('s-1');
    expect((await store.readSources()).map((x) => x.id)).toEqual(['s-2']);
    expect((await store.removeSource('nope').catch((e) => e)).status).toBe(404);
  });
  it('rejects private host URLs', async () => {
    expect((await store.addSource({ kind: 'website', url: 'http://localhost:3000' }).catch((e) => e)).status).toBe(400);
    expect((await store.addSource({ kind: 'website', url: 'http://127.0.0.1' }).catch((e) => e)).status).toBe(400);
    expect((await store.addSource({ kind: 'website', url: 'http://192.168.1.1' }).catch((e) => e)).status).toBe(400);
  });
});

describe('proposals', () => {
  it('creates unique ids and lists newest first', async () => {
    const now = new Date('2026-10-07T10:00:00.000Z');
    const a = await store.newProposalId(now);
    const b = await store.newProposalId(now);
    expect(a).toMatch(/^p-20261007-\d{6}$/);
    expect(b).toBe(`${a}-2`);
    const base = { schemaVersion: 1 as const, sourceIds: [], status: 'open' as const, summary: '', changes: [], guidelines: null, assetsAdded: [] };
    await store.writeProposal({ ...base, id: a, createdAt: '2026-10-07T10:00:00.000Z' });
    await store.writeProposal({ ...base, id: b, createdAt: '2026-10-07T11:00:00.000Z' });
    expect((await store.listProposals()).map((p) => p.id)).toEqual([b, a]);
    expect((await store.readProposal('p-nope').catch((e) => e)).status).toBe(404);
    expect((await store.readProposal('../x').catch((e) => e)).status).toBe(400);
  });
});

import { appendFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Brief, VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreativeStore } from '../src/creatives/creative-store.ts';

const brief: Brief = { goal: 'Lancio app', message: 'Prenota in 3 tap', formats: ['instagram-post-1x1'], durationSec: 15, assets: [], notes: '' };
const day = new Date(2026, 9, 7, 12, 0); // local noon: the slug uses the local date
let projectDir: string;
let store: CreativeStore;
beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ms-cr è '));
  store = new CreativeStore(projectDir);
});

const version = (n: number, extra: Partial<VersionEntry> = {}): VersionEntry => ({
  n, commit: 'abc', sessionId: 's1', status: 'complete', createdAt: day.toISOString(), request: 'r',
  outputs: [{ format: 'instagram-post-1x1', file: 'instagram-post-1x1.mp4', width: 1080, height: 1080, durationSec: 15, verified: true, preview: '.previews/instagram-post-1x1.jpg' }],
  problems: [], tools: [], renderCommand: null, basedOn: null, ...extra,
});

describe('create / get / list', () => {
  it('creates the folder layout with a dated slug', async () => {
    const { slug, creative } = await store.create({ title: 'Lancio App Primavera!', brief }, day);
    expect(slug).toBe('2026-10-07-lancio-app-primavera');
    expect(creative).toMatchObject({ schemaVersion: 1, title: 'Lancio App Primavera!', status: 'draft', error: null, resumeFrom: null });
    for (const rel of ['creative.json', 'versions.json', 'conversation.jsonl', 'work']) {
      await expect(stat(join(store.dir(slug), rel))).resolves.toBeTruthy();
    }
    expect(await store.get(slug)).toEqual(creative);
  });
  it('dates the slug with the local day, not the UTC one', async () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      // 03:00 UTC on Oct 8 is still Oct 7 in Los Angeles.
      const { slug } = await store.create({ title: 'Sera', brief }, new Date('2026-10-08T03:00:00.000Z'));
      expect(slug).toBe('2026-10-07-sera');
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });
  it('makes slugs unique on the same day', async () => {
    const a = await store.create({ title: 'Teaser', brief }, day);
    const b = await store.create({ title: 'Teaser', brief }, day);
    expect([a.slug, b.slug]).toEqual(['2026-10-07-teaser', '2026-10-07-teaser-2']);
  });
  it('rejects an invalid brief with 400', async () => {
    const err = await store.create({ title: 'X', brief: { ...brief, formats: [] } }, day).catch((e) => e);
    expect(err.status).toBe(400);
  });
  it('lists newest first with cover and version count, and reports broken ones', async () => {
    const a = await store.create({ title: 'Prima', brief }, new Date(2026, 9, 1, 12, 0));
    const b = await store.create({ title: 'Seconda', brief }, day);
    await store.appendVersion(a.slug, version(1));
    await store.update(a.slug, { status: 'ready' });
    const c = await store.create({ title: 'Rotta', brief }, day);
    await writeFile(join(store.dir(c.slug), 'creative.json'), '{');
    const items = await store.list();
    expect(items[0]).toMatchObject({ ok: true, slug: a.slug, status: 'ready', versions: 1, cover: 'outputs/v1/.previews/instagram-post-1x1.jpg' });
    expect(items.find((i) => i.slug === b.slug)).toMatchObject({ ok: true, versions: 0, cover: null });
    expect(items.find((i) => i.slug === c.slug)).toMatchObject({ ok: false });
  });
  it('404 for unknown, 400 for traversal', async () => {
    expect((await store.get('nope').catch((e) => e)).status).toBe(404);
    expect((await store.get('../x').catch((e) => e)).status).toBe(400);
  });
});

describe('update', () => {
  it('serializes concurrent updates and bumps updatedAt', async () => {
    const { slug, creative } = await store.create({ title: 'A', brief }, day);
    await Promise.all([store.update(slug, { status: 'working' }), store.update(slug, { error: 'x' })]);
    const after = await store.get(slug);
    expect(after.status).toBe('working');
    expect(after.error).toBe('x');
    expect(after.updatedAt > creative.updatedAt).toBe(true);
  });
});

describe('versions and conversation', () => {
  it('numbers versions and appends them', async () => {
    const { slug } = await store.create({ title: 'A', brief }, day);
    expect(await store.nextVersionNumber(slug)).toBe(1);
    await store.appendVersion(slug, version(1));
    expect(await store.nextVersionNumber(slug)).toBe(2);
    expect((await store.readVersions(slug)).map((v) => v.n)).toEqual([1]);
  });
  it('appends conversation lines and skips corrupt ones', async () => {
    const { slug } = await store.create({ title: 'A', brief }, day);
    await store.appendConversation(slug, { type: 'user', at: day.toISOString(), text: 'ciao', pins: [], attachments: [] });
    await appendFile(join(store.dir(slug), 'conversation.jsonl'), 'not json\n');
    await store.appendConversation(slug, { type: 'system', at: day.toISOString(), level: 'info', text: 'ok' });
    expect((await store.readConversation(slug)).map((e) => e.type)).toEqual(['user', 'system']);
  });
});

describe('recoverInterrupted', () => {
  it('marks working creatives as interrupted and logs it', async () => {
    const { slug } = await store.create({ title: 'A', brief }, day);
    await store.update(slug, { status: 'working' });
    expect(await store.recoverInterrupted()).toEqual([slug]);
    expect((await store.get(slug)).status).toBe('interrupted');
    const conv = await store.readConversation(slug);
    expect(conv.at(-1)).toMatchObject({ type: 'system', level: 'error' });
    expect(await readFile(join(store.dir(slug), 'creative.json'), 'utf8')).toContain('interrupted');
  });
  it('warns with project and creative slug when one creative cannot be recovered, and goes on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await store.create({ title: 'A', brief }, day);
    const b = await store.create({ title: 'B', brief }, day);
    await store.update(a.slug, { status: 'working' });
    await store.update(b.slug, { status: 'working' });
    const original = CreativeStore.prototype.appendConversation;
    CreativeStore.prototype.appendConversation = async function (this: CreativeStore, slug, entry) {
      if (slug === a.slug) throw new Error('disco pieno');
      return original.call(this, slug, entry);
    };
    try {
      expect(await store.recoverInterrupted()).toEqual([b.slug]);
    } finally {
      CreativeStore.prototype.appendConversation = original;
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(`${basename(projectDir)}/${a.slug}`);
    expect(warn.mock.calls[0]![0]).toContain('disco pieno');
  });
});

afterEach(() => { vi.restoreAllMocks(); });

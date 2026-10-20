import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { CUSTOM_CHANNEL, DEFAULT_FORMATS, EMPTY_BRIEF_FORM, type FormatPreset } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormatCatalog } from '../src/formats/format-catalog.ts';
import { deleteCustomFormat, scanUsage } from '../src/formats/custom-formats.ts';
import { listFormats } from '../src/brief/brief-tools.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';

// Report 59: custom formats from New creative, one preset at a time (no whole-catalog PUT from the client).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let app: FastifyInstance;
let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-cfmt-'));
  app = await buildServer({ agentContract: 'media', uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [], openPath: async () => {} });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
});
afterEach(async () => { await app.close(); });

const totem = { name: 'Totem', kind: 'video', width: 1080, height: 1920, maxDurationSec: 30 };
const add = (body: unknown) => app.inject({ method: 'POST', url: '/api/formats/custom', payload: body as object });
const edit = (id: string, body: unknown) => app.inject({ method: 'PUT', url: `/api/formats/custom/${id}`, payload: body as object });
const remove = (id: string) => app.inject({ method: 'DELETE', url: `/api/formats/custom/${id}` });
const catalog = async (): Promise<FormatPreset[]> => (await app.inject('/api/formats')).json().presets;
const useIn = (formats: string[], durationSec = 10) => app.inject({ method: 'POST', url: '/api/projects/acme/creatives',
  payload: { title: 'Lancio', brief: { goal: 'Lancio', message: '', formats, durationSec, assets: [], notes: '' }, generate: false } });
const ws = () => join(base, 'ws');

describe('custom formats: add', () => {
  it('adds one preset to the catalog, in the custom channel, with a derived id, and keeps the rest', async () => {
    const before = await catalog();
    const r = await add(totem);
    expect(r.statusCode).toBe(200);
    const { preset, catalog: state } = r.json();
    expect(preset).toMatchObject({ id: 'custom-totem', channel: CUSTOM_CHANNEL, name: 'Totem', kind: 'video', width: 1080, height: 1920, maxDurationSec: 30 });
    expect(state.presets).toHaveLength(before.length + 1);
    expect(state.presets.at(-1)).toEqual(preset);
    expect((await catalog()).map((p) => p.id)).toEqual([...before.map((p) => p.id), 'custom-totem']);
  });

  it('gives a second preset of the same slug a suffix, and refuses a name another custom format has', async () => {
    expect((await add(totem)).json().preset.id).toBe('custom-totem');
    const same = await add({ ...totem, name: ' totem ' });
    expect(same.statusCode).toBe(409);
    expect(same.json().code).toBe('custom-format-name-taken');
    expect((await add({ ...totem, name: 'Totem!' })).json().preset.id).toBe('custom-totem-2');
  });

  it('validates the fields (400, nothing written)', async () => {
    const before = await catalog();
    for (const bad of [{ ...totem, width: 1081 }, { ...totem, height: 4098 }, { ...totem, name: '' }, { ...totem, width: 15 }, { ...totem, height: 9000 }, { ...totem, width: 10.5 }, { ...totem, maxDurationSec: -1 }, { ...totem, kind: 'gif' }, { ...totem, channel: 'x' }]) {
      expect((await add(bad)).statusCode).toBe(400);
    }
    expect(await catalog()).toEqual(before);
  });

  it('two windows adding at once both land (no lost update)', async () => {
    const rs = await Promise.all([add({ ...totem, name: 'A' }), add({ ...totem, name: 'B' }), add({ ...totem, name: 'C' })]);
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    const ids = (await catalog()).filter((p) => p.channel === CUSTOM_CHANNEL).map((p) => p.id).sort();
    expect(ids).toEqual(['custom-a', 'custom-b', 'custom-c']);
  });

  it('refuses to write over a catalog file it cannot read', async () => {
    await catalog();
    const file = join(base, 'ws', '.studio', 'presets', 'formats.json');
    await writeFile(file, '{ broken');
    const r = await add(totem);
    expect(r.statusCode).toBe(409);
    expect(await readFile(file, 'utf8')).toBe('{ broken');
  });
});

describe('custom formats: edit', () => {
  it('changes name, size, kind and duration of an unused preset; the id stays', async () => {
    await add(totem);
    const r = await edit('custom-totem', { name: 'Totem grande', kind: 'image', width: 2160, height: 3840 });
    expect(r.statusCode).toBe(200);
    expect(r.json().preset).toMatchObject({ id: 'custom-totem', name: 'Totem grande', kind: 'image', width: 2160, height: 3840 });
    expect(r.json().preset.maxDurationSec).toBeUndefined();
    expect((await catalog()).filter((p) => p.id === 'custom-totem')).toHaveLength(1);
  });

  it('only custom presets, only known ones', async () => {
    expect((await edit('instagram-post-1x1', totem)).statusCode).toBe(403);
    expect((await edit('custom-nope', totem)).statusCode).toBe(404);
    expect((await remove('instagram-post-1x1')).statusCode).toBe(403);
    expect((await remove('custom-nope')).statusCode).toBe(404);
  });

  it('the maximum length never drops below the longest a creative uses it at (409)', async () => {
    await add(totem);
    expect((await useIn(['custom-totem'], 20)).statusCode).toBe(201);
    const r = await edit('custom-totem', { ...totem, maxDurationSec: 15 });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('custom-format-duration-too-short');
    expect((await edit('custom-totem', { ...totem, maxDurationSec: 20 })).statusCode).toBe(200);
    expect((await edit('custom-totem', { ...totem, maxDurationSec: undefined })).statusCode).toBe(200);
  });

  it("a composition's own length in versions.json counts for the maximum length", async () => {
    await add(totem);
    const created = (await useIn(['custom-totem'], 10)).json();
    const file = join(ws(), 'acme', 'creatives', created.slug, 'versions.json');
    const v = { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: '2026-10-20T10:00:00.000Z', request: '', outputs: [], problems: [], tools: [],
      renderCommand: null, basedOn: null, compositions: [{ format: 'custom-totem', dir: 'compositions/custom-totem', hash: 'a'.repeat(64), userDuration: { durationSec: 25, briefDurationSec: 10 } }] };
    await writeFile(file, JSON.stringify({ schemaVersion: 1, versions: [v] }));
    expect((await app.inject('/api/formats/custom/custom-totem/usage')).json()).toEqual({ creatives: 1, unreadable: 0, longestSec: 25 });
    expect((await edit('custom-totem', { ...totem, maxDurationSec: 20 })).json().code).toBe('custom-format-duration-too-short');
  });

  it('a preset in use keeps its kind and size (409) but takes a new name and duration', async () => {
    await add(totem);
    expect((await useIn(['custom-totem', 'custom-totem@2'])).statusCode).toBe(201);
    expect((await app.inject('/api/formats/custom/custom-totem/usage')).json()).toEqual({ creatives: 1, unreadable: 0, longestSec: 10 });
    const size = await edit('custom-totem', { ...totem, width: 1000 });
    expect(size.statusCode).toBe(409);
    expect(size.json().code).toBe('custom-format-in-use');
    expect((await edit('custom-totem', { ...totem, kind: 'image' })).statusCode).toBe(409);
    const ok = await edit('custom-totem', { ...totem, name: 'Totem 2', maxDurationSec: 45 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().preset).toMatchObject({ name: 'Totem 2', maxDurationSec: 45, width: 1080 });
  });
});

describe('custom formats: delete', () => {
  it('removes an unused preset from the catalog; its id is never given again', async () => {
    await add(totem);
    const r = await remove('custom-totem');
    expect(r.json()).toMatchObject({ outcome: 'deleted' });
    expect((await catalog()).some((p) => p.id === 'custom-totem')).toBe(false);
    expect((await add(totem)).json().preset.id).toBe('custom-totem-2');
    expect(JSON.parse(await readFile(join(ws(), '.studio', 'presets', 'formats.json'), 'utf8')).deletedCustom).toEqual(['custom-totem']);
  });

  it('a hidden preset no creative uses any more goes on the next add, its id remembered', async () => {
    await add(totem);
    const created = (await useIn(['custom-totem'])).json();
    expect((await remove('custom-totem')).json().outcome).toBe('hidden');
    await rm(join(ws(), 'acme', 'creatives', created.slug), { recursive: true });
    await add({ ...totem, name: 'Altro' });
    const presets = await catalog();
    expect(presets.some((p) => p.id === 'custom-totem')).toBe(false);
    expect((await add(totem)).json().preset.id).toBe('custom-totem-2');
  });

  it('a folder of creatives it cannot list counts as a use (hidden, kind and size locked)', async () => {
    await add(totem);
    await mkdir(join(ws(), 'acme', 'creatives'), { recursive: true });
    await chmod(join(ws(), 'acme', 'creatives'), 0o000);
    try {
      expect((await app.inject('/api/formats/custom/custom-totem/usage')).json()).toMatchObject({ creatives: 0, unreadable: 1 });
      expect((await edit('custom-totem', { ...totem, width: 1000 })).statusCode).toBe(409);
      expect((await remove('custom-totem')).json().outcome).toBe('hidden');
    } finally { await chmod(join(ws(), 'acme', 'creatives'), 0o755); }
  });

  it('an unreadable creative written before the format was added does not lock it; one written after does', async () => {
    const dir = join(ws(), 'acme', 'creatives', 'rotta');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'creative.json'), '{ broken');
    const old = new Date('2020-01-01T00:00:00.000Z');
    await utimes(join(dir, 'creative.json'), old, old);
    const { preset } = (await add(totem)).json();
    expect(preset.createdAt).toEqual(expect.any(String));
    expect((await app.inject('/api/formats/custom/custom-totem/usage')).json()).toEqual({ creatives: 0, unreadable: 0, longestSec: 0 });
    expect((await edit('custom-totem', { ...totem, width: 1000 })).statusCode).toBe(200);
    // The edit keeps when it was added.
    expect((await catalog()).find((p) => p.id === 'custom-totem')!.createdAt).toBe(preset.createdAt);
    // Written again now: it might use the format.
    await writeFile(join(dir, 'creative.json'), '{ broken again');
    const r = await edit('custom-totem', { ...totem, width: 1080 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('non si legge');
    expect((await remove('custom-totem')).json().outcome).toBe('hidden');
  });

  it('a custom preset without createdAt (from before): every unreadable creative counts', async () => {
    const dir = join(ws(), 'acme', 'creatives', 'rotta');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'creative.json'), '{ broken');
    const old = new Date('2020-01-01T00:00:00.000Z');
    await utimes(join(dir, 'creative.json'), old, old);
    const legacy = { id: 'custom-vecchio', channel: CUSTOM_CHANNEL, name: 'Vecchio', kind: 'image', width: 100, height: 100, extensions: ['png'] };
    await app.inject({ method: 'PUT', url: '/api/formats', payload: { presets: [...DEFAULT_FORMATS, legacy] } });
    expect((await app.inject('/api/formats/custom/custom-vecchio/usage')).json()).toMatchObject({ creatives: 0, unreadable: 1 });
  });

  it('a delete scanning while a creative is made with the format: the creative lands first and the format is hidden', async () => {
    await add(totem);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let scanned = false;
    // The scan before the lock is done (no creative yet), then held: the creative is made meanwhile.
    const slow: typeof scanUsage = async (w, prev) => { const r = await scanUsage(w, prev); if (!prev) { scanned = true; await gate; } return r; };
    const pending = deleteCustomFormat({ catalog: new FormatCatalog(ws()), ws: { root: ws() }, scan: slow }, 'custom-totem');
    await vi.waitFor(() => expect(scanned).toBe(true));
    expect((await useIn(['custom-totem'])).statusCode).toBe(201);
    release();
    expect((await pending).outcome).toBe('hidden');
  });

  it('the format check of a creation and a catalog change never interleave (whileOffered holds the lock)', async () => {
    await add(totem);
    const c = new FormatCatalog(ws());
    const order: string[] = [];
    await c.whileOffered(['custom-totem'], [], async () => {
      const change = c.mutate((ps) => { order.push('delete'); return ps.filter((p) => p.id !== 'custom-totem'); });
      await new Promise((r) => setTimeout(r, 50));
      order.push('write');
      void change;
    });
    await vi.waitFor(() => expect(order).toEqual(['write', 'delete']));
    await expect(c.whileOffered(['custom-totem'], [], async () => 'written')).rejects.toMatchObject({ apiCode: 'format-unavailable' });
  });

  it('a slug-shaped folder without project.json is scanned too', async () => {
    await add(totem);
    const created = (await useIn(['custom-totem'])).json();
    await rm(join(ws(), 'acme', 'project.json'));
    expect((await app.inject(`/api/formats/custom/custom-totem/usage`)).json()).toMatchObject({ creatives: 1 });
    expect(created.slug).toBeTruthy();
  });

  it('the catalog is not locked while the scan runs (renders and previews keep loading it)', async () => {
    await add(totem);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let scanning = false;
    const slow: typeof scanUsage = async (w, prev) => { if (!prev) { scanning = true; await gate; } return scanUsage(w, prev); };
    const c = new FormatCatalog(ws());
    const pending = deleteCustomFormat({ catalog: c, ws: { root: ws() }, scan: slow }, 'custom-totem');
    await vi.waitFor(() => expect(scanning).toBe(true));
    // A load during the scan answers at once.
    const loaded = await Promise.race([c.load().then(() => 'loaded'), new Promise((r) => setTimeout(() => r('blocked'), 1000))]);
    expect(loaded).toBe('loaded');
    release();
    expect((await pending).outcome).toBe('deleted');
  });

  it('hides a preset a creative uses: the creative keeps it, the board and the agent do not', async () => {
    await add(totem);
    const created = (await useIn(['custom-totem'])).json();
    const r = await remove('custom-totem');
    expect(r.statusCode).toBe(200);
    expect(r.json().outcome).toBe('hidden');
    const kept = (await catalog()).find((p) => p.id === 'custom-totem');
    expect(kept).toMatchObject({ hidden: true, width: 1080 });
    // The creative still opens with its format's summary.
    const detail = await app.inject(`/api/projects/acme/creatives/${created.slug}`);
    expect(detail.statusCode).toBe(200);
    expect(listFormats(await catalog(), 'it').formats.some((f) => f.id === 'custom-totem')).toBe(false);
    // Hidden: not editable, deleted again only as not found, and its name is free again (the new one takes another id).
    expect((await edit('custom-totem', totem)).statusCode).toBe(404);
    expect((await remove('custom-totem')).statusCode).toBe(404);
    expect((await add(totem)).json().preset.id).toBe('custom-totem-2');
  });

  it('counts an archived creative as a use', async () => {
    await add(totem);
    const created = (await useIn(['custom-totem'])).json();
    expect((await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${created.slug}/archive` })).statusCode).toBe(200);
    expect((await remove('custom-totem')).json().outcome).toBe('hidden');
  });
});

describe('a format no longer offered is refused (400) where a brief names it', () => {
  it('(a) deleted in one window, a creative made in another with it', async () => {
    await add(totem);
    await remove('custom-totem');
    const r = await useIn(['instagram-post-1x1', 'custom-totem']);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('format-unavailable');
    expect((await useIn(['never-a-preset'])).json().code).toBe('format-unavailable');
  });

  it('a brief save may keep a hidden format it has, never add one', async () => {
    await add(totem);
    await add({ ...totem, name: 'Due' });
    const created = (await useIn(['custom-totem'])).json();
    await useIn(['custom-due']);
    await remove('custom-totem');
    await remove('custom-due');
    const brief = { goal: 'Lancio', message: '', formats: ['custom-totem'], durationSec: 12, assets: [], notes: '' };
    const put = (formats: string[]) => app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${created.slug}`, payload: { brief: { ...brief, formats } } });
    expect((await put(['custom-totem'])).statusCode).toBe(200);
    const bad = await put(['custom-totem', 'custom-due']);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('format-unavailable');
  });

  it("the brief session's form: the user's formats may not add a hidden one", async () => {
    await add(totem);
    await useIn(['custom-totem']);
    await remove('custom-totem');
    const s = (await app.inject({ method: 'POST', url: '/api/projects/acme/brief-session', payload: { form: EMPTY_BRIEF_FORM, userEdited: [] } })).json();
    const r = await app.inject({ method: 'PUT', url: `/api/projects/acme/brief-session/${s.id}/form`,
      payload: { form: { ...EMPTY_BRIEF_FORM, formats: ['custom-totem'] }, userEdited: ['formats'], baseRevision: s.revision } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('format-unavailable');
  });
});

describe('a whole-catalog write keeps the custom formats', () => {
  it('reset and PUT /api/formats keep them', async () => {
    await add(totem);
    expect((await app.inject({ method: 'POST', url: '/api/formats/reset' })).json().presets.some((p: FormatPreset) => p.id === 'custom-totem')).toBe(true);
    const put = await app.inject({ method: 'PUT', url: '/api/formats', payload: { presets: [DEFAULT_FORMATS[0]] } });
    expect(put.json().presets.map((p: FormatPreset) => p.id)).toEqual([DEFAULT_FORMATS[0]!.id, 'custom-totem']);
  });
});

describe('the brief agent sees custom presets', () => {
  it('list_formats lists them under "Personalizzati"', async () => {
    await add(totem);
    const f = listFormats(await catalog(), 'it').formats.find((x) => x.id === 'custom-totem');
    expect(f).toEqual({ id: 'custom-totem', label: 'Personalizzati · Totem', channel: 'Personalizzati', kind: 'video', width: 1080, height: 1920, maxDurationSec: 30 });
  });
});

describe('FormatCatalog.mutate', () => {
  it('keeps the seen defaults of the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ms-cfmt-cat-'));
    await mkdir(join(root, '.studio', 'presets'), { recursive: true });
    const file = join(root, '.studio', 'presets', 'formats.json');
    const seen = DEFAULT_FORMATS.map((p) => p.id);
    await writeFile(file, JSON.stringify({ schemaVersion: 1, presets: DEFAULT_FORMATS.slice(1), seenDefaults: seen }));
    const c = new FormatCatalog(root);
    await c.mutate((ps) => ps.slice(1));
    const written = JSON.parse(await readFile(file, 'utf8'));
    expect(written.presets).toHaveLength(DEFAULT_FORMATS.length - 2);
    expect(written.seenDefaults).toEqual(seen);
  });
});

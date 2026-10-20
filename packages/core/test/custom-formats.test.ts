import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { CUSTOM_CHANNEL, DEFAULT_FORMATS, type FormatPreset } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormatCatalog } from '../src/formats/format-catalog.ts';
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
const useIn = (formats: string[]) => app.inject({ method: 'POST', url: '/api/projects/acme/creatives',
  payload: { title: 'Lancio', brief: { goal: 'Lancio', message: '', formats, durationSec: 10, assets: [], notes: '' }, generate: false } });

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
    for (const bad of [{ ...totem, name: '' }, { ...totem, width: 15 }, { ...totem, height: 9000 }, { ...totem, width: 10.5 }, { ...totem, maxDurationSec: -1 }, { ...totem, kind: 'gif' }, { ...totem, channel: 'x' }]) {
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

  it('a preset in use keeps its kind and size (409) but takes a new name and duration', async () => {
    await add(totem);
    expect((await useIn(['custom-totem', 'custom-totem@2'])).statusCode).toBe(201);
    expect((await app.inject('/api/formats/custom/custom-totem/usage')).json()).toEqual({ creatives: 1 });
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
  it('removes an unused preset from the catalog', async () => {
    await add(totem);
    const r = await remove('custom-totem');
    expect(r.json()).toMatchObject({ outcome: 'deleted' });
    expect((await catalog()).some((p) => p.id === 'custom-totem')).toBe(false);
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

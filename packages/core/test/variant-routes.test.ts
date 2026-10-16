// @vitest-environment node
/**
 * Phase 15, Task 2: the variant group routes (spec §2, §5, §7) on a real server with the fake claude: creating sisters
 * (no turn starts, ruling R3), the list with one row per group, discard and restore, ★ picks, layout and directions, the
 * limit of five, an old creative untouched by every route but POST …/variants, `~` refused for user creatives, orphans.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreativeDetail, CreativeListItem } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const brief = { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1', 'web-banner-300x250'], durationSec: 10, assets: [], notes: '' };
let app: FastifyInstance;
let base: string;
const P = '/api/projects/acme/creatives';
const projectDir = () => join(base, 'ws', 'acme');

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-vr-'));
  process.env.FAKE_CLAUDE_SCENARIO = 'render';
  app = await buildServer({ agentContract: 'media', uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), configDir: join(base, 'config'), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [], openPath: async () => {} });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
});
afterEach(async () => { await app.close(); delete process.env.FAKE_CLAUDE_SCENARIO; });

const create = async (title = 'Lancio') => (await app.inject({ method: 'POST', url: P, payload: { title, brief, generate: false } })).json() as { slug: string };
const detail = async (slug: string) => (await app.inject(`${P}/${slug}`)).json() as CreativeDetail;
const creativeJson = (slug: string) => readFile(join(projectDir(), 'creatives', slug, 'creative.json'), 'utf8');

describe('variant routes', () => {
  it('POST …/variants makes the group (no turn starts); the list has one row per group; a sister\'s detail names its host', async () => {
    const { slug } = await create();
    const res = await app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 3, directions: ['Audace', null, 'Calma'] } });
    expect(res.statusCode).toBe(201);
    const d = res.json() as CreativeDetail;
    expect(d.creative.variantGroup!.members.map((m) => [m.letter, m.slug, m.direction, m.directionSource])).toEqual([
      ['a', slug, 'Audace', 'user'], ['b', `${slug}~b`, null, null], ['c', `${slug}~c`, 'Calma', 'user'],
    ]);
    expect(d.variants).toEqual({ orphan: false, host: slug, letter: 'a', group: d.creative.variantGroup, missing: [] });
    expect((await app.inject('/api/jobs')).json()).toEqual([]);
    const list = (await app.inject(P)).json() as CreativeListItem[];
    expect(list.map((i) => i.slug)).toEqual([slug]);
    expect(list[0]).toMatchObject({ variants: { count: 3, active: 3, missing: [] } });
    expect((await app.inject('/api/recent-creatives?limit=12')).json().map((i: { slug: string }) => i.slug)).toEqual([slug]);
    const sister = await detail(`${slug}~b`);
    expect(sister.creative).toMatchObject({ variantOf: slug, brief: { goal: 'Lancio app' } });
    expect(sister.variants).toMatchObject({ orphan: false, host: slug, letter: 'b' });
    // Adding from a sister adds to the group: here two more (5), then a 6th is refused.
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}~b/variants`, payload: { count: 3 } })).json()).toMatchObject({ code: 'variants-full' });
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}~b/variants`, payload: { directions: ['Notte', 'Giorno'] } })).statusCode).toBe(201);
    const sixth = await app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: {} });
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().code).toBe('variants-full');
    expect((await detail(slug)).creative.variantGroup!.members).toHaveLength(5);
    // Bad bodies: a group of one, too many directions, a 141-character direction, unknown keys.
    const other = await create('Altro');
    for (const payload of [{ count: 1 }, { count: 2, directions: ['a', 'b', 'c'] }, { directions: ['x'.repeat(141)] }, { what: 1 }]) {
      expect((await app.inject({ method: 'POST', url: `${P}/${other.slug}/variants`, payload })).statusCode).toBe(400);
    }
    expect(JSON.parse(await creativeJson(other.slug)).variantGroup).toBeUndefined();
  });

  it('discard, restore, picks, use-for-all, layout and direction', async () => {
    const { slug } = await create();
    await app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 2 } });
    const v = `${P}/${slug}/variants`;
    let res = await app.inject({ method: 'POST', url: `${v}/b/discard` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as CreativeDetail).creative.variantGroup!.members[1]!.status).toBe('discarded');
    expect((await app.inject(P)).json()[0]).toMatchObject({ variants: { count: 2, active: 1 } });
    res = await app.inject({ method: 'POST', url: `${v}/a/discard` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'variant-last-active' });
    expect((await app.inject({ method: 'POST', url: `${v}/f/discard` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `${v}/d/restore` })).json()).toMatchObject({ code: 'variant-unknown' });
    expect((await app.inject({ method: 'POST', url: `${v}/b/restore` })).json().creative.variantGroup.members[1].status).toBe('active');
    // Picks: invalid ones are 422; null clears.
    res = await app.inject({ method: 'PUT', url: `${v}/picks/instagram-post-1x1`, payload: { slug: `${slug}~b`, version: 1 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('variant-pick-invalid');
    expect((await app.inject({ method: 'PUT', url: `${v}/picks/instagram-post-1x1`, payload: { slug: 'x', version: 0 } })).statusCode).toBe(400);
    res = await app.inject({ method: 'PUT', url: `${v}/picks/instagram-post-1x1`, headers: { 'content-type': 'application/json' }, payload: 'null' });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${v}/b/use-for-all` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: `${v}/layout`, payload: { layout: 'format' } })).json().creative.variantGroup.layout).toBe('format');
    expect((await app.inject({ method: 'PUT', url: `${v}/layout`, payload: { layout: 'grid' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `${P}/${slug}~b/variants/b/direction`, payload: { direction: 'Più calda' } })).json().creative.variantOf).toBe(slug);
    expect((await detail(slug)).creative.variantGroup!.members[1]).toMatchObject({ direction: 'Più calda', directionSource: 'user' });
  });

  it('a brief saved on any variant reaches the whole group', async () => {
    const { slug } = await create();
    await app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 3 } });
    const res = await app.inject({ method: 'PUT', url: `${P}/${slug}~c`, payload: { title: 'Lancio estivo', brief: { ...brief, goal: 'Estate' } } });
    expect(res.statusCode).toBe(200);
    for (const s of [slug, `${slug}~b`, `${slug}~c`]) expect((await detail(s)).creative).toMatchObject({ title: 'Lancio estivo', brief: { goal: 'Estate' } });
  });

  it('an old creative is unchanged by every route but POST …/variants', async () => {
    const { slug } = await create();
    const before = await creativeJson(slug);
    const beforeDetail = await detail(slug);
    expect(beforeDetail).not.toHaveProperty('variants');
    expect((await app.inject(P)).json()[0]).not.toHaveProperty('variants');
    const v = `${P}/${slug}/variants`;
    const calls = [
      { method: 'POST' as const, url: `${v}/b/discard` }, { method: 'POST' as const, url: `${v}/a/discard` },
      { method: 'POST' as const, url: `${v}/b/restore` }, { method: 'POST' as const, url: `${v}/a/use-for-all` },
      { method: 'PUT' as const, url: `${v}/picks/instagram-post-1x1`, payload: { slug, version: 1 } },
      { method: 'PUT' as const, url: `${v}/layout`, payload: { layout: 'format' } },
      { method: 'PUT' as const, url: `${v}/a/direction`, payload: { direction: 'x' } },
    ];
    for (const c of calls) {
      const res = await app.inject(c);
      expect(res.statusCode, c.url).toBe(409);
      expect(res.json().code).toBe('variant-no-group');
    }
    expect(await creativeJson(slug)).toBe(before);
    expect(await detail(slug)).toEqual(beforeDetail);
    // Its brief edits behave as today (refused while a turn runs, no group involved).
    expect((await app.inject({ method: 'PUT', url: `${P}/${slug}`, payload: { services: { voice: 'none' } } })).json().variantGroup).toBeUndefined();
  });

  it('`~` stays reserved: a user creative never gets one, a hand-made x~b is no creative, an orphan opens alone', async () => {
    const { slug } = await create('Prova~b');
    expect(slug).not.toContain('~');
    // A hand-made folder with a creative.json but no group: 404 everywhere, not listed, no usage.
    const fake = `${slug}~b`;
    await mkdir(join(projectDir(), 'creatives', fake), { recursive: true });
    await writeFile(join(projectDir(), 'creatives', fake, 'creative.json'), await creativeJson(slug));
    expect((await app.inject(`${P}/${fake}`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `${P}/${fake}/turns`, payload: {} })).statusCode).toBe(404);
    expect((await app.inject(P)).json().map((i: CreativeListItem) => i.slug)).toEqual([slug]);
    expect((await app.inject(`/api/usage?project=acme&creative=${encodeURIComponent(fake)}`)).statusCode).toBe(400);
    expect((await app.inject(`${P}/${encodeURIComponent(`${slug}~f`)}`)).statusCode).toBe(400);
    await rm(join(projectDir(), 'creatives', fake), { recursive: true });
    // A real sister: usage answers; then its host deleted by hand: the sister is an orphan, listed and opened alone.
    await app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 2 } });
    expect((await app.inject(`/api/usage?project=acme&creative=${encodeURIComponent(`${slug}~b`)}`)).statusCode).toBe(200);
    await rm(join(projectDir(), 'creatives', slug), { recursive: true });
    const orphan = await app.inject(`${P}/${slug}~b`);
    expect(orphan.statusCode).toBe(200);
    expect((orphan.json() as CreativeDetail).variants).toEqual({ orphan: true, host: slug, letter: 'b' });
    expect((await app.inject(P)).json()).toEqual([expect.objectContaining({ slug: `${slug}~b`, orphan: true })]);
    const add = await app.inject({ method: 'POST', url: `${P}/${slug}~b/variants`, payload: {} });
    expect(add.statusCode).toBe(409);
    expect(add.json().code).toBe('variant-orphan');
  });
});

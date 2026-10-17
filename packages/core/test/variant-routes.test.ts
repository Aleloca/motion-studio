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
import { CreativeSideStateStore } from '../src/creatives/creative-side-state.ts';
import { H, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

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

  it('minor (Task 2): two concurrent POST …/variants on a creative without a group are decided one after the other under the host lock', async () => {
    const { slug } = await create();
    const post = () => app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 3 } });
    const res = await Promise.all([post(), post()]);
    // The first makes the group of 3 (A included); the second sees it and asks to ADD 3 more: over the limit of five.
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.statusCode === 409)!.json().code).toBe('variants-full');
    expect((await detail(slug)).creative.variantGroup!.members.map((m) => m.letter)).toEqual(['a', 'b', 'c']);
  });

  it('minor (Task 2): PUT picks with no body is refused; only an explicit null clears the ★', async () => {
    const { slug } = await create();
    await app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 2 } });
    const url = `${P}/${slug}/variants/picks/instagram-post-1x1`;
    const none = await app.inject({ method: 'PUT', url });
    expect(none.statusCode).toBe(400);
    const cleared = await app.inject({ method: 'PUT', url, headers: { 'content-type': 'application/json' }, payload: 'null' });
    expect(cleared.statusCode).toBe(200);
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

  it('final wave I2: a discarded variant refuses the brief, editor, duplicate, links, resume and localize routes (409 variant-discarded)', async () => {
    const { slug } = await create();
    await app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 3 } });
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/variants/b/discard` })).statusCode).toBe(200);
    const b = `${P}/${slug}~b`;
    const editBody = { baseVersion: 1, format: 'instagram-post-1x1', baseHash: 'a'.repeat(64), composition: {}, staged: [], ops: [], token: 'A'.repeat(43) };
    for (const [method, url, payload] of [
      ['PUT', b, { title: 'Da B scartata', brief: { ...brief, goal: 'Indietro' } }],
      ['POST', `${b}/edits`, editBody],
      ['POST', `${b}/versions/1/duplicate-format`, { instanceId: 'instagram-post-1x1' }],
      ['PUT', `${b}/links`, { follower: 'web-banner-300x250', primary: 'instagram-post-1x1' }],
      ['POST', `${b}/versions/1/restore`, {}],
      ['POST', `${b}/versions/1/localize`, { locales: ['en'] }],
    ] as const) {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(409);
      expect(res.json()).toMatchObject({ code: 'variant-discarded', error: 'Ripristina la variante per lavorarci' });
    }
    // The group is untouched.
    for (const s of [slug, `${slug}~c`]) expect((await detail(s)).creative).toMatchObject({ title: 'Lancio', brief: { goal: 'Lancio app' } });
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
    // Decisions log 833: an orphan sister is a creative for usage too.
    expect((await app.inject(`/api/usage?project=acme&creative=${encodeURIComponent(`${slug}~b`)}`)).statusCode).toBe(200);
    const orphan = await app.inject(`${P}/${slug}~b`);
    expect(orphan.statusCode).toBe(200);
    expect((orphan.json() as CreativeDetail).variants).toEqual({ orphan: true, host: slug, letter: 'b' });
    expect((await app.inject(P)).json()).toEqual([expect.objectContaining({ slug: `${slug}~b`, orphan: true })]);
    const add = await app.inject({ method: 'POST', url: `${P}/${slug}~b/variants`, payload: {} });
    expect(add.statusCode).toBe(409);
    expect(add.json().code).toBe('variant-orphan');
  });
});

describe('fix round 1, Important 1: a translation does not hold back the group\'s brief', () => {
  let env: InstanceEnv;
  afterEach(async () => { await env?.close(); });
  it('B localizing while the group adds a language: once it ends, B has the language and translating into it works', async () => {
    env = await startInstanceEnv('ms-test-variant-loc-');
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['de'] } });
    const B = `${slug}~b`;
    const url = (c: string) => `/api/projects/acme/creatives/${c}`;
    expect((await env.app.inject({ method: 'POST', url: `${url(slug)}/variants`, headers: H, payload: { count: 2, baseFrom: { slug, version: 1 } } })).statusCode).toBe(201);
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const started = await env.app.inject({ method: 'POST', url: `${url(B)}/versions/1/localize`, headers: H, payload: { locales: ['de'] } });
    expect(started.statusCode, started.body).toBe(202);
    const jobId = (started.json() as { jobId: string }).jobId;
    const hostBrief = (await env.app.inject({ url: url(slug), headers: H })).json().creative.brief;
    const res = await env.app.inject({ method: 'PUT', url: url(slug), headers: H, payload: { brief: { ...hostBrief, links: undefined, locales: { primary: 'en', extra: ['de', 'fr'] } } } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await env.app.inject({ url: url(B), headers: H })).json().creative.brief.locales.extra).toEqual(['de']);
    await env.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel`, headers: H });
    await env.waitJob(jobId);
    process.env.FAKE_CLAUDE_SCENARIO = 'composition';
    await vi.waitFor(async () => expect((await env.app.inject({ url: url(B), headers: H })).json().creative.brief.locales.extra).toEqual(['de', 'fr']), { timeout: 10_000 });
    const fr = await env.app.inject({ method: 'POST', url: `${url(B)}/versions/1/localize`, headers: H, payload: { locales: ['fr'] } });
    expect(fr.statusCode, fr.body).toBe(202);
    await env.waitJob((fr.json() as { jobId: string }).jobId);
  });
});

describe('minor (Task 2): the localization overlay edit applies the variant\'s pending brief first', () => {
  let env: InstanceEnv;
  afterEach(async () => { await env?.close(); });
  it('a language only the pending brief has is accepted: the brief is applied under the lock before the check', async () => {
    const side = new CreativeSideStateStore(null);
    env = await startInstanceEnv('ms-test-variant-pend-', { sideState: side });
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['de'] } });
    const B = `${slug}~b`;
    const url = (c: string) => `/api/projects/acme/creatives/${c}`;
    expect((await env.app.inject({ method: 'POST', url: `${url(slug)}/variants`, headers: H, payload: { count: 2, baseFrom: { slug, version: 1 } } })).statusCode).toBe(201);
    // A crash left the group's newer brief (one more language) pending on B, which is idle.
    const bBrief = (await env.app.inject({ url: url(B), headers: H })).json().creative.brief;
    await side.setPendingBrief(env.projectDir(), B, { brief: { ...bBrief, locales: { primary: 'en', extra: ['de', 'fr'] } }, at: new Date().toISOString() });
    const put = await env.app.inject({ method: 'PUT', url: `${url(B)}/versions/1/localizations/fr/test-wide`, headers: H, payload: { texts: { title: 'Bonjour' } } });
    expect(put.statusCode, put.body).toBe(200);
    expect((await env.app.inject({ url: url(B), headers: H })).json().creative.brief.locales.extra).toEqual(['de', 'fr']);
    expect(await side.pendingBrief(env.projectDir(), B)).toBeNull();
  });
});

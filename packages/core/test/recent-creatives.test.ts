import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';
import { MemoryVault } from '../src/secrets/vault.ts';

const TOKEN = 'cd'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const brief = { goal: 'Goal', message: '', formats: ['instagram-post-1x1'], durationSec: 10, assets: [], notes: '' };
let app: FastifyInstance;
let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-recent-'));
  app = await buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [],
    runner: new ClaudeCodeRunner(['true']), vault: new MemoryVault(),
  });
  await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: join(base, 'ws') } });
});
afterEach(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });

/** Creates a creative, then pins its updatedAt so ordering does not depend on the clock. */
async function seed(project: string, title: string, updatedAt: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: `/api/projects/${project}/creatives`, headers: H, payload: { title, brief, generate: false } });
  const slug = r.json().slug as string;
  const file = join(base, 'ws', project, 'creatives', slug, 'creative.json');
  const json = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...json, updatedAt }));
  return slug;
}
const get = (query = '', headers: Record<string, string> = H) => app.inject({ method: 'GET', url: `/api/recent-creatives${query}`, headers });

describe('GET /api/recent-creatives', () => {
  beforeEach(async () => {
    for (const name of ['Alpha', 'Beta', 'Gamma']) await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name } });
  });

  it('returns the 3 most recent creatives across projects, newest first, with their project', async () => {
    await seed('alpha', 'a-old', '2026-01-01T00:00:00.000Z');
    await seed('beta', 'b-new', '2026-03-01T00:00:00.000Z');
    await seed('gamma', 'g-mid', '2026-02-01T00:00:00.000Z');
    await seed('alpha', 'a-mid2', '2026-02-15T00:00:00.000Z');
    const r = await get();
    expect(r.statusCode).toBe(200);
    const body = r.json() as Array<{ title: string; project: { slug: string; name: string } }>;
    expect(body.map((i) => i.title)).toEqual(['b-new', 'a-mid2', 'g-mid']);
    expect(body[0]!.project).toEqual({ slug: 'beta', name: 'Beta' });
  });

  it('clamps limit to 1..12 and falls back to 3 when it is not a number', async () => {
    for (let i = 0; i < 14; i++) await seed('alpha', `c${i}`, `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`);
    expect((await get('?limit=99')).json()).toHaveLength(12);
    expect((await get('?limit=0')).json()).toHaveLength(1);
    expect((await get('?limit=-5')).json()).toHaveLength(1);
    expect((await get('?limit=5')).json()).toHaveLength(5);
    expect((await get('?limit=abc')).json()).toHaveLength(3);
    expect((await get('?limit=')).json()).toHaveLength(3);
  });

  it('breaks ties by project slug then creative slug', async () => {
    const at = '2026-02-01T00:00:00.000Z';
    await seed('beta', 'same', at);
    await seed('alpha', 'same', at);
    const body = (await get()).json() as Array<{ project: { slug: string } }>;
    expect(body.map((i) => i.project.slug)).toEqual(['alpha', 'beta']);
  });

  it('skips unreadable projects and unreadable creatives', async () => {
    await seed('alpha', 'ok', '2026-02-01T00:00:00.000Z');
    await writeFile(join(base, 'ws', 'beta', 'project.json'), '{ not json');
    await mkdir(join(base, 'ws', 'gamma', 'creatives', 'broken'), { recursive: true });
    await writeFile(join(base, 'ws', 'gamma', 'creatives', 'broken', 'creative.json'), '{ not json');
    const body = (await get()).json() as Array<{ title: string }>;
    expect(body.map((i) => i.title)).toEqual(['ok']);
  });

  it('requires the UI token', async () => {
    expect((await get('', {})).statusCode).toBe(401);
    expect((await get('', { 'x-motion-studio-ui': 'ef'.repeat(32) })).statusCode).toBe(401);
  });
});

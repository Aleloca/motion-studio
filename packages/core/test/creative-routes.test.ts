import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { recoverWorkspace } from '../src/server/creative-routes.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';

// Load-robust (flaky under a busy machine): a per-file timeout, not a global one; what the tests check is unchanged.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const brief = { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1', 'web-banner-300x250'], durationSec: 10, assets: [], notes: '' };
let app: FastifyInstance;
let base: string;
let opened: string[];

const build = () => buildServer({ agentContract: 'media', uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
  appConfig: new AppConfigStore(join(base, 'config')),
  git: new Git(),
  runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
  doctor: async () => [],
  openPath: async (p) => { opened.push(p); },
});

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-crr-'));
  opened = [];
  process.env.FAKE_CLAUDE_SCENARIO = 'render';
  app = await build();
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
});
afterEach(async () => { await app.close(); delete process.env.FAKE_CLAUDE_SCENARIO; });

const waitJobs = async () => {
  for (let i = 0; i < 750; i++) {
    const jobs = (await app.inject('/api/jobs')).json() as Array<{ state: string }>;
    if (jobs.every((j) => j.state !== 'queued' && j.state !== 'running')) return jobs;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
};
const createCreative = async (generate = true) =>
  (await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Lancio', brief, generate } })).json();

describe('formats', { timeout: 90_000 }, () => {
  it('serves, validates and resets the catalog', async () => {
    const s = (await app.inject('/api/formats')).json();
    expect(s.presets.length).toBeGreaterThan(30);
    expect((await app.inject({ method: 'PUT', url: '/api/formats', payload: { presets: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/formats', payload: { presets: [s.presets[0]] } })).json().presets).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: '/api/formats/reset' })).json().presets.length).toBe(s.presets.length);
  });
});

describe('creatives', { timeout: 90_000 }, () => {
  it('creates and generates, then exposes detail, conversation and files', async () => {
    const created = await createCreative();
    expect(created.job).toMatchObject({ state: expect.any(String) });
    await waitJobs();
    const list = (await app.inject('/api/projects/acme/creatives')).json();
    expect(list[0]).toMatchObject({ ok: true, slug: created.slug, status: 'ready', versions: 1 });
    const detail = (await app.inject(`/api/projects/acme/creatives/${created.slug}`)).json();
    expect(detail.versions[0].outputs).toHaveLength(2);
    expect(detail.jobKey).toContain(created.slug);
    expect((await app.inject(`/api/projects/acme/creatives/${created.slug}/conversation`)).json().at(-1)).toMatchObject({ type: 'version', n: 1 });
    const file = await app.inject(`/api/projects/acme/creatives/${created.slug}/files/outputs/v1/manifest.json`);
    expect(file.statusCode).toBe(200);
    expect(file.json().schemaVersion).toBe(1);
  });
  it('creates a draft without generating and validates the brief', async () => {
    const created = await createCreative(false);
    expect(created.job).toBeNull();
    expect(created.creative.status).toBe('draft');
    const bad = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'X', brief: { ...brief, goal: '' } } });
    expect(bad.statusCode).toBe(400);
  });
  it('iterates with text and pins, and validates them', async () => {
    const { slug } = await createCreative();
    await waitJobs();
    const url = `/api/projects/acme/creatives/${slug}/turns`;
    expect((await app.inject({ method: 'POST', url, payload: { pins: [{ format: 'x', x: 3, y: 0, timeSec: null }] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, payload: { text: 'x'.repeat(10001) } })).statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url, payload: { text: 'Logo più grande', pins: [{ format: 'instagram-post-1x1', x: 0.5, y: 0.5, timeSec: 1 }] } });
    expect(res.statusCode).toBe(202);
    await waitJobs();
    expect((await app.inject(`/api/projects/acme/creatives/${slug}`)).json().versions).toHaveLength(2);
  });
  it('blocks brief edits while a job runs and allows them afterwards', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const { slug, job } = await createCreative();
    const url = `/api/projects/acme/creatives/${slug}`;
    await new Promise((r) => setTimeout(r, 300));
    expect((await app.inject({ method: 'PUT', url, payload: { title: 'Nuovo' } })).statusCode).toBe(409);
    await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    await waitJobs();
    expect((await app.inject({ method: 'PUT', url, payload: { title: 'Nuovo', brief: { ...brief, durationSec: 6 } } })).json()).toMatchObject({ title: 'Nuovo', brief: { durationSec: 6 } });
  });
  it('a services-only edit changes just the services of the brief stored now (not a caller copy of it)', async () => {
    const { slug } = await createCreative(false);
    const url = `/api/projects/acme/creatives/${slug}`;
    // A newer brief is on the server; the chip still holds the old one and sends only its services.
    await app.inject({ method: 'PUT', url, payload: { brief: { ...brief, durationSec: 7, goal: 'Newer goal' } } });
    const res = await app.inject({ method: 'PUT', url, payload: { services: { voice: 'none' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().brief).toMatchObject({ goal: 'Newer goal', durationSec: 7, services: { voice: 'none' } });
    expect((await app.inject({ method: 'PUT', url, payload: { services: { voice: 'bogus' } } })).statusCode).toBe(400);
  });
  it('a partial save of labels, order and removal merges into the stored brief under the lock (Phase 12)', async () => {
    const { slug } = await createCreative(false);
    const url = `/api/projects/acme/creatives/${slug}`;
    const three = { ...brief, formats: ['instagram-post-1x1', 'instagram-post-1x1@2', 'web-banner-300x250'], formatLabels: { 'instagram-post-1x1@2': 'Promo' } };
    expect((await app.inject({ method: 'PUT', url, payload: { brief: three } })).statusCode).toBe(200);
    // A newer brief is on the server; the caller holds an old copy and sends only labels.
    await app.inject({ method: 'PUT', url, payload: { brief: { ...three, goal: 'Newer goal' } } });
    let res = await app.inject({ method: 'PUT', url, payload: { formatLabels: { 'instagram-post-1x1@2': 'Summer', 'web-banner-300x250': 'Banner' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().brief).toMatchObject({ goal: 'Newer goal', formats: three.formats, formatLabels: { 'instagram-post-1x1@2': 'Summer', 'web-banner-300x250': 'Banner' } });
    // Reorder.
    res = await app.inject({ method: 'PUT', url, payload: { formats: ['web-banner-300x250', 'instagram-post-1x1', 'instagram-post-1x1@2'] } });
    expect(res.json().brief.formats).toEqual(['web-banner-300x250', 'instagram-post-1x1', 'instagram-post-1x1@2']);
    expect(res.json().brief.goal).toBe('Newer goal');
    // Removal prunes the labels of the removed format (no 400), and sends labels in the same save too.
    res = await app.inject({ method: 'PUT', url, payload: { formats: ['instagram-post-1x1', 'web-banner-300x250'], formatLabels: { 'web-banner-300x250': 'B2' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().brief.formats).toEqual(['instagram-post-1x1', 'web-banner-300x250']);
    expect(res.json().brief.formatLabels).toEqual({ 'web-banner-300x250': 'B2' });
    // Removal alone drops the stored label of the format that goes.
    res = await app.inject({ method: 'PUT', url, payload: { formats: ['instagram-post-1x1'] } });
    expect(res.json().brief.formatLabels).toBeUndefined();
    // Refused: adding, duplicates, empty, an odd id, a label too long; a label for a format not in the brief is dropped.
    for (const formats of [['instagram-post-1x1', 'web-banner-300x250'], ['instagram-post-1x1', 'instagram-post-1x1'], [], ['Bad Id']]) {
      expect((await app.inject({ method: 'PUT', url, payload: { formats } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'PUT', url, payload: { formatLabels: { 'instagram-post-1x1': 'x'.repeat(61) } } })).statusCode).toBe(400);
    res = await app.inject({ method: 'PUT', url, payload: { formatLabels: { 'web-banner-300x250': 'gone', 'instagram-post-1x1': 'Main' } } });
    expect(res.json().brief.formatLabels).toEqual({ 'instagram-post-1x1': 'Main' });
    // Labels merge per key: a key left out is kept (a stale tab cannot drop a newer label); '' or null clears that key only.
    await app.inject({ method: 'PUT', url, payload: { formatLabels: { 'instagram-post-1x1': 'Newer' } } });
    res = await app.inject({ method: 'PUT', url, payload: { formatLabels: {} } });
    expect(res.json().brief.formatLabels).toEqual({ 'instagram-post-1x1': 'Newer' });
    res = await app.inject({ method: 'PUT', url, payload: { formatLabels: { 'instagram-post-1x1@2': 'Other' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().brief.formatLabels).toEqual({ 'instagram-post-1x1': 'Newer' });
    res = await app.inject({ method: 'PUT', url, payload: { formatLabels: { 'instagram-post-1x1': null } } });
    expect(res.json().brief.formatLabels).toBeUndefined();
    await app.inject({ method: 'PUT', url, payload: { formatLabels: { 'instagram-post-1x1': 'Again' } } });
    res = await app.inject({ method: 'PUT', url, payload: { formatLabels: { 'instagram-post-1x1': '' } } });
    expect(res.json().brief.formatLabels).toBeUndefined();
  });
  it('a full brief together with formats or labels is refused, not half ignored', async () => {
    const { slug } = await createCreative(false);
    const url = `/api/projects/acme/creatives/${slug}`;
    expect((await app.inject({ method: 'PUT', url, payload: { brief, formats: ['instagram-post-1x1'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url, payload: { brief, formatLabels: { 'instagram-post-1x1': 'x' } } })).statusCode).toBe(400);
  });
  it('a legacy odd format id stored in a brief can be removed through the partial path', async () => {
    const { slug } = await createCreative(false);
    const file = join(base, 'ws', 'acme', 'creatives', slug, 'creative.json');
    const c = JSON.parse(await readFile(file, 'utf8'));
    c.brief.formats = ['instagram-post-1x1', 'Old_One', 'Old_Two'];
    await writeFile(file, JSON.stringify(c));
    const url = `/api/projects/acme/creatives/${slug}`;
    const res = await app.inject({ method: 'PUT', url, payload: { formats: ['instagram-post-1x1', 'Old_Two'] } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().brief.formats).toEqual(['instagram-post-1x1', 'Old_Two']);
  });
  it('a full brief save with labels of formats it removes prunes them instead of answering 400 (Ruling H)', async () => {
    const { slug } = await createCreative(false);
    const url = `/api/projects/acme/creatives/${slug}`;
    const res = await app.inject({ method: 'PUT', url, payload: { brief: { ...brief, formatLabels: { 'instagram-post-1x1': 'A', 'tiktok-9x16': 'gone' } } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().brief.formatLabels).toEqual({ 'instagram-post-1x1': 'A' });
  });
  it('restores a version and reveals its folder', async () => {
    const { slug } = await createCreative();
    await waitJobs();
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/restore` });
    expect(r.json().resumeFrom).toMatchObject({ version: 1 });
    expect((await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/reveal` })).json()).toEqual({ ok: true });
    expect(opened[0]).toMatch(/outputs[/\\]v1$/);
    expect((await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/9/reveal` })).statusCode).toBe(404);
  });
});

describe('reveal safety', { timeout: 90_000 }, () => {
  it('refuses a symlinked version folder or outputs folder', async () => {
    const { slug } = await createCreative();
    await waitJobs();
    const cdir = join(base, 'ws', 'acme', 'creatives', slug);
    const outside = await mkdtemp(join(tmpdir(), 'ms-reveal-out-'));
    await symlink(outside, join(cdir, 'outputs', 'v5'));
    expect((await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/5/reveal` })).statusCode).toBe(404);
    await rm(join(cdir, 'outputs'), { recursive: true });
    await mkdir(join(outside, 'v1'));
    await symlink(outside, join(cdir, 'outputs'));
    expect((await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/reveal` })).statusCode).toBe(404);
    expect(opened).toEqual([]);
  });
});

describe('file serving safety', { timeout: 90_000 }, () => {
  it('refuses traversal, non-output paths and symlinks', async () => {
    const { slug } = await createCreative();
    await waitJobs();
    const dir = join(base, 'ws', 'acme', 'creatives', slug);
    await symlink('/etc/hosts', join(dir, 'outputs', 'v1', 'leak.txt'));
    const files = `/api/projects/acme/creatives/${slug}/files/`;
    for (const p of ['creative.json', 'outputs/../creative.json', 'outputs/%2e%2e/creative.json', '..%2f..%2fproject.json', 'outputs/v1/leak.txt', 'work/scene.txt']) {
      expect((await app.inject(files + p)).statusCode, p).toBe(404);
    }
  });
});

describe('file route confinement', { timeout: 90_000 }, () => {
  it.skipIf(process.platform === 'win32')('refuses symlinked directories and serves .feedback with sandbox headers', async () => {
    const { slug } = await createCreative();
    await waitJobs();
    const dir = join(base, 'ws', 'acme', 'creatives', slug);
    await mkdir(join(dir, 'work', '.feedback'), { recursive: true });
    await writeFile(join(dir, 'work', '.feedback', 'ok.txt'), 'ok');
    await writeFile(join(dir, 'work', 'secret.txt'), 'secret');
    await symlink('..', join(dir, 'outputs', 'v2'));
    const files = `/api/projects/acme/creatives/${slug}/files/`;
    expect((await app.inject(files + 'outputs/v2/creative.json')).statusCode).toBe(404);
    expect((await app.inject(files + 'outputs/v2/work/secret.txt')).statusCode).toBe(404);
    const ok = await app.inject(files + 'work/.feedback/ok.txt');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-security-policy']).toBe('sandbox');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    await rm(join(dir, 'work', '.feedback'), { recursive: true });
    await symlink('.', join(dir, 'work', '.feedback'));
    expect((await app.inject(files + 'work/.feedback/secret.txt')).statusCode).toBe(404);
  });
});

describe('startup recovery', { timeout: 90_000 }, () => {
  it('marks creatives left in working as interrupted', async () => {
    const { slug } = await createCreative(false);
    const file = join(base, 'ws', 'acme', 'creatives', slug, 'creative.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('"draft"', '"working"'));
    await app.close();
    app = await build();
    expect((await app.inject(`/api/projects/acme/creatives/${slug}`)).json().creative.status).toBe('interrupted');
  });
});

describe('recoverWorkspace', { timeout: 90_000 }, () => {
  it('sweeps leftovers and completes the .gitignore of existing projects', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    const dir = ws.projectDir('acme');
    await writeFile(join(dir, '.gitignore'), 'outputs/\n');
    const old = new Date(Date.now() - 2 * 3600_000);
    for (const f of ['assets/.old.part', 'references/.old.part']) { await writeFile(join(dir, f), 'x'); await utimes(join(dir, f), old, old); }
    await writeFile(join(dir, 'assets', '.fresh.part'), 'x');
    await mkdir(join(dir, 'brand', 'proposals', 'p-20260101-000000'), { recursive: true });
    await mkdir(join(dir, 'brand', 'proposals', 'p-20260101-000001'), { recursive: true });
    await writeFile(join(dir, 'brand', 'proposals', 'p-20260101-000001', 'proposal.json'), '{}');
    await mkdir(join(dir, 'assets', '.describe'), { recursive: true });
    await writeFile(join(dir, 'assets', '.describe', 'job.json'), '[]');
    await recoverWorkspace(ws);
    expect((await readdir(join(dir, 'assets'))).sort()).toEqual(['.describe', '.fresh.part', '.gitkeep']);
    expect(await readdir(join(dir, 'assets', '.describe'))).toEqual([]);
    expect(await readdir(join(dir, 'references'))).toEqual(['.gitkeep']);
    expect(await readdir(join(dir, 'brand', 'proposals'))).toEqual(['p-20260101-000001']);
    expect((await readFile(join(dir, '.gitignore'), 'utf8')).split('\n')).toEqual(['outputs/', '.*.part', 'assets/.describe/', '.cache/', 'creatives/*/work/tmp/', '.studio/cache/', '']);
    await recoverWorkspace(ws);
    expect((await readFile(join(dir, '.gitignore'), 'utf8')).split('\n')).toEqual(['outputs/', '.*.part', 'assets/.describe/', '.cache/', 'creatives/*/work/tmp/', '.studio/cache/', '']);
    // Older projects also get the union merge for the usage ledger, once.
    expect(await readFile(join(dir, '.gitattributes'), 'utf8')).toBe('.studio/usage.jsonl merge=union\n');
  });
  it('appends the ledger merge rule to an existing .gitattributes, once, keeping its lines', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    const dir = ws.projectDir('acme');
    await writeFile(join(dir, '.gitattributes'), '*.png binary');
    await recoverWorkspace(ws);
    await recoverWorkspace(ws);
    expect(await readFile(join(dir, '.gitattributes'), 'utf8')).toBe('*.png binary\n.studio/usage.jsonl merge=union\n');
  });
  it('leaves brand job files alone while a brand job runs', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    const dir = ws.projectDir('acme');
    await mkdir(join(dir, 'brand', 'proposals', 'p-20260101-000000'), { recursive: true });
    await recoverWorkspace(ws, (key) => key.startsWith('brand:'));
    expect(await readdir(join(dir, 'brand', 'proposals'))).toEqual(['p-20260101-000000']);
  });
  it('warns with the project slug when a project cannot be recovered, and goes on', async () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((m: string) => { warnings.push(m); });
    const original = CreativeStore.prototype.recoverInterrupted;
    const seen: string[] = [];
    CreativeStore.prototype.recoverInterrupted = async function (this: CreativeStore) {
      const dir = (this as unknown as { projectDir: string }).projectDir;
      seen.push(dir);
      if (dir.endsWith('rotto')) throw new Error('permesso negato');
      return [];
    };
    const ws = {
      root: '/ws',
      listProjects: async () => [{ ok: true, slug: 'rotto' }, { ok: true, slug: 'sano' }],
      projectDir: (slug: string) => `/ws/${slug}`,
    } as unknown as WorkspaceStore;
    try {
      await recoverWorkspace(ws);
    } finally {
      CreativeStore.prototype.recoverInterrupted = original;
      warn.mockRestore();
    }
    expect(seen).toEqual(['/ws/rotto', '/ws/sano']);
    expect(warnings).toEqual([expect.stringContaining('in project rotto: permesso negato')]);
  });
});

describe('M3: logo concepts on create (decision 786)', { timeout: 90_000 }, () => {
  const create = (formats: string[], identity?: unknown) => app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'L', brief: { ...brief, formats, ...(identity ? { identity } : {}) } } });
  it('a logo from scratch gets one instance per concept; the UI body (already expanded) is left as it is', async () => {
    const a = await create(['identity-logo', 'identity-favicon'], { start: 'scratch', name: 'Acme', concepts: 3 });
    expect(a.statusCode).toBe(201);
    expect(a.json().creative.brief.formats).toEqual(['identity-logo', 'identity-logo@2', 'identity-logo@3', 'identity-favicon']);
    const b = await create(['identity-logo', 'identity-logo@2', 'identity-logo@3', 'identity-favicon'], { start: 'scratch', name: 'Acme', concepts: 3 });
    expect(b.json().creative.brief.formats).toEqual(['identity-logo', 'identity-logo@2', 'identity-logo@3', 'identity-favicon']);
    // The default is 3 concepts; a gap is filled first.
    const c = await create(['identity-logo@3'], { start: 'scratch', name: 'Acme' });
    expect(c.json().creative.brief.formats).toEqual(['identity-logo@3', 'identity-logo', 'identity-logo@2']);
  });
  it('from the brand logo, or without a logo format, nothing is added', async () => {
    expect((await create(['identity-logo'], { start: 'brand' })).json().creative.brief.formats).toEqual(['identity-logo']);
    expect((await create(['identity-favicon'], { start: 'scratch', name: 'Acme', concepts: 4 })).json().creative.brief.formats).toEqual(['identity-favicon']);
  });
});

describe('creative linked codebases', { timeout: 90_000 }, () => {
  it('accepts and normalizes linkedCodebases on create and edit', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'C', brief, linkedCodebases: [{ path: '/tmp/app/' }] } });
    expect(res.json().creative.linkedCodebases).toEqual([{ path: '/tmp/app' }]);
    const bad = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${res.json().slug}`, payload: { linkedCodebases: [{ path: 'rel' }] } });
    expect(bad.statusCode).toBe(400);
  });
  it('refuses codebases overlapping the project or the workspace', async () => {
    const ws = join(base, 'ws');
    const res = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'C', brief, linkedCodebases: [{ path: join(ws, 'acme') }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(join(ws, 'acme'));
    const ok = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'C', brief } });
    const edit = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${ok.json().slug}`, payload: { linkedCodebases: [{ path: base }] } });
    expect(edit.statusCode).toBe(400);
    expect(edit.json().error).toContain(base);
  });
  it('decision 781: refuses folders with glob characters, and a plain-named link to one, on every linking route', async () => {
    const holder = join(base, 'holder');
    await mkdir(holder, { recursive: true });
    for (const name of ['cb (x) [y]', 'a[1]', 'b{c}', 'star*', 'q?', 'back\\slash', 'p (x)']) await mkdir(join(holder, name));
    await symlink(join(holder, 'cb (x) [y]'), join(holder, 'alias'));
    await mkdir(join(holder, 'plain'));
    const bad = [...['cb (x) [y]', 'a[1]', 'b{c}', 'star*', 'q?', 'back\\slash', 'p (x)'].map((n) => join(holder, n)), join(holder, 'alias'), join(holder, 'missing (old)')];
    const ok = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'C', brief } });
    for (const path of bad) {
      const routes = [
        app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'C', brief, linkedCodebases: [{ path: join(holder, 'plain') }, { path }] } }),
        app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${ok.json().slug}`, payload: { linkedCodebases: [{ path }] } }),
        app.inject({ method: 'PUT', url: '/api/projects/acme', payload: { linkedCodebases: [{ path }] } }),
      ];
      for (const r of await Promise.all(routes)) {
        expect(r.statusCode, path).toBe(400);
        expect(r.json().code, path).toBe('codebase-glob-chars');
        expect(r.json().error, path).toContain('( ) [ ] { } * ?');
        expect(r.json().error, path).toContain(path);
      }
    }
    // Nothing was stored, and a clean folder still links.
    expect((await app.inject('/api/projects/acme')).json().project.linkedCodebases).toEqual([]);
    expect((await app.inject({ method: 'PUT', url: '/api/projects/acme', payload: { linkedCodebases: [{ path: join(holder, 'plain') }] } })).statusCode).toBe(200);
  });
  it('decision 788: a legacy glob path already stored does not block other edits; a new one is refused naming it', async () => {
    const holder = join(base, 'legacy');
    for (const name of ['old (x) [y]', 'new [z]', 'clean']) await mkdir(join(holder, name), { recursive: true });
    const legacy = join(holder, 'old (x) [y]');
    const fresh = join(holder, 'new [z]');
    const clean = join(holder, 'clean');
    // Stored before the check existed, behind the API's back.
    const created = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'C', brief } });
    const slug = created.json().slug as string;
    const ws = join(base, 'ws', 'acme');
    await new CreativeStore(ws).update(slug, { linkedCodebases: [{ path: legacy }] });
    const pj = JSON.parse(await readFile(join(ws, 'project.json'), 'utf8'));
    await writeFile(join(ws, 'project.json'), JSON.stringify({ ...pj, linkedCodebases: [{ path: legacy }] }));
    // The brief (goal only) and the codebases list as the UI sends it back (also another spelling of the stored path).
    const goal = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, payload: { brief: { ...brief, goal: 'Nuovo obiettivo' }, linkedCodebases: [{ path: `${legacy}/` }] } });
    expect(goal.statusCode, goal.body).toBe(200);
    expect(goal.json().brief.goal).toBe('Nuovo obiettivo');
    const proj = await app.inject({ method: 'PUT', url: '/api/projects/acme', payload: { linkedCodebases: [{ path: legacy }, { path: clean }] } });
    expect(proj.statusCode, proj.body).toBe(200);
    expect((await app.inject('/api/projects/acme')).json().project.linkedCodebases).toEqual([{ path: legacy }, { path: clean }]);
    // A new glob path is refused on both, and the message names it.
    for (const r of [
      await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, payload: { linkedCodebases: [{ path: legacy }, { path: fresh }] } }),
      await app.inject({ method: 'PUT', url: '/api/projects/acme', payload: { linkedCodebases: [{ path: legacy }, { path: clean }, { path: fresh }] } }),
    ]) {
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe('codebase-glob-chars');
      expect(r.json().error).toContain(fresh);
    }
    // Creative create checks every path: the legacy one is new there.
    const again = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'C', brief, linkedCodebases: [{ path: legacy }] } });
    expect(again.json().code).toBe('codebase-glob-chars');
    expect(again.json().error).toContain(legacy);
  });
});

describe('decision 792: overlap check only on new or changed codebase paths', { timeout: 60_000 }, () => {
  it('a stored overlapping entry does not block the brief or project saves; a new one is refused naming it', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'C', brief } });
    const slug = created.json().slug as string;
    const ws = join(base, 'ws', 'acme');
    const legacy = join(ws, 'assets');
    const clean = join(base, 'plain792');
    await mkdir(clean, { recursive: true });
    await new CreativeStore(ws).update(slug, { linkedCodebases: [{ path: legacy }] });
    const pj = JSON.parse(await readFile(join(ws, 'project.json'), 'utf8'));
    await writeFile(join(ws, 'project.json'), JSON.stringify({ ...pj, linkedCodebases: [{ path: legacy }] }));
    const goal = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, payload: { brief: { ...brief, goal: 'Altro' }, linkedCodebases: [{ path: `${legacy}/` }] } });
    expect(goal.statusCode, goal.body).toBe(200);
    const proj = await app.inject({ method: 'PUT', url: '/api/projects/acme', payload: { linkedCodebases: [{ path: legacy }, { path: clean }] } });
    expect(proj.statusCode, proj.body).toBe(200);
    const fresh = join(ws, 'brand');
    for (const r of [
      await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, payload: { linkedCodebases: [{ path: legacy }, { path: fresh }] } }),
      await app.inject({ method: 'PUT', url: '/api/projects/acme', payload: { linkedCodebases: [{ path: legacy }, { path: clean }, { path: fresh }] } }),
    ]) {
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toContain(fresh);
    }
    // Creating a creative checks everything: the legacy entry is new there.
    const again = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'C', brief, linkedCodebases: [{ path: legacy }] } });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toContain(legacy);
  });
});

describe('creative export', { timeout: 90_000 }, () => {
  it('exports a version to a folder outside the workspace and validates input', async () => {
    const { slug } = await createCreative();
    await waitJobs();
    const url = (n: number) => `/api/projects/acme/creatives/${slug}/versions/${n}/export`;
    const dest = join(base, 'consegna');
    const ok = await app.inject({ method: 'POST', url: url(1), payload: { destination: dest } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().files).toHaveLength(2);
    expect((await readdir(dest)).length).toBe(2);
    expect((await app.inject({ method: 'POST', url: url(9), payload: { destination: dest } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: url(1), payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: url(1), payload: { destination: dest, formats: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: url(1), payload: { destination: dest, formats: ['nope'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: url(1), payload: { destination: dest, formats: 'x' } })).statusCode).toBe(400);
    const inside = await app.inject({ method: 'POST', url: url(1), payload: { destination: join(base, 'ws', 'acme', 'out') } });
    expect(inside.statusCode).toBe(400);
    expect(inside.json().error).toBe('Scegli una cartella fuori dal workspace di Motion Studio');
  });
  it('names the files after the creative title in the destination, without overwriting (route level)', async () => {
    const { slug } = await createCreative();
    await waitJobs();
    const renamed = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, payload: { title: 'Autumn Sourdough Launch!' } });
    expect(renamed.statusCode).toBe(200);
    const url = `/api/projects/acme/creatives/${slug}/versions/1/export`;
    const dest = join(base, 'delivery');
    // The extension is the output's own (the fake agent decides it).
    const out = ((await app.inject(`/api/projects/acme/creatives/${slug}`)).json().versions[0].outputs as Array<{ format: string; file: string }>).find((o) => o.format === 'instagram-post-1x1')!;
    const ext = out.file.slice(out.file.lastIndexOf('.'));
    const first = await app.inject({ method: 'POST', url, payload: { destination: dest, formats: ['instagram-post-1x1'] } });
    expect(first.statusCode).toBe(200);
    const [file] = first.json().files as Array<{ to: string }>;
    expect(file!.to).toBe(join(dest, `autumn-sourdough-launch-instagram-post-1x1-v1${ext}`));
    expect(await readdir(dest)).toEqual([`autumn-sourdough-launch-instagram-post-1x1-v1${ext}`]);
    // The same export again: a second copy with -2, the first one untouched.
    const again = await app.inject({ method: 'POST', url, payload: { destination: dest, formats: ['instagram-post-1x1'] } });
    expect((again.json().files as Array<{ to: string }>)[0]!.to).toBe(join(dest, `autumn-sourdough-launch-instagram-post-1x1-v1-2${ext}`));
    expect((await readdir(dest)).sort()).toEqual([`autumn-sourdough-launch-instagram-post-1x1-v1-2${ext}`, `autumn-sourdough-launch-instagram-post-1x1-v1${ext}`].sort());
  });
  it('exports per-format picks with the workspace name pattern (or the one sent)', async () => {
    const { slug } = await createCreative();
    await waitJobs();
    const url = `/api/projects/acme/creatives/${slug}/export`;
    const dest = join(base, 'picks');
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { exportNamePattern: '{channel}_{title}_v{v}' } });
    const r = await app.inject({ method: 'POST', url, payload: { destination: dest, picks: { 'instagram-post-1x1': 1 } } });
    expect(r.statusCode).toBe(200);
    expect(await readdir(dest)).toEqual(['instagram_lancio_v1.mp4']);
    const sent = await app.inject({ method: 'POST', url, payload: { destination: dest, picks: { 'web-banner-300x250': 1 }, pattern: 'x-{format}' } });
    expect((sent.json().files as Array<{ to: string }>)[0]!.to.split('/').pop()).toMatch(/^x-web-banner-300x250\./);
    const bad = async (payload: object) => { const x = await app.inject({ method: 'POST', url, payload: { destination: dest, ...payload } }); return [x.statusCode, x.json().code]; };
    expect(await bad({ picks: {} })).toEqual([400, 'export-invalid-picks']);
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f${i}`, 1]));
    expect(await bad({ picks: many })).toEqual([400, 'export-invalid-picks']);
    expect(await bad({ picks: { 'instagram-post-1x1': 1 }, date: '2026-13-01' })).toEqual([400, 'export-invalid-date']);
    for (const destination of [undefined, '', '   ', 42]) {
      const x = await app.inject({ method: 'POST', url, payload: { destination, picks: { 'instagram-post-1x1': 1 } } });
      expect([x.statusCode, x.json().code]).toEqual([400, 'export-invalid-destination']);
    }
    expect(await bad({ destination: 'relative/dir', picks: { 'instagram-post-1x1': 1 } })).toEqual([400, 'export-invalid-destination']);
    expect(await bad({ picks: { 'instagram-post-1x1': 'v1' } })).toEqual([400, 'export-invalid-picks']);
    expect(await bad({ picks: { 'instagram-post-1x1': 7 } })).toEqual([400, 'export-pick-no-file']);
    expect(await bad({ picks: { 'instagram-post-1x1': 1 }, pattern: 42 })).toEqual([400, 'export-invalid-pattern']);
    expect(await bad({ picks: { 'instagram-post-1x1': 1 }, pattern: '{nope}' })).toEqual([400, 'export-name-empty']);
    await rm(join(base, 'ws', 'acme', 'creatives', slug, 'outputs', 'v1', (await readdir(join(base, 'ws', 'acme', 'creatives', slug, 'outputs', 'v1'))).find((f) => f.startsWith('web-banner'))!));
    expect(await bad({ picks: { 'instagram-post-1x1': 1, 'web-banner-300x250': 1 } })).toEqual([409, 'export-file-missing']);
    expect((await readdir(dest)).length).toBe(2);
  });
  it('refuses colliding names at the server, before copying', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Lancio', brief: { ...brief, formats: ['instagram-post-1x1', 'instagram-reel-9x16'] }, generate: true } })).json();
    await waitJobs();
    const dest = join(base, 'collide');
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${created.slug}/export`,
      payload: { destination: dest, picks: { 'instagram-post-1x1': 1, 'instagram-reel-9x16': 1 }, pattern: '{title}-v{v}' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('export-name-collision');
    expect(r.json().error).toContain('lancio-v1.mp4');
    await expect(readdir(dest)).rejects.toThrow();
  });
  it('accepts the older single-version payload: every output of that version', async () => {
    const { slug } = await createCreative();
    await waitJobs();
    const dest = join(base, 'old');
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, payload: { destination: dest, version: 1 } });
    expect(r.statusCode).toBe(200);
    expect((await readdir(dest)).sort().map((f) => f.replace(/\.[a-z0-9]+$/, ''))).toEqual(['lancio-instagram-post-1x1-v1', 'lancio-web-banner-300x250-v1']);
    expect((await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, payload: { destination: dest, version: 9 } })).statusCode).toBe(404);
    // A pattern (and the previewed date) apply to the older payload too.
    const named = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, payload: { destination: join(base, 'old2'), version: 1, pattern: '{date}_{channel}', date: '2026-01-02' } });
    expect(named.statusCode).toBe(200);
    expect((await readdir(join(base, 'old2'))).sort().map((f) => f.replace(/\.[a-z0-9]+$/, ''))).toEqual(['2026-01-02_instagram', '2026-01-02_web']);
  });
  it('requires the UI token', async () => {
    const guarded = await buildServer({ agentContract: 'media', uiToken: 'ab'.repeat(32), sandbox: async () => ({ available: false, reason: 'test' }),
      appConfig: new AppConfigStore(join(base, 'config2')), git: new Git(), doctor: async () => [],
      runner: new ClaudeCodeRunner([process.execPath, FAKE]) });
    const r = await guarded.inject({ method: 'POST', url: '/api/projects/acme/creatives/x/versions/1/export', payload: { destination: join(base, 'out') } });
    await guarded.close();
    expect(r.statusCode).toBe(401);
  });
});

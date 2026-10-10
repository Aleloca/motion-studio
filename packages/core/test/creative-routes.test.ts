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

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const brief = { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1', 'web-banner-300x250'], durationSec: 10, assets: [], notes: '' };
let app: FastifyInstance;
let base: string;
let opened: string[];

const build = () => buildServer({ uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
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

describe('formats', { timeout: 20_000 }, () => {
  it('serves, validates and resets the catalog', async () => {
    const s = (await app.inject('/api/formats')).json();
    expect(s.presets.length).toBeGreaterThan(30);
    expect((await app.inject({ method: 'PUT', url: '/api/formats', payload: { presets: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/formats', payload: { presets: [s.presets[0]] } })).json().presets).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: '/api/formats/reset' })).json().presets.length).toBe(s.presets.length);
  });
});

describe('creatives', { timeout: 20_000 }, () => {
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

describe('reveal safety', { timeout: 20_000 }, () => {
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

describe('file serving safety', { timeout: 20_000 }, () => {
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

describe('file route confinement', { timeout: 20_000 }, () => {
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

describe('startup recovery', { timeout: 20_000 }, () => {
  it('marks creatives left in working as interrupted', async () => {
    const { slug } = await createCreative(false);
    const file = join(base, 'ws', 'acme', 'creatives', slug, 'creative.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('"draft"', '"working"'));
    await app.close();
    app = await build();
    expect((await app.inject(`/api/projects/acme/creatives/${slug}`)).json().creative.status).toBe('interrupted');
  });
});

describe('recoverWorkspace', { timeout: 20_000 }, () => {
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

describe('creative linked codebases', { timeout: 20_000 }, () => {
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
    expect(res.json().error).toBe('La cartella collegata non può contenere il progetto né trovarsi al suo interno');
    const ok = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'C', brief } });
    const edit = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${ok.json().slug}`, payload: { linkedCodebases: [{ path: base }] } });
    expect(edit.statusCode).toBe(400);
    expect(edit.json().error).toBe('La cartella collegata non può contenere il progetto né trovarsi al suo interno');
  });
});

describe('creative export', { timeout: 20_000 }, () => {
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
  });
  it('requires the UI token', async () => {
    const guarded = await buildServer({ uiToken: 'ab'.repeat(32), sandbox: async () => ({ available: false, reason: 'test' }),
      appConfig: new AppConfigStore(join(base, 'config2')), git: new Git(), doctor: async () => [],
      runner: new ClaudeCodeRunner([process.execPath, FAKE]) });
    const r = await guarded.inject({ method: 'POST', url: '/api/projects/acme/creatives/x/versions/1/export', payload: { destination: join(base, 'out') } });
    await guarded.close();
    expect(r.statusCode).toBe(401);
  });
});

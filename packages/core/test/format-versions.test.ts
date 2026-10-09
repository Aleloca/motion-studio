import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_FORMATS, messages, type Brief, type FormatSummary, type OutputFileInfo, type VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { CreativeTurnService, type CreativeRef } from '../src/creatives/creative-turns.ts';
import { clearHashMemory, hashCachePath, withLazyHashes } from '../src/creatives/output-hashes.ts';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { buildServer } from '../src/server/app.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';
import { testLauncher } from './helpers/launcher.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const REEL = 'instagram-reel-9x16';
const TIKTOK = 'tiktok-9x16';
const SHORTS = 'youtube-shorts-9x16';
const POST = 'instagram-post-1x1';

afterEach(() => { delete process.env.FAKE_CLAUDE_SCENARIO; clearHashMemory(); vi.restoreAllMocks(); });

const output = (format: string, file: string, durationSec: number | null = 20): OutputFileInfo =>
  ({ format, file, width: 1080, height: format === POST ? 1080 : 1920, durationSec, verified: true, preview: null });
const version = (n: number, outputs: OutputFileInfo[], problems: string[] = []): VersionEntry => ({
  n, commit: null, sessionId: null, status: problems.length ? 'incomplete' : 'complete', createdAt: '2026-10-09T10:00:00.000Z',
  request: `v${n}`, outputs, problems, tools: [], renderCommand: null, basedOn: n > 1 ? n - 1 : null,
});

describe('hashes recorded with a new version', { timeout: 20_000 }, () => {
  it('stores the sha256 of every output, computed by the core from the files', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ms-fv-turn-'));
    const git = new Git();
    const ws = await WorkspaceStore.open(join(base, 'ws'), git);
    const { slug } = await ws.createProject({ name: 'Acme' });
    const projectDir = ws.projectDir(slug);
    const store = new CreativeStore(projectDir);
    const brief: Brief = { goal: 'Lancio', message: '', formats: ['instagram-post-1x1', 'web-banner-300x250'], durationSec: 10, assets: [], notes: '' };
    const created = await store.create({ title: 'Lancio', brief });
    const ref: CreativeRef = { root: ws.root, projectSlug: slug, projectDir, creativeSlug: created.slug };
    const queue = new JobQueue({ concurrency: 1 });
    const service = new CreativeTurnService({
      queue, git, media: NoMediaTools, vault: new MemoryVault(),
      launcher: testLauncher(new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 })),
      presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {},
    });
    process.env.FAKE_CLAUDE_SCENARIO = 'render';
    await service.start(ref);
    await queue.whenIdle();
    const [v1] = await store.readVersions(created.slug);
    expect(v1!.outputs).toHaveLength(2);
    for (const o of v1!.outputs) {
      expect(o.sha256).toBe(sha(await readFile(join(store.outputsDir(created.slug, 1), o.file))));
    }
  });
});

describe('lazy hashes of old versions', () => {
  let projectDir: string;
  let store: CreativeStore;
  let slug: string;
  const files = { [`${REEL}.mp4`]: 'reel-v1', [`${POST}.mp4`]: 'post-v1' };

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'ms-fv-lazy-'));
    store = new CreativeStore(projectDir);
    slug = (await store.create({ title: 'Old', brief: { goal: 'x', message: '', formats: [REEL, POST], durationSec: null, assets: [], notes: '' } })).slug;
    await mkdir(store.outputsDir(slug, 1), { recursive: true });
    for (const [f, c] of Object.entries(files)) await writeFile(join(store.outputsDir(slug, 1), f), c);
    await store.appendVersion(slug, version(1, [output(REEL, `${REEL}.mp4`), output(POST, `${POST}.mp4`)]));
  });
  const lazy = async (budgetMs = 10_000, onBackgroundDone?: () => void) => withLazyHashes({
    projectDir, creativeSlug: slug, creativeDir: store.dir(slug), versions: await store.readVersions(slug), budgetMs, onBackgroundDone,
  });

  it('fills the missing hashes, writes the cache outside outputs/ and never rewrites versions.json', async () => {
    const before = await readFile(join(store.dir(slug), 'versions.json'), 'utf8');
    const [v1] = await lazy();
    expect(v1!.outputs.map((o) => o.sha256)).toEqual([sha('reel-v1'), sha('post-v1')]);
    const cache = JSON.parse(await readFile(hashCachePath(projectDir, slug, 1), 'utf8'));
    expect(hashCachePath(projectDir, slug, 1)).toBe(join(projectDir, '.studio', 'cache', 'hashes', slug, 'v1.json'));
    expect(cache.files[`${REEL}.mp4`]).toMatchObject({ sha256: sha('reel-v1'), size: 7 });
    expect(await readFile(join(store.dir(slug), 'versions.json'), 'utf8')).toBe(before);
  });

  it('reuses the cache while name, size and mtime match, and recomputes otherwise', async () => {
    await lazy();
    clearHashMemory();
    const path = hashCachePath(projectDir, slug, 1);
    const cache = JSON.parse(await readFile(path, 'utf8'));
    cache.files[`${REEL}.mp4`].sha256 = 'f'.repeat(64);
    await writeFile(path, JSON.stringify(cache));
    expect((await lazy())[0]!.outputs[0]!.sha256).toBe('f'.repeat(64));
    clearHashMemory();
    await utimes(join(store.outputsDir(slug, 1), `${REEL}.mp4`), new Date(), new Date(Date.now() - 60_000));
    expect((await lazy())[0]!.outputs[0]!.sha256).toBe(sha('reel-v1'));
  });

  it('recomputes on a corrupt cache file instead of failing', async () => {
    await mkdir(join(projectDir, '.studio', 'cache', 'hashes', slug), { recursive: true });
    await writeFile(hashCachePath(projectDir, slug, 1), '{oops');
    expect((await lazy())[0]!.outputs[0]!.sha256).toBe(sha('reel-v1'));
    expect(JSON.parse(await readFile(hashCachePath(projectDir, slug, 1), 'utf8')).files[`${REEL}.mp4`].sha256).toBe(sha('reel-v1'));
  });

  it('leaves the hash absent for a missing file, a symlink or a hard-linked file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await rm(join(store.outputsDir(slug, 1), `${REEL}.mp4`));
    const [v1] = await lazy();
    expect('sha256' in v1!.outputs[0]!).toBe(false);
    expect(v1!.outputs[1]!.sha256).toBe(sha('post-v1'));

    const outside = join(projectDir, 'secret.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, join(store.outputsDir(slug, 1), `${REEL}.mp4`));
    clearHashMemory();
    expect('sha256' in (await lazy())[0]!.outputs[0]!).toBe(false);
    await rm(join(store.outputsDir(slug, 1), `${REEL}.mp4`));
    await link(outside, join(store.outputsDir(slug, 1), `${REEL}.mp4`));
    clearHashMemory();
    expect('sha256' in (await lazy())[0]!.outputs[0]!).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('does not wait past the budget: the rest is filled in the background', async () => {
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });
    const [v1] = await lazy(0, () => done());
    expect(v1!.outputs.every((o) => o.sha256 === undefined)).toBe(true);
    await finished;
    expect((await lazy())[0]!.outputs.map((o) => o.sha256)).toEqual([sha('reel-v1'), sha('post-v1')]);
  });
});

describe('format routes', { timeout: 20_000 }, () => {
  let app: FastifyInstance;
  let base: string;
  let projectDir: string;
  let slug: string;
  let url: string;
  const brief = { goal: 'Lancio', message: '', formats: [REEL, TIKTOK, SHORTS, POST], durationSec: null, assets: [], notes: '' };

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ms-fv-routes-'));
    app = await buildServer({
      uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
      appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
      runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [],
    });
    await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    projectDir = join(base, 'ws', 'acme');
    const created = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Lancio', brief, generate: false } });
    slug = created.json().slug;
    url = `/api/projects/acme/creatives/${slug}`;
  });
  afterEach(async () => { await app.close(); });

  /** v1: reel; v2: reel changed + post; v3: reel same as v2, post changed, version with problems. */
  const seed = async (reelDuration = 20) => {
    const store = new CreativeStore(projectDir);
    const put = async (n: number, contents: Record<string, string>) => {
      await mkdir(store.outputsDir(slug, n), { recursive: true });
      for (const [f, c] of Object.entries(contents)) await writeFile(join(store.outputsDir(slug, n), f), c);
    };
    await put(1, { 'reel.mp4': 'reel-a' });
    await put(2, { 'reel.mp4': 'reel-b', 'post.mp4': 'post-a' });
    await put(3, { 'reel.mp4': 'reel-b', 'post.mp4': 'post-b' });
    await store.appendVersion(slug, version(1, [output(REEL, 'reel.mp4', reelDuration)]));
    await store.appendVersion(slug, version(2, [output(REEL, 'reel.mp4', reelDuration), output(POST, 'post.mp4')]));
    await store.appendVersion(slug, version(3, [output(REEL, 'reel.mp4', reelDuration), output(POST, 'post.mp4')], ['problema']));
    return store;
  };
  const summary = async (): Promise<FormatSummary[]> => (await app.inject(url)).json().formats;
  const of = (s: FormatSummary[], id: string) => s.find((f) => f.id === id)!;
  const pick = (format: string, v: number | null) => app.inject({ method: 'PUT', url: `${url}/export-picks`, payload: { format, version: v } });
  const linkTo = (follower: string, primary: string | null) => app.inject({ method: 'PUT', url: `${url}/links`, payload: { follower, primary } });

  it('gives new creatives the default links, with the duration still unknown', async () => {
    const creative = (await app.inject(url)).json().creative;
    expect(creative.brief.links).toEqual({ [TIKTOK]: REEL, [SHORTS]: REEL });
  });

  it('summarises history, ★ and linkable primaries per format', async () => {
    await seed();
    const s = await summary();
    expect(s.map((f) => f.id)).toEqual([REEL, TIKTOK, SHORTS, POST]);
    expect(of(s, REEL)).toMatchObject({ history: [1, 2], star: { version: 2, manual: false, follows: null }, starFileMissing: false });
    // v3 has problems: the default ★ of the post is the latest clean one.
    expect(of(s, POST)).toMatchObject({ history: [2, 3], star: { version: 2, manual: false } });
    expect(of(s, TIKTOK).star).toEqual({ version: null, manual: false, newer: null, follows: REEL });
    expect(of(s, SHORTS).linkable).toEqual(expect.arrayContaining([
      { primary: REEL, ok: true }, { primary: TIKTOK, ok: false, reason: 'chain' }, { primary: POST, ok: false, reason: 'size' },
    ]));
    const detail = (await app.inject(url)).json();
    expect(detail.versions[0].outputs[0].sha256).toBe(sha('reel-a'));
    // The hash cache is never versioned.
    await execCommand('git', ['add', '-A'], { cwd: projectDir });
    expect((await execCommand('git', ['status', '--porcelain'], { cwd: projectDir })).stdout).not.toContain('.studio/cache');
  });

  it('stores, keeps and clears export picks', async () => {
    await seed();
    let res = await pick(POST, 3);
    expect(res.statusCode).toBe(200);
    expect(res.json().creative.exportPicks).toEqual({ [POST]: 3 });
    expect(of(res.json().formats, POST).star).toMatchObject({ version: 3, manual: true });
    // Picking what the default rule gives (v2, the latest clean one, not the latest) clears the pick.
    res = await pick(POST, 2);
    expect(res.json().creative.exportPicks ?? {}).toEqual({});
    await pick(REEL, 1);
    expect(of(await summary(), REEL).star).toMatchObject({ version: 1, manual: true, newer: 2 });
    res = await pick(REEL, null);
    expect(res.json().creative.exportPicks ?? {}).toEqual({});
    expect(JSON.parse(await readFile(join(projectDir, 'creatives', slug, 'creative.json'), 'utf8')).exportPicks ?? {}).toEqual({});
  });

  it('refuses invalid picks with stable codes', async () => {
    await seed();
    const cases: Array<[string, number | null, number, string]> = [
      [TIKTOK, 2, 400, 'pick-follower'],
      ['youtube-16x9', 1, 400, 'format-not-in-brief'],
      [POST, 9, 404, 'version-not-found'],
      [POST, 1, 400, 'pick-no-file'],
    ];
    for (const [format, v, status, code] of cases) {
      const res = await pick(format, v);
      expect([format, res.statusCode, res.json().code]).toEqual([format, status, code]);
    }
    expect((await app.inject({ method: 'PUT', url: `${url}/export-picks`, payload: { format: POST, version: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/projects/acme/creatives/2020-01-01-nope/export-picks', payload: { format: POST, version: 1 } })).statusCode).toBe(404);
  });

  it('reports a pick on a file missing on disk', async () => {
    await seed();
    await pick(REEL, 1);
    await rm(join(projectDir, 'creatives', slug, 'outputs', 'v1', 'reel.mp4'));
    expect(of(await summary(), REEL)).toMatchObject({ star: { version: 1, manual: true }, starFileMissing: true });
    await rm(join(projectDir, 'creatives', slug, 'outputs', 'v2', 'post.mp4'));
    const res = await pick(POST, 2);
    expect([res.statusCode, res.json().code]).toEqual([409, 'pick-file-missing']);
  });

  it('links and unlinks formats, refusing self-links, chains and incompatible pairs', async () => {
    let res = await linkTo(SHORTS, null);
    expect(res.statusCode).toBe(200);
    expect(res.json().creative.brief.links).toEqual({ [TIKTOK]: REEL });
    expect(of(res.json().formats, SHORTS).star.follows).toBeNull();
    for (const [follower, primary, code] of [
      [SHORTS, SHORTS, 'link-self'], [SHORTS, TIKTOK, 'link-chain'], [REEL, SHORTS, 'link-chain'],
      [POST, REEL, 'link-incompatible'], ['youtube-16x9', REEL, 'format-not-in-brief'],
    ] as const) {
      res = await linkTo(follower, primary);
      expect([follower, primary, res.statusCode, res.json().code]).toEqual([follower, primary, 400, code]);
    }
    res = await linkTo(SHORTS, REEL);
    expect(res.json().creative.brief.links).toEqual({ [TIKTOK]: REEL, [SHORTS]: REEL });
  });

  it('checks the duration against the primary’s latest render, with a translated reason', async () => {
    await linkTo(SHORTS, null);
    await seed(75);
    const res = await linkTo(SHORTS, REEL);
    expect([res.statusCode, res.json().code]).toEqual([400, 'link-incompatible']);
    expect(res.json().error).toContain(messages('it').errors.followReason.duration);
    expect(of(await summary(), SHORTS).linkable).toContainEqual({ primary: REEL, ok: false, reason: 'duration' });
  });

  it('keeps the links when the brief is saved without them', async () => {
    await linkTo(SHORTS, null);
    const { links: _links, ...noLinks } = (await app.inject(url)).json().creative.brief;
    const res = await app.inject({ method: 'PUT', url, payload: { brief: { ...noLinks, goal: 'Nuovo' } } });
    expect(res.json().brief).toMatchObject({ goal: 'Nuovo', links: { [TIKTOK]: REEL } });
  });

  it('refuses link changes while a generation runs', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const job = (await app.inject({ method: 'POST', url: `${url}/turns`, payload: {} })).json();
    await new Promise((r) => setTimeout(r, 300));
    expect((await linkTo(SHORTS, null)).statusCode).toBe(409);
    await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    for (let i = 0; i < 500; i++) {
      const jobs = (await app.inject('/api/jobs')).json() as Array<{ state: string }>;
      if (jobs.every((j) => j.state !== 'queued' && j.state !== 'running')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  it('refuses unknown creatives and bad bodies', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/projects/acme/creatives/2020-01-01-nope/links', payload: { follower: SHORTS, primary: null } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `${url}/links`, payload: { follower: '' } })).statusCode).toBe(400);
  });
});

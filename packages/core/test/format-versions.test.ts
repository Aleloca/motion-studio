import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_FORMATS, messages, type Brief, type FormatSummary, type OutputFileInfo, type VersionEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { CreativeTurnService, PICK_RETRY_AFTER_SEC, type CreativeRef } from '../src/creatives/creative-turns.ts';
import { clearHashMemory, DEFAULT_HASH_MEMORY_MAX, hashCachePath, hashTesting, hashVersionOutputs, withLazyHashes } from '../src/creatives/output-hashes.ts';
import { hashConfinedFile } from '../src/brand/agent-guard.ts';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { buildServer } from '../src/server/app.ts';
import { CodedError, WorkspaceStore } from '../src/workspace-store.ts';
import { testLauncher } from './helpers/launcher.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const REEL = 'instagram-reel-9x16';
const TIKTOK = 'tiktok-9x16';
const SHORTS = 'youtube-shorts-9x16';
const POST = 'instagram-post-1x1';

afterEach(() => { delete process.env.FAKE_CLAUDE_SCENARIO; clearHashMemory(); hashTesting.setHasher(null); hashTesting.setMemoryMax(DEFAULT_HASH_MEMORY_MAX); vi.restoreAllMocks(); });

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
  const lazy = async (budgetMs = 10_000, onBackgroundDone?: () => void) => (await withLazyHashes({
    projectDir, creativeSlug: slug, creativeDir: store.dir(slug), versions: await store.readVersions(slug), budgetMs, onBackgroundDone,
  })).versions;

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

  it('a follower\'s starFileMissing is about its own file in its primary\'s ★ version', async () => {
    const store = await seed();
    // The Reel's ★ is v2, which has no TikTok file.
    expect(of(await summary(), TIKTOK)).toMatchObject({ star: { follows: REEL }, starFileMissing: true });
    await mkdir(store.outputsDir(slug, 4), { recursive: true });
    await writeFile(join(store.outputsDir(slug, 4), 'reel.mp4'), 'reel-c');
    await writeFile(join(store.outputsDir(slug, 4), 'tiktok.mp4'), 'reel-c');
    await store.appendVersion(slug, version(4, [output(REEL, 'reel.mp4', 20), output(TIKTOK, 'tiktok.mp4', 20), output(POST, 'post.mp4')]));
    await writeFile(join(store.outputsDir(slug, 4), 'post.mp4'), 'post-b');
    expect(of(await summary(), TIKTOK).starFileMissing).toBe(false);
    await rm(join(store.outputsDir(slug, 4), 'tiktok.mp4'));
    expect(of(await summary(), TIKTOK).starFileMissing).toBe(true);
  });

  it('a follower added without the agent exports from the later version where the primary is identical (decisions log 140)', async () => {
    const store = await seed();
    // v4: the Reel repeated byte for byte (outside its history), TikTok materialized as its copy.
    await mkdir(store.outputsDir(slug, 4), { recursive: true });
    await writeFile(join(store.outputsDir(slug, 4), 'reel.mp4'), 'reel-b');
    await writeFile(join(store.outputsDir(slug, 4), 'tiktok.mp4'), 'reel-b');
    await writeFile(join(store.outputsDir(slug, 4), 'post.mp4'), 'post-b');
    await store.appendVersion(slug, version(4, [output(REEL, 'reel.mp4', 20), output(TIKTOK, 'tiktok.mp4', 20), output(POST, 'post.mp4')]));
    let s = await summary();
    expect(of(s, REEL)).toMatchObject({ history: [1, 2], star: { version: 2 }, exportVersion: 2 });
    expect(of(s, TIKTOK)).toMatchObject({ star: { version: null, follows: REEL }, exportVersion: 4, starFileMissing: false });
    // Shorts follows the Reel too but has no file in any version: missing.
    expect(of(s, SHORTS)).toMatchObject({ exportVersion: null, starFileMissing: true });
    // A manual ★ on the Reel v1: no version with TikTok has that Reel file.
    await pick(REEL, 1);
    s = await summary();
    expect(of(s, TIKTOK)).toMatchObject({ exportVersion: null, starFileMissing: true });
  });

  it('refuses a pick on a hard-linked file', async () => {
    await seed();
    const file = join(projectDir, 'creatives', slug, 'outputs', 'v1', 'reel.mp4');
    await link(file, join(projectDir, 'reel-copy.mp4'));
    const res = await pick(REEL, 1);
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
    const busy = await linkTo(SHORTS, null);
    expect([busy.statusCode, busy.json().code]).toEqual([409, 'job-running']);
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

/** A fake hasher: each call waits for its gate (open by default when `gated` is false) and is recorded in order. */
function fakeHasher(gated: boolean) {
  const calls: string[] = [];
  const gates: Array<() => void> = [];
  hashTesting.setHasher(async (base, rel) => {
    calls.push(rel);
    if (gated) await new Promise<void>((r) => gates.push(r));
    else await new Promise((r) => setTimeout(r, 30));
    return hashConfinedFile(base, rel);
  });
  return { calls, release: () => { for (const g of gates.splice(0)) g(); }, waitCalls: async (n: number) => {
    for (let i = 0; i < 500 && calls.length < n; i++) await new Promise((r) => setTimeout(r, 5));
  } };
}

describe('hashing: scheduling, de-duplication and safety', () => {
  let projectDir: string;
  let store: CreativeStore;
  let slug: string;
  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'ms-fv-sched-'));
    store = new CreativeStore(projectDir);
    slug = (await store.create({ title: 'Old', brief: { goal: 'x', message: '', formats: ['a', 'b', 'c', 'd'], durationSec: null, assets: [], notes: '' } })).slug;
  });
  const addVersion = async (n: number, names: string[]) => {
    await mkdir(store.outputsDir(slug, n), { recursive: true });
    for (const f of names) await writeFile(join(store.outputsDir(slug, n), `${f}.mp4`), `${f}-${n}`);
    await store.appendVersion(slug, version(n, names.map((f) => output(f, `${f}.mp4`))));
  };
  const lazyFull = async (budgetMs = 10_000) => withLazyHashes({ projectDir, creativeSlug: slug, creativeDir: store.dir(slug), versions: await store.readVersions(slug), budgetMs });
  const lazy = async (budgetMs = 10_000) => (await lazyFull(budgetMs)).versions;

  it('runs one hashing per file for concurrent requests', async () => {
    await addVersion(1, ['a', 'b']);
    const h = fakeHasher(false);
    const [x, y] = await Promise.all([lazy(), lazy()]);
    expect(h.calls).toHaveLength(2);
    expect(x[0]!.outputs.map((o) => o.sha256)).toEqual([sha('a-1'), sha('b-1')]);
    expect(y[0]!.outputs.map((o) => o.sha256)).toEqual([sha('a-1'), sha('b-1')]);
  });

  it('gives the hashes of a turn being finalized priority over a lazy backlog', async () => {
    await addVersion(1, ['a', 'b', 'c', 'd']);
    await mkdir(store.outputsDir(slug, 2), { recursive: true });
    await writeFile(join(store.outputsDir(slug, 2), 'new.mp4'), 'new');
    const h = fakeHasher(true);
    await lazy(0);
    await h.waitCalls(2);
    const recorded = hashVersionOutputs(store.dir(slug), 2, [output('a', 'new.mp4')]);
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 5; i++) { h.release(); await new Promise((r) => setTimeout(r, 20)); }
    expect((await recorded)[0]!.sha256).toBe(sha('new'));
    expect(h.calls[2]).toBe('outputs/v2/new.mp4');
  });

  it('discards an incoming sha256 and recomputes it from the file', async () => {
    await addVersion(1, ['a']);
    const [o] = await hashVersionOutputs(store.dir(slug), 1, [{ ...output('a', 'a.mp4'), sha256: 'f'.repeat(64) }]);
    expect(o!.sha256).toBe(sha('a-1'));
  });

  it('warns once per file state for a symlinked output', async () => {
    await addVersion(1, ['a']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await rm(join(store.outputsDir(slug, 1), 'a.mp4'));
    await writeFile(join(projectDir, 'elsewhere.txt'), 'x');
    await symlink(join(projectDir, 'elsewhere.txt'), join(store.outputsDir(slug, 1), 'a.mp4'));
    await lazy();
    await lazy();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports completeness: unhashable files count as complete, pending work does not', async () => {
    await addVersion(1, ['a', 'b']);
    await rm(join(store.outputsDir(slug, 1), 'b.mp4'));
    expect((await lazyFull()).complete).toBe(true);
    clearHashMemory();
    await writeFile(join(store.outputsDir(slug, 1), 'b.mp4'), 'b-again');
    const h = fakeHasher(true);
    const r = await lazyFull(0);
    expect(r.complete).toBe(false);
    await h.waitCalls(1);
    h.release();
  });

  it('retries a transient hashing error on the next request, warning once', async () => {
    await addVersion(1, ['a']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    hashTesting.setHasher(async (base, rel) => { if (fail) { fail = false; throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' }); } return hashConfinedFile(base, rel); });
    const first = await lazyFull();
    expect(first.complete).toBe(false);
    expect('sha256' in first.versions[0]!.outputs[0]!).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const second = await lazyFull();
    expect(second).toMatchObject({ complete: true });
    expect(second.versions[0]!.outputs[0]!.sha256).toBe(sha('a-1'));
  });

  it('treats a permission error as unhashable for good (warned once), a transient errno as retry', async () => {
    await addVersion(1, ['a', 'b']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    hashTesting.setHasher(async (base, rel) => (rel.endsWith('a.mp4') ? { skipped: 'unreadable', code: 'EACCES' } : hashConfinedFile(base, rel)));
    expect((await lazyFull()).complete).toBe(true);
    expect((await lazyFull()).complete).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    clearHashMemory();
    hashTesting.setHasher(async (base, rel) => (rel.endsWith('a.mp4') ? { skipped: 'unreadable', code: 'EIO' } : hashConfinedFile(base, rel)));
    expect((await lazyFull()).complete).toBe(false);
  });

  it('retries an `outside` skip when the file is confined again, and is final otherwise', async () => {
    await addVersion(1, ['a']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The check raced a swap: the file on disk is a normal confined file now.
    hashTesting.setHasher(async () => ({ skipped: 'outside' }));
    expect((await lazyFull()).complete).toBe(false);
    // A version folder that is a symlink stays outside: unhashable, complete.
    hashTesting.setHasher(null);
    await symlink(store.outputsDir(slug, 1), store.outputsDir(slug, 2));
    const r = await withLazyHashes({ projectDir, creativeSlug: slug, creativeDir: store.dir(slug), budgetMs: 10_000,
      versions: [version(2, [output('a', 'a.mp4')])] });
    expect(r.complete).toBe(true);
    expect('sha256' in r.versions[0]!.outputs[0]!).toBe(false);
  });

  it('does not join a run hashing a file that changed since', async () => {
    await addVersion(1, ['a']);
    const h = fakeHasher(true);
    const old = lazy();
    await h.waitCalls(1);
    await writeFile(join(store.outputsDir(slug, 1), 'a.mp4'), 'a-changed!');
    const fresh = lazy();
    await h.waitCalls(2);
    h.release();
    expect(h.calls).toHaveLength(2);
    await old;
    expect((await fresh)[0]!.outputs[0]!.sha256).toBe(sha('a-changed!'));
  });

  it('keeps the in-memory cache within its bound', async () => {
    hashTesting.setMemoryMax(2);
    for (const n of [1, 2, 3]) await addVersion(n, ['a']);
    await lazy();
    expect(hashTesting.memorySize()).toBe(2);
  });

  it('refuses `..` segments and symlinked folders in the exact confined hash', async () => {
    await addVersion(1, ['a']);
    await writeFile(join(store.dir(slug), 'outside.mp4'), 'x');
    expect(await hashConfinedFile(store.dir(slug), 'outputs/v1/../../outside.mp4')).toEqual({ skipped: 'outside' });
    await symlink(store.outputsDir(slug, 1), join(store.dir(slug), 'outputs', 'v9'));
    expect(await hashConfinedFile(store.dir(slug), 'outputs/v9/a.mp4')).toEqual({ skipped: 'outside' });
    expect(await hashConfinedFile(store.dir(slug), 'outputs/v1/a.mp4')).toMatchObject({ sha256: sha('a-1') });
  });
});

describe('export picks are never decided on partial hashes', { timeout: 20_000 }, () => {
  it('answers hashes-pending (503) while hashes are missing, then succeeds on retry', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ms-fv-503-'));
    const git = new Git();
    const ws = await WorkspaceStore.open(join(base, 'ws'), git);
    const { slug: project } = await ws.createProject({ name: 'Acme' });
    const projectDir = ws.projectDir(project);
    const store = new CreativeStore(projectDir);
    const created = await store.create({ title: 'Lancio', brief: { goal: 'x', message: '', formats: [REEL], durationSec: null, assets: [], notes: '' } });
    const ref: CreativeRef = { root: ws.root, projectSlug: project, projectDir, creativeSlug: created.slug };
    for (const n of [1, 2]) {
      await mkdir(store.outputsDir(created.slug, n), { recursive: true });
      await writeFile(join(store.outputsDir(created.slug, n), 'reel.mp4'), `reel-${n}`);
      await store.appendVersion(created.slug, version(n, [output(REEL, 'reel.mp4')]));
    }
    const service = new CreativeTurnService({
      queue: new JobQueue({ concurrency: 1 }), git, media: NoMediaTools, vault: new MemoryVault(),
      launcher: testLauncher(new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 })),
      presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {}, pickHashBudgetMs: 50,
    });
    const h = fakeHasher(true);
    const err = await service.setExportPick(ref, REEL, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodedError);
    expect(err).toMatchObject({ status: 503, apiCode: 'hashes-pending', retryAfterSec: PICK_RETRY_AFTER_SEC });
    // Cheap checks come first: no waiting for hashes on an invalid pick.
    await expect(service.setExportPick(ref, REEL, 9)).rejects.toMatchObject({ apiCode: 'version-not-found' });
    await h.waitCalls(2);
    h.release();
    // Bounded poll until the background hashing has filled both versions' caches.
    for (let i = 0; i < 200; i++) {
      const done = await Promise.all([1, 2].map((n) => readFile(hashCachePath(projectDir, created.slug, n), 'utf8').then(
        (t) => Boolean(JSON.parse(t).files['reel.mp4']), () => false)));
      if (done.every(Boolean)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await service.setExportPick(ref, REEL, 1)).exportPicks).toEqual({ [REEL]: 1 });
  });

  it('lets a pick succeed when an old file cannot be read (chmod 000), warning once', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ms-fv-eacces-'));
    const git = new Git();
    const ws = await WorkspaceStore.open(join(base, 'ws'), git);
    const { slug: project } = await ws.createProject({ name: 'Acme' });
    const projectDir = ws.projectDir(project);
    const store = new CreativeStore(projectDir);
    const created = await store.create({ title: 'Lancio', brief: { goal: 'x', message: '', formats: [REEL], durationSec: null, assets: [], notes: '' } });
    const ref: CreativeRef = { root: ws.root, projectSlug: project, projectDir, creativeSlug: created.slug };
    for (const n of [1, 2]) {
      await mkdir(store.outputsDir(created.slug, n), { recursive: true });
      await writeFile(join(store.outputsDir(created.slug, n), 'reel.mp4'), `reel-${n}`);
      await store.appendVersion(created.slug, version(n, [output(REEL, 'reel.mp4')]));
    }
    const locked = join(store.outputsDir(created.slug, 1), 'reel.mp4');
    await chmod(locked, 0o000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const service = new CreativeTurnService({
        queue: new JobQueue({ concurrency: 1 }), git, media: NoMediaTools, vault: new MemoryVault(),
        launcher: testLauncher(new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 })),
        presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {},
      });
      expect((await service.setExportPick(ref, REEL, 1)).exportPicks).toEqual({ [REEL]: 1 });
      expect(warn.mock.calls.filter(([m]) => String(m).includes('outputs/v1/reel.mp4'))).toHaveLength(1);
    } finally { await chmod(locked, 0o644); }
  });

  it('sends Retry-After with the 503', async () => {
    const app = (await import('fastify')).default();
    app.setErrorHandler((await import('../src/server/app.ts')).errorReply);
    app.get('/x', async () => { throw new CodedError(503, 'wait', 'hashes-pending', 5); });
    const res = await app.inject('/x');
    expect([res.statusCode, res.headers['retry-after'], res.json()]).toEqual([503, '5', { error: 'wait', code: 'hashes-pending' }]);
    await app.close();
  });
});

describe('export picks do not hold the creative lock while hashing', { timeout: 20_000 }, () => {
  it('lets a brief update through while a pick waits for slow hashes', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ms-fv-lock-'));
    const git = new Git();
    const ws = await WorkspaceStore.open(join(base, 'ws'), git);
    const { slug: project } = await ws.createProject({ name: 'Acme' });
    const projectDir = ws.projectDir(project);
    const store = new CreativeStore(projectDir);
    const created = await store.create({ title: 'Lancio', brief: { goal: 'x', message: '', formats: [REEL], durationSec: null, assets: [], notes: '' } });
    const ref: CreativeRef = { root: ws.root, projectSlug: project, projectDir, creativeSlug: created.slug };
    for (const n of [1, 2]) {
      await mkdir(store.outputsDir(created.slug, n), { recursive: true });
      await writeFile(join(store.outputsDir(created.slug, n), 'reel.mp4'), `reel-${n}`);
      await store.appendVersion(created.slug, version(n, [output(REEL, 'reel.mp4')]));
    }
    const service = new CreativeTurnService({
      queue: new JobQueue({ concurrency: 1 }), git, media: NoMediaTools, vault: new MemoryVault(),
      launcher: testLauncher(new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 })),
      presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {},
    });
    const h = fakeHasher(true);
    const picked = service.setExportPick(ref, REEL, 1);
    await h.waitCalls(1);
    const edited = await Promise.race([
      service.updateBrief(ref, { title: 'Nuovo' }).then((c) => c.title),
      new Promise((r) => setTimeout(() => r('blocked'), 3000)),
    ]);
    expect(edited).toBe('Nuovo');
    h.release();
    await h.waitCalls(2);
    h.release();
    expect((await picked).exportPicks).toEqual({ [REEL]: 1 });
    // The pass under the lock was served by the cache: one hashing per file.
    expect(h.calls).toHaveLength(2);
  });
});

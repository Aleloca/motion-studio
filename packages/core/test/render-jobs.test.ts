// @vitest-environment node
/**
 * Render jobs (Task 5) with a fake render engine (the real renderer is covered by render-jobs.chrome.test.ts): the route
 * (auth, origin, errors), one job per request, progress, cancel, the records (versions.json outputs with sha256 and
 * fromComposition, the manifest v2 renders[], renderState), followers by copy, old renders kept, the versions.json lock,
 * the turn's earlier-output check, and the startup sweep of leftovers.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderState, type FormatPreset, type JobSummary, type ManifestV2, type VersionEntry } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { noteCoreOutputWrite, snapshotChanges, snapshotOutputs, withoutCoreWrites } from '../src/creatives/carry-over.ts';
import { noteCoreTemp } from '../src/core-temps.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { renderPlan, RenderJobService } from '../src/creatives/render-jobs.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import type { MediaNormalizer } from '../src/render/media-normalize.ts';
import { Git } from '../src/git.ts';
import { RenderError } from '../src/render/errors.ts';
import { sweepProjectRenders, sweepRenderTempDirs } from '../src/render/render-sweep.ts';
import type { RenderCompositionOptions, RenderEngine, RenderResult } from '../src/render/renderer.ts';
import { buildServer } from '../src/server/app.ts';

const TOKEN = 'ab'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const PRESETS: FormatPreset[] = [
  { id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 },
  { id: 'test-wide-b', channel: 'Test', name: 'Wide B', width: 320, height: 180, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 },
  { id: 'test-tall', channel: 'Test', name: 'Tall', width: 180, height: 320, kind: 'video', extensions: ['mp4', 'webm'] },
  { id: 'test-still', channel: 'Test', name: 'Still', width: 320, height: 180, kind: 'image', extensions: ['png', 'jpg'] },
  // A follower with its own, stricter limits (M4): another container and a tiny size cap.
  { id: 'test-wide-c', channel: 'Other', name: 'Wide C', width: 320, height: 180, kind: 'video', extensions: ['mp4', 'mov'], maxFileMB: 0.00001 },
];
const comp = (w: number, h: number, duration: number, fill = '#ff0000') => ({
  $schema: 'motion-studio/composition@1', width: w, height: h, fps: 30, duration, background: '#101010', fonts: [],
  scenes: duration > 0 ? [{ id: 's', start: 0, duration }] : [],
  tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'box', type: 'shape', start: 0, duration, props: { x: 10, y: 10, width: 100, height: 50, fill } }] }],
});

interface Fake {
  engine: RenderEngine;
  calls: RenderCompositionOptions[];
  /** When set, each render waits for it before writing (after reporting the first frames). */
  gate: Promise<void> | null;
  fail: Record<string, string>;
  kind: 'injected' | null;
  /** Runs right after a render's file is in place (before the job records it). */
  after: ((o: RenderCompositionOptions) => void | Promise<void>) | null;
}
function fakeEngine(): Fake {
  const f: Fake = { calls: [], gate: null, fail: {}, kind: 'injected', after: null, engine: null as unknown as RenderEngine };
  f.engine = {
    info: async () => ({ kind: f.kind }),
    provider: async () => { throw new Error('not used'); },
    render: async (o: Omit<RenderCompositionOptions, 'provider'>): Promise<RenderResult> => {
      f.calls.push(o as RenderCompositionOptions);
      const still = !(o.composition.duration > 0);
      const total = still ? 1 : Math.round(o.composition.duration * o.composition.fps);
      o.onProgress?.({ frames: 0, total });
      o.onProgress?.({ frames: 1, total });
      const temp = join(dirname(o.out), `.${basename(o.out)}.render-${randomBytes(6).toString('hex')}.tmp`);
      noteCoreTemp(temp); // as the real renderer does
      await writeFile(temp, `partial ${o.format.id}`);
      try {
        if (f.gate) {
          await Promise.race([f.gate, new Promise((_, reject) => {
            if (o.signal.aborted) reject(new RenderError('cancelled', 'cancelled'));
            o.signal.addEventListener('abort', () => reject(new RenderError('cancelled', 'cancelled')), { once: true });
          })]);
        }
        if (f.fail[o.format.id]) throw new RenderError('ffmpegFailed', f.fail[o.format.id]!);
        for (let i = 2; i <= total; i++) o.onProgress?.({ frames: i, total });
        const body = `render of ${o.format.id} at ${Date.now()} ${randomBytes(4).toString('hex')}`;
        await writeFile(temp, body);
        await o.beforeRename?.(temp);
        await rename(temp, o.out);
        await f.after?.(o as RenderCompositionOptions);
        return { file: o.out, sha256: createHash('sha256').update(body).digest('hex'), width: o.composition.width, height: o.composition.height,
          durationSec: still ? null : o.composition.duration, frames: total, encoder: still ? null : 'libx264', audio: false, warnings: [] };
      } finally {
        rmSync(temp, { force: true });
      }
    },
  } as unknown as RenderEngine;
  return f;
}

let base: string;
let app: FastifyInstance;
let fake: Fake;
let ws: string;

const build = (o: { engine?: RenderEngine | null } = {}) => buildServer({
  uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
  appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
  runner: new ClaudeCodeRunner([process.execPath, '-e', ''], { killGraceMs: 200 }), doctor: async () => [],
  ...(o.engine === null ? {} : { render: o.engine ?? fake.engine }),
});

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'ms-test-render-jobs-'));
  fake = fakeEngine();
  app = await build();
  ws = join(base, 'ws');
  await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: ws } });
  await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } });
  expect((await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: PRESETS } })).statusCode).toBe(200);
});
afterEach(async () => { await app?.close(); rmSync(base, { recursive: true, force: true }); });

const projectDir = () => join(ws, 'acme');

/**
 * A creative with a v2 version `n`: one composition folder per primary (each its own colour), followers sharing their
 * primary's. `noFollowsField`: the follower entry is written without `followsFormat` (recognised from the brief's link).
 */
async function v2Creative(o: { formats?: string[]; links?: Record<string, string>; versions?: number[]; noFollowsField?: boolean } = {}) {
  const formats = o.formats ?? ['test-wide', 'test-wide-b', 'test-still'];
  const links = o.links ?? { 'test-wide-b': 'test-wide' };
  const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
    title: 'Launch', generate: false, brief: { goal: 'g', message: '', formats, durationSec: 1, assets: [], notes: '', links },
  } });
  expect(r.statusCode, r.body).toBe(201);
  const slug = r.json().slug as string;
  const store = new CreativeStore(projectDir());
  for (const n of o.versions ?? [1]) {
    const vdir = store.outputsDir(slug, n);
    const compositions: Array<{ format: string; dir: string; hash: string; followsFormat?: string; problems: string[] }> = [];
    for (const f of formats.filter((x) => !links[x])) {
      const preset = PRESETS.find((p) => p.id === f)!;
      const dir = join(vdir, 'compositions', f);
      mkdirSync(join(dir, 'assets'), { recursive: true });
      writeFileSync(join(dir, 'composition.json'), JSON.stringify(comp(preset.width, preset.height, preset.kind === 'image' ? 0 : 1, `#${String(n).repeat(6).slice(0, 6)}`)));
      compositions.push({ format: f, dir: `compositions/${f}`, hash: (await readCompositionFolder(dir)).hash, problems: [] });
    }
    for (const [f, p] of Object.entries(links)) {
      const primary = compositions.find((c) => c.format === p)!;
      compositions.push({ format: f, dir: primary.dir, hash: primary.hash, ...(o.noFollowsField ? {} : { followsFormat: p }), problems: [] });
    }
    const manifest: ManifestV2 = { schemaVersion: 2, compositions, renders: [] };
    writeFileSync(join(vdir, 'manifest.json'), JSON.stringify(manifest));
    await store.appendVersion(slug, {
      n, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', outputs: [], problems: [], tools: [],
      renderCommand: null, basedOn: null, compositions,
    });
  }
  return { slug, store, dir: store.dir(slug) };
}

const renderUrl = (slug: string, n: number) => `/api/projects/acme/creatives/${slug}/versions/${n}/render`;
const post = (slug: string, n: number, payload: unknown = {}, headers: Record<string, string> = H) => app.inject({ method: 'POST', url: renderUrl(slug, n), headers, payload: payload as object });
async function waitJob(id: string, until: (j: JobSummary) => boolean = (j) => j.state !== 'queued' && j.state !== 'running'): Promise<JobSummary> {
  for (let i = 0; i < 1500; i++) {
    const j = ((await app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id);
    if (j && until(j)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for the job');
}
const versionOf = async (store: CreativeStore, slug: string, n: number) => (await store.readVersions(slug)).find((v) => v.n === n)!;
const manifestOf = (dir: string, n: number) => JSON.parse(readFileSync(join(dir, 'outputs', `v${n}`, 'manifest.json'), 'utf8')) as ManifestV2;

describe('the render route', { timeout: 30_000 }, () => {
  it('needs the UI token and a local origin, like every API route', async () => {
    const { slug } = await v2Creative();
    expect((await post(slug, 1, {}, {})).statusCode).toBe(401);
    expect((await post(slug, 1, {}, { 'x-motion-studio-ui': 'wrong' })).statusCode).toBe(401);
    expect((await post(slug, 1, {}, { ...H, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(fake.calls).toEqual([]);
  });

  it('refuses an unknown version, a legacy version, unknown formats and a bad body', async () => {
    const { slug, store } = await v2Creative();
    expect((await post(slug, 9)).statusCode).toBe(404);
    expect((await post(slug, 0)).statusCode).toBe(404);
    await store.appendVersion(slug, { n: 2, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null });
    const legacy = await post(slug, 2);
    expect(legacy.statusCode).toBe(400);
    expect(legacy.json().code).toBe('version-not-v2');
    const unknown = await post(slug, 1, { formats: ['test-tall', 'nope'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe('formats-not-in-version');
    expect((await post(slug, 1, { formats: 'test-wide' })).statusCode).toBe(400);
    expect((await post(slug, 1, { formats: ['test-wide'], extra: 1 })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/projects/acme/creatives/NOPE/versions/1/render', headers: H, payload: {} })).statusCode).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it('without a renderer: 503 no-renderer; without a browser: 409 no-browser (the UI offers the download)', async () => {
    const { slug } = await v2Creative();
    fake.kind = null;
    const r = await post(slug, 1);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('no-browser');
    await app.close();
    app = await build({ engine: null });
    const n = await post(slug, 1);
    expect(n.statusCode).toBe(503);
    expect(n.json().code).toBe('no-renderer');
  });
});

describe('render jobs', { timeout: 60_000 }, () => {
  it('one job renders every primary, copies followers, and records outputs, renders[] and renderState', async () => {
    const { slug, store, dir } = await v2Creative();
    const r = await post(slug, 1);
    expect(r.statusCode).toBe(202);
    const job = r.json() as JobSummary;
    expect(job).toMatchObject({ kind: 'render', state: expect.any(String), formats: ['test-wide', 'test-still', 'test-wide-b'] });
    expect(job.key).toMatch(/^render:.*:acme:.*:v1$/);
    expect(job.label).toBe('Render · Launch v1');
    const done = await waitJob(job.id);
    expect(done.state, done.error).toBe('succeeded');
    expect(done.progress).toBeUndefined();
    expect(fake.calls.map((c) => [c.format.id, c.versionDir, basename(c.out)])).toEqual([['test-wide', 'outputs/v1', 'test-wide.mp4'], ['test-still', 'outputs/v1', 'test-still.png']]);
    // The media of every render goes to the session (empty here: no video clip).
    expect(fake.calls[0]!.media).toMatchObject({ dir: join(projectDir(), '.studio', 'cache', 'media') });
    const vdir = join(dir, 'outputs', 'v1');
    expect(readdirSync(vdir).sort()).toEqual(['compositions', 'manifest.json', 'test-still.png', 'test-wide-b.mp4', 'test-wide.mp4']);
    // The follower is a copy: same bytes, its own inode, never a hard link.
    const a = statSync(join(vdir, 'test-wide.mp4')), b = statSync(join(vdir, 'test-wide-b.mp4'));
    expect(readFileSync(join(vdir, 'test-wide-b.mp4'))).toEqual(readFileSync(join(vdir, 'test-wide.mp4')));
    expect(b.ino).not.toBe(a.ino);
    expect([a.nlink, b.nlink]).toEqual([1, 1]);
    const v = await versionOf(store, slug, 1);
    const sha = (f: string) => createHash('sha256').update(readFileSync(join(vdir, f))).digest('hex');
    const hashOf = (f: string) => v.compositions!.find((c) => c.format === f)!.hash;
    expect(v.outputs.map((o) => [o.format, o.file, o.sha256, o.fromComposition, o.problems]).sort()).toEqual([
      ['test-still', 'test-still.png', sha('test-still.png'), hashOf('test-still'), []],
      ['test-wide', 'test-wide.mp4', sha('test-wide.mp4'), hashOf('test-wide'), []],
      ['test-wide-b', 'test-wide-b.mp4', sha('test-wide.mp4'), hashOf('test-wide-b'), []],
    ]);
    expect(v.outputs.find((o) => o.format === 'test-wide')).toMatchObject({ width: 320, height: 180, durationSec: 1, verified: false, preview: null });
    expect(v.outputs.find((o) => o.format === 'test-still')).toMatchObject({ durationSec: null });
    for (const f of ['test-wide', 'test-wide-b', 'test-still']) expect(renderState(v, f), f).toBe('rendered');
    const m = manifestOf(dir, 1);
    expect(m.renders.map((x) => [x.format, x.file, x.sha256, x.fromComposition, x.durationSec]).sort()).toEqual([
      ['test-still', 'test-still.png', sha('test-still.png'), hashOf('test-still'), null],
      ['test-wide', 'test-wide.mp4', sha('test-wide.mp4'), hashOf('test-wide'), 1],
      ['test-wide-b', 'test-wide-b.mp4', sha('test-wide.mp4'), hashOf('test-wide'), 1],
    ]);
    expect(m.compositions).toEqual(v.compositions);
    // The composition folders are untouched: the hash recorded for the version still matches.
    for (const c of v.compositions!) expect((await readCompositionFolder(join(vdir, c.dir))).hash).toBe(c.hash);
  });

  it('a follower named in the request renders its primary; a follower entry without followsFormat gets it', async () => {
    const { slug, store, dir } = await v2Creative({ noFollowsField: true });
    const job = (await post(slug, 1, { formats: ['test-wide-b'] })).json() as JobSummary;
    expect(job.formats).toEqual(['test-wide', 'test-wide-b']);
    expect((await waitJob(job.id)).state).toBe('succeeded');
    expect(fake.calls.map((c) => c.format.id)).toEqual(['test-wide']);
    const v = await versionOf(store, slug, 1);
    expect(v.compositions!.find((c) => c.format === 'test-wide-b')!.followsFormat).toBe('test-wide');
    expect(manifestOf(dir, 1).compositions.find((c) => c.format === 'test-wide-b')!.followsFormat).toBe('test-wide');
    expect(renderState(v, 'test-wide-b')).toBe('rendered');
    expect(renderState(v, 'test-still')).toBe('none');
  });

  it('reports progress per format (media, frames, finishing), and refuses a second job for the same version', async () => {
    const { slug } = await v2Creative({ formats: ['test-wide'], links: {} });
    let release!: () => void;
    fake.gate = new Promise((r) => { release = r; });
    const job = (await post(slug, 1)).json() as JobSummary;
    const seen = await waitJob(job.id, (j) => j.progress?.phase === 'frames');
    expect(seen.progress).toMatchObject({ format: 'test-wide', phase: 'frames', total: 30 });
    expect(seen.progress!.done).toBeGreaterThanOrEqual(0);
    const again = await post(slug, 1);
    expect(again.statusCode).toBe(409);
    release();
    expect((await waitJob(job.id)).state).toBe('succeeded');
    // A new request once it is done is fine.
    fake.gate = null;
    expect((await waitJob((await post(slug, 1)).json().id)).state).toBe('succeeded');
  });

  it('cancel: the render stops, nothing is recorded, no output and no temp file is left', async () => {
    const { slug, store, dir } = await v2Creative({ formats: ['test-wide'], links: {} });
    fake.gate = new Promise(() => {});
    const job = (await post(slug, 1)).json() as JobSummary;
    await waitJob(job.id, (j) => j.progress?.phase === 'frames');
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: H })).json()).toEqual({ cancelled: true });
    expect((await waitJob(job.id)).state).toBe('cancelled');
    expect(readdirSync(join(dir, 'outputs', 'v1')).sort()).toEqual(['compositions', 'manifest.json']);
    expect((await versionOf(store, slug, 1)).outputs).toEqual([]);
    expect(manifestOf(dir, 1).renders).toEqual([]);
  });

  it('a failed format fails the job but keeps the formats rendered before it; old renders are never deleted', async () => {
    const { slug, store, dir } = await v2Creative({ versions: [1, 2] });
    expect((await waitJob((await post(slug, 1)).json().id)).state).toBe('succeeded');
    const v1dir = join(dir, 'outputs', 'v1');
    const before = Object.fromEntries(readdirSync(v1dir).filter((f) => f.includes('.')).map((f) => [f, readFileSync(join(v1dir, f))]));
    const v1Before = await versionOf(store, slug, 1);
    fake.fail['test-still'] = 'boom';
    const job = await waitJob((await post(slug, 2)).json().id);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/Render non riuscito: .*Still.*boom/); // tests run in Italian (setup-locale.ts)
    const v2 = await versionOf(store, slug, 2);
    expect(v2.outputs.map((o) => o.format).sort()).toEqual(['test-wide', 'test-wide-b']);
    expect(renderState(v2, 'test-still')).toBe('none');
    expect(readdirSync(join(dir, 'outputs', 'v2')).filter((f) => f.startsWith('.'))).toEqual([]);
    // v1 is exactly as it was.
    expect(Object.fromEntries(readdirSync(v1dir).filter((f) => f.includes('.')).map((f) => [f, readFileSync(join(v1dir, f))]))).toEqual(before);
    expect(await versionOf(store, slug, 1)).toEqual(v1Before);
    // A re-render of the same version replaces its own file atomically; the record follows.
    delete fake.fail['test-still'];
    expect((await waitJob((await post(slug, 1, { formats: ['test-wide'] })).json().id)).state).toBe('succeeded');
    const again = await versionOf(store, slug, 1);
    expect(again.outputs.find((o) => o.format === 'test-wide')!.sha256).not.toBe(v1Before.outputs.find((o) => o.format === 'test-wide')!.sha256);
    expect(again.outputs.find((o) => o.format === 'test-still')).toEqual(v1Before.outputs.find((o) => o.format === 'test-still'));
    expect(manifestOf(dir, 1).renders).toHaveLength(3);
  });

  it('a composition that changed since the version was recorded, or became invalid, is not rendered', async () => {
    const { slug, store, dir } = await v2Creative({ formats: ['test-wide', 'test-tall'], links: {} });
    writeFileSync(join(dir, 'outputs', 'v1', 'compositions', 'test-wide', 'assets', 'new.txt'), 'x');
    writeFileSync(join(dir, 'outputs', 'v1', 'compositions', 'test-tall', 'composition.json'), '{"$schema": "motion-studio/composition@1"}');
    const job = await waitJob((await post(slug, 1)).json().id);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/cambiata dopo il salvataggio della versione/);
    expect(job.error).toMatch(/ha dei problemi/);
    expect(fake.calls).toEqual([]);
    expect((await versionOf(store, slug, 1)).outputs).toEqual([]);
  });

  it('server close cancels a running render job and awaits it', async () => {
    const { slug, dir } = await v2Creative({ formats: ['test-wide'], links: {} });
    fake.gate = new Promise(() => {});
    const job = (await post(slug, 1)).json() as JobSummary;
    await waitJob(job.id, (j) => j.progress?.phase === 'frames');
    await app.close();
    expect(readdirSync(join(dir, 'outputs', 'v1')).sort()).toEqual(['compositions', 'manifest.json']);
    app = await build();
    expect((await app.inject({ url: '/api/jobs', headers: H })).json()).toEqual([]);
  });
});

describe('progress events and warnings', { timeout: 30_000 }, () => {
  it('per format: media (sources done of total), frames, finishing (the follower copies); media warnings become notes and chat warnings', async () => {
    const { slug, store } = await v2Creative({ formats: ['test-wide', 'test-wide-b'] });
    const updates: JobSummary[] = [];
    let released = 0;
    const queue = new JobQueue({ concurrency: 1, onUpdate: (j) => updates.push(j) });
    const normalizer = {
      prepare: async (p: { onProgress?(x: { done: number; total: number }): void }) => {
        for (const done of [0, 1, 2]) p.onProgress?.({ done, total: 2 });
        return { media: { dir: join(projectDir(), '.studio', 'cache', 'media'), clips: new Map() }, warnings: [{ src: 'assets/v.mp4', kind: 'notNormalised', message: 'x' }], made: 0, cached: 0, release: () => { released++; } };
      },
    } as unknown as MediaNormalizer;
    const svc = new RenderJobService({ queue, engine: fake.engine, media: NoMediaTools, normalizer, presets: async () => PRESETS, broadcast: () => {}, progressIntervalMs: 0 });
    const job = await svc.start({ root: ws, projectSlug: 'acme', projectDir: projectDir(), creativeSlug: slug }, 1);
    await queue.whenIdle();
    const mine = updates.filter((u) => u.id === job.id);
    expect(mine.at(-1)!.state).toBe('succeeded');
    // Every job update carries the current progress (a note is an update too): consecutive repeats are one state.
    const seq = mine.map((u) => u.progress).filter((p) => p !== undefined).map((p) => `${p.phase} ${p.done}/${p.total}`).filter((x, i, a) => x !== a[i - 1]);
    expect(seq.slice(0, 5)).toEqual(['media 0/0', 'media 0/2', 'media 1/2', 'media 2/2', 'frames 0/30']);
    expect(seq).toContain('frames 30/30');
    expect(seq.slice(-2)).toEqual(['finishing 0/2', 'finishing 1/2']);
    expect(mine.at(-1)!.progress).toBeUndefined();
    expect(mine.at(-1)!.notes).toEqual([expect.stringContaining('assets/v.mp4')]);
    expect(released).toBe(1); // the media lease ends with the render
    const chat = await store.readConversation(slug);
    expect(chat.at(-1)).toMatchObject({ type: 'system', level: 'warning', text: expect.stringContaining('assets/v.mp4') });
  });
});

describe('fix round: records always written, follower limits, the render lane', { timeout: 60_000 }, () => {
  it('a cancel after a render is in place still records it (I3); the next format is not rendered', async () => {
    const { slug, store, dir } = await v2Creative({ formats: ['test-wide', 'test-still', 'test-wide-b'] });
    let id = '';
    fake.after = async (o) => { if (o.format.id === 'test-wide') await app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: H }); };
    id = (await post(slug, 1)).json().id;
    expect((await waitJob(id)).state).toBe('cancelled');
    expect(fake.calls.map((c) => c.format.id)).toEqual(['test-wide']);
    const v = await versionOf(store, slug, 1);
    const sha = (f: string) => createHash('sha256').update(readFileSync(join(dir, 'outputs', 'v1', f))).digest('hex');
    // The primary and its follower are recorded with exactly what is on disk.
    expect(v.outputs.map((o) => [o.format, o.sha256]).sort()).toEqual([['test-wide', sha('test-wide.mp4')], ['test-wide-b', sha('test-wide-b.mp4')]]);
    expect(manifestOf(dir, 1).renders.map((r) => r.format).sort()).toEqual(['test-wide', 'test-wide-b']);
    expect(renderState(v, 'test-still')).toBe('none');
  });

  it('a follower that cannot be copied is left out; the primary is recorded and the job fails (I3)', async () => {
    const { slug, store, dir } = await v2Creative({ formats: ['test-wide', 'test-wide-b'] });
    mkdirSync(join(dir, 'outputs', 'v1', 'test-wide-b.mp4', 'blocker'), { recursive: true });
    const job = await waitJob((await post(slug, 1)).json().id);
    expect(job.state).toBe('failed');
    const v = await versionOf(store, slug, 1);
    expect(v.outputs.map((o) => o.format)).toEqual(['test-wide']);
    expect(renderState(v, 'test-wide')).toBe('rendered');
    expect(readdirSync(join(dir, 'outputs', 'v1')).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('a follower is checked against its own preset: its size limit (M4)', async () => {
    const { slug, store } = await v2Creative({ formats: ['test-wide', 'test-wide-c'], links: { 'test-wide-c': 'test-wide' } });
    expect((await waitJob((await post(slug, 1)).json().id)).state).toBe('succeeded');
    const v = await versionOf(store, slug, 1);
    expect(v.outputs.find((o) => o.format === 'test-wide')!.problems).toEqual([]);
    const c = v.outputs.find((o) => o.format === 'test-wide-c')!;
    expect(c.file).toBe('test-wide-c.mp4');
    expect(c.problems).toEqual([expect.stringContaining('MB')]);
  });

  it('renders have their own lane of one: queued renders show their position and never block a main-lane job (M3)', async () => {
    const updates: JobSummary[] = [];
    const queue = new JobQueue({ concurrency: 1, lanes: { render: 1 }, onUpdate: (j) => updates.push(j) });
    const gates: Array<() => void> = [];
    const blocked = () => new Promise<void>((r) => gates.push(r));
    const r1 = queue.enqueue({ key: 'render:a', kind: 'render', label: 'r1', lane: 'render', run: blocked });
    const r2 = queue.enqueue({ key: 'render:b', kind: 'render', label: 'r2', lane: 'render', run: blocked });
    const r3 = queue.enqueue({ key: 'render:c', kind: 'render', label: 'r3', lane: 'render', run: blocked });
    expect([r1.queuePosition, r2.queuePosition, r3.queuePosition]).toEqual([undefined, 1, 2]);
    const turn = queue.enqueue({ key: 'creative:x', kind: 'creative', label: 't', run: blocked });
    const state = (id: string) => queue.list().find((j) => j.id === id)!;
    await new Promise((r) => setTimeout(r, 10));
    expect(state(turn.id).state).toBe('running'); // the render lane is busy, the main lane is not
    expect(state(r1.id).state).toBe('running');
    gates.shift()!(); // r1 done
    await new Promise((r) => setTimeout(r, 10));
    expect(state(r2.id)).toMatchObject({ state: 'running' });
    expect(state(r2.id).queuePosition).toBeUndefined();
    expect(state(r3.id).queuePosition).toBe(1);
    expect(updates.some((u) => u.id === r3.id && u.queuePosition === 1)).toBe(true);
    for (const id of [r2.id, r3.id, turn.id]) queue.cancel(id);
    gates.forEach((g) => g());
    await queue.whenIdle();
  });
});

describe('round 2: the record follows the disk', { timeout: 60_000 }, () => {
  it('the primary is recorded right after its rename, before posters and followers (crash window)', async () => {
    const { slug, store, dir } = await v2Creative({ formats: ['test-wide', 'test-wide-b'] });
    let openPoster!: () => void;
    const posterGate = new Promise<void>((r) => { openPoster = r; });
    const media = {
      available: true,
      probe: async () => ({ width: 320, height: 180, durationSec: 1 }),
      poster: async (_v: string, out: string) => { await posterGate; writeFileSync(out, 'jpeg'); return true; },
      frame: async () => false,
    };
    const queue = new JobQueue({ concurrency: 1, lanes: { render: 1 } });
    const normalizer = { prepare: async () => ({ media: { dir: join(projectDir(), '.studio', 'cache', 'media'), clips: new Map() }, warnings: [], made: 0, cached: 0, release: () => {} }) } as unknown as MediaNormalizer;
    const svc = new RenderJobService({ queue, engine: fake.engine, media, normalizer, presets: async () => PRESETS, broadcast: () => {} });
    await svc.start({ root: ws, projectSlug: 'acme', projectDir: projectDir(), creativeSlug: slug }, 1);
    const sha = (f: string) => createHash('sha256').update(readFileSync(join(dir, 'outputs', 'v1', f))).digest('hex');
    // While the poster hangs (a crash here would lose nothing): the primary is already recorded with its true hash.
    for (let i = 0; i < 500 && (await versionOf(store, slug, 1)).outputs.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const early = await versionOf(store, slug, 1);
    expect(early.outputs.map((o) => [o.format, o.sha256])).toEqual([['test-wide', sha('test-wide.mp4')]]);
    expect(renderState(early, 'test-wide')).toBe('rendered');
    openPoster();
    await queue.whenIdle();
    const v = await versionOf(store, slug, 1);
    expect(v.outputs.map((o) => [o.format, o.preview]).sort()).toEqual([['test-wide', '.previews/test-wide.mp4.jpg'], ['test-wide-b', '.previews/test-wide-b.mp4.jpg']]);
    // The poster went through a temp file: none is left.
    expect(readdirSync(join(dir, 'outputs', 'v1', '.previews')).sort()).toEqual(['test-wide-b.mp4.jpg', 'test-wide.mp4.jpg']);
  });

  it('a render whose file changed after it was recorded is re-hashed and corrected when the creative is read', async () => {
    const { slug, store, dir } = await v2Creative({ formats: ['test-wide'], links: {} });
    expect((await waitJob((await post(slug, 1)).json().id)).state).toBe('succeeded');
    const file = join(dir, 'outputs', 'v1', 'test-wide.mp4');
    writeFileSync(file, 'bytes the record does not know (a crash between rename and record)');
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    expect((await versionOf(store, slug, 1)).outputs[0]!.sha256).not.toBe(sha);
    const detail = (await app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H })).json() as { versions: VersionEntry[] };
    expect(detail.versions[0]!.outputs[0]!.sha256).toBe(sha);
    expect((await versionOf(store, slug, 1)).outputs[0]!.sha256).toBe(sha);
    expect(manifestOf(dir, 1).renders[0]!.sha256).toBe(sha);
    // A second read with nothing changed does not hash again (the stamp matches): same answer.
    expect(((await app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H })).json() as { versions: VersionEntry[] }).versions[0]!.outputs[0]!.sha256).toBe(sha);
  });

  it('a re-render replaces the follower\'s record with its new copy (never a stale entry)', async () => {
    const { slug, store, dir } = await v2Creative({ formats: ['test-wide', 'test-wide-b'] });
    expect((await waitJob((await post(slug, 1)).json().id)).state).toBe('succeeded');
    const before = (await versionOf(store, slug, 1)).outputs.find((o) => o.format === 'test-wide-b')!.sha256;
    expect((await waitJob((await post(slug, 1)).json().id)).state).toBe('succeeded');
    const after = (await versionOf(store, slug, 1)).outputs.find((o) => o.format === 'test-wide-b')!.sha256;
    expect(after).not.toBe(before);
    expect(after).toBe(createHash('sha256').update(readFileSync(join(dir, 'outputs', 'v1', 'test-wide-b.mp4'))).digest('hex'));
  });
});

describe('a turn and a render on the same creative (M9)', { timeout: 120_000 }, () => {
  it('both versions.json writes are kept and the turn reports no earlier-output change', async () => {
    const { slug, store } = await v2Creative({ formats: ['test-wide'], links: {} });
    await app.close();
    const wait = join(base, 'go');
    process.env.FAKE_CLAUDE_SCENARIO = 'composition';
    process.env.FAKE_CLAUDE_WAIT_FILE_CREATIVE = wait;
    try {
      app = await buildServer({
        uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
        appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
        runner: new ClaudeCodeRunner([process.execPath, join(import.meta.dirname, 'fixtures', 'fake-claude.mjs')], { killGraceMs: 200 }), doctor: async () => [],
        render: fake.engine,
      });
      let release!: () => void;
      fake.gate = new Promise((r) => { release = r; });
      const render = (await post(slug, 1)).json() as JobSummary;
      await waitJob(render.id, (j) => j.progress?.phase === 'frames');
      const turn = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/turns`, headers: H, payload: { text: 'more contrast' } });
      expect(turn.statusCode, turn.body).toBe(202);
      const turnId = turn.json().id as string;
      await waitJob(turnId, (j) => j.state === 'running');
      await new Promise((r) => setTimeout(r, 300)); // the turn's snapshot of earlier outputs is taken
      release();
      expect((await waitJob(render.id)).state).toBe('succeeded'); // written into v1 while the turn runs
      writeFileSync(wait, 'go');
      const t = await waitJob(turnId);
      expect(t.state, t.error).toBe('succeeded');
      const versions = await store.readVersions(slug);
      expect(versions.map((v) => v.n)).toEqual([1, 2]);
      expect(renderState(versions[0]!, 'test-wide')).toBe('rendered');
      const warnings = (await store.readConversation(slug)).filter((e) => e.type === 'system' && e.level !== 'info').map((e) => (e as { text: string }).text);
      expect(warnings).toEqual([]);
    } finally {
      delete process.env.FAKE_CLAUDE_SCENARIO;
      delete process.env.FAKE_CLAUDE_WAIT_FILE_CREATIVE;
    }
  });
});

describe('render plan', () => {
  const c = (format: string, dir: string, hash: string, followsFormat?: string) => ({ format, dir, hash, ...(followsFormat ? { followsFormat } : {}) });
  const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64);
  it('primaries by default, followers of rendered primaries copied, a requested follower stands for its primary', () => {
    const comps = [c('a', 'compositions/a', H1), c('b', 'compositions/a', H1, 'a'), c('d', 'compositions/d', H2)];
    expect(renderPlan(comps, { formats: ['a', 'b', 'd'] })).toEqual({ primaries: ['a', 'd'], followers: { b: 'a' }, fixFollows: {}, unknown: [] });
    expect(renderPlan(comps, { formats: ['a', 'b', 'd'] }, ['b'])).toEqual({ primaries: ['a'], followers: { b: 'a' }, fixFollows: {}, unknown: [] });
    expect(renderPlan(comps, { formats: ['a', 'b', 'd'] }, ['d', 'x'])).toMatchObject({ primaries: ['d'], followers: {}, unknown: ['x'] });
  });
  it('a brief link is a follower only when its entry has the primary\'s very composition', () => {
    const brief = { formats: ['a', 'b', 'e'], links: { b: 'a', e: 'a' } };
    const plan = renderPlan([c('a', 'compositions/a', H1), c('b', 'compositions/a', H1), c('e', 'compositions/e', H2)], brief);
    expect(plan).toEqual({ primaries: ['a', 'e'], followers: { b: 'a' }, fixFollows: { b: 'a' }, unknown: [] });
  });
});

describe('versions.json and the turn\'s earlier-output check while a render runs', () => {
  it('updateVersion and appendVersion from separate stores never lose each other\'s writes', async () => {
    const { slug } = await v2Creative({ formats: ['test-wide'], links: {} });
    const a = new CreativeStore(projectDir()), b = new CreativeStore(projectDir());
    const entry = (n: number): VersionEntry => ({ n, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null });
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => a.appendVersion(slug, entry(i + 2))),
      ...Array.from({ length: 10 }, (_, i) => b.updateVersion(slug, 1, (v) => ({ ...v, tools: [...v.tools, `t${i}`] }))),
    ]);
    const versions = await a.readVersions(slug);
    expect(versions.map((v) => v.n).sort((x, y) => x - y)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    expect(versions.find((v) => v.n === 1)!.tools).toHaveLength(10);
  });

  it('the core\'s own writes into an earlier version and its temp files are not reported as changes', async () => {
    const dir = mkdtempSync(join(base, 'c-'));
    mkdirSync(join(dir, 'outputs', 'v1'), { recursive: true });
    writeFileSync(join(dir, 'outputs', 'v1', 'a.mp4'), 'a');
    const before = await snapshotOutputs(dir, ['v1']);
    writeFileSync(join(dir, 'outputs', 'v1', 'render.mp4'), 'core');
    await noteCoreOutputWrite(dir, 'outputs/v1/render.mp4');
    noteCoreTemp(join(dir, 'outputs', 'v1', '.render.mp4.render-0123456789ab.tmp'));
    writeFileSync(join(dir, 'outputs', 'v1', '.render.mp4.render-0123456789ab.tmp'), 'temp');
    // A temp-looking name the core did not create in this process is reported (M5).
    writeFileSync(join(dir, 'outputs', 'v1', '.x.mp4.render-abcdefabcdef.tmp'), 'agent temp');
    writeFileSync(join(dir, 'outputs', 'v1', 'agent.mp4'), 'agent');
    const after = await snapshotOutputs(dir, ['v1']);
    expect(withoutCoreWrites(dir, snapshotChanges(before, after), after)).toEqual(['outputs/v1/.x.mp4.render-abcdefabcdef.tmp', 'outputs/v1/agent.mp4']);
    // Rewritten after the core's note: reported again.
    writeFileSync(join(dir, 'outputs', 'v1', 'render.mp4'), 'someone else, longer');
    const later = await snapshotOutputs(dir, ['v1']);
    expect(withoutCoreWrites(dir, snapshotChanges(before, later), later)).toEqual(['outputs/v1/.x.mp4.render-abcdefabcdef.tmp', 'outputs/v1/agent.mp4', 'outputs/v1/render.mp4']);
  });
});

describe('startup sweep', () => {
  const old = (p: string) => { const t = new Date(Date.now() - 3600_000); utimesSync(p, t, t); };
  it('removes old render and media temp files of a project, and nothing else', async () => {
    const p = join(base, 'proj');
    const v = join(p, 'creatives', 'c1', 'outputs', 'v2');
    const media = join(p, '.studio', 'cache', 'media');
    mkdirSync(join(v, '.previews'), { recursive: true });
    mkdirSync(media, { recursive: true });
    const files = {
      oldRender: join(v, '.sq.mp4.render-0123456789ab.tmp'), newRender: join(v, '.tall.mp4.render-0123456789ab.tmp'),
      oldPreview: join(v, '.previews', '.sq.mp4.jpg.render-abcdefabcdef.tmp'), output: join(v, 'sq.mp4'), agentTmp: join(v, 'agent.tmp'),
      oldMedia: join(media, `.${'a'.repeat(64)}-30-320x180-n1.0123456789ab.tmp`), cached: join(media, `${'a'.repeat(64)}-30-320x180-n1.mp4`), other: join(media, '.other.tmp'),
      oldRecipe: join(media, `${'b'.repeat(64)}-30-320x180-n0.mp4`),
      oldManifestTmp: join(v, 'manifest.json.0123456789ab.tmp'), oldVersionsTmp: join(p, 'creatives', 'c1', 'versions.json.abcdef012345.tmp'),
      oldHashesTmp: join(p, '.studio', 'cache', 'source-hashes.json.0123456789ab.tmp'), notOurs: join(v, 'manifest.json.xyz.tmp'),
    };
    for (const f of Object.values(files)) writeFileSync(f, 'x');
    for (const k of ['oldRender', 'oldPreview', 'output', 'agentTmp', 'oldMedia', 'cached', 'other', 'oldRecipe', 'oldManifestTmp', 'oldVersionsTmp', 'oldHashesTmp', 'notOurs'] as const) old(files[k]);
    // A creative reached through a link is never swept (M6); neither is one with an active render job.
    const elsewhere = join(base, 'elsewhere', 'outputs', 'v1');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, '.sq.mp4.render-0123456789ab.tmp'), 'x');
    old(join(elsewhere, '.sq.mp4.render-0123456789ab.tmp'));
    symlinkSync(join(base, 'elsewhere'), join(p, 'creatives', 'linked'));
    const busy = join(p, 'creatives', 'busy', 'outputs', 'v1');
    mkdirSync(busy, { recursive: true });
    writeFileSync(join(busy, '.sq.mp4.render-0123456789ab.tmp'), 'x');
    old(join(busy, '.sq.mp4.render-0123456789ab.tmp'));
    const removed = await sweepProjectRenders(p, { skipCreative: (slug) => slug === 'busy' });
    expect(removed.sort()).toEqual([files.oldMedia, files.oldPreview, files.oldRender, files.oldRecipe, files.oldManifestTmp, files.oldVersionsTmp, files.oldHashesTmp].sort());
    expect(existsSync(files.notOurs)).toBe(true);
    expect(readdirSync(elsewhere)).toHaveLength(1);
    expect(readdirSync(busy)).toHaveLength(1);
    for (const k of ['newRender', 'output', 'agentTmp', 'cached', 'other'] as const) expect(lstatSync(files[k]).isFile(), k).toBe(true);
  });

  it('removes only the renderer\'s own temp folders (exact names, owner marker, owner gone); never test fixtures or live ones (I5)', async () => {
    const root = mkdtempSync(join(base, 'tmp-'));
    const mk = (name: string, owner?: number) => { const d = join(root, name); mkdirSync(d); if (owner !== undefined) writeFileSync(join(d, 'owner.pid'), String(owner)); return d; };
    const dead = mk('ms-render-Ab12cD', 999_999);
    const profile = mk('ms-render-chrome-xyz789', 999_999);
    const media = mk('ms-render-media-q1W2e3', 999_999);
    const unmarked = mk('ms-render-zzzzzz');
    writeFileSync(join(unmarked, 'something'), 'x'); // not empty and no marker: not provably ours
    const emptyCrash = mk('ms-render-e0e0e0'); // made, never marked (a crash between the two): empty, removed
    const live = mk('ms-render-live01', process.pid);
    const recent = mk('ms-render-new001', 999_999);
    // Test fixtures and other tools: never, marker or not.
    const fixtures = ['ms-render-jobs-AbCdEf', 'ms-render-proc-AbCdEf', 'ms-render-media-AbCdEfG', 'ms-test-render-AbCdEf', 'something-else'].map((n) => mk(n, 999_999));
    for (const d of [dead, profile, media, unmarked, emptyCrash, live, ...fixtures]) old(d);
    const removed = await sweepRenderTempDirs({ root });
    expect(removed.sort()).toEqual([dead, profile, media, emptyCrash].sort());
    expect(readdirSync(root).sort()).toEqual([unmarked, live, recent, ...fixtures].map((d) => basename(d)).sort());
  });
});

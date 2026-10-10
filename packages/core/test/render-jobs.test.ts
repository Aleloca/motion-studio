// @vitest-environment node
/**
 * Render jobs (Task 5) with a fake render engine (the real renderer is covered by render-jobs.chrome.test.ts): the route
 * (auth, origin, errors), one job per request, progress, cancel, the records (versions.json outputs with sha256 and
 * fromComposition, the manifest v2 renders[], renderState), followers by copy, old renders kept, the versions.json lock,
 * the turn's earlier-output check, and the startup sweep of leftovers.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { renderPlan } from '../src/creatives/render-jobs.ts';
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
}
function fakeEngine(): Fake {
  const f: Fake = { calls: [], gate: null, fail: {}, kind: 'injected', engine: null as unknown as RenderEngine };
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
        await rename(temp, o.out);
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
  base = mkdtempSync(join(tmpdir(), 'ms-render-jobs-'));
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
    writeFileSync(join(dir, 'outputs', 'v1', '.render.mp4.render-0123456789ab.tmp'), 'temp');
    writeFileSync(join(dir, 'outputs', 'v1', 'agent.mp4'), 'agent');
    const after = await snapshotOutputs(dir, ['v1']);
    expect(withoutCoreWrites(dir, snapshotChanges(before, after), after)).toEqual(['outputs/v1/agent.mp4']);
    // Rewritten after the core's note: reported again.
    writeFileSync(join(dir, 'outputs', 'v1', 'render.mp4'), 'someone else, longer');
    const later = await snapshotOutputs(dir, ['v1']);
    expect(withoutCoreWrites(dir, snapshotChanges(before, later), later)).toEqual(['outputs/v1/agent.mp4', 'outputs/v1/render.mp4']);
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
      oldMedia: join(media, `.${'a'.repeat(64)}-30-320.0123456789ab.tmp`), cached: join(media, `${'a'.repeat(64)}-30-320.mp4`), other: join(media, '.other.tmp'),
    };
    for (const f of Object.values(files)) writeFileSync(f, 'x');
    for (const k of ['oldRender', 'oldPreview', 'output', 'agentTmp', 'oldMedia', 'cached', 'other'] as const) old(files[k]);
    const removed = await sweepProjectRenders(p);
    expect(removed.sort()).toEqual([files.oldMedia, files.oldPreview, files.oldRender].sort());
    for (const k of ['newRender', 'output', 'agentTmp', 'cached', 'other'] as const) expect(lstatSync(files[k]).isFile(), k).toBe(true);
  });

  it('removes old, unused ms-render-* folders of the temp folder; keeps live, recent and foreign ones', async () => {
    const root = mkdtempSync(join(base, 'tmp-'));
    const mk = (name: string, owner?: number) => { const d = join(root, name); mkdirSync(d); if (owner !== undefined) writeFileSync(join(d, 'owner.pid'), String(owner)); return d; };
    const dead = mk('ms-render-abc123', 999_999);
    const profile = mk('ms-render-chrome-xyz789');
    const live = mk('ms-render-live01', process.pid);
    const recent = mk('ms-render-new001');
    const foreign = mk('something-else');
    for (const d of [dead, profile, live, foreign]) old(d);
    const removed = await sweepRenderTempDirs({ root });
    expect(removed.sort()).toEqual([dead, profile].sort());
    expect(readdirSync(root).sort()).toEqual([basename(live), basename(recent), basename(foreign)].sort());
  });
});

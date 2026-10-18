// @vitest-environment node
/**
 * Export in the background (decision 974, user reports 20 and 22), with a fake render engine: `background: true` answers with
 * an export job at once (the request's refusals still come at once), the job renders what is missing and copies into the
 * folder, and reports the files; a cancel stops it and the renders it started (never one another request started); another
 * quality or resolution is rendered for the export alone, never recorded in the version; a version render made before the
 * quality choice is rendered again for a default export; the render records its quality, size and encoder.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaledSize, type FormatPreset, type JobSummary, type ManifestV2 } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { noteCoreTemp } from '../src/core-temps.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { Git } from '../src/git.ts';
import { RenderError } from '../src/render/errors.ts';
import type { RenderCompositionOptions, RenderEngine, RenderResult } from '../src/render/renderer.ts';
import { buildServer } from '../src/server/app.ts';

const TOKEN = 'cd'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const PRESETS: FormatPreset[] = [
  { id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 },
  { id: 'test-wide-b', channel: 'Test', name: 'Wide B', width: 320, height: 180, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 },
  { id: 'test-still', channel: 'Test', name: 'Still', width: 320, height: 180, kind: 'image', extensions: ['png', 'jpg'] },
];
const comp = (w: number, h: number, duration: number, fill = '#ff0000') => ({
  $schema: 'motion-studio/composition@1', width: w, height: h, fps: 30, duration, background: '#101010', fonts: [],
  scenes: duration > 0 ? [{ id: 's', start: 0, duration }] : [],
  tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'box', type: 'shape', start: 0, duration, props: { x: 10, y: 10, width: 100, height: 50, fill } }] }],
});

interface Fake { engine: RenderEngine; calls: RenderCompositionOptions[]; gate: Promise<void> | null }
/** A render engine that writes a small file per render, at the size and quality asked for; `gate` holds every render. */
function fakeEngine(): Fake {
  const f: Fake = { calls: [], gate: null, engine: null as unknown as RenderEngine };
  f.engine = {
    info: async () => ({ kind: 'injected' }),
    provider: async () => { throw new Error('not used'); },
    render: async (o: Omit<RenderCompositionOptions, 'provider'>): Promise<RenderResult> => {
      f.calls.push(o as RenderCompositionOptions);
      const still = !(o.composition.duration > 0);
      const total = still ? 1 : Math.round(o.composition.duration * o.composition.fps);
      o.onProgress?.({ frames: 1, total });
      const temp = join(dirname(o.out), `.${basename(o.out)}.render-${randomBytes(6).toString('hex')}.tmp`);
      noteCoreTemp(temp);
      try {
        if (f.gate) {
          await Promise.race([f.gate, new Promise((_, reject) => {
            if (o.signal.aborted) reject(new RenderError('cancelled', 'cancelled'));
            o.signal.addEventListener('abort', () => reject(new RenderError('cancelled', 'cancelled')), { once: true });
          })]);
        }
        const size = still ? { width: o.composition.width, height: o.composition.height } : scaledSize(o.composition, o.short);
        const body = `render of ${o.format.id} ${size.width}x${size.height} ${o.quality ?? '-'} ${randomBytes(4).toString('hex')}`;
        await writeFile(temp, body);
        await o.beforeRename?.(temp);
        await rename(temp, o.out);
        return { file: o.out, sha256: createHash('sha256').update(body).digest('hex'), ...size, durationSec: still ? null : o.composition.duration, frames: total,
          encoder: still ? null : 'libx264', ...(still ? {} : { quality: o.quality ?? 'high' }), audio: false, warnings: [] };
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

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'ms-test-export-jobs-'));
  fake = fakeEngine();
  app = await buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, '-e', ''], { killGraceMs: 200 }), doctor: async () => [], render: fake.engine,
  });
  ws = join(base, 'ws');
  await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: ws } });
  await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } });
  expect((await app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: PRESETS } })).statusCode).toBe(200);
});
afterEach(async () => { await app?.close(); rmSync(base, { recursive: true, force: true }); });

/** A creative with a v2 version 1: a composition per primary, the follower sharing its primary's. */
async function v2Creative(formats = ['test-wide', 'test-wide-b', 'test-still'], links: Record<string, string> = { 'test-wide-b': 'test-wide' }) {
  const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
    title: 'Launch', generate: false, brief: { goal: 'g', message: '', formats, durationSec: 1, assets: [], notes: '', links },
  } });
  expect(r.statusCode, r.body).toBe(201);
  const slug = r.json().slug as string;
  const store = new CreativeStore(join(ws, 'acme'));
  const vdir = store.outputsDir(slug, 1);
  const compositions: Array<{ format: string; dir: string; hash: string; followsFormat?: string; problems: string[] }> = [];
  for (const f of formats.filter((x) => !links[x])) {
    const preset = PRESETS.find((p) => p.id === f)!;
    const dir = join(vdir, 'compositions', f);
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'composition.json'), JSON.stringify(comp(preset.width, preset.height, preset.kind === 'image' ? 0 : 1)));
    compositions.push({ format: f, dir: `compositions/${f}`, hash: (await readCompositionFolder(dir)).hash, problems: [] });
  }
  for (const [f, p] of Object.entries(links)) {
    const primary = compositions.find((c) => c.format === p)!;
    compositions.push({ format: f, dir: primary.dir, hash: primary.hash, followsFormat: p, problems: [] });
  }
  writeFileSync(join(vdir, 'manifest.json'), JSON.stringify({ schemaVersion: 2, compositions, renders: [] } satisfies ManifestV2));
  await store.appendVersion(slug, {
    n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', outputs: [], problems: [], tools: [],
    renderCommand: null, basedOn: null, compositions,
  });
  return { slug, store, dir: store.dir(slug) };
}

const jobs = async () => (await app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[];
async function waitJob(id: string, until: (j: JobSummary) => boolean = (j) => j.state !== 'queued' && j.state !== 'running'): Promise<JobSummary> {
  for (let i = 0; i < 1500; i++) {
    const j = (await jobs()).find((x) => x.id === id);
    if (j && until(j)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for the job');
}
const exportUrl = (slug: string) => `/api/projects/acme/creatives/${slug}/export`;
const startExport = async (slug: string, payload: Record<string, unknown>) => {
  const r = await app.inject({ method: 'POST', url: exportUrl(slug), headers: H, payload: { background: true, quality: 'high', ...payload } });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { job: JobSummary }).job;
};
const renderVersion = async (slug: string, formats?: string[]) => {
  const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: formats ? { formats } : {} });
  expect(r.statusCode, r.body).toBe(202);
  return r.json() as JobSummary;
};

describe('export jobs (decision 974)', { timeout: 120_000 }, () => {
  it('answers with the job at once; the job renders what is missing, copies, and reports the files; the render records quality, size and encoder', async () => {
    const { slug, store, dir } = await v2Creative();
    const dest = join(base, 'out');
    const job = await startExport(slug, { destination: dest, picks: { 'test-wide': 1, 'test-still': 1 }, follow: { 'test-wide-b': 1 } });
    expect(job).toMatchObject({ kind: 'export', label: 'Export · Launch' });
    expect(job.key).toMatch(new RegExp(`^export:.*:acme:${slug}:[0-9a-f]{8}$`));
    const done = await waitJob(job.id);
    expect(done.state, done.error).toBe('succeeded');
    expect(done.export).toMatchObject({ stage: 'done', pct: 100, destination: dest });
    expect(done.export!.files!.map((f) => basename(f)).sort()).toEqual(['launch-test-still-v1.png', 'launch-test-wide-b-v1.mp4', 'launch-test-wide-v1.mp4']);
    expect(done.export!.renders).toHaveLength(1);
    const render = (await jobs()).find((j) => j.id === done.export!.renders![0])!;
    expect(render).toMatchObject({ kind: 'render', state: 'succeeded' });
    expect(readdirSync(dest).sort()).toEqual(['launch-test-still-v1.png', 'launch-test-wide-b-v1.mp4', 'launch-test-wide-v1.mp4']);
    // The version's render is at the default quality, recorded with its encoder (the follower carries its primary's).
    expect(fake.calls.map((c) => [c.format.id, c.quality, c.short])).toEqual([['test-wide', 'high', undefined], ['test-still', 'high', undefined]]);
    const v = (await store.readVersions(slug))[0]!;
    const rec = { quality: 'high', width: 320, height: 180, encoder: 'libx264' };
    expect(v.outputs.find((o) => o.format === 'test-wide')!.render).toEqual(rec);
    expect(v.outputs.find((o) => o.format === 'test-wide-b')!.render).toEqual(rec);
    expect(v.outputs.find((o) => o.format === 'test-still')!.render).toBeUndefined();
    const m = JSON.parse(readFileSync(join(dir, 'outputs', 'v1', 'manifest.json'), 'utf8')) as ManifestV2;
    expect(m.renders.find((r) => r.format === 'test-wide')!.render).toEqual(rec);
  });

  it('a bad request is refused at once, never as a failed job', async () => {
    const { slug } = await v2Creative();
    const rel = await app.inject({ method: 'POST', url: exportUrl(slug), headers: H, payload: { background: true, destination: 'relative/out', picks: { 'test-wide': 1 } } });
    expect(rel.statusCode).toBe(400);
    const nofile = await app.inject({ method: 'POST', url: exportUrl(slug), headers: H, payload: { background: true, destination: join(base, 'o'), picks: { 'test-wide': 7 } } });
    expect(nofile.statusCode).toBe(400);
    expect(nofile.json().code).toBe('export-pick-no-file');
    const profile = await app.inject({ method: 'POST', url: exportUrl(slug), headers: H, payload: { background: true, destination: join(base, 'o'), picks: { 'test-wide': 1 }, resolution: 900 } });
    expect(profile.statusCode).toBe(400);
    expect((await jobs()).filter((j) => j.kind === 'export')).toEqual([]);
  });

  it('cancel: the export and the render it started stop, nothing is written', async () => {
    const { slug } = await v2Creative();
    let release!: () => void;
    fake.gate = new Promise((r) => { release = r; });
    const dest = join(base, 'out');
    const job = await startExport(slug, { destination: dest, picks: { 'test-wide': 1 } });
    const waiting = await waitJob(job.id, (j) => (j.export?.renders?.length ?? 0) > 0);
    const renderId = waiting.export!.renders![0]!;
    await waitJob(renderId, (j) => j.state === 'running');
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: H })).json()).toEqual({ cancelled: true });
    expect((await waitJob(job.id)).state).toBe('cancelled');
    expect((await waitJob(renderId)).state).toBe('cancelled');
    expect(existsSync(dest)).toBe(false);
    release();
  });

  it('a cancelled export leaves alone a render another request started', async () => {
    const { slug } = await v2Creative();
    let release!: () => void;
    fake.gate = new Promise((r) => { release = r; });
    const agent = await renderVersion(slug, ['test-wide']);
    await waitJob(agent.id, (j) => j.state === 'running');
    const job = await startExport(slug, { destination: join(base, 'out'), picks: { 'test-wide': 1 } });
    await waitJob(job.id, (j) => (j.export?.renders ?? []).includes(agent.id));
    await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: H });
    expect((await waitJob(job.id)).state).toBe('cancelled');
    expect((await jobs()).find((j) => j.id === agent.id)!.state).toBe('running');
    release();
    expect((await waitJob(agent.id)).state).toBe('succeeded');
  });

  it('another resolution or quality is rendered for the export alone, at that size; the version keeps its own render', async () => {
    const { slug, store } = await v2Creative();
    await waitJob((await renderVersion(slug)).id);
    const before = (await store.readVersions(slug))[0]!.outputs;
    const calls = fake.calls.length;
    const dest = join(base, 'out');
    const job = await startExport(slug, { destination: dest, picks: { 'test-wide': 1, 'test-still': 1 }, follow: { 'test-wide-b': 1 }, resolution: 480, quality: 'max', pattern: '{format}' });
    const done = await waitJob(job.id);
    expect(done.state, done.error).toBe('succeeded');
    // One render for the export (the follower takes its primary's file); the still is copied as it is.
    const made = fake.calls.slice(calls);
    expect(made.map((c) => [c.format.id, c.quality, c.short])).toEqual([['test-wide', 'max', 480]]);
    expect(made[0]!.out.includes(join('outputs', 'v1'))).toBe(false);
    const exportRender = (await jobs()).find((j) => j.id === done.export!.renders![0])!;
    expect(exportRender.key).toMatch(new RegExp(`^render-export:.*:acme:${slug}:v1:[0-9a-f]{8}$`));
    expect(exportRender.label).toMatch(/ · Launch v1 \(480p · /);
    expect(readdirSync(dest).sort()).toEqual(['test-still.png', 'test-wide-b.mp4', 'test-wide.mp4']);
    expect(readFileSync(join(dest, 'test-wide.mp4'), 'utf8')).toContain('854x480 max');
    expect(readFileSync(join(dest, 'test-wide-b.mp4'), 'utf8')).toContain('854x480 max');
    // Nothing recorded in the version, and the export's temp folder is gone.
    expect((await store.readVersions(slug))[0]!.outputs).toEqual(before);
    expect(existsSync(dirname(dirname(made[0]!.out)))).toBe(false);
    // The default export again uses the version's own render (no new render): a render at another size never stands in.
    const again = await startExport(slug, { destination: join(base, 'out2'), picks: { 'test-wide': 1 } });
    expect((await waitJob(again.id)).state).toBe('succeeded');
    expect(fake.calls.length).toBe(calls + 1);
  });

  it('a version render made before the quality choice: copied for a standard export, rendered again at high for the default', async () => {
    const { slug, store } = await v2Creative(['test-wide'], {});
    await waitJob((await renderVersion(slug)).id);
    // As a render made before decision 974: no record of its quality.
    await store.updateVersion(slug, 1, (v) => ({ ...v, outputs: v.outputs.map(({ render: _r, ...o }) => o) }));
    const calls = fake.calls.length;
    const standard = await startExport(slug, { destination: join(base, 's'), picks: { 'test-wide': 1 }, quality: 'standard' });
    expect((await waitJob(standard.id)).state).toBe('succeeded');
    expect(fake.calls.length).toBe(calls);
    const high = await startExport(slug, { destination: join(base, 'h'), picks: { 'test-wide': 1 } });
    expect((await waitJob(high.id)).state).toBe('succeeded');
    expect(fake.calls.slice(calls).map((c) => [c.format.id, c.quality, c.out.includes(join('outputs', 'v1'))])).toEqual([['test-wide', 'high', true]]);
    expect((await store.readVersions(slug))[0]!.outputs[0]!.render?.quality).toBe('high');
  });

  it('review #1: a follower exported alone after a primary render made before the quality choice: the primary is rendered again, then the follower is copied', async () => {
    const { slug, store } = await v2Creative(['test-wide', 'test-wide-b'], { 'test-wide-b': 'test-wide' });
    await waitJob((await renderVersion(slug)).id);
    await store.updateVersion(slug, 1, (v) => ({ ...v, outputs: v.outputs.map(({ render: _r, ...o }) => o) }));
    const calls = fake.calls.length;
    const job = await startExport(slug, { destination: join(base, 'g'), picks: {}, follow: { 'test-wide-b': 1 } });
    const done = await waitJob(job.id);
    expect(done.state, done.error).toBe('succeeded');
    expect(fake.calls.slice(calls).map((c) => c.format.id)).toEqual(['test-wide']);
    expect((await store.readVersions(slug))[0]!.outputs.map((o) => [o.format, o.render?.quality]).sort()).toEqual([['test-wide', 'high'], ['test-wide-b', 'high']]);
  });
});

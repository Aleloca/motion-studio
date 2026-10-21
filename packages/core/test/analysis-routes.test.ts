import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EMPTY_BRIEF_FORM, type BriefSessionView, type VideoAnalysisView } from '@motion-studio/shared';
import { parseSidecar } from '../src/analysis/sidecar.ts';
import type { MediaTools } from '../src/media/media-tools.ts';
import type { CommandExec, CommandResult } from '../src/exec.ts';
import { analysisApp, analysisHelpers, wholeWrite, type AnalysisApp } from './helpers/analysis-app.ts';
import { hasFfmpeg, twoScenes } from './helpers/analysis-fixtures.ts';

const A = '/api/projects/acme/video-analyses';
const brief = { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1'], durationSec: 10, assets: [] as string[], notes: '' };
let fx: { silent: string; other: string };
beforeAll(async () => {
  if (!hasFfmpeg) return;
  const dir = await mkdtemp(join(tmpdir(), 'ms-ar-fx-'));
  fx = { silent: await twoScenes(join(dir, 'silent.mp4'), 'silent'), other: await twoScenes(join(dir, 'other.mp4'), 'none') };
}, 60_000);

async function setup() {
  const t = await analysisApp();
  const h = analysisHelpers(t);
  await copyFile(fx.silent, join(t.projectDir, 'assets', 'clip.mp4'));
  await copyFile(fx.other, join(t.projectDir, 'assets', 'second.mp4'));
  await writeFile(join(t.projectDir, 'assets', 'logo.png'), 'png');
  return { t, h };
}
const create = (t: AnalysisApp, assets: string[]) => t.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Lancio', brief: { ...brief, assets }, generate: false } });
/** Finishes the n-th analysis run with a full write. */
async function finishRun(t: AnalysisApp, h: ReturnType<typeof analysisHelpers>, n: number) {
  const run = await t.runner.next(n);
  expect((await h.tool(run, 'write_video_analysis', wholeWrite(8))).statusCode).toBe(200);
  run.finish({ write: false });
  await vi.waitFor(async () => expect((await h.analysisJobs()).every((j) => j.state !== 'queued' && j.state !== 'running')).toBe(true));
}

describe.skipIf(!hasFfmpeg)('video analysis routes and triggers', () => {
  it('a creative whose brief holds a video queues one analysis; a brief adding one queues it, removing one queues nothing', async () => {
    const { t, h } = await setup();
    const res = await create(t, ['assets/clip.mp4', 'assets/logo.png']);
    expect(res.statusCode).toBe(201);
    const slug = res.json().slug as string;
    await vi.waitFor(async () => expect(await h.analysisJobs()).toHaveLength(1));
    await finishRun(t, h, 0);
    expect((await t.app.inject(`${A}/view?file=assets/clip.mp4`)).json()).toMatchObject({ state: 'ready' });
    const put = await t.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, payload: { brief: { ...brief, assets: ['assets/clip.mp4', 'assets/second.mp4'] } } });
    expect(put.statusCode).toBe(200);
    await vi.waitFor(async () => expect(await h.analysisJobs()).toHaveLength(2));
    await finishRun(t, h, 1);
    await t.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, payload: { brief: { ...brief, assets: ['assets/second.mp4'] } } });
    await new Promise((r) => setTimeout(r, 100));
    expect(await h.analysisJobs()).toHaveLength(2);
  }, 60_000);

  it('a brief session queues the videos of its context; fill_brief with the same video makes no second job', async () => {
    const { t, h } = await setup();
    const open = (await t.app.inject({ method: 'POST', url: '/api/projects/acme/brief-session', payload: { form: EMPTY_BRIEF_FORM, userEdited: [] } })).json() as BriefSessionView;
    const id = open.id;
    const ctx = await t.app.inject({ method: 'PUT', url: `/api/projects/acme/brief-session/${id}/context`, payload: { codebases: [], assets: ['assets/clip.mp4'] } });
    expect(ctx.statusCode).toBe(200);
    await vi.waitFor(async () => expect(await h.analysisJobs()).toHaveLength(1));
    const sent = await t.app.inject({ method: 'POST', url: `/api/projects/acme/brief-session/${id}/messages`, payload: { clientId: 'c1', text: 'Usa il video', context: { codebases: [], assets: ['assets/clip.mp4'] }, form: EMPTY_BRIEF_FORM, userEdited: [], baseRevision: 0 } });
    expect(sent.statusCode).toBe(202);
    await t.runner.next(1);
    const analysisRun = t.runner.runs.find((r) => r.req.prompt.includes('write_video_analysis'))!;
    const briefRun = t.runner.runs.find((r) => r !== analysisRun)!;
    expect(briefRun.req.prompt).toContain('fill_brief');
    expect((await h.tool(briefRun, 'fill_brief', { assets: ['assets/clip.mp4'] })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(await h.analysisJobs()).toHaveLength(1);
    briefRun.finish({ write: false });
    await h.tool(analysisRun, 'write_video_analysis', wholeWrite(8));
    analysisRun.finish({ write: false });
  }, 60_000);

  it('Rianalizza an edited analysis asks first; the edit keeps the hash; a stale edited analysis is not re-analysed automatically', async () => {
    const { t, h } = await setup();
    expect((await t.app.inject({ method: 'POST', url: A, payload: { file: 'assets/clip.mp4' } })).statusCode).toBe(202);
    await finishRun(t, h, 0);
    const before = parseSidecar(await readFile(join(t.projectDir, 'assets/.analysis/clip.mp4.md'), 'utf8'))!;
    const edited = await t.app.inject({ method: 'PUT', url: `${A}/body`, payload: { file: 'assets/clip.mp4', body: '## Summary\nMine.' } });
    expect(edited.statusCode).toBe(200);
    expect((edited.json() as VideoAnalysisView).header).toEqual({ ...before.header, edited: true });
    const refused = await t.app.inject({ method: 'POST', url: A, payload: { file: 'assets/clip.mp4' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('analysis-edited');
    // The video changes, then enters a creative's brief: the user's edit is never overwritten silently.
    await copyFile(fx.other, join(t.projectDir, 'assets', 'clip.mp4'));
    await create(t, ['assets/clip.mp4']);
    await new Promise((r) => setTimeout(r, 150));
    expect(await h.analysisJobs()).toHaveLength(1);
    expect((await t.app.inject(`${A}/view?file=assets/clip.mp4`)).json()).toMatchObject({ state: 'stale', header: { edited: true } });
    expect((await t.app.inject({ method: 'POST', url: A, payload: { file: 'assets/clip.mp4', overwrite: true } })).statusCode).toBe(202);
    expect(await h.analysisJobs()).toHaveLength(2);
    await finishRun(t, h, 1);
    expect((await t.app.inject(`${A}/view?file=assets/clip.mp4`)).json()).toMatchObject({ state: 'ready', header: { edited: false } });
  }, 60_000);

  it('rename during a running analysis: the job is cancelled and no analysis file is written under either name', async () => {
    const { t, h } = await setup();
    await t.app.inject({ method: 'POST', url: '/api/projects/acme/assets/register', payload: { files: ['clip.mp4'] } });
    await t.app.inject({ method: 'POST', url: A, payload: { file: 'assets/clip.mp4' } });
    const run = await t.runner.next(0);
    const renamed = await t.app.inject({ method: 'PATCH', url: '/api/projects/acme/assets/item/clip.mp4', payload: { name: 'intro.mp4' } });
    expect(renamed.statusCode).toBe(200);
    await vi.waitFor(async () => expect((await h.analysisJobs())[0]!.state).toBe('cancelled'));
    // The run's bridge access ended with the job: a late write reaches nothing.
    await h.tool(run, 'write_video_analysis', wholeWrite(8)).catch(() => null);
    run.finish({ write: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(await readFile(join(t.projectDir, 'assets/.analysis/clip.mp4.md'), 'utf8').catch(() => null)).toBeNull();
    expect(await readFile(join(t.projectDir, 'assets/.analysis/intro.mp4.md'), 'utf8').catch(() => null)).toBeNull();
  }, 60_000);

  it('a user edit made while an analysis runs is kept (decision 1539)', async () => {
    const { t, h } = await setup();
    await t.app.inject({ method: 'POST', url: A, payload: { file: 'assets/clip.mp4' } });
    await finishRun(t, h, 0);
    expect((await t.app.inject({ method: 'POST', url: A, payload: { file: 'assets/clip.mp4' } })).statusCode).toBe(202);
    const run = await t.runner.next(1);
    expect((await t.app.inject({ method: 'PUT', url: `${A}/body`, payload: { file: 'assets/clip.mp4', body: '## Summary\nMine.' } })).statusCode).toBe(200);
    expect((await h.tool(run, 'write_video_analysis', wholeWrite(8))).statusCode).toBe(200);
    run.finish({ write: false });
    await vi.waitFor(async () => expect((await h.analysisJobs()).every((j) => j.state !== 'queued' && j.state !== 'running')).toBe(true));
    expect((await h.analysisJobs()).map((j) => j.state)).toEqual(['succeeded', 'succeeded']);
    const kept = parseSidecar(await readFile(join(t.projectDir, 'assets/.analysis/clip.mp4.md'), 'utf8'))!;
    expect(kept.header.edited).toBe(true);
    expect(kept.body).toBe('## Summary\nMine.\n');
  }, 60_000);

  it('a rename that fails stops nothing (decision 1537)', async () => {
    const { t, h } = await setup();
    await t.app.inject({ method: 'POST', url: '/api/projects/acme/assets/register', payload: { files: ['clip.mp4', 'second.mp4'] } });
    await t.app.inject({ method: 'POST', url: A, payload: { file: 'assets/clip.mp4' } });
    await t.runner.next(0);
    const refused = await t.app.inject({ method: 'PATCH', url: '/api/projects/acme/assets/item/clip.mp4', payload: { name: 'second.mp4' } });
    expect(refused.statusCode).toBe(409);
    expect((await h.analysisJobs())[0]!.state).toBe('running');
    await finishRun(t, h, 0);
    expect((await t.app.inject(`${A}/view?file=assets/clip.mp4`)).json()).toMatchObject({ state: 'ready' });
  }, 60_000);

  it('lists the library videos and refuses what is not one', async () => {
    const { t } = await setup();
    await t.app.inject({ method: 'POST', url: '/api/projects/acme/assets/register', payload: { files: ['clip.mp4', 'logo.png'] } });
    expect((await t.app.inject(`${A}/view?file=assets/logo.png`)).statusCode).toBe(400);
    expect((await t.app.inject(`${A}/view?file=assets/missing.mp4`)).statusCode).toBe(404);
    expect((await t.app.inject('/api/projects/nope/video-analyses')).statusCode).toBe(404);
    expect((await t.app.inject(`${A}/view?file=assets/clip.mp4`)).json()).toMatchObject({ state: 'none', file: 'assets/clip.mp4' });
  }, 60_000);
});

describe('confirm-long', () => {
  it('releases the held job', async () => {
    const ok = (): CommandResult => ({ code: 0, stdout: '', stderr: '', notFound: false });
    const ff: CommandExec = async (_cmd, args) => { if (args.includes('mjpeg')) await writeFile(args.at(-1)!, 'jpeg'); return ok(); };
    const t = await analysisApp({ media: (real: MediaTools) => ({ ...real, available: true, probe: async () => ({ width: 640, height: 360, durationSec: 1300, fps: 25, audio: false }) }), ffExec: ff });
    const h = analysisHelpers(t);
    await writeFile(join(t.projectDir, 'assets', 'talk.mp4'), 'fake');
    const queued = await t.app.inject({ method: 'POST', url: A, payload: { file: 'assets/talk.mp4' } });
    expect(queued.json()).toMatchObject({ state: 'waiting', pending: { kind: 'long' } });
    expect((await h.analysisJobs())[0]).toMatchObject({ waitReason: 'video-long' });
    const confirmed = await t.app.inject({ method: 'POST', url: `${A}/confirm-long`, payload: { file: 'assets/talk.mp4', density: 'reduced' } });
    expect(confirmed.statusCode).toBe(200);
    await t.runner.next(0);
    expect((await h.analysisJobs())[0]).toMatchObject({ state: 'running' });
    expect((await t.app.inject({ method: 'DELETE', url: `${A}?file=assets/talk.mp4` })).json()).toEqual({ cancelled: true });
  });
});

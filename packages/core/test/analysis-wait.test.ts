import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { messages, type ConversationEntry, type MediaInfo } from '@motion-studio/shared';
import type { CommandExec, CommandResult } from '../src/exec.ts';
import type { MediaTools } from '../src/media/media-tools.ts';
import { analysisApp, analysisHelpers, wholeWrite, type AnalysisApp } from './helpers/analysis-app.ts';
import { hasFfmpeg, twoScenes } from './helpers/analysis-fixtures.ts';

const it_ = messages('it');
const brief = { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1'], durationSec: 10, assets: [] as string[], notes: '' };
const LINE = 'assets/clip.mp4 (analysis: assets/.analysis/clip.mp4.md — read it before opening the video)';
let silent = '';
beforeAll(async () => {
  if (!hasFfmpeg) return;
  silent = await twoScenes(join(await mkdtemp(join(tmpdir(), 'ms-aw-fx-')), 'silent.mp4'), 'silent');
}, 60_000);

const create = async (t: AnalysisApp, assets: string[]) => {
  const res = await t.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Lancio', brief: { ...brief, assets }, generate: true } });
  expect(res.statusCode).toBe(201);
  return res.json().slug as string;
};
const conversation = async (t: AnalysisApp, slug: string) => (await t.app.inject(`/api/projects/acme/creatives/${slug}/conversation`)).json() as ConversationEntry[];
const isAnalysis = (prompt: string) => prompt.includes('write_video_analysis');
/** The run of the creative turn, once it started. */
const creativeRun = (t: AnalysisApp) => t.runner.runs.find((r) => !isAnalysis(r.req.prompt));
const settle = async (t: AnalysisApp, h: ReturnType<typeof analysisHelpers>) => {
  await vi.waitFor(() => expect(creativeRun(t)).toBeDefined(), { timeout: 10_000 });
  // The fake outputs fail the real media checks: the turn's repair attempts are finished too, until nothing runs.
  await vi.waitFor(async () => {
    for (const r of t.runner.runs) if (!isAnalysis(r.req.prompt)) r.finish();
    expect((await h.jobs()).every((j) => j.state !== 'queued' && j.state !== 'running')).toBe(true);
  }, { timeout: 20_000, interval: 50 });
};

describe.skipIf(!hasFfmpeg)('the first turn and the analyses of its videos (decision 1478)', () => {
  it('the first turn waits and then reads the analysis', async () => {
    const t = await analysisApp();
    const h = analysisHelpers(t);
    await copyFile(silent, join(t.projectDir, 'assets', 'clip.mp4'));
    const slug = await create(t, ['assets/clip.mp4']);
    const analysis = await t.runner.next(0);
    expect(isAnalysis(analysis.req.prompt)).toBe(true);
    await vi.waitFor(async () => expect((await conversation(t, slug)).some((e) => e.type === 'system' && e.analysisWait)).toBe(true));
    const wait = (await conversation(t, slug)).find((e) => e.type === 'system' && e.analysisWait);
    expect(wait).toMatchObject({ text: it_.videoAnalysis.waiting({ files: 'clip.mp4' }), analysisWait: { files: ['clip.mp4'] } });
    expect((await t.app.inject(`/api/projects/acme/creatives/${slug}/analysis-wait`)).json()).toEqual({ files: ['clip.mp4'] });
    expect(t.sent.some((m) => m.type === 'analysis-wait' && m.files.length === 1)).toBe(true);
    expect((await h.jobs()).find((j) => j.kind === 'creative')!.state).toBe('running');
    expect(creativeRun(t)).toBeUndefined();
    await h.tool(analysis, 'write_video_analysis', wholeWrite(8));
    analysis.finish({ write: false });
    await vi.waitFor(() => expect(creativeRun(t)).toBeDefined());
    expect(creativeRun(t)!.req.prompt).toContain(LINE);
    expect(t.sent.some((m) => m.type === 'analysis-wait' && m.files.length === 0)).toBe(true);
    await settle(t, h);
  }, 60_000);

  it('Salta starts the turn without the analysis', async () => {
    const t = await analysisApp();
    const h = analysisHelpers(t);
    await copyFile(silent, join(t.projectDir, 'assets', 'clip.mp4'));
    const slug = await create(t, ['assets/clip.mp4']);
    const analysis = await t.runner.next(0);
    await vi.waitFor(async () => expect((await t.app.inject(`/api/projects/acme/creatives/${slug}/analysis-wait`)).json().files).toEqual(['clip.mp4']));
    expect((await t.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/analysis-wait/skip` })).statusCode).toBe(204);
    await vi.waitFor(() => expect(creativeRun(t)).toBeDefined());
    expect(creativeRun(t)!.req.prompt).toContain('- Assets to use (project paths): assets/clip.mp4\n');
    expect((await conversation(t, slug)).some((e) => e.type === 'system' && e.text === it_.videoAnalysis.skipped({ files: 'clip.mp4' }))).toBe(true);
    expect((await t.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/analysis-wait/skip` })).statusCode).toBe(404);
    await h.tool(analysis, 'write_video_analysis', wholeWrite(8));
    analysis.finish({ write: false });
    await settle(t, h);
  }, 60_000);

  it('a failed analysis never blocks the turn; a second turn never waits', async () => {
    const t = await analysisApp();
    const h = analysisHelpers(t);
    await copyFile(silent, join(t.projectDir, 'assets', 'clip.mp4'));
    const slug = await create(t, ['assets/clip.mp4']);
    const analysis = await t.runner.next(0);
    analysis.finish({ write: false });
    await vi.waitFor(() => expect(creativeRun(t)).toBeDefined());
    expect(creativeRun(t)!.req.prompt).toContain('- Assets to use (project paths): assets/clip.mp4\n');
    await settle(t, h);
    // The video changes: a second turn does not wait for anything (only the first turn does).
    await writeFile(join(t.projectDir, 'assets', 'clip.mp4'), 'changed');
    const before = t.runner.runs.length;
    const res = await t.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/turns`, payload: { text: 'Più veloce', pins: [] } });
    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => expect(t.runner.runs.length).toBe(before + 1));
    expect(isAnalysis(t.runner.runs.at(-1)!.req.prompt)).toBe(false);
    await settle(t, h);
  }, 60_000);
});

describe('a held analysis does not hold the turn', () => {
  it('a long video waiting for confirmation: the first turn starts at once', async () => {
    const ok = (): CommandResult => ({ code: 0, stdout: '', stderr: '', notFound: false });
    const ff: CommandExec = async () => ok();
    const probe = async (): Promise<MediaInfo> => ({ width: 640, height: 360, durationSec: 1300, fps: 25, audio: false });
    const t = await analysisApp({ media: (real: MediaTools) => ({ ...real, available: true, probe }), ffExec: ff });
    const h = analysisHelpers(t);
    await writeFile(join(t.projectDir, 'assets', 'clip.mp4'), 'fake');
    const slug = await create(t, ['assets/clip.mp4']);
    await vi.waitFor(() => expect(creativeRun(t)).toBeDefined());
    expect((await h.analysisJobs())[0]).toMatchObject({ state: 'queued', waitReason: 'video-long' });
    expect((await conversation(t, slug)).some((e) => e.type === 'system' && e.analysisWait)).toBe(false);
    await t.app.inject({ method: 'DELETE', url: '/api/projects/acme/video-analyses?file=assets/clip.mp4' });
    await settle(t, h);
  }, 60_000);
});

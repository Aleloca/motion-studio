import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { messages } from '@motion-studio/shared';
import { execCommand, type CommandExec, type CommandResult } from '../src/exec.ts';
import { parseSidecar } from '../src/analysis/sidecar.ts';
import type { MediaTools } from '../src/media/media-tools.ts';
import { planFrames } from '../src/analysis/frames.ts';
import { hashVideo } from '../src/analysis/video-hash.ts';
import { analysisApp, analysisHelpers, wholeWrite, type AnalysisApp } from './helpers/analysis-app.ts';
import { hasFfmpeg, twoScenes } from './helpers/analysis-fixtures.ts';

const it_ = messages('it');
let fx: { silent: string; tone: string; other: string };
beforeAll(async () => {
  if (!hasFfmpeg) return;
  const dir = await mkdtemp(join(tmpdir(), 'ms-va-fx-'));
  fx = { silent: await twoScenes(join(dir, 'silent.mp4'), 'silent'), tone: await twoScenes(join(dir, 'tone.mp4'), 'tone'), other: await twoScenes(join(dir, 'other.mp4'), 'none') };
}, 60_000);

const sidecarOf = async (t: AnalysisApp, name: string) => {
  const text = await readFile(join(t.projectDir, 'assets', '.analysis', `${name}.md`), 'utf8').catch(() => null);
  return text === null ? null : parseSidecar(text);
};

/** Runs one whole analysis of `file` with a full write; returns the run. */
async function analyse(t: AnalysisApp, h: ReturnType<typeof analysisHelpers>, file: string, index = t.runner.runs.length) {
  const [v] = await t.analyses.ensure(t.ref, [file], { from: 'brief' });
  const run = await t.runner.next(index);
  expect((await h.tool(run, 'write_video_analysis', wholeWrite(8))).statusCode).toBe(200);
  run.finish({ write: false });
  await t.analyses.settled(v!.jobId!);
  return run;
}

/**
 * A stub ffmpeg (the chunked and long cases): scene detection prints the given cuts, each frame grab writes a small file,
 * audio extraction writes a wav and the silence report prints nothing (speech).
 */
function stubFf(cuts: number[], o: { audio?: boolean; wavs?: string[] } = {}): CommandExec {
  return async (cmd, args): Promise<CommandResult> => {
    const ok = (stderr = ''): CommandResult => ({ code: 0, stdout: '', stderr, notFound: false });
    if (cmd !== 'ffmpeg') return ok();
    const out = args.at(-1)!;
    if (args.includes('mjpeg')) { await writeFile(out, 'jpeg'); return ok(); }
    if (args.includes('pcm_s16le')) {
      if (!o.audio) return { code: 1, stdout: '', stderr: 'no audio', notFound: false };
      await writeFile(out, Buffer.alloc(1000));
      o.wavs?.push(out);
      return ok();
    }
    if (args.some((a) => a.startsWith('silencedetect'))) return ok('');
    return ok(cuts.map((c, n) => `[Parsed_showinfo_1 @ 0x1] n:${n} pts:${c * 25} pts_time:${c} duration:1`).join('\n'));
  };
}

describe.skipIf(!hasFfmpeg)('VideoAnalysisService', () => {
  it('a short video: one whole run, the sidecar is written and committed', async () => {
    const t = await analysisApp();
    const h = analysisHelpers(t);
    await copyFile(fx.silent, join(t.projectDir, 'assets', 'clip.mp4'));
    const [v] = await t.analyses.ensure(t.ref, ['assets/clip.mp4', 'assets/logo.png'], { from: 'brief' });
    expect(v).toMatchObject({ file: 'assets/clip.mp4' });
    expect((await h.analysisJobs()).map((j) => j.kind)).toEqual(['video-analysis']);
    const run = await t.runner.next(0);
    const sha = (await hashVideo(join(t.projectDir, 'assets', 'clip.mp4'))).sha256;
    const framesDir = join(t.projectDir, '.studio', 'cache', 'analysis', sha);
    expect(run.req.addDirs).toEqual([framesDir]);
    expect(run.req.prompt).toContain(join(framesDir, 'f-00000000.jpg'));
    expect(run.req.prompt).toContain(join(framesDir, 'f-00004000.jpg'));
    expect(existsSync(join(framesDir, 'f-00004000.jpg'))).toBe(true);
    expect((await h.tool(run, 'write_video_analysis', wholeWrite(8))).statusCode).toBe(200);
    run.finish({ write: false });
    await t.analyses.settled(v!.jobId!);
    const s = await sidecarOf(t, 'clip.mp4');
    expect(s!.header).toMatchObject({ asset: 'assets/clip.mp4', sha256: sha, transcript: 'none-no-speech', hasAudio: true, width: 320, height: 240, edited: false });
    expect(s!.body).toContain('- [00:00–00:08] Logo on white');
    const log = await execCommand('git', ['-C', t.projectDir, 'log', '-1', '--format=%s']);
    expect(log.stdout.trim()).toBe(it_.videoAnalysis.commit({ file: 'clip.mp4' }));
    expect(h.views().filter((m) => m.file === 'assets/clip.mp4').at(-1)!.view.state).toBe('ready');
    expect((await h.analysisJobs())[0]!.state).toBe('succeeded');
  }, 60_000);

  it('speech without a transcription method: none-skipped', async () => {
    const t = await analysisApp();
    const h = analysisHelpers(t);
    await copyFile(fx.tone, join(t.projectDir, 'assets', 'tone.mp4'));
    await analyse(t, h, 'assets/tone.mp4');
    expect((await sidecarOf(t, 'tone.mp4'))!.header.transcript).toBe('none-skipped');
  }, 60_000);

  it('same content twice: one job, every copy gets its own sidecar; a fresh sidecar is not analysed again', async () => {
    const t = await analysisApp();
    const h = analysisHelpers(t);
    await copyFile(fx.silent, join(t.projectDir, 'assets', 'clip.mp4'));
    await copyFile(fx.silent, join(t.projectDir, 'assets', 'copy.mp4'));
    await t.analyses.ensure(t.ref, ['assets/clip.mp4'], { from: 'brief' });
    await t.analyses.ensure(t.ref, ['assets/clip.mp4', 'assets/copy.mp4'], { from: 'brief' });
    expect(await h.analysisJobs()).toHaveLength(1);
    const run = await t.runner.next(0);
    await h.tool(run, 'write_video_analysis', wholeWrite(8));
    run.finish({ write: false });
    await t.analyses.settled((await h.analysisJobs())[0]!.id);
    expect((await sidecarOf(t, 'clip.mp4'))!.header.asset).toBe('assets/clip.mp4');
    expect((await sidecarOf(t, 'copy.mp4'))!.header.asset).toBe('assets/copy.mp4');
    const again = await t.analyses.ensure(t.ref, ['assets/clip.mp4', 'assets/copy.mp4'], { from: 'brief' });
    expect(again.map((v) => v.state)).toEqual(['ready', 'ready']);
    expect(await h.analysisJobs()).toHaveLength(1);
  }, 60_000);

  it('a changed file is analysed again', async () => {
    const t = await analysisApp();
    const h = analysisHelpers(t);
    await copyFile(fx.silent, join(t.projectDir, 'assets', 'clip.mp4'));
    await analyse(t, h, 'assets/clip.mp4');
    await copyFile(fx.other, join(t.projectDir, 'assets', 'clip.mp4'));
    expect((await t.analyses.view(t.ref, 'assets/clip.mp4')).state).toBe('stale');
    await analyse(t, h, 'assets/clip.mp4', 1);
    expect(await h.analysisJobs()).toHaveLength(2);
    expect((await sidecarOf(t, 'clip.mp4'))!.header).toMatchObject({ hasAudio: false, transcript: 'none-no-speech' });
  }, 60_000);

  it('the video changes during the analysis: the sidecar is not written, the analysis is queued again', async () => {
    const t = await analysisApp();
    const h = analysisHelpers(t);
    await copyFile(fx.silent, join(t.projectDir, 'assets', 'clip.mp4'));
    const [v] = await t.analyses.ensure(t.ref, ['assets/clip.mp4'], { from: 'brief' });
    const run = await t.runner.next(0);
    await copyFile(fx.other, join(t.projectDir, 'assets', 'clip.mp4'));
    await h.tool(run, 'write_video_analysis', wholeWrite(8));
    run.finish({ write: false });
    await t.analyses.settled(v!.jobId!);
    expect(await sidecarOf(t, 'clip.mp4')).toBeNull();
    await vi.waitFor(async () => expect(await h.analysisJobs()).toHaveLength(2));
    const second = await t.runner.next(1);
    expect(second.req.prompt).toContain((await hashVideo(join(t.projectDir, 'assets', 'clip.mp4'))).sha256);
  }, 60_000);
});

describe('VideoAnalysisService with a stub ffmpeg', () => {
  const longMedia = (durationSec: number, audio = false) => (real: MediaTools): MediaTools => ({
    ...real, available: true, probe: async () => ({ width: 640, height: 360, durationSec, fps: 25, audio }),
  });

  it('45 frames: two chunk runs then a final run', async () => {
    const cuts = Array.from({ length: 44 }, (_, i) => i + 1);
    const t = await analysisApp({ media: longMedia(45), ffExec: stubFf(cuts) });
    const h = analysisHelpers(t);
    const file = await h.put('long.mp4', 'fake video');
    const [v] = await t.analyses.ensure(t.ref, [file], { from: 'brief' });
    const first = await t.runner.next(0);
    expect(first.req.prompt).toContain('part 1 of 2');
    expect(first.req.prompt).toContain('f-00039000.jpg');
    expect(first.req.prompt).not.toContain('f-00040000.jpg');
    expect((await h.tool(first, 'write_video_analysis', { summary: 'x' })).statusCode).toBe(400);
    expect((await h.tool(first, 'write_video_analysis', { timeline: [{ from: 0, to: 40, onScreen: 'First part', frame: 'f-00000000.jpg' }] })).statusCode).toBe(200);
    first.finish({ write: false });
    const second = await t.runner.next(1);
    expect(second.req.prompt).toContain('part 2 of 2, from 00:40 to 00:45');
    expect((await h.tool(second, 'write_video_analysis', { timeline: [{ from: 40, to: 45, onScreen: 'Second part', frame: 'f-00044000.jpg' }] })).statusCode).toBe(200);
    second.finish({ write: false });
    const final = await t.runner.next(2);
    expect(final.req.prompt).toContain('"First part"');
    expect(final.req.prompt).toContain('"Second part"');
    expect(final.req.prompt).not.toContain('.studio/cache/analysis');
    const { timeline: _t, ...rest } = wholeWrite(45);
    expect((await h.tool(final, 'write_video_analysis', rest)).statusCode).toBe(200);
    final.finish({ write: false });
    await t.analyses.settled(v!.jobId!);
    const s = await sidecarOf(t, 'long.mp4');
    expect(s!.body).toContain('- [00:00–00:40] First part');
    expect(s!.body).toContain('- [00:40–00:45] Second part');
    expect(s!.body).toContain('A short demo.');
  });

  it('a chunk run without a write fails the analysis', async () => {
    const wavs: string[] = [];
    const t = await analysisApp({ media: longMedia(20, true), ffExec: stubFf([10], { audio: true, wavs }) });
    const h = analysisHelpers(t);
    const file = await h.put('clip.mp4', 'fake video');
    const [v] = await t.analyses.ensure(t.ref, [file], { from: 'brief' });
    const run = await t.runner.next(0);
    expect(run.req.prompt).toContain('not transcribed');
    run.finish({ write: false });
    await t.analyses.settled(v!.jobId!);
    const view = await t.analyses.view(t.ref, file);
    expect(view.state).toBe('error');
    expect(view.error).toBe(it_.errors.analysisNoWrite);
    expect(await sidecarOf(t, 'clip.mp4')).toBeNull();
    expect((await h.analysisJobs())[0]).toMatchObject({ state: 'failed' });
    expect(wavs).toHaveLength(1);
    expect(existsSync(wavs[0]!)).toBe(false);
  });

  it('a long video waits for confirmation, then follows the reduced plan', async () => {
    const t = await analysisApp({ media: longMedia(1300), ffExec: stubFf([]) });
    const h = analysisHelpers(t);
    const file = await h.put('talk.mp4', 'fake long video');
    const [v] = await t.analyses.ensure(t.ref, [file], { from: 'brief' });
    const frames = planFrames([], 1300, 'full').length, reduced = planFrames([], 1300, 'reduced').length;
    expect(v).toMatchObject({ state: 'waiting', pending: { kind: 'long', frames, reducedFrames: reduced, tokens: frames * 800, reducedTokens: reduced * 800 } });
    expect((await h.analysisJobs())[0]).toMatchObject({ state: 'queued', waitReason: 'video-long' });
    expect(t.analyses.activeFor(t.ref, [file])).toEqual([]);
    expect(t.runner.runs).toHaveLength(0);
    await t.analyses.confirmLong(t.ref, file, 'reduced');
    const run = await t.runner.next(0);
    expect(run.req.prompt).toContain('f-00030000.jpg');
    expect(run.req.prompt).not.toContain('f-00010000.jpg');
    await t.analyses.cancel(t.ref, file);
  });

  it('without the studio tools nothing is queued', async () => {
    const t = await analysisApp({ media: longMedia(10), ffExec: stubFf([]), mcp: false });
    const h = analysisHelpers(t);
    const file = await h.put('clip.mp4', 'x');
    expect((await t.analyses.ensure(t.ref, [file]))[0]!.state).toBe('none');
    expect(await h.analysisJobs()).toHaveLength(0);
  });
});

describe('sweepAnalysisFrames', () => {
  it('removes old key frames, never a content in use', async () => {
    const { mkdir, utimes } = await import('node:fs/promises');
    const { sweepAnalysisFrames } = await import('../src/creatives/cache-sweep.ts');
    const dir = await mkdtemp(join(tmpdir(), 'ms-va-sweep-'));
    const root = join(dir, '.studio', 'cache', 'analysis');
    for (const sha of ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]) {
      await mkdir(join(root, sha), { recursive: true });
      await writeFile(join(root, sha, 'f-00000000.jpg'), 'x');
    }
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    for (const sha of ['a'.repeat(64), 'b'.repeat(64)]) { await utimes(join(root, sha, 'f-00000000.jpg'), old, old); await utimes(join(root, sha), old, old); }
    const removed = await sweepAnalysisFrames(dir, { inUse: (sha) => sha === 'b'.repeat(64) });
    expect(removed).toEqual([join(root, 'a'.repeat(64))]);
    expect(existsSync(join(root, 'b'.repeat(64)))).toBe(true);
    expect(existsSync(join(root, 'c'.repeat(64)))).toBe(true);
  });
});

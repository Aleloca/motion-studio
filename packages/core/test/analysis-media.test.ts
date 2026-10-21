import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execCommand } from '../src/exec.ts';
import { detectScenes, extractFrames, planFrames } from '../src/analysis/frames.ts';
import { extractWav, silenceRatio } from '../src/analysis/audio.ts';
import { hasFfmpeg, makeAnalysisFixtures, probe } from './helpers/analysis-fixtures.ts';

let dir = '';
let fx: Awaited<ReturnType<typeof makeAnalysisFixtures>>;
beforeAll(async () => {
  if (!hasFfmpeg) return;
  dir = await mkdtemp(join(tmpdir(), 'ms-analysis-media-'));
  fx = await makeAnalysisFixtures(dir);
}, 60_000);
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe('planFrames', () => {
  it('one frame per scene plus one every 10 s inside it; no cut: one every 10 s', () => {
    expect(planFrames([3, 6], 31, 'full')).toEqual([0, 3, 6, 16, 26]);
    expect(planFrames([], 25, 'full')).toEqual([0, 10, 20]);
  });
  it('reduced density: scene starts at least 30 s apart; no cut: one every 30 s', () => {
    expect(planFrames([3, 6, 40], 100, 'reduced')).toEqual([0, 40]);
    expect(planFrames([], 95, 'reduced')).toEqual([0, 30, 60, 90]);
  });
  it('keeps every time inside the video', () => {
    expect(planFrames([], 0.05, 'full')).toEqual([0]);
    expect(planFrames([4.99], 5, 'full')).toEqual([0, 4.9]);
  });
});

describe.skipIf(!hasFfmpeg)('scenes, frames and audio with ffmpeg', () => {
  it('finds the two cuts of the fixture', async () => {
    const cuts = await detectScenes(execCommand, fx.clip, 31);
    expect(cuts).toHaveLength(2);
    expect(Math.abs(cuts[0]! - 3)).toBeLessThan(0.2);
    expect(Math.abs(cuts[1]! - 6)).toBeLessThan(0.2);
  }, 60_000);

  it('extracts named frames, never enlarged, the long side at most 768', async () => {
    const out = join(dir, 'frames');
    expect(await extractFrames(execCommand, fx.clip, [0, 3.5], out)).toEqual(['f-00000000.jpg', 'f-00003500.jpg']);
    expect((await readdir(out)).sort()).toEqual(['f-00000000.jpg', 'f-00003500.jpg']);
    const small = (await probe(join(out, 'f-00000000.jpg'))).streams[0]!;
    expect([small.width, small.height]).toEqual([640, 360]);
    const bigOut = join(dir, 'frames-big');
    await extractFrames(execCommand, fx.big, [0], bigOut);
    const big = (await probe(join(bigOut, 'f-00000000.jpg'))).streams[0]!;
    expect([big.width, big.height]).toEqual([768, 432]);
  }, 60_000);

  it('extracts 16 kHz mono audio, none from a video without audio, and measures silence', async () => {
    expect(await extractWav(execCommand, fx.noaudio, join(dir, 'none.wav'))).toBe(false);
    const wav = join(dir, 'clip.wav');
    expect(await extractWav(execCommand, fx.clip, wav)).toBe(true);
    const a = (await probe(wav)).streams[0]!;
    expect([a.sample_rate, a.channels, a.codec_name]).toEqual(['16000', 1, 'pcm_s16le']);
    expect(await silenceRatio(execCommand, wav, 31)).toBeLessThan(0.95);
    const silentWav = join(dir, 'silent.wav');
    expect(await extractWav(execCommand, fx.silent, silentWav)).toBe(true);
    expect(await silenceRatio(execCommand, silentWav, 12)).toBeGreaterThanOrEqual(0.95);
  }, 60_000);
});

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execCommand, type CommandExec } from '../src/exec.ts';
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

describe('the ffmpeg passes stop on abort (decision 1536)', () => {
  it('execCommand kills its own child when the signal aborts', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 50);
    const r = await execCommand('sleep', ['10'], { signal: ac.signal, timeoutMs: 20_000 });
    expect(r.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });
  it('every pass hands its signal to the runner and ends with an AbortError', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    // A runner that never ends by itself: only the abort ends it, as a killed child would.
    const hang: CommandExec = (_cmd, _args, o) => { seen.push(o?.signal); return new Promise((res) => o?.signal?.addEventListener('abort', () => res({ code: -1, stdout: '', stderr: '', notFound: false, aborted: true }))); };
    const dir = await mkdtemp(join(tmpdir(), 'ms-abort-'));
    const video = join(dir, 'v.mp4');
    await writeFile(video, 'x');
    const passes: Array<(s: AbortSignal) => Promise<unknown>> = [
      (s) => detectScenes(hang, video, 10, s),
      (s) => extractFrames(hang, video, [0], join(dir, 'f'), s),
      (s) => extractWav(hang, video, join(dir, 'a.wav'), s, 10),
      (s) => silenceRatio(hang, video, 10, s),
    ];
    for (const pass of passes) {
      const ac = new AbortController();
      const p = pass(ac.signal);
      setTimeout(() => ac.abort(), 10);
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      expect(seen.at(-1)).toBe(ac.signal);
    }
  });
});

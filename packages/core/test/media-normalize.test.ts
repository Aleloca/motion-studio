// @vitest-environment node
/**
 * Video media normalisation (Task 5): every video clip source gets a render version (H.264 yuv420p, CFR at the composition
 * fps, short GOP, no audio, size capped to the clip's need, BT.709), cached by source content in .studio/cache/media, probed
 * for the trusted source fields. Real ffmpeg (required under MS_REQUIRE_CHROME=1); everything under the OS temp folder.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Composition } from '@motion-studio/shared';
import { RenderError } from '../src/render/errors.ts';
import { findFfmpeg, type FfmpegInfo } from '../src/render/encode.ts';
import {
  clipScaleBound, MAX_MEDIA_DIM, MEDIA_TEMP_RE, MediaNormalizer, normalisedFieldsOf, targetSize, videoNeeds,
} from '../src/render/media-normalize.ts';
import { listProcesses } from '../src/render/watchdog.ts';

const ffmpeg = await findFfmpeg();
if (!ffmpeg) {
  if (process.env.MS_REQUIRE_CHROME === '1') it('media normalisation: ffmpeg is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing ffmpeg'); });
  else console.warn('[core] media normalisation tests SKIPPED: no ffmpeg. Required on CI (MS_REQUIRE_CHROME=1).');
}

const ff = (args: string[]) => execFileSync(ffmpeg!.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const probe = (file: string, args: string[]) => execFileSync(join(ffmpeg!.path, '..', 'ffprobe'), ['-v', 'error', ...args, file], { encoding: 'utf8' });
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function comp(clips: unknown[], o: { fps?: number; width?: number; height?: number } = {}): Composition {
  return {
    $schema: 'motion-studio/composition@1', width: o.width ?? 320, height: o.height ?? 180, fps: o.fps ?? 30, duration: 2, background: '#000000',
    fonts: [], scenes: [{ id: 's', start: 0, duration: 2 }], tracks: [{ id: 'v', kind: 'video', clips }],
  } as unknown as Composition;
}
const video = (src: string, extra: Record<string, unknown> = {}) => ({ id: `c${Math.random().toString(36).slice(2, 8)}`, type: 'video', src, start: 0, duration: 2, props: { x: 0, y: 0, width: 320, height: 180 }, ...extra });

describe('sizes and fields (pure)', () => {
  it('the scale bound takes the clip scale and the largest scale its animations reach, at least 1, at most 8', () => {
    expect(clipScaleBound({ props: {} })).toBe(1);
    expect(clipScaleBound({ props: { scale: 0.5 } })).toBe(1);
    expect(clipScaleBound({ props: { scale: 2 } })).toBe(2);
    expect(clipScaleBound({ props: { scale: 1.5 }, animations: [{ prop: 'scale', from: 1, to: 2 }] })).toBe(3);
    expect(clipScaleBound({ props: {}, animations: [{ prop: 'scale', keyframes: [{ t: 0, v: 1 }, { t: 0.5, v: 3 }, { t: 1, v: 1 }] }] })).toBe(3);
    expect(clipScaleBound({ props: {}, animations: [{ preset: 'popIn' }, { prop: 'x', from: 0, to: 900 }] })).toBe(1.1);
    expect(clipScaleBound({ props: { scale: 50 } })).toBe(8);
  });

  it('needs: the largest box times its scale per source, hidden tracks ignored, a box without size is the composition', () => {
    const c = comp([video('assets/a.mp4'), video('assets/a.mp4', { props: { width: 100, height: 400 } }), video('assets/b.mp4', { props: {}, animations: [{ prop: 'scale', from: 1, to: 2 }] })]);
    (c.tracks as unknown[]).push({ id: 'h', kind: 'video', hidden: true, clips: [video('assets/c.mp4')] });
    expect(Object.fromEntries(videoNeeds(c))).toEqual({ 'assets/a.mp4': { width: 320, height: 400 }, 'assets/b.mp4': { width: 640, height: 360 } });
  });

  it('target size: a cover crop keeps the need, never upscaled, even sides, at most MAX_MEDIA_DIM', () => {
    expect(targetSize({ width: 1920, height: 1080 }, { width: 320, height: 180 })).toEqual({ width: 320, height: 180 });
    // A tall box over a wide source: the height decides (cover).
    expect(targetSize({ width: 1920, height: 1080 }, { width: 100, height: 400 })).toEqual({ width: 712, height: 400 });
    expect(targetSize({ width: 640, height: 360 }, { width: 1920, height: 1080 })).toEqual({ width: 640, height: 360 });
    expect(targetSize({ width: 641, height: 359 }, { width: 1920, height: 1080 })).toEqual({ width: 642, height: 360 });
    expect(targetSize({ width: 8000, height: 4000 }, { width: 8000, height: 4000 })).toEqual({ width: MAX_MEDIA_DIM, height: 2048 });
  });

  it('a normalised file is trusted only when it is exactly what was asked', () => {
    const want = { fps: 30, width: 320, height: 180 };
    const good = { streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 320, height: 180, r_frame_rate: '30/1', start_time: '0.000000', nb_read_packets: '60', color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709', color_range: 'tv' }] };
    expect(normalisedFieldsOf(good, want)).toEqual({ sourceFps: 30, sourceStart: 0, sourceVideoEnd: 2 });
    const bad = (patch: Record<string, unknown>, extra: unknown[] = []) => normalisedFieldsOf({ streams: [{ ...good.streams[0], ...patch }, ...extra] }, want);
    for (const p of [{ r_frame_rate: '25/1' }, { pix_fmt: 'yuv444p' }, { codec_name: 'hevc' }, { width: 640 }, { color_primaries: 'unknown' }, { nb_read_packets: '0' }]) expect(bad(p)).toHaveProperty('problem');
    expect(bad({}, [{ codec_type: 'audio' }])).toHaveProperty('problem');
    expect(normalisedFieldsOf(null, want)).toHaveProperty('problem');
  });
});

describe.skipIf(!ffmpeg)('normalisation with ffmpeg', () => {
  let work: string;
  let project: string;
  let compDir: string;
  let cache: string;
  const normalizer = (o: { x264Preset?: string; parallel?: number } = {}) => new MediaNormalizer({ ffmpeg: async () => ffmpeg as FfmpegInfo, ...o });

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'ms-media-norm-'));
    project = join(work, 'project');
    compDir = join(project, 'creatives', 'c', 'outputs', 'v1', 'compositions', 'story');
    cache = join(project, '.studio', 'cache', 'media');
    mkdirSync(join(compDir, 'assets'), { recursive: true });
    writeFileSync(join(compDir, 'composition.json'), '{}');
    // 1280×720, 25 fps, 3 s, untagged colour, first frame at 0.1 s, with a 4 s audio track.
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=3', '-f', 'lavfi', '-i', 'sine=d=4', '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-output_ts_offset', '0.1', join(compDir, 'assets', 'hd.mp4')]);
    // 12 s, small: long enough for the GOP rule.
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=24:d=12', '-c:v', 'libx264', '-preset', 'ultrafast', join(compDir, 'assets', 'long.mp4')]);
    // A heavier source for the cancel test.
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', join(compDir, 'assets', 'heavy.mp4')]);
    writeFileSync(join(compDir, 'assets', 'text.mp4'), 'not a video at all');
    writeFileSync(join(work, 'outside.mp4'), readFileSync(join(compDir, 'assets', 'long.mp4')));
    symlinkSync(join(work, 'outside.mp4'), join(compDir, 'assets', 'link.mp4'));
    linkSync(join(work, 'outside.mp4'), join(compDir, 'assets', 'hard.mp4'));
  }, 300_000);
  afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

  const prepare = (n: MediaNormalizer, c: Composition, signal = new AbortController().signal, onProgress?: (p: { done: number; total: number }) => void) =>
    n.prepare({ projectDir: project, compDir, composition: c, signal, ...(onProgress ? { onProgress } : {}) });

  it('makes an H.264 yuv420p CFR file at the composition fps, all-intra under 10 s, no audio, capped to the box, tagged BT.709', async () => {
    const progress: string[] = [];
    const r = await prepare(normalizer(), comp([video('assets/hd.mp4')]), undefined, (p) => progress.push(`${p.done}/${p.total}`));
    expect(r.warnings).toEqual([]);
    expect([r.made, r.cached]).toEqual([1, 0]);
    expect(progress).toEqual(['0/1', '1/1']);
    const m = r.media.clips.get('assets/hd.mp4')!;
    expect(m.file).toBe(join(cache, `${sha(join(compDir, 'assets', 'hd.mp4'))}-30-320.mp4`));
    const s = JSON.parse(probe(m.file, ['-count_packets', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_read_packets,color_primaries,color_transfer,color_space,color_range,has_b_frames', '-of', 'json'])).streams as Array<Record<string, unknown>>;
    expect(s).toHaveLength(1); // no audio
    expect(s[0]).toMatchObject({ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 320, height: 180, r_frame_rate: '30/1', avg_frame_rate: '30/1',
      color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709', color_range: 'tv', has_b_frames: 0 });
    // Every frame at i/30 from 0, every one a key frame (the source is under 10 s).
    const frames = probe(m.file, ['-select_streams', 'v', '-show_entries', 'frame=pts_time,key_frame', '-of', 'csv=p=0']).trim().split('\n').map((l) => l.split(','));
    expect(frames.length).toBe(90);
    frames.forEach(([key, pts], i) => { expect(key).toBe('1'); expect(Number(pts)).toBeCloseTo(i / 30, 5); });
    expect(m).toMatchObject({ sourceFps: 30, sourceStart: 0 });
    expect(m.sourceVideoEnd).toBeCloseTo(3, 6);
    expect(r.media.dir).toBe(cache);
    expect(readdirSync(cache).filter((f) => f.startsWith('.'))).toEqual([]);
  }, 300_000);

  it('a source of 10 s or more gets a key frame every half second; a scale animation raises the size, still never upscaled', async () => {
    const r = await prepare(normalizer(), comp([video('assets/long.mp4', { props: { width: 40, height: 22 }, animations: [{ prop: 'scale', from: 1, to: 2 }] })]));
    const m = r.media.clips.get('assets/long.mp4')!;
    expect(m.file.endsWith('-30-80.mp4')).toBe(true); // 40 × 2 wide
    const keys = probe(m.file, ['-select_streams', 'v', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0']).trim().split('\n').map((l) => parseInt(l, 10));
    expect(keys.length).toBe(360);
    expect(keys.flatMap((k, i) => (k ? [i] : []))).toEqual(Array.from({ length: 24 }, (_, i) => i * 15));
    expect(m.sourceVideoEnd).toBeCloseTo(12, 6);
    const big = await prepare(normalizer(), comp([video('assets/long.mp4', { props: { width: 320, height: 180, scale: 4 } })], { fps: 25 }));
    expect(big.media.clips.get('assets/long.mp4')!.file.endsWith('-25-160.mp4')).toBe(true); // the source is 160 wide
  }, 300_000);

  it('cache: a second preparation finds the file (no new encode); a new source content is a new name', async () => {
    const c = comp([video('assets/hd.mp4')]);
    const first = await prepare(normalizer(), c);
    const file = first.media.clips.get('assets/hd.mp4')!.file;
    const before = statSync(file);
    const again = await prepare(normalizer(), c);
    expect([again.made, again.cached]).toEqual([0, 1]);
    expect(again.media.clips.get('assets/hd.mp4')).toEqual(first.media.clips.get('assets/hd.mp4'));
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    // Two clips of one composition on the same source share one file.
    const two = await prepare(normalizer(), comp([video('assets/hd.mp4'), video('assets/hd.mp4', { start: 1, duration: 1 })]));
    expect(two.media.clips.size).toBe(1);
    // A changed source (same name): a new file; the old one stays (the cache is never cleaned here).
    const other = join(compDir, 'assets', 'swap.mp4');
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', other]);
    const a = (await prepare(normalizer(), comp([video('assets/swap.mp4')]))).media.clips.get('assets/swap.mp4')!.file;
    rmSync(other);
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1.5', '-c:v', 'libx264', '-preset', 'ultrafast', other]);
    const b = (await prepare(normalizer(), comp([video('assets/swap.mp4')]))).media.clips.get('assets/swap.mp4')!.file;
    expect(b).not.toBe(a);
    expect(existsSync(a) && existsSync(b)).toBe(true);
    // A damaged cached file is made again.
    writeFileSync(b, 'damaged');
    const c2 = await prepare(normalizer(), comp([video('assets/swap.mp4')]));
    expect([c2.made, c2.cached]).toEqual([1, 0]);
  }, 300_000);

  it('an unreadable source is a hard error: missing, not a video, a symlink, a hard link', async () => {
    for (const src of ['assets/missing.mp4', 'assets/text.mp4', 'assets/link.mp4', 'assets/hard.mp4']) {
      const e = await prepare(normalizer(), comp([video(src)])).catch((x: unknown) => x);
      expect(e, src).toBeInstanceOf(RenderError);
      expect((e as RenderError).code, src).toBe('mediaUnreadable');
    }
  }, 300_000);

  it('a normalisation that fails leaves the clip on its own file (untrusted) with a warning, never a hard error', async () => {
    const r = await prepare(normalizer({ x264Preset: 'no-such-preset' }), comp([video('assets/long.mp4', { props: { width: 30, height: 16 } })]));
    expect(r.media.clips.size).toBe(0);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ src: 'assets/long.mp4' });
    expect(r.warnings[0]!.message).toMatch(/not normalised/);
    expect(readdirSync(cache).filter((f) => MEDIA_TEMP_RE.test(f))).toEqual([]);
    // Without ffmpeg: every clip is a warning.
    const none = await new MediaNormalizer({ ffmpeg: async () => null }).prepare({ projectDir: project, compDir, composition: comp([video('assets/hd.mp4')]), signal: new AbortController().signal });
    expect(none.media.clips.size).toBe(0);
    expect(none.warnings[0]!.message).toMatch(/ffmpeg is missing/);
  }, 300_000);

  /** ffmpeg processes writing into the media cache. */
  const encoders = async () => (await listProcesses()).filter((r) => /ffmpeg/.test(r.command) && r.command.includes(cache));

  it('cancel kills the encoder group and leaves no temp file; close() does the same for every running preparation', async () => {
    for (const how of ['abort', 'close'] as const) {
      const n = normalizer();
      const ac = new AbortController();
      const run = prepare(n, comp([video('assets/heavy.mp4', { props: { width: 1920, height: 1080 } })], { width: 1920, height: 1080, fps: 60 }), ac.signal);
      run.catch(() => {});
      const t0 = Date.now();
      while ((await encoders()).length === 0 && Date.now() - t0 < 120_000) await new Promise((r) => setTimeout(r, 200));
      expect((await encoders()).length, how).toBeGreaterThan(0);
      if (how === 'abort') ac.abort(); else await n.close();
      const e = await run.catch((x: unknown) => x);
      expect((e as RenderError).code, how).toBe('cancelled');
      expect(await encoders(), how).toEqual([]);
      expect(readdirSync(cache).filter((f) => f.startsWith('.')), how).toEqual([]);
      expect(readdirSync(cache).some((f) => f.endsWith('-60-1920.mp4')), how).toBe(false);
    }
    // After close() the normaliser refuses new work.
    const closed = normalizer();
    await closed.close();
    await expect(prepare(closed, comp([video('assets/hd.mp4')]))).rejects.toMatchObject({ code: 'cancelled' });
  }, 600_000);
});

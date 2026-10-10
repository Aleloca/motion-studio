// @vitest-environment node
/**
 * Video media normalisation (Task 5): every video clip source gets a render version (H.264 yuv420p, CFR at the composition
 * fps, short GOP, no audio, size capped to the clip's need, BT.709), cached by source content in .studio/cache/media, probed
 * for the trusted source fields. Real ffmpeg (required under MS_REQUIRE_CHROME=1); everything under the OS temp folder.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Composition } from '@motion-studio/shared';
import { RenderError } from '../src/render/errors.ts';
import { findFfmpeg, h264Args, runFfmpeg, type FfmpegInfo } from '../src/render/encode.ts';
import { alignVideoAudio, mixAudio } from '../src/render/audio-mix.ts';
import {
  clipScaleBound, gamutFilter, hdrFilter, MAX_MEDIA_DIM, MEDIA_TEMP_RE, MediaNormalizer, normalisedFieldsOf, normalizeArgs, pruneMediaCache, targetSize, videoNeeds,
} from '../src/render/media-normalize.ts';
import { listProcesses, liveGroupCount } from '../src/render/watchdog.ts';
import { burstWav, decodeAudio, decodeStrips, frameCodedVideo, onset, readCode } from './helpers/render-env.ts';

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
    const good = { streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 320, height: 180, r_frame_rate: '30/1', start_time: '0.000000', nb_read_packets: '60', color_primaries: 'bt709', color_transfer: 'iec61966-2-1', color_space: 'bt709', color_range: 'tv' }] };
    expect(normalisedFieldsOf(good, want)).toEqual({ sourceFps: 30, sourceStart: 0, sourceVideoEnd: 2 });
    const bad = (patch: Record<string, unknown>, extra: unknown[] = []) => normalisedFieldsOf({ streams: [{ ...good.streams[0], ...patch }, ...extra] }, want);
    for (const p of [{ r_frame_rate: '25/1' }, { pix_fmt: 'yuv444p' }, { codec_name: 'hevc' }, { width: 640 }, { color_primaries: 'unknown' }, { color_transfer: 'bt709' }, { nb_read_packets: '0' }]) expect(bad(p)).toHaveProperty('problem');
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

  it('makes an H.264 yuv420p CFR file at the composition fps, all-intra under 10 s, no audio, capped to the box, tagged BT.709 (sRGB transfer)', async () => {
    const progress: string[] = [];
    const r = await prepare(normalizer(), comp([video('assets/hd.mp4')]), undefined, (p) => progress.push(`${p.done}/${p.total}`));
    expect(r.warnings).toEqual([]);
    expect([r.made, r.cached]).toEqual([1, 0]);
    expect(progress).toEqual(['0/1', '1/1']);
    const m = r.media.clips.get('assets/hd.mp4')!;
    expect(m.file).toBe(join(cache, `${sha(join(compDir, 'assets', 'hd.mp4'))}-30-320x180-n1.mp4`));
    const s = JSON.parse(probe(m.file, ['-count_packets', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_read_packets,color_primaries,color_transfer,color_space,color_range,has_b_frames', '-of', 'json'])).streams as Array<Record<string, unknown>>;
    expect(s).toHaveLength(1); // no audio
    expect(s[0]).toMatchObject({ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 320, height: 180, r_frame_rate: '30/1', avg_frame_rate: '30/1',
      color_primaries: 'bt709', color_transfer: 'iec61966-2-1', color_space: 'bt709', color_range: 'tv', has_b_frames: 0 });
    // Every frame at i/30 from 0, every one a key frame (the source is under 10 s).
    const frames = probe(m.file, ['-select_streams', 'v', '-show_entries', 'frame=pts_time,key_frame', '-of', 'csv=p=0']).trim().split('\n').map((l) => l.split(','));
    expect(frames.length).toBe(90);
    frames.forEach(([key, pts], i) => { expect(key).toBe('1'); expect(Number(pts)).toBeCloseTo(i / 30, 5); });
    expect(m).toMatchObject({ sourceFps: 30, sourceStart: 0 });
    expect(m.sourceVideoEnd).toBeCloseTo(3, 6);
    expect(r.media.dir).toBe(cache);
    expect(readdirSync(cache).filter((f) => f.startsWith('.'))).toEqual([]);
  }, 300_000);

  it('frame j of the normalised file shows the source frame on screen at j / fps (25 → 30 fps and 30 → 24 fps, first frame at 0.1 s)', async () => {
    frameCodedVideo(ffmpeg!, join(compDir, 'assets', 'code25.mp4'), { fps: 25, frames: 50, offset: 0.1 });
    frameCodedVideo(ffmpeg!, join(compDir, 'assets', 'code30.mp4'), { fps: 30, frames: 60 });
    for (const [src, from, to] of [['assets/code25.mp4', 25, 30], ['assets/code30.mp4', 30, 24]] as const) {
      const r = await prepare(normalizer(), comp([video(src, { props: { width: 64, height: 32 } })], { fps: to }));
      const m = r.media.clips.get(src)!;
      const codes = decodeStrips(ffmpeg!, m.file, { x: 0, y: 0, width: 64, height: 32 }, 2).map(readCode);
      const frames = from === 25 ? 50 : 60;
      expect(codes.length, src).toBe(Math.ceil((frames * to) / from));
      codes.forEach((code, j) => expect(code - 1, `${src} frame ${j}`).toBe(Math.floor((j * from) / to + 1e-9)));
      expect(m.sourceVideoEnd).toBeCloseTo(codes.length / to, 6);
    }
  }, 300_000);

  it('a source of 10 s or more gets a key frame every half second; a scale animation raises the size, still never upscaled', async () => {
    const r = await prepare(normalizer(), comp([video('assets/long.mp4', { props: { width: 40, height: 22 }, animations: [{ prop: 'scale', from: 1, to: 2 }] })]));
    const m = r.media.clips.get('assets/long.mp4')!;
    expect(m.file.endsWith('-30-80x46-n1.mp4')).toBe(true); // 40 × 2 wide (cover: 22 × 2 high → 80×46 keeps the aspect)
    const keys = probe(m.file, ['-select_streams', 'v', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0']).trim().split('\n').map((l) => parseInt(l, 10));
    expect(keys.length).toBe(360);
    expect(keys.flatMap((k, i) => (k ? [i] : []))).toEqual(Array.from({ length: 24 }, (_, i) => i * 15));
    expect(m.sourceVideoEnd).toBeCloseTo(12, 6);
    const big = await prepare(normalizer(), comp([video('assets/long.mp4', { props: { width: 320, height: 180, scale: 4 } })], { fps: 25 }));
    expect(big.media.clips.get('assets/long.mp4')!.file.endsWith('-25-160x90-n1.mp4')).toBe(true); // the source is 160 wide
  }, 300_000);

  it('cache: a second preparation finds the file (no new encode); a new source content is a new name', async () => {
    const c = comp([video('assets/hd.mp4')]);
    const first = await prepare(normalizer(), c);
    const file = first.media.clips.get('assets/hd.mp4')!.file;
    const before = statSync(file);
    const again = await prepare(normalizer(), c);
    expect([again.made, again.cached]).toEqual([0, 1]);
    expect(again.media.clips.get('assets/hd.mp4')).toEqual(first.media.clips.get('assets/hd.mp4'));
    // Not encoded again (same inode); its mtime is touched on use (the cache's LRU clock).
    expect(statSync(file).ino).toBe(before.ino);
    expect(statSync(file).mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs);
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
      expect(readdirSync(cache).some((f) => f.endsWith('-60-1920x1080-n1.mp4')), how).toBe(false);
    }
    // After close() the normaliser refuses new work.
    const closed = normalizer();
    await closed.close();
    await expect(prepare(closed, comp([video('assets/hd.mp4')]))).rejects.toMatchObject({ code: 'cancelled' });
  }, 600_000);
});

describe('cache maintenance (pure files)', () => {
  const NAME = (c: string, recipe = 1) => `${c.repeat(64)}-30-320x180-n${recipe}.mp4`;
  it('prunes older recipes, files unused for 30 days, and the least recently used above the cap; never in use, links or recent files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-test-media-prune-'));
    try {
      const now = Date.now();
      const put = (name: string, bytes: number, ageMs: number) => { const p = join(dir, name); writeFileSync(p, Buffer.alloc(bytes)); const t = new Date(now - ageMs); utimesSync(p, t, t); return p; };
      const DAY = 24 * 3600 * 1000;
      const oldRecipe = put(NAME('a', 0), 10, DAY);
      const stale = put(NAME('b'), 10, 31 * DAY);
      const lru1 = put(NAME('c'), 400, 5 * DAY);
      const lru2 = put(NAME('d'), 400, 4 * DAY);
      const used = put(NAME('e'), 400, 6 * DAY);
      const recent = put(NAME('f'), 400, 60_000);
      const other = put('notes.txt', 10, 40 * DAY);
      linkSync(lru2, join(dir, NAME('g'))); // a hard link: never touched (both names then have nlink 2)
      symlinkSync(lru1, join(dir, NAME('h')));
      const removed = await pruneMediaCache(dir, { maxBytes: 1000, now, inUse: (f) => f === used });
      // c, e (in use: counted, never removed) and f count: 1200 > 1000, so the least recently used removable one (c) goes.
      // d is hard-linked, h a symlink, notes.txt not a cache name: none of them counts.
      expect(removed.sort()).toEqual([oldRecipe, stale, lru1].sort());
      for (const f of [lru2, used, recent, other]) expect(existsSync(f), f).toBe(true);
      rmSync(join(dir, NAME('g')));
      const again = await pruneMediaCache(dir, { maxBytes: 1000, now, inUse: (f) => f === used });
      // d, e and f now count (1200 > 1000): d goes; f is recent, e in use.
      expect(again).toEqual([lru2]);
      expect(existsSync(used) && existsSync(recent)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('HDR: tone-mapped when zscale and tonemap exist, else the colorspace filter with the approximate flag', () => {
    const hlg = { primaries: 'bt2020', transfer: 'arib-std-b67', space: 'bt2020nc' };
    expect(gamutFilter({ primaries: 'bt2020', transfer: 'bt709', space: 'bt2020nc' })).toBe('colorspace=all=bt709:iprimaries=bt2020:ispace=bt2020ncl:itrc=bt709:format=yuv420p,');
    expect(hdrFilter(hlg, new Set(['zscale', 'tonemap']))).toMatchObject({ approximate: false, vf: expect.stringContaining('tonemap=hable') });
    expect(hdrFilter(hlg, new Set(['colorspace', 'tonemap']))).toEqual({ approximate: true, vf: 'colorspace=all=bt709:iprimaries=bt2020:ispace=bt2020ncl:itrc=bt2020-10:format=yuv420p,' });
    expect(normalizeArgs({ fps: 30, width: 64, height: 36, allIntra: true, hdrVf: 'X,' }).join(' ')).toContain('round=up,X,scale=64:36:flags=lanczos:in_color_matrix=bt709');
  });

  it('a video clip\'s sound is aligned to its first video frame (M12)', () => {
    const clip = { src: 'assets/v.mp4', start: 1, duration: 2, trimStart: 0.5, volume: 1, fadeIn: 0, fadeOut: 0, fromVideo: true };
    expect(alignVideoAudio(clip, { video: 0.1, audio: 0 })).toEqual({ ...clip, trimStart: 0.6 });
    expect(alignVideoAudio(clip, { video: 0, audio: 0.8 })).toEqual({ ...clip, start: 1.3, duration: 1.7, trimStart: 0 });
    expect(alignVideoAudio(clip, { video: 0, audio: 3 })).toBeNull();
    expect(alignVideoAudio(clip, null)).toEqual(clip);
  });
});

describe.skipIf(!ffmpeg)('normalisation: sharing, slots, failures, HDR, memo, audio, final tags', () => {
  let work: string;
  let project: string;
  let compDir: string;
  let cache: string;
  const prep = (n: MediaNormalizer, c: Composition, signal = new AbortController().signal) => n.prepare({ projectDir: project, compDir, composition: c, signal });
  const encoders = async () => (await listProcesses()).filter((r) => /ffmpeg/.test(r.command) && r.command.includes(cache));
  const waitFor = async (cond: () => Promise<boolean>, ms = 120_000) => { const t0 = Date.now(); while (!(await cond()) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100)); };
  const heavyComp = () => comp([video('assets/heavy.mp4', { props: { width: 1280, height: 720 } })], { width: 1280, height: 720, fps: 60 });

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'ms-test-media-fix-'));
    project = join(work, 'project');
    compDir = join(project, 'creatives', 'c', 'outputs', 'v1', 'compositions', 'story');
    cache = join(project, '.studio', 'cache', 'media');
    mkdirSync(join(compDir, 'assets'), { recursive: true });
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=60:d=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', join(compDir, 'assets', 'heavy.mp4')]);
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', join(compDir, 'assets', 'small.mp4')]);
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', join(compDir, 'assets', 'small2.mp4')]);
    // 10-bit BT.2020 HLG.
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1', '-vf', 'format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', join(compDir, 'assets', 'hlg.mp4')]);
    // BT.2020 primaries with an SDR (BT.709) transfer: wide gamut, not HDR.
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1', '-vf', 'format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=bt709:colorspace=bt2020nc:range=tv',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-color_primaries', 'bt2020', '-color_trc', 'bt709', '-colorspace', 'bt2020nc', join(compDir, 'assets', 'wide.mp4')]);
  }, 300_000);
  afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

  it('a shared encode survives the cancel of one of its waiters; the other completes (I1)', async () => {
    const n = new MediaNormalizer({ ffmpeg: async () => ffmpeg as FfmpegInfo });
    const a = new AbortController();
    const first = prep(n, heavyComp(), a.signal);
    first.catch(() => {});
    await waitFor(async () => (await encoders()).length > 0);
    const second = prep(n, heavyComp());
    await waitFor(async () => n.sharedWaiters() >= 2); // the second job waits on the same encode
    a.abort();
    expect(await first.catch((e: RenderError) => e.code)).toBe('cancelled');
    const r = await second;
    expect([r.made + r.cached, r.warnings]).toEqual([1, []]);
    expect(n.stats.encodes).toBe(1); // exactly one encode ran, shared by both jobs
    expect(existsSync(r.media.clips.get('assets/heavy.mp4')!.file)).toBe(true);
    // Only one encode ran: no second one was started for the second job.
    r.release();
    await n.close();
    expect(liveGroupCount()).toBe(0);
  }, 600_000);

  it('a cache hit never waits for a busy slot, and a waiter for a slot leaves on cancel (M11)', async () => {
    // veryslow: the heavy encode holds the only slot for the whole test.
    const n = new MediaNormalizer({ ffmpeg: async () => ffmpeg as FfmpegInfo, parallel: 1, x264Preset: 'veryslow' });
    rmSync(cache, { recursive: true, force: true });
    (await prep(n, comp([video('assets/small.mp4')]))).release(); // cached now
    const busy = new AbortController();
    const heavy = prep(n, heavyComp(), busy.signal);
    heavy.catch(() => {});
    await waitFor(async () => (await encoders()).length > 0);
    const t0 = Date.now();
    const hit = await prep(n, comp([video('assets/small.mp4')]));
    expect(hit.cached).toBe(1);
    expect((await encoders()).length).toBeGreaterThan(0); // the heavy encode still holds the only slot
    hit.release();
    const waiting = new AbortController();
    const queued = prep(n, comp([video('assets/small2.mp4')]), waiting.signal);
    await new Promise((r) => setTimeout(r, 1500));
    waiting.abort();
    expect(await queued.catch((e: RenderError) => e.code)).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect((await encoders()).length).toBeGreaterThan(0);
    busy.abort();
    await heavy.catch(() => {});
    await n.close();
    expect(await encoders()).toEqual([]);
    expect(liveGroupCount()).toBe(0);
  }, 600_000);

  it('an unreadable source fails the preparation and cancels its siblings; close() waits for them (M2)', async () => {
    rmSync(cache, { recursive: true, force: true });
    const n = new MediaNormalizer({ ffmpeg: async () => ffmpeg as FfmpegInfo });
    const c = comp([video('assets/heavy.mp4', { props: { width: 1280, height: 720 } }), video('assets/nope.mp4')], { width: 1280, height: 720, fps: 60 });
    expect(await prep(n, c).catch((e: RenderError) => e.code)).toBe('mediaUnreadable');
    await n.close();
    expect(await encoders()).toEqual([]);
    expect(liveGroupCount()).toBe(0);
    expect(readdirSync(cache).filter((f) => f.startsWith('.'))).toEqual([]);
  }, 600_000);

  it('a damaged cached file in use is left alone (warning); once released it is made again (I2)', async () => {
    const n = new MediaNormalizer({ ffmpeg: async () => ffmpeg as FfmpegInfo });
    const held = await prep(n, comp([video('assets/small.mp4')]));
    const file = held.media.clips.get('assets/small.mp4')!.file;
    writeFileSync(file, 'damaged');
    const again = await prep(n, comp([video('assets/small.mp4')]));
    expect(again.media.clips.size).toBe(0);
    expect(again.warnings[0]).toMatchObject({ kind: 'notNormalised', message: expect.stringContaining('damaged') });
    expect(readFileSync(file, 'utf8')).toBe('damaged');
    held.release();
    const fixed = await prep(n, comp([video('assets/small.mp4')]));
    expect(fixed.made).toBe(1);
    fixed.release();
    await n.close();
  }, 600_000);

  it('an HLG source is converted (no zscale here: colorspace filter), stays trusted, and warns that its colours are approximate (I4)', async () => {
    const n = new MediaNormalizer({ ffmpeg: async () => ffmpeg as FfmpegInfo });
    const r = await prep(n, comp([video('assets/hlg.mp4')]));
    const m = r.media.clips.get('assets/hlg.mp4')!;
    expect(m).toMatchObject({ sourceFps: 30, sourceStart: 0 });
    const expectApprox = !(ffmpeg!.filters?.has('zscale') && ffmpeg!.filters.has('tonemap'));
    expect(r.warnings).toEqual(expectApprox ? [{ src: 'assets/hlg.mp4', kind: 'hdrApproximate', message: expect.stringContaining('HDR') }] : []);
    const s = JSON.parse(probe(m.file, ['-show_entries', 'stream=pix_fmt,color_primaries,color_transfer,color_space', '-of', 'json'])).streams[0];
    expect(s).toEqual({ pix_fmt: 'yuv420p', color_primaries: 'bt709', color_transfer: 'iec61966-2-1', color_space: 'bt709' });
    // Converted, not relabelled: the mean of the frame differs from the same source with its BT.2020 tags ignored.
    const mean = (f: string, vf: string) => execFileSync(ffmpeg!.path, ['-v', 'error', '-i', f, '-frames:v', '1', '-vf', `${vf}scale=8:8,format=rgb24`, '-f', 'rawvideo', '-'] , { maxBuffer: 1 << 20 });
    const converted = mean(m.file, '');
    const relabelled = mean(join(compDir, 'assets', 'hlg.mp4'), 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709,');
    const diff = converted.reduce((a, v, i) => a + Math.abs(v - relabelled[i]!), 0) / converted.length;
    expect(diff).toBeGreaterThan(2);
    r.release();
    await n.close();
  }, 600_000);

  it('BT.2020 primaries with an SDR transfer get a gamut conversion and no HDR warning (I4)', async () => {
    const n = new MediaNormalizer({ ffmpeg: async () => ffmpeg as FfmpegInfo });
    const r = await prep(n, comp([video('assets/wide.mp4')]));
    expect(r.warnings).toEqual([]);
    const m = r.media.clips.get('assets/wide.mp4')!;
    const s = JSON.parse(probe(m.file, ['-show_entries', 'stream=color_primaries,color_space', '-of', 'json'])).streams[0];
    expect(s).toEqual({ color_primaries: 'bt709', color_space: 'bt709' });
    r.release();
    await n.close();
  }, 600_000);

  it('files are leased as soon as they are picked: a cap prune during a long sibling encode keeps the early hit (lease window)', async () => {
    rmSync(cache, { recursive: true, force: true });
    const n = new MediaNormalizer({ ffmpeg: async () => ffmpeg as FfmpegInfo, x264Preset: 'veryslow' });
    const first = await prep(n, comp([video('assets/small.mp4', { props: { width: 160, height: 90 } })], { width: 1280, height: 720, fps: 60 }));
    const hit = first.media.clips.get('assets/small.mp4')!.file;
    first.release();
    const long = new AbortController();
    const both = prep(n, comp([video('assets/small.mp4', { props: { width: 160, height: 90 } }), video('assets/heavy.mp4', { props: { width: 1280, height: 720 } })], { width: 1280, height: 720, fps: 60 }), long.signal);
    both.catch(() => {});
    await waitFor(async () => (await encoders()).length > 0);
    await new Promise((r) => setTimeout(r, 500)); // the hit was picked (and leased) meanwhile
    const later = Date.now() + 20 * 60_000; // as if the sibling encode had run for 20 minutes
    const pruned = await pruneMediaCache(cache, { maxBytes: 1, maxUnusedMs: null, inUse: n.inUse, now: later });
    expect(pruned, `${hit} ${readdirSync(cache).join(',')}`).toEqual([]);
    expect(existsSync(hit)).toBe(true);
    long.abort();
    expect(await both.catch((e: RenderError) => e.code)).toBe('cancelled');
    // A preparation that throws gives its leases back: the same prune now removes the file.
    expect(await pruneMediaCache(cache, { maxBytes: 1, maxUnusedMs: null, inUse: n.inUse, now: later })).toEqual([hit]);
    await n.close();
    expect(liveGroupCount()).toBe(0);
  }, 600_000);

  it('source hashes are remembered under .studio/cache by path, size, mtime and inode (M10)', async () => {
    const memoFile = join(project, '.studio', 'cache', 'source-hashes.json');
    const memo = JSON.parse(readFileSync(memoFile, 'utf8')) as { entries: Record<string, string> };
    const key = Object.keys(memo.entries).find((k) => k.endsWith(join(compDir, 'assets', 'small.mp4')))!;
    expect(memo.entries[key]).toBe(sha(join(compDir, 'assets', 'small.mp4')));
    // A new normaliser (a new app start) uses the remembered hash: a planted one names the cache file.
    const planted = 'f'.repeat(64);
    writeFileSync(memoFile, JSON.stringify({ schemaVersion: 1, entries: { ...memo.entries, [key]: planted } }));
    const n = new MediaNormalizer({ ffmpeg: async () => ffmpeg as FfmpegInfo });
    const r = await prep(n, comp([video('assets/small.mp4')]));
    expect(r.media.clips.get('assets/small.mp4')!.file).toContain(`${planted}-30-`);
    r.release();
    await n.close();
  }, 600_000);

  it('the mix aligns a video clip\'s sound to its first video frame when the streams start apart (M12)', async () => {
    // Video starts at 0.1 s, audio at 0 with a beep at 0.5 s: 0.4 s after the first video frame.
    const src = join(compDir, 'assets', 'apart.mp4');
    const wav = join(work, 'beep.wav');
    burstWav(ffmpeg!, wav, { seconds: 2, at: 0.5, burst: 0.2 });
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=30:d=2', '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'pcm_s16le', '-output_ts_offset', '0', src.replace('.mp4', '.mov')]);
    ff(['-itsoffset', '0.1', '-i', src.replace('.mp4', '.mov'), '-i', src.replace('.mp4', '.mov'), '-map', '0:v', '-map', '1:a', '-c', 'copy', src.replace('.mp4', '2.mov')]);
    const starts = JSON.parse(probe(src.replace('.mp4', '2.mov'), ['-show_entries', 'stream=codec_type,start_time', '-of', 'json'])).streams as Array<{ codec_type: string; start_time: string }>;
    const v0 = Number(starts.find((s) => s.codec_type === 'video')!.start_time), a0 = Number(starts.find((s) => s.codec_type === 'audio')!.start_time);
    expect(v0 - a0).toBeCloseTo(0.1, 2);
    const out = join(work, 'mix.wav');
    const clip = { src: 'assets/apart2.mov', start: 0, duration: 1.5, trimStart: 0, volume: 1, fadeIn: 0, fadeOut: 0, fromVideo: true };
    expect(await mixAudio({ ff: ffmpeg!, compDir, clips: [clip], durationSec: 1.5, outWav: out, workDir: work, signal: new AbortController().signal })).toBe(true);
    const at = onset(decodeAudio(ffmpeg!, out), 0);
    expect(Math.abs(at - Math.round((0.5 - (v0 - a0)) * 48000))).toBeLessThan(48 * 3);
  }, 600_000);

  it('final renders are tagged full BT.709, limited range (ruling)', async () => {
    const out = join(work, 'final.mp4');
    await runFfmpeg(ffmpeg!, ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=0.5', ...h264Args('libx264', 800, 30), '-f', 'mp4', out]);
    const s = JSON.parse(probe(out, ['-show_entries', 'stream=color_primaries,color_transfer,color_space,color_range', '-of', 'json'])).streams[0];
    expect(s).toEqual({ color_range: 'tv', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709' });
  }, 300_000);
});

// @vitest-environment node
/**
 * Final wave part 3, S (decisions log 191): every filtergraph the core passes to ffmpeg comes from the typed builders of
 * `media/ffmpeg-filters.ts`. The graphs below are the ones the core produced before the change, byte for byte (checked
 * against the previous string code), for the real use cases.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  audioMixFilter, filterArgv, flattenFilter, frameScaleFilter, silentAudioInput, gamutStage, h264ColourFilter, hdrStage, normalizeVideoFilter, ssimCompareFilter, testPatternInput,
  type ColourStage, type FilterArg,
} from '../src/media/ffmpeg-filters.ts';
import { mixGraph } from '../src/render/audio-mix.ts';
import { normalizeArgs } from '../src/render/media-normalize.ts';
import { createFfmpegTools } from '../src/media/media-tools.ts';

const argv = (x: FilterArg) => filterArgv(x);
const TAIL = 'format=yuv420p,setsar=1,setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv';
const IN709 = 'in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=tv';

describe('ffmpeg filter builders: the real graphs', () => {
  it('normalisation: plain, untagged, tone-mapped HDR, approximate HDR and wide gamut', () => {
    const hlg = { primaries: 'bt2020', transfer: 'arib-std-b67', space: 'bt2020nc' };
    expect(argv(normalizeVideoFilter({ fps: 30, width: 1080, height: 1920 }))).toEqual(['-vf',
      `setpts=PTS-STARTPTS,fps=fps=30:round=up,scale=1080:1920:flags=lanczos:out_color_matrix=bt709:out_range=tv,${TAIL}`]);
    expect(argv(normalizeVideoFilter({ fps: 25, width: 640, height: 360, untagged: true }))).toEqual(['-vf',
      `setpts=PTS-STARTPTS,fps=fps=25:round=up,scale=640:360:flags=lanczos:${IN709},${TAIL}`]);
    expect(argv(normalizeVideoFilter({ fps: 24, width: 320, height: 180, colour: hdrStage(hlg, new Set(['zscale', 'tonemap'])).stage }))).toEqual(['-vf',
      'setpts=PTS-STARTPTS,fps=fps=24:round=up,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,'
      + `scale=320:180:flags=lanczos:${IN709},${TAIL}`]);
    expect(argv(normalizeVideoFilter({ fps: 60, width: 320, height: 180, colour: hdrStage(hlg, new Set(['colorspace'])).stage }))).toEqual(['-vf',
      `setpts=PTS-STARTPTS,fps=fps=60:round=up,colorspace=all=bt709:iprimaries=bt2020:ispace=bt2020ncl:itrc=bt2020-10:format=yuv420p,scale=320:180:flags=lanczos:${IN709},${TAIL}`]);
    expect(argv(normalizeVideoFilter({ fps: 60, width: 320, height: 180, colour: hdrStage({ primaries: 'bt709', transfer: 'smpte2084', space: 'bt709' }, undefined).stage }))).toEqual(['-vf',
      `setpts=PTS-STARTPTS,fps=fps=60:round=up,colorspace=all=bt709:iprimaries=bt709:ispace=bt709:itrc=bt2020-10:format=yuv420p,scale=320:180:flags=lanczos:${IN709},${TAIL}`]);
    expect(argv(normalizeVideoFilter({ fps: 30, width: 320, height: 180, colour: gamutStage({ primaries: 'bt2020', transfer: 'bt709', space: 'bt2020nc' }) }))).toEqual(['-vf',
      `setpts=PTS-STARTPTS,fps=fps=30:round=up,colorspace=all=bt709:iprimaries=bt2020:ispace=bt2020ncl:itrc=bt709:format=yuv420p,scale=320:180:flags=lanczos:${IN709},${TAIL}`]);
    expect(argv(normalizeVideoFilter({ fps: 30, width: 320, height: 180, colour: gamutStage({ primaries: 'bt2020', transfer: 'smpte170m', space: 'smpte170m' }) }))).toEqual(['-vf',
      `setpts=PTS-STARTPTS,fps=fps=30:round=up,colorspace=all=bt709:iprimaries=bt2020:ispace=smpte170m:itrc=smpte170m:format=yuv420p,scale=320:180:flags=lanczos:${IN709},${TAIL}`]);
    // normalizeArgs places the builder's option among the encode settings.
    const args = normalizeArgs({ fps: 30, width: 64, height: 36, allIntra: true });
    expect(args.slice(0, 5)).toEqual(['-map', '0:v:0', '-an', '-sn', '-dn']);
    expect(argv(args[5] as FilterArg)?.[0]).toBe('-vf');
  });

  it('probe values outside the tables map to fixed names (no probe text reaches a graph)', () => {
    expect(gamutStage({ primaries: 'other', transfer: 'other', space: 'other' })).toEqual({ kind: 'colorspace', primaries: 'bt2020', space: 'bt2020ncl', trc: 'bt709' });
    expect(gamutStage({ primaries: 'bt2020', transfer: 'constructor', space: 'toString' })).toEqual({ kind: 'colorspace', primaries: 'bt2020', space: 'bt2020ncl', trc: 'bt709' });
    expect(hdrStage({ primaries: 'other', transfer: 'other', space: 'other' }, undefined)).toEqual({ approximate: true, stage: { kind: 'colorspace', primaries: 'bt709', space: 'bt709', trc: 'bt2020-10' } });
  });

  it('final encode colour tags, still frames, the VideoToolbox test pattern and its SSIM check', () => {
    expect(argv(h264ColourFilter())).toEqual(['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv']);
    expect(argv(frameScaleFilter(540))).toEqual(['-vf', "scale='min(540,iw)':-2"]);
    expect(argv(testPatternInput(1080, 1920, 30))).toEqual(['-protocol_whitelist', 'file', '-format_whitelist', 'lavfi', '-f', 'lavfi', '-i',
      'testsrc=size=1080x1920:rate=30:duration=2[a];testsrc=size=270x480:rate=30:duration=2[b];[a][b]overlay=16:16[out0]']);
    expect(argv(testPatternInput(64, 64, 30))).toEqual(['-protocol_whitelist', 'file', '-format_whitelist', 'lavfi', '-f', 'lavfi', '-i',
      'testsrc=size=64x64:rate=30:duration=2[a];testsrc=size=16x16:rate=30:duration=2[b];[a][b]overlay=16:16[out0]']);
    expect(argv(ssimCompareFilter())).toEqual(['-lavfi', '[0:v]format=yuv420p[a];[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[b];[a][b]ssim']);
  });

  it('still frames (storyboards, reference frames, posters) reach ffmpeg with the builder graph, expanded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-test-frame-'));
    try {
      const video = join(dir, 'clip.mp4');
      writeFileSync(video, Buffer.alloc(64));
      const calls: string[][] = [];
      const tools = await createFfmpegTools(async (_cmd, args) => { calls.push([...args]); return { code: 0, stdout: '', stderr: '', notFound: false }; });
      await tools.frame(video, join(dir, 'out.jpg'), 0, { width: 539.6 });
      expect(calls.at(-1)).toEqual(['-y', '-loglevel', 'error', '-ss', '0', '-protocol_whitelist', 'file', '-format_whitelist', expect.any(String), '-i', video,
        '-frames:v', '1', '-q:v', '3', '-vf', "scale='min(540,iw)':-2", '-f', 'mjpeg', join(dir, 'out.jpg')]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('audio mix: one clip with fades, and two clips (gain rounded to 6 decimals)', () => {
    const per = (i: number, body: string) => `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${body}[a${i}]`;
    const end = 'duration=longest:dropout_transition=0:normalize=0,apad=whole_len=144000,alimiter=limit=0.89:level=false:latency=1,atrim=end_sample=144000,asetpts=N/SR/TB[out]';
    expect(argv(mixGraph([{ start: 0.5, duration: 1, trimStart: 0.25, volume: 0.8, fadeIn: 0.1, fadeOut: 0.2 }], 144_000))).toEqual(['-filter_complex',
      `${per(0, 'atrim=start_sample=12000:end_sample=60000,asetpts=N/SR/TB,volume=0.8,afade=t=in:start_sample=0:nb_samples=4800,afade=t=out:start_sample=38400:nb_samples=9600,adelay=delays=24000S:all=1')};`
      + `[a0]amix=inputs=1:${end}`]);
    expect(argv(mixGraph([
      { start: 0, duration: 3, trimStart: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
      { start: 1.25, duration: 0.5, trimStart: 2, volume: 1.234567891, fadeIn: 0.5, fadeOut: 0.5 },
    ], 144_000))).toEqual(['-filter_complex',
      `${per(0, 'atrim=start_sample=0:end_sample=144000,asetpts=N/SR/TB,volume=1,adelay=delays=0S:all=1')};`
      + `${per(1, 'atrim=start_sample=96000:end_sample=120000,asetpts=N/SR/TB,volume=1.234568,afade=t=in:start_sample=0:nb_samples=24000,afade=t=out:start_sample=0:nb_samples=24000,adelay=delays=60000S:all=1')};`
      + `[a0][a1]amix=inputs=2:${end}`]);
    // A non-finite value from a composition counts as 0 before the builder (the mix's own policy).
    expect(argv(mixGraph([{ start: Number.NaN, duration: 1, trimStart: 0, volume: Number.NaN, fadeIn: 0, fadeOut: 0 }], 48_000))?.[1]).toContain('volume=0,adelay=delays=0S:all=1');
  });
});

describe('ffmpeg filter builders: invalid values are refused', () => {
  it('sizes, rates and sample counts out of range or not integers', () => {
    for (const o of [{ width: 0, height: 36 }, { width: 64.5, height: 36 }, { width: 64, height: -2 }, { width: 64, height: 99_999 }, { width: Number.NaN, height: 36 }]) {
      expect(() => normalizeVideoFilter({ fps: 30, ...o }), JSON.stringify(o)).toThrow(RangeError);
    }
    for (const fps of [0, -30, Number.POSITIVE_INFINITY, Number.NaN, 1000]) expect(() => normalizeVideoFilter({ fps, width: 64, height: 36 }), String(fps)).toThrow(RangeError);
    for (const w of [0, 1.5, -540, 1e9, Number.NaN]) expect(() => frameScaleFilter(w), String(w)).toThrow(RangeError);
    expect(() => testPatternInput(8, 64, 30)).toThrow(RangeError);
    expect(() => testPatternInput(64, 64, 0)).toThrow(RangeError);
    const ok = { trimStart: 0, length: 48_000, volume: 1, fadeIn: 0, fadeOut: 0, delay: 0 };
    expect(() => audioMixFilter([ok], 48_000, 48_000)).not.toThrow();
    expect(() => audioMixFilter([], 48_000, 48_000)).toThrow(RangeError);
    expect(() => audioMixFilter([ok], 48_000, 0)).toThrow(RangeError);
    expect(() => audioMixFilter([ok], -1, 48_000)).toThrow(RangeError);
    for (const bad of [{ trimStart: -1 }, { length: 0.5 }, { volume: Number.NaN }, { volume: -0.1 }, { volume: 17 }, { fadeIn: Number.POSITIVE_INFINITY }, { delay: -48_000 }]) {
      expect(() => audioMixFilter([{ ...ok, ...bad }], 48_000, 48_000), JSON.stringify(bad)).toThrow(RangeError);
    }
  });

  it('a colour stage outside the enums is refused (also when forced past the types)', () => {
    const forced = (s: unknown) => () => normalizeVideoFilter({ fps: 30, width: 64, height: 36, colour: s as ColourStage });
    expect(forced({ kind: 'colorspace', primaries: 'bt601', space: 'bt709', trc: 'bt709' })).toThrow(RangeError);
    expect(forced({ kind: 'colorspace', primaries: 'bt709', space: 'bt709', trc: 'linear' })).toThrow(RangeError);
    expect(forced({ kind: 'other' })).toThrow(RangeError);
  });

  it('only objects made by the builders carry arguments: strings and look-alikes do not', () => {
    expect(filterArgv('scale=64:36')).toBeUndefined();
    expect(filterArgv({ argv: ['-vf', 'scale=64:36'] })).toBeUndefined();
    expect(filterArgv(null)).toBeUndefined();
    const made = frameScaleFilter(64);
    expect(Object.isFrozen(made) && Object.keys(made).length === 0).toBe(true);
    expect(Object.isFrozen(filterArgv(made))).toBe(true);
  });

  it('store steps (Phase 12): the flatten graph and the silent audio input, with their values checked', () => {
    expect(argv(flattenFilter(1320, 2868, '0a1b2c'))).toEqual(['-filter_complex',
      'color=c=0x0a1b2c:s=1320x2868:r=1[bg];[0:v]format=rgba[fg];[bg][fg]overlay=format=rgb:shortest=1,format=rgb24[out]']);
    for (const bad of ['#0a1b2c', '0A1B2C', 'red', '0a1b2c:s=1x1', '']) expect(() => flattenFilter(10, 10, bad), bad).toThrow(RangeError);
    expect(() => flattenFilter(0, 10, '000000')).toThrow(RangeError);
    expect(() => flattenFilter(10.5, 10, '000000')).toThrow(RangeError);
    expect(argv(silentAudioInput(960_000, 48_000))).toEqual(['-protocol_whitelist', 'file', '-format_whitelist', 'lavfi', '-f', 'lavfi', '-i',
      'anullsrc=r=48000:cl=stereo,atrim=end_sample=960000']);
    expect(() => silentAudioInput(0, 48_000)).toThrow(RangeError);
    expect(() => silentAudioInput(100, 100)).toThrow(RangeError);
    expect(() => silentAudioInput(Number.NaN, 48_000)).toThrow(RangeError);
  });
});

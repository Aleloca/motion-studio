// @vitest-environment node
/**
 * Store render steps (Phase 12, Task 6, spec §4.2, Review Focus 5), with real ffmpeg (and Chrome for the renderer part):
 * - a store screenshot PNG with an alpha channel is flattened onto the composition background (`format=rgb24`, typed
 *   filter builders): the IHDR colour type becomes 2, the size is kept, a half-transparent pixel is mixed with the background;
 * - a video without audio gets a silent stereo AAC track (the App Store preview needs one), of the video's length;
 * - which presets get which step (`storeRenderOptions`), and the render jobs pass them to the engine;
 * The renderer itself (real Chrome) is in store-render.chrome.test.ts. Skipped without ffmpeg, unless MS_REQUIRE_CHROME=1.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_FORMATS, type Composition, type JobSummary } from '@motion-studio/shared';
import { backgroundRgb, flattenPng, storeRenderOptions, withSilentAudio } from '../src/store-pack/flatten.ts';
import { readImageInfo } from '../src/store-pack/requirements.ts';
import { createFfmpegTools } from '../src/media/media-tools.ts';
import { renderTools } from './helpers/render-env.ts';
import { firstPixel, makePng } from './helpers/store-images.ts';
import { H, PRESETS, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

const tools = await renderTools('store render steps');
const ff = tools.ffmpeg;
const work = mkdtempSync(join(tmpdir(), 'ms-test-store-flatten-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const signal = new AbortController().signal;
const ffprobe = () => join(ff!.path, '..', 'ffprobe');
const streams = (file: string) => (JSON.parse(execFileSync(ffprobe(), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels,sample_rate,duration', '-of', 'json', file], { encoding: 'utf8' })) as { streams: Array<Record<string, string | number>> }).streams;

describe('storeRenderOptions and backgroundRgb', () => {
  const comp = (background: string, duration = 0) => ({ background, duration }) as Composition;
  it('flattens every store screenshot and the feature graphic; the App Store preview gets the store audio', () => {
    for (const id of ['appstore-iphone-69', 'appstore-iphone-69@3', 'appstore-iphone-65', 'appstore-ipad-13@2', 'playstore-phone-9x16', 'playstore-tablet@2', 'playstore-feature']) {
      expect(storeRenderOptions(id, comp('#112233')), id).toEqual({ flattenOnto: '#112233' });
    }
    expect(storeRenderOptions('appstore-preview', comp('#000', 20))).toEqual({ storeAudio: true });
    for (const id of ['instagram-post-1x1', 'playstore-promo-16x9', 'appstore-icon', 'test-wide']) expect(storeRenderOptions(id, comp('#fff')), id).toEqual({});
  });
  it('reads the rgb part of any composition colour', () => {
    expect(backgroundRgb('#abc')).toBe('aabbcc');
    expect(backgroundRgb('#abcd')).toBe('aabbcc');
    expect(backgroundRgb('#A1B2C3')).toBe('a1b2c3');
    expect(backgroundRgb('#a1b2c300')).toBe('a1b2c3');
    expect(() => backgroundRgb('red')).toThrow();
    expect(() => backgroundRgb('#12345')).toThrow();
  });
});

describe.skipIf(!ff)('flattenPng and withSilentAudio (real ffmpeg)', () => {
  it('flattens a PNG with alpha onto the background: colour type 2 (IHDR), same size, pixel mixed with the background', async () => {
    const src = join(work, 'alpha.png');
    writeFileSync(src, makePng(40, 30, 6)); // every pixel (128, 128, 128, alpha 128)
    expect(await readImageInfo(src)).toMatchObject({ ok: true, alpha: true, colorType: 6 });
    const out = join(work, 'flat.png');
    await flattenPng(ff!, src, out, { width: 40, height: 30, background: '#ff0000' }, signal);
    const info = await readImageInfo(out);
    expect(info).toEqual({ ok: true, format: 'png', width: 40, height: 30, alpha: false, colorType: 2 });
    const { pixel } = firstPixel(readFileSync(out));
    // About half grey, half red.
    expect(pixel[0]).toBeGreaterThan(170);
    expect(pixel[0]).toBeLessThan(210);
    expect(pixel[1]).toBeGreaterThan(45);
    expect(pixel[1]).toBeLessThan(85);
  });

  it('refuses an output of another size (a PNG that is not the format size)', async () => {
    const src = join(work, 'small.png');
    writeFileSync(src, makePng(20, 10, 6));
    await expect(flattenPng(ff!, src, join(work, 'never.png'), { width: 40, height: 30, background: '#000000' }, signal)).rejects.toThrow();
    expect(existsSync(join(work, 'never.png'))).toBe(false);
  });

  it('adds a silent stereo AAC track of the video length to a video without audio', async () => {
    const src = join(work, 'mute.mp4');
    execFileSync(ff!.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x128:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', src]);
    expect(streams(src).map((s) => s.codec_type)).toEqual(['video']);
    const out = join(work, 'with-audio.mp4');
    await withSilentAudio(ff!, src, out, { durationSec: 2, container: 'mp4' }, signal);
    const s = streams(out);
    expect(s.map((x) => x.codec_type).sort()).toEqual(['audio', 'video']);
    const a = s.find((x) => x.codec_type === 'audio')!;
    expect(a).toMatchObject({ codec_name: 'aac', channels: 2, sample_rate: '48000' });
    expect(Math.abs(Number(a.duration) - 2)).toBeLessThan(0.05);
    // The probe the store check uses sees it.
    const media = await createFfmpegTools();
    expect(await media.probe(out)).toMatchObject({ width: 64, height: 128, fps: 30, videoCodec: 'h264', audio: true });
    expect(await media.probe(src)).toMatchObject({ videoCodec: 'h264', audio: false });
  });
});

describe('render jobs pass the store steps to the engine', { timeout: 120_000 }, () => {
  let env: InstanceEnv;
  afterEach(async () => { await env?.close(); });
  it('a store screenshot is rendered with flattenOnto, the App Store preview with storeAudio, others with neither', async () => {
    env = await startInstanceEnv('ms-test-store-jobs-');
    const store = DEFAULT_FORMATS.filter((p) => p.id === 'appstore-iphone-69' || p.id === 'appstore-preview');
    expect((await env.app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: [...PRESETS, ...store] } })).statusCode).toBe(200);
    const slug = await env.create(['appstore-iphone-69', 'appstore-iphone-69@2', 'appstore-preview', 'test-wide'], { links: {} });
    const r = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: {} });
    expect(r.statusCode, r.body).toBe(202);
    const done = await env.waitJob((r.json() as JobSummary).id);
    expect(done.state, done.error).toBe('succeeded');
    const call = (id: string) => env.fake.renders.find((x) => x.out.endsWith(`/${id}.png`) || x.out.endsWith(`/${id}.mp4`))!;
    expect(call('appstore-iphone-69')).toMatchObject({ flattenOnto: expect.stringMatching(/^#/) });
    expect(call('appstore-iphone-69@2')).toMatchObject({ flattenOnto: expect.stringMatching(/^#/) });
    expect(call('appstore-preview')).toMatchObject({ storeAudio: true });
    expect(call('appstore-preview').flattenOnto).toBeUndefined();
    expect(call('test-wide').flattenOnto).toBeUndefined();
    expect(call('test-wide').storeAudio).toBeUndefined();
  });
});

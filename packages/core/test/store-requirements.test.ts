// @vitest-environment node
/**
 * Store requirements (Phase 12, Task 6, spec §4.2, Review Focus 5): bounded PNG (IHDR) and JPEG (SOF) readers, tested against
 * hostile files (truncated, huge declared sizes, wrong magic, endless segments), and `checkStoreFile`: exact size, PNG or
 * JPEG, no alpha, and for the App Store preview the probe's duration (15–30 s, refused with the limits named), fps, codec and
 * audio track.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { messages, STORE_LIMITS } from '@motion-studio/shared';
import { checkStoreFile, readImageInfo } from '../src/store-pack/requirements.ts';
import type { MediaInfo } from '../src/media/media-tools.ts';
import { currentLocale } from '../src/i18n.ts';
import { chunk, makeJpeg, makePng } from './helpers/store-images.ts';


const dir = mkdtempSync(join(tmpdir(), 'ms-test-store-req-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;
const file = (data: Buffer | string, ext = 'png') => { const p = join(dir, `f${seq++}.${ext}`); writeFileSync(p, data); return p; };
const c = () => messages(currentLocale()).variants.storePack.check;

describe('readImageInfo (bounded readers)', () => {
  it('reads a PNG: size, colour type and alpha (RGBA, grey+alpha, tRNS)', async () => {
    expect(await readImageInfo(file(makePng(40, 30, 2)))).toEqual({ ok: true, format: 'png', width: 40, height: 30, alpha: false, colorType: 2 });
    expect(await readImageInfo(file(makePng(40, 30, 6)))).toMatchObject({ ok: true, alpha: true, colorType: 6 });
    expect(await readImageInfo(file(makePng(4, 3, 4)))).toMatchObject({ ok: true, alpha: true, colorType: 4 });
    expect(await readImageInfo(file(makePng(4, 3, 2, [chunk('tRNS', Buffer.alloc(6))])))).toMatchObject({ ok: true, alpha: true, colorType: 2 });
  });

  it('reads a JPEG SOF (baseline and progressive); a JPEG never has alpha', async () => {
    expect(await readImageInfo(file(makeJpeg(1320, 2868), 'jpg'))).toEqual({ ok: true, format: 'jpeg', width: 1320, height: 2868, alpha: false });
    expect(await readImageInfo(file(makeJpeg(64, 48, 0xc2), 'jpg'))).toMatchObject({ ok: true, width: 64, height: 48 });
  });

  it('refuses hostile files without reading them whole: wrong magic, truncated, huge declared sizes, endless segments', async () => {
    const bad = async (data: Buffer | string, ext = 'png') => (await readImageInfo(file(data, ext))).ok;
    expect(await bad('GIF89a not a store image')).toBe(false);
    expect(await bad(Buffer.alloc(0))).toBe(false);
    expect(await bad(makePng(10, 10).subarray(0, 8))).toBe(false); // signature only
    expect(await bad(makePng(10, 10).subarray(0, 20))).toBe(false); // IHDR cut
    // IHDR with a huge size (over 2^31) or zero size.
    const huge = makePng(10, 10); huge.writeUInt32BE(0xffffffff, 16);
    expect(await bad(huge)).toBe(false);
    const zero = makePng(10, 10); zero.writeUInt32BE(0, 20);
    expect(await bad(zero)).toBe(false);
    // First chunk not IHDR, or IHDR declaring a length other than 13.
    const notIhdr = makePng(10, 10); notIhdr.write('IHDX', 12, 'latin1');
    expect(await bad(notIhdr)).toBe(false);
    const longIhdr = makePng(10, 10); longIhdr.writeUInt32BE(0x7fffffff, 8);
    expect(await bad(longIhdr)).toBe(false);
    // A chunk before IDAT declaring a length past the end of the file.
    const liar = Buffer.concat([makePng(10, 10).subarray(0, 33), Buffer.from([0xff, 0xff, 0xff, 0xf0]), Buffer.from('tEXt', 'latin1')]);
    expect(await bad(liar)).toBe(false);
    // JPEG: SOI only, a segment length past the end, a length under 2, a SOF cut short, no SOF before SOS, endless empty segments.
    expect(await bad(Buffer.from([0xff, 0xd8]), 'jpg')).toBe(false);
    expect(await bad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00]), 'jpg')).toBe(false);
    expect(await bad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x00, 0x00]), 'jpg')).toBe(false);
    expect(await bad(makeJpeg(10, 10).subarray(0, 26), 'jpg')).toBe(false);
    expect(await bad(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]), 'jpg')).toBe(false);
    const endless = Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array.from({ length: 20_000 }, () => Buffer.from([0xff, 0xfe, 0x00, 0x02]))]);
    expect(await bad(endless, 'jpg')).toBe(false);
    // A JPEG SOF declaring a zero size.
    expect(await bad(makeJpeg(0, 10), 'jpg')).toBe(false);
  });

  it('refuses what is not a regular file (a folder)', async () => {
    expect((await readImageInfo(dir)).ok).toBe(false);
    expect((await readImageInfo(join(dir, 'missing.png'))).ok).toBe(false);
  });
});

describe('checkStoreFile', () => {
  const shot = { width: 40, height: 30 };
  it('a screenshot: exact size, PNG or JPEG, no alpha', async () => {
    expect(await checkStoreFile('screenshot', 'appstore', file(makePng(40, 30, 2)), shot)).toEqual({ ok: true });
    expect(await checkStoreFile('screenshot', 'appstore', file(makeJpeg(40, 30), 'jpg'), shot)).toEqual({ ok: true });
    expect(await checkStoreFile('screenshot', 'appstore', file(makePng(41, 30, 2)), shot)).toEqual({ ok: false, reason: c().wrongSize({ width: 41, height: 30, expectedWidth: 40, expectedHeight: 30 }) });
    expect(await checkStoreFile('screenshot', 'appstore', file(makePng(40, 30, 6)), shot)).toEqual({ ok: false, reason: c().hasAlpha });
    expect(await checkStoreFile('screenshot', 'playstore', file(makePng(40, 30, 6)), shot)).toEqual({ ok: false, reason: c().hasAlpha });
    expect(await checkStoreFile('screenshot', 'appstore', file('RIFF....WEBPVP8 '), shot)).toEqual({ ok: false, reason: c().notImage });
  });

  it('the Play feature graphic: no alpha, exact size', async () => {
    const f = { width: 1024, height: 500 };
    expect(await checkStoreFile('feature', 'playstore', file(makePng(1024, 500, 2)), f)).toEqual({ ok: true });
    expect(await checkStoreFile('feature', 'playstore', file(makePng(1024, 500, 6)), f)).toEqual({ ok: false, reason: c().hasAlpha });
    expect((await checkStoreFile('feature', 'playstore', file(makePng(1024, 512, 2)), f)).ok).toBe(false);
  });

  describe('the App Store preview (probe)', () => {
    const size = { width: 886, height: 1920 };
    const good: MediaInfo = { width: 886, height: 1920, durationSec: 20, fps: 30, videoCodec: 'h264', audio: true };
    const probe = (info: Partial<MediaInfo> | null) => async () => (info === null ? null : { ...good, ...info });
    const video = file('not read: the probe is injected', 'mp4');
    const check = (info: Partial<MediaInfo> | null) => checkStoreFile('preview', 'appstore', video, { ...size, probe: probe(info) });
    const { minSec, maxSec, fps } = STORE_LIMITS.appstore.preview;

    it('accepts 15–30 s, 30 fps, H.264 with audio', async () => {
      expect(await check({})).toEqual({ ok: true });
      expect(await check({ durationSec: 15 })).toEqual({ ok: true });
      expect(await check({ durationSec: 30 })).toEqual({ ok: true });
    });
    it('refuses 12 s and 35 s, naming the limits', async () => {
      for (const seconds of [12, 35]) {
        const r = await check({ durationSec: seconds });
        expect(r).toEqual({ ok: false, reason: c().duration({ seconds, min: minSec, max: maxSec }) });
        expect((r as { reason: string }).reason).toContain(String(minSec));
        expect((r as { reason: string }).reason).toContain(String(maxSec));
      }
    });
    it('refuses another fps, another codec, no audio, a wrong size, an unreadable file', async () => {
      expect(await check({ fps: 25 })).toEqual({ ok: false, reason: c().fps({ fps: 25, expected: fps }) });
      expect(await check({ videoCodec: 'hevc' })).toEqual({ ok: false, reason: c().codec({ codec: 'hevc' }) });
      expect(await check({ audio: false })).toEqual({ ok: false, reason: c().noAudio });
      expect(await check({ width: 1080 })).toEqual({ ok: false, reason: c().wrongSize({ width: 1080, height: 1920, expectedWidth: 886, expectedHeight: 1920 }) });
      expect(await check(null)).toEqual({ ok: false, reason: c().notVideo });
      expect(await check({ durationSec: null })).toEqual({ ok: false, reason: c().notVideo });
    });
    it('the Google Play promo video: size and H.264 only (it goes to YouTube)', async () => {
      const promo = { width: 1920, height: 1080 };
      const ok = await checkStoreFile('preview', 'playstore', video, { ...promo, probe: probe({ width: 1920, height: 1080, durationSec: 45, audio: false, fps: 25 }) });
      expect(ok).toEqual({ ok: true });
      expect((await checkStoreFile('preview', 'playstore', video, { ...promo, probe: probe({ width: 1920, height: 1080, videoCodec: 'vp9' }) })).ok).toBe(false);
    });
  });
});

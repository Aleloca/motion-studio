// @vitest-environment node
/**
 * The quality and resolution of a render (decision 974, user report 22): the encode of each quality (encoder, CRF, cap,
 * frames), the H.264 arguments at another size, and the capture size check of a scaled page.
 */
import { describe, expect, it } from 'vitest';
import { captureFrame } from '../src/render/capture.ts';
import { pagePixels, scaleFlags, type RenderPage } from '../src/render/chromium-provider.ts';
import { h264Args, qualitySettings } from '../src/render/encode.ts';
import { filterArgv } from '../src/media/ffmpeg-filters.ts';

const text = (args: ReturnType<typeof h264Args>) => args.flatMap((x) => (typeof x === 'string' ? [x] : [...filterArgv(x)!])).join(' ');

/** A PNG header of `w`×`h` (enough for `imageSize`). */
function pngOf(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
const pageOf = (w: number, h: number): RenderPage => ({ info: { duration: 1, fps: 30, width: w, height: h, frames: 30, errors: [] }, seek: async () => {}, capture: async () => pngOf(w, h), errors: async () => [], close: async () => {} });

describe('render quality (decision 974)', () => {
  it('standard is the phase 8 encode; high is libx264 CRF 18 at 1.6x; max is CRF 16 without a cap, from PNG frames', () => {
    expect(qualitySettings('standard', 5000)).toEqual({ encoder: 'auto', kbps: 5000, crf: 20, cap: true, capture: 'jpeg', jpegQuality: 90 });
    // About 8 Mbps at 1080p30 landscape (YouTube's recommendation), scaled with the target.
    expect(qualitySettings('high', 5000)).toEqual({ encoder: 'libx264', kbps: 8000, crf: 18, cap: true, capture: 'jpeg', jpegQuality: 95 });
    expect(qualitySettings('high', 4000).kbps).toBe(6400);
    expect(qualitySettings('max', 5000)).toEqual({ encoder: 'libx264', kbps: 15000, crf: 16, cap: false, preset: 'medium', capture: 'png' });
  });

  it('the H.264 arguments take the CRF, drop the cap for max (never for VideoToolbox), and scale to another size', () => {
    const high = text(h264Args('libx264', 8000, 30, 'fast', { crf: 18, cap: true }));
    expect(high).toContain('-crf 18');
    expect(high).toContain('-maxrate 12000k -bufsize 16000k');
    const max = text(h264Args('libx264', 15000, 30, 'medium', { crf: 16, cap: false }));
    expect(max).toContain('-preset medium -crf 16');
    expect(max).not.toContain('-maxrate');
    expect(text(h264Args('h264_videotoolbox', 5000, 30, 'fast', { cap: false }))).toContain('-maxrate 7500k');
    const sized = text(h264Args('libx264', 3000, 30, 'fast', { crf: 18, size: { width: 854, height: 480 } }));
    expect(sized).toContain('-vf scale=854:480:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p,');
    // The default stays the phase 8 one.
    expect(text(h264Args('libx264', 4000, 30))).toContain('-crf 20');
  });

  it('a scaled capture may be a pixel off its rounded size, never more', async () => {
    await expect(captureFrame(pageOf(853, 480), 0, { format: 'png', width: 854, height: 480, tolerance: 1 })).resolves.toBeInstanceOf(Buffer);
    await expect(captureFrame(pageOf(852, 480), 0, { format: 'png', width: 854, height: 480, tolerance: 1 })).rejects.toMatchObject({ code: 'badFrame' });
    await expect(captureFrame(pageOf(853, 480), 0, { format: 'png', width: 854, height: 480 })).rejects.toMatchObject({ code: 'badFrame' });
  });

  it('review #8: a page rasterised at a scale counts its physical pixels for the memory limits', () => {
    expect(pagePixels({ width: 1080, height: 1920 })).toEqual({ width: 1080, height: 1920 });
    expect(pagePixels({ width: 1920, height: 1080, deviceScaleFactor: 2 })).toEqual({ width: 3840, height: 2160 });
  });

  it('report 51: a browser for a scaled render is launched at its scale; at 1 (stills, previews) with no flag', () => {
    expect(scaleFlags(4 / 3)).toEqual([`--force-device-scale-factor=${4 / 3}`]);
    expect(scaleFlags(2)).toEqual(['--force-device-scale-factor=2']);
    for (const k of [1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(scaleFlags(k), String(k)).toEqual([]);
  });
});

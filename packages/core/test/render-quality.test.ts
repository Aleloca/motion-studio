// @vitest-environment node
/**
 * The quality and resolution of a render (decision 974, user report 22): the encode of each quality (encoder, CRF, cap,
 * frames), the H.264 arguments at another size, and the capture size check of a scaled page.
 */
import { describe, expect, it } from 'vitest';
import { captureFrame, captureRawFrame, captureSegment } from '../src/render/capture.ts';
import { pagePixels, scaleFlags, type RenderPage } from '../src/render/chromium-provider.ts';
import { frameInput, h264Args, qualitySettings } from '../src/render/encode.ts';
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
/** A page whose raw frames (report 53) are `sizes` in turn (the last one repeats). */
const rawPageOf = (...sizes: Array<[number, number]>): RenderPage => {
  let i = 0;
  return { ...pageOf(1, 1), captureRaw: async () => { const [w, h] = sizes[Math.min(i++, sizes.length - 1)]!; return { data: Buffer.alloc(w * h * 4), width: w, height: h }; } };
};
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

  it('report 51: a browser for an upscaled render is launched at its scale; at 1 (stills, previews) or below with no flag', () => {
    expect(scaleFlags(4 / 3)).toEqual([`--force-device-scale-factor=${4 / 3}`]);
    expect(scaleFlags(2)).toEqual(['--force-device-scale-factor=2']);
    // Below 1 (a 720p or 480p export of a 1080p composition, decision 1346): no flag, as before; the layers are drawn at 1x and
    // the page shrinks them.
    for (const k of [1, 0.5, 2 / 3, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(scaleFlags(k), String(k)).toEqual([]);
  });

  it('report 53: a raw frame (BGRA, no encode) is checked like an encoded one', async () => {
    await expect(captureRawFrame(rawPageOf([853, 480]), 0, { width: 854, height: 480, tolerance: 1 })).resolves.toMatchObject({ width: 853, height: 480 });
    await expect(captureRawFrame(rawPageOf([852, 480]), 0, { width: 854, height: 480, tolerance: 1 })).rejects.toMatchObject({ code: 'badFrame' });
    await expect(captureRawFrame(rawPageOf([854, 480]), 0, { width: 854, height: 481 })).rejects.toMatchObject({ code: 'badFrame' });
    // A buffer that does not hold width × height BGRA pixels is never encoded.
    const short: RenderPage = { ...pageOf(1, 1), captureRaw: async () => ({ data: Buffer.alloc(10), width: 854, height: 480 }) };
    await expect(captureRawFrame(short, 0, { width: 854, height: 480 })).rejects.toMatchObject({ code: 'badFrame' });
    // A page without raw frames cannot be asked for one.
    await expect(captureRawFrame(pageOf(854, 480), 0, { width: 854, height: 480 })).rejects.toMatchObject({ code: 'badFrame' });
  });

  it('report 53: a raw segment hands each frame with its size, and every frame of it has the first one\'s size', async () => {
    const seen: string[] = [];
    const sink = async (b: Buffer, i: number, size?: { width: number; height: number }) => { seen.push(`${i}:${size?.width}x${size?.height}:${b.length}`); };
    const base = { fps: 30, format: 'png' as const, width: 4, height: 2, signal: new AbortController().signal, sink, raw: true };
    await captureSegment(rawPageOf([4, 2]), { index: 0, from: 0, to: 2 }, base);
    expect(seen).toEqual(['0:4x2:32', '1:4x2:32']);
    await expect(captureSegment(rawPageOf([4, 2], [5, 2]), { index: 0, from: 0, to: 2 }, { ...base, tolerance: 1 })).rejects.toMatchObject({ code: 'badFrame' });
  });

  it('report 53: the encoder reads raw BGRA frames of the given size, or the encoded ones as before', () => {
    expect(frameInput({ raw: { width: 2560, height: 1440 } }, 60)).toEqual(['-protocol_whitelist', 'pipe,fd', '-format_whitelist', 'rawvideo', '-f', 'rawvideo',
      '-pixel_format', 'bgra', '-video_size', '2560x1440', '-framerate', '60', '-i', '-']);
    expect(frameInput('png', 30)).toEqual(['-protocol_whitelist', 'pipe,fd', '-format_whitelist', 'image2pipe', '-f', 'image2pipe', '-c:v', 'png', '-framerate', '30', '-i', '-']);
    expect(frameInput('jpeg', 30)).toContain('mjpeg');
  });
});

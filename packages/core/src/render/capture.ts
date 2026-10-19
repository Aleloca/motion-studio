import type { Writable } from 'node:stream';
import type { CaptureFormat, RawFrame, RenderPage } from './chromium-provider.ts';
import { RenderError } from './errors.ts';

/**
 * Frame capture (spec §5.3; spike §2): `seek(i / fps)` then `Page.captureScreenshot`, frame by frame. A video is split into
 * N contiguous segments, one page each, every page streaming its frames (JPEG q90) into its own ffmpeg; the segments are
 * joined with the concat demuxer, and the final frame count is checked exactly.
 */

export interface Segment { index: number; from: number; to: number }

/** `frames` split into at most `parallel` contiguous, non-empty segments `[from, to)` of near-equal length. */
export function splitSegments(frames: number, parallel: number): Segment[] {
  const n = Math.max(1, Math.min(Math.floor(parallel), frames));
  const out: Segment[] = [];
  let from = 0;
  for (let i = 0; i < n; i++) {
    const to = Math.round(((i + 1) * frames) / n);
    if (to > from) out.push({ index: out.length, from, to });
    from = to;
  }
  return out;
}

/** Width and height of a PNG or baseline/progressive JPEG, or null. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return null;
}

/**
 * Captures one frame and checks its size: a frame of another size is never encoded. `tolerance`: a render at another scale
 * (decision 974) may come out a pixel off its rounded size (the encode then scales it exactly).
 */
export async function captureFrame(page: RenderPage, t: number, o: { format: CaptureFormat; quality?: number; width: number; height: number; tolerance?: number }): Promise<Buffer> {
  await page.seek(t);
  const buf = await page.capture(o.format, o.quality);
  const size = imageSize(buf);
  const off = (a: number, b: number) => Math.abs(a - b) > (o.tolerance ?? 0);
  if (!size || off(size.width, o.width) || off(size.height, o.height)) {
    throw new RenderError('badFrame', `captured frame is ${size ? `${size.width}×${size.height}` : 'unreadable'}, expected ${o.width}×${o.height}`);
  }
  return buf;
}

/**
 * Report 53: one frame as raw BGRA pixels (`RenderPage.captureRaw`), checked like `captureFrame` (its size, within
 * `tolerance`) and for its length: a buffer that is not `width × height × 4` bytes is never encoded.
 */
export async function captureRawFrame(page: RenderPage, t: number, o: { width: number; height: number; tolerance?: number }): Promise<RawFrame> {
  if (!page.captureRaw) throw new RenderError('badFrame', 'this page has no raw frames');
  await page.seek(t);
  const f = await page.captureRaw();
  const off = (a: number, b: number) => Math.abs(a - b) > (o.tolerance ?? 0);
  if (off(f.width, o.width) || off(f.height, o.height) || f.data.length !== f.width * f.height * 4) {
    throw new RenderError('badFrame', `captured frame is ${f.width}×${f.height} (${f.data.length} bytes), expected ${o.width}×${o.height}`);
  }
  return f;
}

/** Writes `buf` to `stream` honouring backpressure; rejects when `ended` settles first (the consumer died). */
export function writeWithBackpressure(stream: Writable, buf: Buffer, ended: Promise<unknown>): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return Promise.reject(new RenderError('ffmpegFailed', 'the encoder stopped reading'));
  if (stream.write(buf)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new RenderError('ffmpegFailed', 'the encoder stopped reading')); };
    const cleanup = () => { stream.off('drain', onDrain); stream.off('close', onClose); stream.off('error', onClose); };
    stream.once('drain', onDrain);
    stream.once('close', onClose);
    stream.once('error', onClose);
    ended.then(onClose, onClose);
  });
}

/**
 * Captures frames `[seg.from, seg.to)` of `page` at `fps` and hands each one to `sink` in order. Stops at the first error
 * or when `signal` aborts.
 */
export async function captureSegment(page: RenderPage, seg: Segment, o: {
  fps: number; format: CaptureFormat; quality?: number; width: number; height: number; tolerance?: number; signal: AbortSignal;
  /** Report 53: raw BGRA frames (`captureRaw`); the sink gets each frame's size, the same for the whole segment. */
  raw?: boolean;
  sink: (frame: Buffer, index: number, size?: { width: number; height: number }) => Promise<void>; onFrame?: () => void;
}): Promise<void> {
  let first: { width: number; height: number } | null = null;
  for (let i = seg.from; i < seg.to; i++) {
    if (o.signal.aborted) throw new RenderError('cancelled', 'cancelled');
    if (o.raw) {
      const f = await captureRawFrame(page, i / o.fps, o);
      first ??= { width: f.width, height: f.height };
      // Raw frames carry no size of their own: the encoder reads them all at the first one's.
      if (f.width !== first.width || f.height !== first.height) throw new RenderError('badFrame', `captured frame is ${f.width}×${f.height}, the segment's ${first.width}×${first.height}`);
      await o.sink(f.data, i, first);
    } else {
      await o.sink(await captureFrame(page, i / o.fps, o), i);
    }
    o.onFrame?.();
  }
}

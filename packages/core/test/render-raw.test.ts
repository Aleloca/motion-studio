// @vitest-environment node
/**
 * Report 53: a render segment fed with raw frames (`encodeSegment`, the renderer's per-page loop) with a fake encoder: the
 * encoder starts at the first frame with its size, a segment without frames fails, an encoder dying mid-segment reports its
 * own error (stderr), a cancel during a raw capture stops the segment and kills the encoder.
 */
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { encodeSegment } from '../src/render/capture.ts';
import { RenderError, type RawFrame, type RenderPage } from '../src/render/chromium-provider.ts';
import type { FfmpegProcess } from '../src/render/encode.ts';

const W = 4, H = 2;
const frame = (w = W, h = H): RawFrame => ({ data: Buffer.alloc(w * h * 4, 7), width: w, height: h });

function rawPage(captureRaw: () => Promise<RawFrame>): RenderPage {
  return {
    info: { duration: 1, fps: 30, width: W, height: H, frames: 30, errors: [] },
    seek: async () => {}, capture: async () => { throw new Error('no encoded frames here'); }, captureRaw, errors: async () => [], close: async () => {},
  };
}

/** A fake ffmpeg: records its input and every byte; `dieAfter` bytes, it exits with an error (stdin closed, `done` rejects). */
function fakeEncoder(o: { dieAfter?: number } = {}) {
  const started: string[][] = [];
  let bytes = 0;
  let killed = 0;
  let fail: ((e: Error) => void) | null = null;
  let ok: (() => void) | null = null;
  const start = (input: string[]): FfmpegProcess => {
    started.push(input);
    const done = new Promise<void>((resolve, reject) => { ok = resolve; fail = reject; });
    done.catch(() => {});
    const stdin = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (o.dieAfter !== undefined && bytes > o.dieAfter) {
          fail!(new RenderError('ffmpegFailed', 'ffmpeg exited with 1: Invalid frame dimensions 482x271'));
          stdin.destroy();
          return;
        }
        setImmediate(cb);
      },
      final(cb) { ok!(); cb(); },
    });
    return { proc: {} as FfmpegProcess['proc'], stdin, done, kill: () => { killed++; } };
  };
  return { start, started, get bytes() { return bytes; }, get killed() { return killed; } };
}

const base = (signal = new AbortController().signal) => ({ fps: 30, encoded: 'png' as const, format: 'png' as const, width: W, height: H, signal, raw: true });

describe('a raw render segment (report 53)', () => {
  it('starts the encoder at the first frame, with that frame\'s size, and feeds it every frame', async () => {
    const enc = fakeEncoder();
    let captures = 0;
    const page = rawPage(async () => { expect(enc.started.length).toBe(captures === 0 ? 0 : 1); captures++; return frame(); });
    await encodeSegment(page, { index: 0, from: 0, to: 3 }, { ...base(), start: enc.start });
    expect(enc.started).toHaveLength(1);
    expect(enc.started[0]!.join(' ')).toContain(`-f rawvideo -pixel_format bgra -video_size ${W}x${H} -framerate 30`);
    expect(enc.bytes).toBe(3 * W * H * 4);
  });

  it('a segment without frames fails and starts no encoder', async () => {
    const enc = fakeEncoder();
    await expect(encodeSegment(rawPage(async () => frame()), { index: 0, from: 2, to: 2 }, { ...base(), start: enc.start })).rejects.toMatchObject({ code: 'badFrame' });
    expect(enc.started).toHaveLength(0);
  });

  it('an encoder dying mid-segment reports its own error (stderr), not "the encoder stopped reading"', async () => {
    const enc = fakeEncoder({ dieAfter: W * H * 4 });
    const err = await encodeSegment(rawPage(async () => frame()), { index: 0, from: 0, to: 5 }, { ...base(), start: enc.start }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ffmpegFailed' });
    expect((err as Error).message).toContain('Invalid frame dimensions 482x271');
    expect(enc.killed).toBeGreaterThan(0);
  });

  it('the same for encoded frames', async () => {
    const enc = fakeEncoder({ dieAfter: 10 });
    const png = Buffer.alloc(64);
    png.writeUInt32BE(0x89504e47, 0); png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(W, 16); png.writeUInt32BE(H, 20);
    const page: RenderPage = { ...rawPage(async () => frame()), capture: async () => png };
    const err = await encodeSegment(page, { index: 0, from: 0, to: 5 }, { ...base(), raw: false, start: enc.start }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('Invalid frame dimensions');
    expect(enc.started[0]!.join(' ')).toContain('-f image2pipe -c:v png');
  });

  it('a cancel during a raw capture ends the segment and kills the encoder', async () => {
    const enc = fakeEncoder();
    const ctl = new AbortController();
    let n = 0;
    const page = rawPage(() => (n++ === 0 ? Promise.resolve(frame()) : new Promise<RawFrame>((_, reject) => {
      // The provider closes its windows on a cancel: the capture in flight fails.
      ctl.signal.addEventListener('abort', () => reject(new RenderError('cancelled', 'the render windows are closed')), { once: true });
      setTimeout(() => ctl.abort(), 5);
    })));
    await expect(encodeSegment(page, { index: 0, from: 0, to: 5 }, { ...base(ctl.signal), start: enc.start })).rejects.toMatchObject({ code: 'cancelled' });
    expect(enc.started).toHaveLength(1);
    expect(enc.killed).toBeGreaterThan(0);
  });
});

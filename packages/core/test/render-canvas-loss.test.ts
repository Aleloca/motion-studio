// @vitest-environment node
/**
 * Decision 1752: a video canvas that loses its GPU context (Chrome's GPU process went) shows its box black until it is
 * drawn again. The runtime redraws it before a seek ends; a loss after the seek, before or during the capture, is seen by
 * the page's `canvasLost()` after the capture: the frame is sought and captured again, a bounded number of times.
 */
import { describe, expect, it } from 'vitest';
import { captureFrame, captureRawFrame, CANVAS_LOSS_ATTEMPTS } from '../src/render/capture.ts';
import type { RenderPage } from '../src/render/chromium-provider.ts';

function pngOf(w: number, h: number, tag: number): Buffer {
  const b = Buffer.alloc(25);
  b.writeUInt32BE(0x89504e47, 0);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = tag;
  return b;
}

/** A page whose capture `k` (from 0) is tagged `k`; `lost[k]` says whether a canvas was lost around it. */
function pageOf(lost: boolean[]) {
  const calls: string[] = [];
  let k = 0;
  const page: RenderPage = {
    info: { duration: 1, fps: 30, width: 4, height: 2, frames: 30, errors: [] },
    seek: async (t) => { calls.push(`seek ${t}`); },
    capture: async () => { calls.push('capture'); return pngOf(4, 2, k); },
    captureRaw: async () => { calls.push('raw'); return { data: Buffer.alloc(4 * 2 * 4, k), width: 4, height: 2 }; },
    canvasLost: async () => { calls.push('check'); return lost[k++] ?? false; },
    errors: async () => [],
    close: async () => {},
  };
  return { page, calls };
}

describe('a capture that a lost canvas may have spoiled is made again (decision 1752)', () => {
  it('a loss seen after the capture: seek and capture again; the clean capture is the one kept', async () => {
    const { page, calls } = pageOf([true, false]);
    const buf = await captureFrame(page, 0.5, { format: 'png', width: 4, height: 2 });
    expect(buf[24]).toBe(1);
    expect(calls).toEqual(['seek 0.5', 'capture', 'check', 'seek 0.5', 'capture', 'check']);
  });

  it('raw frames too', async () => {
    const { page, calls } = pageOf([true, false]);
    const f = await captureRawFrame(page, 0.5, { width: 4, height: 2 });
    expect(f.data[0]).toBe(1);
    expect(calls).toEqual(['seek 0.5', 'raw', 'check', 'seek 0.5', 'raw', 'check']);
  });

  it('losses on every attempt fail the frame (frameTimeout), never encode a spoiled one', async () => {
    const { page, calls } = pageOf(Array.from({ length: 10 }, () => true));
    await expect(captureFrame(page, 0, { format: 'png', width: 4, height: 2 })).rejects.toMatchObject({ code: 'frameTimeout' });
    expect(calls.filter((c) => c === 'capture')).toHaveLength(CANVAS_LOSS_ATTEMPTS);
  });

  it('a page without the check (an older provider) captures once, as before', async () => {
    const { page, calls } = pageOf([]);
    delete (page as { canvasLost?: unknown }).canvasLost;
    await captureFrame(page, 0, { format: 'png', width: 4, height: 2 });
    expect(calls).toEqual(['seek 0', 'capture']);
  });
});

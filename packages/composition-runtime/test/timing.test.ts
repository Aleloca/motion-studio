import { describe, expect, it } from 'vitest';
import { audioGain, frameCount, frameTime, isClipVisible, needsResync, sourceFrameIndex, videoSourceTime } from '../src/timing.ts';

describe('clip visibility', () => {
  const clip = { start: 1, duration: 2 };
  it('is start-inclusive and end-exclusive', () => {
    expect(isClipVisible(clip, 0.999, 6)).toBe(false);
    expect(isClipVisible(clip, 1, 6)).toBe(true);
    expect(isClipVisible(clip, 2.999, 6)).toBe(true);
    expect(isClipVisible(clip, 3, 6)).toBe(false);
  });
  it('tolerates float noise on frame times at the boundaries', () => {
    // 0.1 + 0.2 = 0.30000000000000004: a clip starting at 0.3 is on at that frame, one ending there is off.
    expect(isClipVisible({ start: 0.3, duration: 1 }, 0.1 + 0.2, 6)).toBe(true);
    expect(isClipVisible({ start: 0, duration: 0.3 }, 0.1 + 0.2, 6)).toBe(false);
    expect(isClipVisible({ start: 7 / 30, duration: 1 }, frameTime(7, 30), 6)).toBe(true);
  });
  it('shows the clips that end with the composition on its last frame and at its end', () => {
    const tail = { start: 4, duration: 2 };
    expect(isClipVisible(tail, frameTime(frameCount(6, 30) - 1, 30), 6)).toBe(true);
    expect(isClipVisible(tail, 6, 6)).toBe(true);
    expect(isClipVisible(clip, 6, 6)).toBe(false);
    expect(isClipVisible({ start: 0, duration: 5.5 }, 6, 6)).toBe(false);
  });
  it('never shows an empty clip in a video; shows every clip of a still at t = 0', () => {
    expect(isClipVisible({ start: 1, duration: 0 }, 1, 6)).toBe(false);
    expect(isClipVisible({ start: 0, duration: 0 }, 0, 0)).toBe(true);
    expect(isClipVisible({ start: 0, duration: 3 }, 0, 0)).toBe(true);
  });
});

describe('frames', () => {
  it('counts frames, one for a still', () => {
    expect(frameCount(6, 30)).toBe(180);
    expect(frameCount(1 / 3, 30)).toBe(10);
    expect(frameCount(0, 30)).toBe(1);
  });
  it('frame times are i / fps', () => {
    expect(frameTime(0, 25)).toBe(0);
    expect(frameTime(50, 25)).toBe(2);
  });
});

describe('video seek target: the centre of the source frame', () => {
  it.each([24, 25, 30])('lands on the centre of the frame shown at the source time, %i fps source', (fps) => {
    const clip = { start: 1, trimStart: 0.5, sourceFps: fps };
    for (let k = 0; k < 90; k++) {
      const t = frameTime(30 + k, 30); // composition at 30 fps, from the clip start
      const s = 0.5 + k / 30;
      const i = Math.floor(s * fps + 1e-6);
      const target = videoSourceTime(clip, t);
      expect(target).toBeCloseTo((i + 0.5) / fps, 9);
      expect(Math.floor(target * fps)).toBe(i); // strictly inside frame i, never on a boundary
      expect(target * fps - i).toBeCloseTo(0.5, 9);
    }
  });
  it('picks the exact frame when the source time is a float hair below a frame boundary', () => {
    expect(sourceFrameIndex(0.1 + 0.2, 10)).toBe(3);
    expect(sourceFrameIndex(1 / 24 * 24, 24)).toBe(24);
  });
  it('maps 24 fps sources under a 30 fps composition: frames repeat in a 3:2-like cadence', () => {
    const clip = { start: 0, sourceFps: 24 };
    const frames = Array.from({ length: 10 }, (_, k) => sourceFrameIndex(videoSourceTime(clip, k / 30), 24));
    expect(frames).toEqual([0, 0, 1, 2, 3, 4, 4, 5, 6, 7]);
  });
  it('holds the last source frame instead of seeking past the end', () => {
    const target = videoSourceTime({ start: 0, sourceFps: 25 }, 9, 2);
    expect(target).toBeCloseTo(49.5 / 25, 9);
  });
  it('without a source fps (VFR or unknown) seeks 1 ms past the source time, inside the shown frame', () => {
    expect(videoSourceTime({ start: 2, trimStart: 1 }, 2.5)).toBeCloseTo(1.501, 9);
    expect(videoSourceTime({ start: 0 }, 9, 3)).toBeCloseTo(2.999, 9);
  });
  it('before the clip start seeks to the first frame', () => {
    expect(videoSourceTime({ start: 2, sourceFps: 30 }, 1)).toBeCloseTo(0.5 / 30, 9);
  });
});

describe('preview media sync', () => {
  it('resyncs only past one frame of drift', () => {
    expect(needsResync(1.0, 1.02, 30)).toBe(false);
    expect(needsResync(1.0, 1.04, 30)).toBe(true);
    expect(needsResync(1.04, 1.0, 30)).toBe(true);
  });
  it('audio gain follows volume and the fades', () => {
    const c = { start: 1, duration: 4, volume: 0.5, fadeIn: 1, fadeOut: 2 };
    expect(audioGain(c, 1)).toBe(0);
    expect(audioGain(c, 1.5)).toBeCloseTo(0.25, 9);
    expect(audioGain(c, 2.5)).toBeCloseTo(0.5, 9);
    expect(audioGain(c, 4)).toBeCloseTo(0.25, 9);
    expect(audioGain(c, 5)).toBe(0);
    expect(audioGain({ start: 0, duration: 2 }, 1)).toBe(1);
    expect(audioGain({ start: 0, duration: 2, volume: 2 }, 1)).toBe(1); // an element cannot go above 1
  });
});

describe('videoSourceTime with sourceStart (a source whose first frame is not at 0)', () => {
  it('offsets the target by sourceStart and holds the last frame against the media end', async () => {
    const { videoSourceTime: vst, sourceStartOf } = await import('../src/timing.ts');
    const clip = { start: 1, trimStart: 0.5, sourceFps: 25, sourceStart: 0.1 };
    // t = 1.2: 0.7 s into the source → frame 17 → its centre 17.5/25 = 0.7 s, plus 0.1.
    expect(vst(clip, 1.2)).toBeCloseTo(0.1 + 17.5 / 25, 9);
    // Media timeline ends at 2.1 s (2 s of frames after 0.1): the last frame (49) is held.
    expect(vst(clip, 10, 2.1)).toBeCloseTo(0.1 + 49.5 / 25, 9);
    // Without sourceFps: the source time plus the nudge, from sourceStart.
    expect(vst({ start: 0, sourceStart: 0.1 }, 0.5)).toBeCloseTo(0.6 + 0.001, 9);
    for (const bad of [-1, Number.NaN, '0.1', 1e9, undefined]) expect(sourceStartOf({ sourceStart: bad })).toBe(0);
  });
});

describe('frameVerdict (render: accept the frame a video shows after a seek)', () => {
  const base = { previous: null, stableMs: 0, before: null, seen: [] as number[], settleMs: 300 } as const;
  it('draws a frame inside the declared window at once', async () => {
    const { frameVerdict } = await import('../src/timing.ts');
    expect(frameVerdict({ ...base, ts: 0.5, target: 0.5 + 0.5 / 30, span: 1 / 30 })).toBe('draw');
  });
  it('a 25 fps file declared as 30 fps: an out-of-window frame that stays put is drawn with a warning, after settling', async () => {
    const { frameVerdict } = await import('../src/timing.ts');
    // target (i + 0.5) / 30 for i = 15 is 0.5167; Chrome shows the 25 fps frame 12 at 0.48 (it is also the previous seek's frame).
    const o = { ...base, ts: 0.48, target: 15.5 / 30, span: 1 / 30, before: 0.48, seen: [0.4, 0.44, 0.48, 0.52] };
    expect(frameVerdict({ ...o, previous: null })).toBe('wait');
    expect(frameVerdict({ ...o, previous: 0.48, stableMs: 100 })).toBe('wait');
    expect(frameVerdict({ ...o, previous: 0.48, stableMs: 300 })).toBe('warn');
  });
  it('a first frame at 0.1 s without sourceStart: targets before it are drawn with a warning, not stalled', async () => {
    const { frameVerdict } = await import('../src/timing.ts');
    const o = { ...base, ts: 0.1, target: 0.5 / 30, span: 1 / 30, before: 0.1, seen: [0.1, 0.1333] };
    expect(frameVerdict({ ...o, previous: 0.1, stableMs: 400 })).toBe('warn');
  });
  it('stale only with evidence: a frame already seen starts after the shown one and by the target', async () => {
    const { frameVerdict } = await import('../src/timing.ts');
    const o = { ...base, ts: 0.8, target: 0.85, span: 1 / 30, before: 0.8, previous: 0.8, stableMs: 10_000 };
    expect(frameVerdict({ ...o, seen: [0.7667, 0.8, 0.8333] })).toBe('stale');
    expect(frameVerdict({ ...o, seen: [0.7667, 0.8] })).toBe('warn'); // nothing later seen yet: cannot tell, drawn with a warning
    // VFR: a long frame (1/12 s) shown for a target inside it is not stale, though shorter frames were seen earlier.
    expect(frameVerdict({ ...o, span: null, ts: 0.9, before: 0.9, previous: 0.9, target: 0.95, seen: [0.8, 0.8333, 0.8667, 0.9, 0.9833] })).toBe('draw');
    expect(frameVerdict({ ...o, ts: 0.8, target: 0.85, before: null, seen: [0.8, 0.8333] })).toBe('warn'); // not unchanged
  });

  it('VFR (no sourceFps): drawn once stable, without a warning', async () => {
    const { frameVerdict } = await import('../src/timing.ts');
    expect(frameVerdict({ ...base, ts: 0.3, target: 0.31, span: null })).toBe('wait');
    expect(frameVerdict({ ...base, ts: 0.3, target: 0.31, span: null, previous: 0.3 })).toBe('draw');
  });
});

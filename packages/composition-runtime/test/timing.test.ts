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

describe('sourceVideoEnd: the last video frame is held when the audio is longer', () => {
  it('clamps targets past the video track to its last frame, not to the media end', async () => {
    const { videoSourceTime: vst, sourceVideoEndOf, sourceTrustedOf } = await import('../src/timing.ts');
    // 2.0 s of 30 fps video in a 2.3 s file: the media end would ask for frame 68, which does not exist.
    expect(vst({ start: 0, sourceFps: 30 }, 2.2, 2.3)).toBeCloseTo(66.5 / 30, 9);
    expect(vst({ start: 0, sourceFps: 30, sourceVideoEnd: 2.0 }, 2.2, 2.3)).toBeCloseTo(59.5 / 30, 9);
    expect(vst({ start: 0, sourceVideoEnd: 2.0 }, 2.2, 2.3)).toBeCloseTo(1.999, 9);
    for (const bad of [0, -1, Number.NaN, '2', 1e9, undefined]) expect(sourceVideoEndOf({ sourceVideoEnd: bad })).toBeNull();
    expect(sourceTrustedOf({ sourceTrusted: true })).toBe(true);
    for (const bad of ['true', 1, undefined, false]) expect(sourceTrustedOf({ sourceTrusted: bad })).toBe(false);
  });
});

const us = (s: number) => Math.round(s * 1e6);
const F30 = us(1 / 30);

describe('frameVerdict (render: which frame a video may show after a seek)', () => {
  const base = { trusted: true, videoEndUs: null as number | null, atEnd: false, stable: false, loadFrame: false, spanUs: null as number | null };
  type Row = readonly [string, number, number | null, number, Partial<typeof base>, string];
  const check = async ([, ts, dur, target, extra, verdict]: Row) => {
    const { frameVerdict } = await import('../src/timing.ts');
    expect(frameVerdict({ ...base, ...extra, tsUs: us(ts), durUs: dur, targetUs: us(target) })).toBe(verdict);
  };
  const strict: Row[] = [
    ['the frame covering the target', 0.833333, F30, 0.85, {}, 'draw'],
    ['the previous frame ended before the target: stale, never drawn', 0.8, F30, 0.85, {}, 'stale'],
    ['stable does not make a stale frame drawable', 0.8, F30, 0.85, { stable: true }, 'stale'],
    ['tolerance edge: the target 50 µs before the frame end is still inside it', 0.8, 50_000, 0.85 - 50e-6, {}, 'draw'],
    ['tolerance edge: the frame end within ε of the target is not stale', 0.8, 50_000 - 60, 0.85, {}, 'draw'],
    ['the frame ended 200 µs (> ε) before the target: stale', 0.8, 50_000 - 200, 0.85, {}, 'stale'],
    ['a later frame: wait', 0.9, F30, 0.85, {}, 'wait'],
    ['the load frame is not special: a stale one stays stale', 0, F30, 0.5, { loadFrame: true, stable: true }, 'stale'],
    ['past the video end (sourceVideoEnd 2.0): the last frame is drawn', 59 / 30, F30, 2.2, { videoEndUs: us(2.0) }, 'draw'],
    ['past the video end: an earlier frame is stale', 58 / 30, F30, 2.2, { videoEndUs: us(2.0) }, 'stale'],
    ['no sourceVideoEnd: a stable frame at the media end is the last frame', 59 / 30, F30, 2.2, { stable: true, atEnd: true }, 'draw'],
    ['no sourceVideoEnd: the same frame on its first read waits for the stability check (stale)', 59 / 30, F30, 2.2, { atEnd: true }, 'stale'],
    ['no sourceVideoEnd: stable but not at the media end: stale', 59 / 30, F30, 2.2, { stable: true }, 'stale'],
    ['no duration: the lenient rule (stable → warn)', 0.8, null, 0.85, { stable: true }, 'warn'],
  ];
  const lenient: Row[] = [
    ['the frame covering the target', 0.833333, F30, 0.85, {}, 'draw'],
    ['WebM default duration (0.033 for a 0.133 s frame), first read: wait', 0.4, F30, 0.47, {}, 'wait'],
    ['the same frame stable: drawn with a warning, never a failure', 0.4, F30, 0.47, { stable: true }, 'warn'],
    ['25 fps declared as 30: Chrome\'s 25 fps frame covers the target', 0.48, 40_000, 15.5 / 30, { spanUs: F30 }, 'draw'],
    ['a source starting at 0.1 without sourceStart: its first frame, stable → warn', 0.1, F30, 0.5 / 30, { stable: true }, 'warn'],
    ['the same on its first read: wait', 0.1, F30, 0.5 / 30, {}, 'wait'],
    ['the load frame, target more than one frame later: hold (wait for change)', 0, F30, 0.5, { loadFrame: true, stable: true }, 'hold'],
    ['the load frame covering the target: draw', 0, F30, 0.02, { loadFrame: true }, 'draw'],
    ['the load frame after the target (a source starting at 0.1): warn, not hold', 0.1, F30, 0.5 / 30, { loadFrame: true, stable: true }, 'warn'],
    ['no duration, inside the declared frame: draw', 0.5, null, 0.5 + 0.5 / 30, { spanUs: F30 }, 'draw'],
    ['no duration, VFR, stable: warn', 0.3, null, 0.31, { stable: true }, 'warn'],
    ['audio longer than video, no sourceVideoEnd: the last frame at the media end is drawn', 59 / 30, F30, 2.25, { stable: true, atEnd: true }, 'draw'],
    ['audio longer than video, with sourceVideoEnd: drawn at once', 59 / 30, F30, 2.25, { videoEndUs: us(2.0) }, 'draw'],
  ];
  it.each(strict)('strict (sourceTrusted): %s', async (...row) => { await check(row); });
  it.each(lenient)('lenient (untrusted): %s', async (...row) => { await check([row[0], row[1], row[2], row[3], { trusted: false, ...row[4] }, row[5]]); });
});

describe('pickVideoFrame (the read loop)', () => {
  type F = { ts: number; dur: number | null; closed?: boolean };
  const run = async (reads: Array<F | null>, o: { target: number; trusted?: boolean; deadlineReads?: number; loadTs?: number | null }) => {
    const { pickVideoFrame } = await import('../src/timing.ts');
    let i = 0, clock = 0;
    const handed: F[] = [];
    const r = await pickVideoFrame<F>({
      read: () => { const f = reads[Math.min(i, reads.length - 1)]; i++; if (f) { const c = { ...f }; handed.push(c); return c; } return null; },
      stamp: (f) => ({ tsUs: us(f.ts), durUs: f.dur }), close: (f) => { f.closed = true; },
      nextFrame: async () => { clock += 16; }, now: () => clock, deadline: 16 * (o.deadlineReads ?? 50),
      targetUs: us(o.target), trusted: o.trusted ?? true, videoEndUs: null, atEnd: () => false,
      loadTsUs: o.loadTs === undefined || o.loadTs === null ? null : us(o.loadTs), spanUs: F30,
    });
    return { r, handed, reads: i };
  };
  const stale = { ts: 0.8, dur: F30 }, right = { ts: 0.833333, dur: F30 };
  it('strict: a stale frame is never drawn; re-read until the right one comes', async () => {
    const { r, handed } = await run([stale, stale, stale, right], { target: 0.85 });
    expect(r.verdict).toBe('draw');
    expect(r.tsUs).toBe(us(0.833333));
    expect(handed.slice(0, 3).every((f) => f.closed)).toBe(true);
  });
  it('strict: a frame stale until the deadline is not drawn (no frame, verdict stale: the seek fails)', async () => {
    const { r, handed } = await run([stale], { target: 0.85, deadlineReads: 5 });
    expect(r).toEqual({ frame: null, verdict: 'stale', tsUs: us(0.8) });
    expect(handed.every((f) => f.closed)).toBe(true);
  });
  it('lenient: a frame that does not cover the target is drawn with a warning once stable (two reads)', async () => {
    const { r, reads } = await run([stale], { target: 0.85, trusted: false });
    expect(r.verdict).toBe('warn');
    expect(reads).toBe(2);
  });
  it('lenient: the load frame is held until it changes', async () => {
    const load = { ts: 0, dur: F30 }, later = { ts: 0.5, dur: F30 };
    const { r, reads } = await run([load, load, load, later], { target: 0.51, trusted: false, loadTs: 0 });
    expect(r.verdict).toBe('draw');
    expect(r.tsUs).toBe(us(0.5));
    expect(reads).toBe(4);
  });
  it('lenient: a load frame that never changes is drawn with a warning at the deadline, not failed', async () => {
    const { r } = await run([{ ts: 0, dur: F30 }], { target: 0.5, trusted: false, loadTs: 0, deadlineReads: 5 });
    expect(r.verdict).toBe('warn');
    expect(r.frame).not.toBeNull();
  });
  it('no frame at all until the deadline: none', async () => {
    const { r } = await run([null], { target: 0.5, deadlineReads: 3 });
    expect(r).toEqual({ frame: null, verdict: 'none', tsUs: null });
  });
});

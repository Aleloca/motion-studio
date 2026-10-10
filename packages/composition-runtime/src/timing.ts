/**
 * Pure time maths of the runtime: clip visibility, frame times, video seek targets and preview audio gain.
 * No DOM here, so it is unit tested directly.
 */

/** Tolerance on times in seconds: frame times like 7/30 are not exact in binary floating point. */
export const TIME_EPS = 1e-6;
/** Without a source frame rate (VFR or unknown), seek this far past the source time, inside the frame shown there. */
export const VFR_NUDGE = 0.001;

/** Number of frames a render captures: one for a still (`duration` 0). */
export function frameCount(duration: number, fps: number): number {
  return duration <= 0 ? 1 : Math.max(1, Math.round(duration * fps));
}

/** Time of frame `i`. */
export function frameTime(i: number, fps: number): number {
  return i / fps;
}

/**
 * Whether a clip is on screen at time `t`:
 * - start-inclusive, end-exclusive (`start <= t < start + duration`), with `TIME_EPS` of tolerance on both sides;
 * - at the composition end (`t >= duration`, the frame a scrubber shows at the very end) a clip that ends with the
 *   composition stays visible, so the end does not go blank;
 * - in a still (composition `duration` 0) every visual clip is visible: stills show t = 0 only and ignore timing;
 * - a clip of duration 0 in a video is never visible.
 */
export function isClipVisible(clip: { start: number; duration: number }, t: number, compositionDuration: number): boolean {
  if (compositionDuration <= 0) return true;
  if (!(clip.duration > 0)) return false;
  const end = clip.start + clip.duration;
  if (t < clip.start - TIME_EPS) return false;
  if (t < end - TIME_EPS) return true;
  return t >= compositionDuration - TIME_EPS && Math.abs(end - compositionDuration) <= TIME_EPS;
}

/** The source frame shown at source time `s` (seconds), tolerant to float noise just below a frame boundary. */
export function sourceFrameIndex(s: number, fps: number): number {
  return Math.max(0, Math.floor(s * fps + TIME_EPS));
}

/** A usable `sourceStart` (seconds), else 0. */
export function sourceStartOf(clip: { sourceStart?: unknown }): number {
  const s = clip.sourceStart;
  return typeof s === 'number' && Number.isFinite(s) && s >= 0 && s <= 36_000 ? s : 0;
}

/**
 * The `currentTime` to give a video element so it shows the source frame of composition time `t`:
 * - the time into the source is `trimStart + (t - clip.start)` (clamped at the clip start), counted from the source's
 *   first frame, which sits at `sourceStart` on the media timeline (0 unless given: a file whose first timestamp is 0.1 s
 *   has `sourceStart` 0.1; the core sets it from ffprobe, Task 5);
 * - with `sourceFps`, the centre of that source frame, `sourceStart + (i + 0.5) / sourceFps`. Seeking exactly to a frame
 *   boundary shows the previous frame about one time in three (spike §1); the centre never does;
 * - without it (variable or unknown frame rate), `VFR_NUDGE` past the source time;
 * - never past the end of the video: the last frame is held. The end is `sourceVideoEnd` (the video track's end, which
 *   can be earlier than the media's when the audio is longer) when given, else `sourceDuration` (the media timeline's end).
 */
export function videoSourceTime(clip: { start: number; trimStart?: number; sourceFps?: number; sourceStart?: unknown; sourceVideoEnd?: unknown }, t: number, sourceDuration?: number): number {
  const base = sourceStartOf(clip);
  const s = (clip.trimStart ?? 0) + Math.max(0, t - clip.start);
  const end = sourceVideoEndOf(clip) ?? sourceDuration;
  const known = end !== undefined && Number.isFinite(end) && end > base;
  const fps = clip.sourceFps;
  if (fps !== undefined && fps > 0) {
    let i = sourceFrameIndex(s, fps);
    if (known) i = Math.min(i, Math.max(0, Math.ceil((end - base) * fps - TIME_EPS) - 1));
    return base + (i + 0.5) / fps;
  }
  const target = base + s + VFR_NUDGE;
  return known ? Math.min(target, Math.max(base, end - VFR_NUDGE)) : target;
}

/** A usable `sourceVideoEnd` (seconds, the end of the video track on the media timeline, from ffprobe), else null. */
export function sourceVideoEndOf(clip: object): number | null {
  const s = (clip as { sourceVideoEnd?: unknown }).sourceVideoEnd;
  return typeof s === 'number' && Number.isFinite(s) && s > 0 && s <= 36_000 ? s : null;
}

/** Whether the core probed the source and vouches for its metadata (`sourceTrusted: true`, Task 5): the strict rule. */
export function sourceTrustedOf(clip: object): boolean {
  return (clip as { sourceTrusted?: unknown }).sourceTrusted === true;
}

/** Tolerance on frame timestamps and durations, in whole microseconds (WebCodecs units): above µs rounding noise. */
export const FRAME_EPS_US = 100;

export type FrameVerdict = 'draw' | 'warn' | 'stale' | 'wait' | 'hold';

/**
 * Render mode: what to do with the frame a video holds after a seek (`pickVideoFrame`). Everything is in whole
 * microseconds (`VideoFrame.timestamp`/`duration` units); a frame covers [ts, ts + dur).
 * - `draw` when the frame **covers** the target: `ts ≤ target + ε` and `ts + dur > target − ε` (only with a positive
 *   `dur`). A frame is past only when it ended at least ε before the target.
 * - `draw` for the **last video frame**: with `videoEndUs` (`sourceVideoEnd`), a frame at or before the target that reaches
 *   the end of the video track (`ts + dur ≥ videoEnd − ε`); without it, a frame at or before the target, `stable` (the same
 *   on two reads) while the element sits at the end of the media (`atEnd`). Targets past the video's end (audio longer
 *   than video) show the last frame.
 * - **Strict** (`trusted`, the core probed the source, and a positive `dur`): a frame that ended before the target is
 *   `stale`, never drawn; anything else (a later frame) is `wait`. At the seek's deadline the seek fails.
 * - **Lenient** (untrusted: agent-declared, normalisation failed, or no duration): container durations can be wrong
 *   (WebM reports its default duration for frames that last longer), so a correct frame must never fail the render. A
 *   frame that does not cover the target is drawn once `stable`, as `warn` (non-fatal `videoFrameMismatch`). The one
 *   exception is the **load frame** (`loadFrame`: the frame held before the video's first seek, the first-seek bug):
 *   when the target is more than one frame after it, `hold`: read again until it changes or the deadline passes, then
 *   draw it with a warning.
 */
export function frameVerdict(o: {
  tsUs: number; durUs: number | null; targetUs: number; trusted: boolean;
  videoEndUs: number | null; atEnd: boolean; stable: boolean; loadFrame: boolean; spanUs: number | null;
}): FrameVerdict {
  const { tsUs: ts, targetUs: target } = o;
  const E = FRAME_EPS_US;
  const dur = o.durUs !== null && o.durUs > 0 ? o.durUs : null;
  const notAfter = ts <= target + E;
  if (dur !== null && notAfter && ts + dur > target - E) return 'draw';
  if (notAfter && (o.videoEndUs !== null ? dur !== null && ts + dur >= o.videoEndUs - E : o.stable && o.atEnd)) return 'draw';
  if (o.trusted && dur !== null) return ts + dur <= target - E ? 'stale' : 'wait';
  // Lenient. Without a duration, the declared frame (span) before the target counts as covering.
  if (dur === null && o.spanUs !== null && notAfter && ts + o.spanUs > target - E) return 'draw';
  if (!o.stable) return 'wait';
  if (o.loadFrame && target > ts + Math.max(dur ?? 0, o.spanUs ?? 0) + E) return 'hold';
  return 'warn';
}

/**
 * Reads the frame a video holds until `frameVerdict` accepts it (`draw`, or `warn` in lenient mode), one native animation
 * frame apart, up to `deadline` (native ms). `stable` is the same timestamp as the previous read. Returns the accepted
 * frame (the caller draws and closes it). At the deadline: a `hold` frame (lenient load frame) is returned as `warn`;
 * otherwise no frame and the last verdict (`stale`, `wait` or `none`): a frame that is not accepted is never drawn.
 * DOM-free, so it is unit tested.
 */
export async function pickVideoFrame<F>(o: {
  read(): F | null; stamp(f: F): { tsUs: number; durUs: number | null }; close(f: F): void;
  nextFrame(): Promise<void>; now(): number; deadline: number;
  targetUs: number; trusted: boolean; videoEndUs: number | null; atEnd(): boolean; loadTsUs: number | null; spanUs: number | null;
}): Promise<{ frame: F | null; verdict: FrameVerdict | 'none'; tsUs: number | null }> {
  let previous: number | null = null;
  let last: { verdict: 'stale' | 'wait' | 'none'; tsUs: number | null } = { verdict: 'none', tsUs: null };
  for (;;) {
    const f = o.read();
    const late = o.now() > o.deadline;
    if (f) {
      const { tsUs, durUs } = o.stamp(f);
      const verdict = frameVerdict({
        tsUs, durUs, targetUs: o.targetUs, trusted: o.trusted, videoEndUs: o.videoEndUs, atEnd: o.atEnd(),
        stable: tsUs === previous, loadFrame: o.loadTsUs !== null && tsUs === o.loadTsUs, spanUs: o.spanUs,
      });
      if (verdict === 'draw' || verdict === 'warn') return { frame: f, verdict, tsUs };
      if (verdict === 'hold' && late) return { frame: f, verdict: 'warn', tsUs };
      o.close(f);
      previous = tsUs;
      last = { verdict: verdict === 'hold' ? 'wait' : verdict, tsUs };
    } else {
      previous = null;
      last = { verdict: 'none', tsUs: null };
    }
    if (late) return { frame: null, ...last };
    await o.nextFrame();
  }
}

/** Preview playback: whether a media element drifted more than one composition frame from where it should be. */
export function needsResync(current: number, target: number, fps: number): boolean {
  return Math.abs(current - target) > 1 / fps;
}

/**
 * Preview gain of an audio clip at composition time `t`: `volume` (clamped to 1, the most an element can play)
 * times the linear fade-in and fade-out. 0 outside the clip.
 */
export function audioGain(clip: { start: number; duration: number; volume?: number; fadeIn?: number; fadeOut?: number }, t: number): number {
  const local = t - clip.start;
  if (local < 0 || local > clip.duration) return 0;
  let g = Math.min(1, Math.max(0, clip.volume ?? 1));
  if (clip.fadeIn && clip.fadeIn > 0) g *= Math.min(1, local / clip.fadeIn);
  if (clip.fadeOut && clip.fadeOut > 0) g *= Math.min(1, (clip.duration - local) / clip.fadeOut);
  return Math.max(0, g);
}

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

/**
 * The `currentTime` to give a video element so it shows the source frame of composition time `t`:
 * - the source time is `trimStart + (t - clip.start)` (clamped at the clip start);
 * - with `sourceFps`, the centre of that source frame, `(i + 0.5) / sourceFps`. Seeking exactly to a frame boundary
 *   shows the previous frame about one time in three (spike §1); the centre never does;
 * - without it (variable or unknown frame rate), `VFR_NUDGE` past the source time;
 * - never past the end of the source (`sourceDuration`, when known): the last frame is held.
 */
export function videoSourceTime(clip: { start: number; trimStart?: number; sourceFps?: number }, t: number, sourceDuration?: number): number {
  const s = (clip.trimStart ?? 0) + Math.max(0, t - clip.start);
  const known = sourceDuration !== undefined && Number.isFinite(sourceDuration) && sourceDuration > 0;
  const fps = clip.sourceFps;
  if (fps !== undefined && fps > 0) {
    let i = sourceFrameIndex(s, fps);
    if (known) i = Math.min(i, Math.max(0, Math.ceil(sourceDuration * fps - TIME_EPS) - 1));
    return (i + 0.5) / fps;
  }
  const target = s + VFR_NUDGE;
  return known ? Math.min(target, Math.max(0, sourceDuration - VFR_NUDGE)) : target;
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

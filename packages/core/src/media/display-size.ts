/**
 * Round 2 of report 70 (N3): the one rule for the size a player shows a video stream at, shared by the render normalisation
 * (`sourceInfoOf`) and the media probe (the library's sizes, "the original format"): the sample aspect ratio applied to the
 * width (when it is a sane 0.1–10), then the sides swapped for a quarter turn (the display matrix's rotation, or the older
 * `rotate` tag). Not rounded: the callers round.
 */
export interface DisplayStream {
  width?: number; height?: number; sample_aspect_ratio?: string;
  side_data_list?: Array<{ rotation?: unknown }>; tags?: { rotate?: unknown };
}

const ratio = (r: string | undefined): number | null => {
  const [a, b] = (r ?? '').replace(':', '/').split('/').map(Number);
  return a && b && Number.isFinite(a / b) && a / b > 0 ? a / b : null;
};

/** The stream's rotation in degrees as ffprobe gives it (display matrix first, else the tag); 0 when none. */
export const streamRotation = (v: DisplayStream): number =>
  Number(v.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? v.tags?.rotate ?? 0) || 0;

/** The shown size of a stream with a coded `width` × `height`. */
export function streamDisplaySize(v: DisplayStream & { width: number; height: number }): { width: number; height: number } {
  const sar = ratio(v.sample_aspect_ratio) ?? 1;
  let w = v.width * (sar > 0.1 && sar < 10 ? sar : 1), h = v.height;
  if (Math.abs(streamRotation(v)) % 180 === 90) [w, h] = [h, w];
  return { width: w, height: h };
}

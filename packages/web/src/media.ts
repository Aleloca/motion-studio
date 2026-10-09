/**
 * What kind of media a file is, by its extension: the one rule shared by the canvas, the format view, the project and
 * creative cards and the library thumbnails. A GIF is an animated image: it plays by itself in an <img>, has no
 * transport and no poster.
 */
export type MediaKind = 'video' | 'animated' | 'image';

const VIDEO = /\.(mp4|mov|webm|m4v)$/i;
const ANIMATED = /\.gif$/i;

export function mediaKindOf(file: string): MediaKind {
  const path = file.split(/[?#]/)[0]!;
  if (VIDEO.test(path)) return 'video';
  if (ANIMATED.test(path)) return 'animated';
  return 'image';
}

export const isVideoFile = (file: string): boolean => mediaKindOf(file) === 'video';

/**
 * The video behind a cover, for playback on hover. The core's cover is the first output of the latest version, or
 * its poster `outputs/vN/.previews/<file>.jpg` (output-contract): the poster of a video points back to the video.
 * Null for images and GIFs (a GIF already moves).
 */
export function coverVideo(cover: string): string | null {
  if (isVideoFile(cover)) return cover;
  const m = /^(.*\/)?\.previews\/([^/]+)\.jpg$/i.exec(cover);
  return m && isVideoFile(m[2]!) ? `${m[1] ?? ''}${m[2]}` : null;
}

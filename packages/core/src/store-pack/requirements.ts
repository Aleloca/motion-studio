import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { STORE_LIMITS, type StoreId } from '@motion-studio/shared';
import type { MediaInfo } from '../media/media-tools.ts';
import { t } from '../i18n.ts';

/**
 * The store requirements checked on a rendered file before it goes into a pack (Phase 12, spec §4.2, Review Focus 5).
 *
 * Images are read with bounded readers, never decoded: the PNG signature and IHDR (size, colour type), then the chunk headers
 * up to the first IDAT looking for `tRNS` (transparency on an RGB or palette image); the JPEG markers up to the first SOFn
 * (size). Every length a file declares is checked against the file size before it is followed, at most `MAX_CHUNKS` chunks or
 * segments are visited and each read is a few bytes at a known offset, so a truncated or hostile file costs at most a few
 * hundred small reads and never a large allocation. Videos go through the existing probe (duration, fps, codec, audio).
 */

export type StoreFileKind = 'screenshot' | 'preview' | 'feature';
export type StoreCheck = { ok: true } | { ok: false; reason: string };
export type ImageInfo =
  | { ok: true; format: 'png'; width: number; height: number; alpha: boolean; colorType: number }
  | { ok: true; format: 'jpeg'; width: number; height: number; alpha: false }
  | { ok: false; error: 'notImage' | 'unreadable' };

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chunks (PNG) or segments (JPEG) visited before giving up. */
const MAX_CHUNKS = 512;
/** Largest side accepted (the PNG spec allows 2^31 - 1; a store image is far smaller). */
const MAX_SIDE = 65_535;

async function readAt(fh: FileHandle, at: number, n: number, size: number): Promise<Buffer | null> {
  if (at < 0 || n < 0 || at + n > size) return null;
  const b = Buffer.alloc(n);
  const { bytesRead } = await fh.read(b, 0, n, at);
  return bytesRead === n ? b : null;
}

async function pngInfo(fh: FileHandle, size: number): Promise<ImageInfo> {
  // Signature (8), then the IHDR chunk: length 13, type, data, CRC.
  const head = await readAt(fh, 0, 33, size);
  if (!head || !head.subarray(0, 8).equals(PNG_SIG)) return { ok: false, error: 'notImage' };
  if (head.readUInt32BE(8) !== 13 || head.subarray(12, 16).toString('latin1') !== 'IHDR') return { ok: false, error: 'notImage' };
  const width = head.readUInt32BE(16), height = head.readUInt32BE(20), colorType = head[25]!;
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || ![0, 2, 3, 4, 6].includes(colorType)) return { ok: false, error: 'notImage' };
  let alpha = colorType === 4 || colorType === 6;
  // Chunk headers up to the first IDAT: a `tRNS` gives an RGB, grey or palette image transparency.
  let at = 33;
  for (let k = 0; k < MAX_CHUNKS; k++) {
    const h = await readAt(fh, at, 8, size);
    if (!h) return { ok: false, error: 'notImage' };
    const len = h.readUInt32BE(0);
    const type = h.subarray(4, 8).toString('latin1');
    if (!/^[A-Za-z]{4}$/.test(type) || len > 0x7fffffff || at + 12 + len > size) return { ok: false, error: 'notImage' };
    if (type === 'IDAT') return { ok: true, format: 'png', width, height, alpha, colorType };
    if (type === 'IEND') return { ok: false, error: 'notImage' };
    if (type === 'tRNS') alpha = true;
    at += 12 + len;
  }
  return { ok: false, error: 'notImage' };
}

/** SOFn markers that carry the frame size: C0–CF except DHT (C4), JPG (C8) and DAC (CC). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

async function jpegInfo(fh: FileHandle, size: number): Promise<ImageInfo> {
  let at = 2;
  for (let k = 0; k < MAX_CHUNKS; k++) {
    const h = await readAt(fh, at, 2, size);
    if (!h || h[0] !== 0xff) return { ok: false, error: 'notImage' };
    const m = h[1]!;
    if (m === 0xff) { at += 1; continue; } // fill byte
    // Markers without a length: SOI, EOI, RSTn, TEM. Reaching EOI or SOS before a SOF: no size.
    if (m === 0xd8 || m === 0xd9 || m === 0xda) return { ok: false, error: 'notImage' };
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { at += 2; continue; }
    const lenBuf = await readAt(fh, at + 2, 2, size);
    if (!lenBuf) return { ok: false, error: 'notImage' };
    const len = lenBuf.readUInt16BE(0);
    if (len < 2 || at + 2 + len > size) return { ok: false, error: 'notImage' };
    if (isSof(m)) {
      if (len < 8) return { ok: false, error: 'notImage' };
      const sof = await readAt(fh, at + 4, 5, size);
      if (!sof) return { ok: false, error: 'notImage' };
      const height = sof.readUInt16BE(1), width = sof.readUInt16BE(3);
      if (width < 1 || height < 1) return { ok: false, error: 'notImage' };
      return { ok: true, format: 'jpeg', width, height, alpha: false };
    }
    at += 2 + len;
  }
  return { ok: false, error: 'notImage' };
}

/**
 * The format, size and alpha of a PNG or JPEG at `file`, read by content (see the module comment). Only a regular file is read
 * (opened non-blocking: a FIFO or device never stalls the core); anything else is `unreadable`, any other content `notImage`.
 */
export async function readImageInfo(file: string): Promise<ImageInfo> {
  let fh: FileHandle;
  try { fh = await open(file, constants.O_RDONLY | constants.O_NONBLOCK); } catch { return { ok: false, error: 'unreadable' }; }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, error: 'unreadable' };
    const head = await readAt(fh, 0, Math.min(8, st.size), st.size);
    if (!head || head.length < 3) return { ok: false, error: 'notImage' };
    if (head.length >= 8 && head.equals(PNG_SIG)) return await pngInfo(fh, st.size);
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return await jpegInfo(fh, st.size);
    return { ok: false, error: 'notImage' };
  } catch {
    return { ok: false, error: 'unreadable' };
  } finally {
    await fh.close().catch(() => {});
  }
}

export interface StoreCheckOptions {
  /** The exact size the store file must have (the preset's). */
  width: number; height: number;
  /** The media probe (videos); without it a video is not readable. */
  probe?: (file: string) => Promise<MediaInfo | null>;
  /** The file's size in bytes (the App Store preview's 500 MB limit); read from the file when absent. */
  bytes?: number;
}

const fail = (reason: string): StoreCheck => ({ ok: false, reason });

/**
 * Whether `file` meets the store's requirements for its kind (texts in the UI language):
 * - screenshot and feature graphic: PNG or JPEG, exactly `width`×`height`, no alpha channel (both stores);
 * - App Store preview: readable video of that size, H.264, 30 fps, 15–30 s, with an audio track, at most 500 MB;
 * - Google Play promo video (it goes to YouTube, not to the store): a readable H.264 video of that size.
 */
export async function checkStoreFile(kind: StoreFileKind, store: StoreId, file: string, o: StoreCheckOptions): Promise<StoreCheck> {
  const c = t().variants.storePack.check;
  const wrongSize = (w: number, h: number) => (w !== o.width || h !== o.height ? fail(c.wrongSize({ width: w, height: h, expectedWidth: o.width, expectedHeight: o.height })) : null);
  if (kind !== 'preview') {
    const info = await readImageInfo(file);
    if (!info.ok) return fail(info.error === 'unreadable' ? c.unreadable : c.notImage);
    const size = wrongSize(info.width, info.height);
    if (size) return size;
    if (info.alpha) return fail(c.hasAlpha);
    return { ok: true };
  }
  const probed = o.probe ? await o.probe(file).catch(() => null) : null;
  if (!probed || probed.durationSec === null) return fail(c.notVideo);
  const size = wrongSize(probed.width, probed.height);
  if (size) return size;
  if (probed.videoCodec !== 'h264') return fail(c.codec({ codec: probed.videoCodec ?? '?' }));
  if (store === 'playstore') return { ok: true };
  const lim = STORE_LIMITS.appstore.preview;
  if (probed.fps === undefined || Math.abs(probed.fps - lim.fps) > 0.01) return fail(c.fps({ fps: probed.fps ?? 0, expected: lim.fps }));
  // A rendered video lasts its frame count / fps, give or take one frame of container rounding.
  const d = probed.durationSec;
  if (d < lim.minSec - 0.05 || d > lim.maxSec + 0.05) return fail(c.duration({ seconds: d, min: lim.minSec, max: lim.maxSec }));
  if (probed.audio !== true) return fail(c.noAudio);
  let bytes = o.bytes;
  if (bytes === undefined) {
    const fh = await open(file, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
    if (!fh) return fail(c.unreadable);
    try { bytes = (await fh.stat()).size; } finally { await fh.close().catch(() => {}); }
  }
  if (bytes > lim.maxFileMB * 1024 * 1024) return fail(c.tooLarge({ sizeMB: Math.ceil(bytes / (1024 * 1024)), maxMB: lim.maxFileMB }));
  return { ok: true };
}

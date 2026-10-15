import { deflateSync, inflateSync } from 'node:zlib';

/**
 * A minimal PNG reader and writer for the identity sets (Phase 14): no dependency. Reads what Chrome's screenshots and the
 * ffmpeg flatten write (8-bit grey, grey+alpha, RGB, RGBA; not interlaced), writes 8-bit RGB or RGBA.
 */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Most pixels decoded (a 4096×4096 image): a bigger PNG is refused instead of allocating without bound. */
const MAX_PIXELS = 4096 * 4096;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface PngImage { width: number; height: number; /** RGBA, 4 bytes a pixel, rows top to bottom. */ rgba: Uint8Array; /** The file had an alpha channel. */ alpha: boolean }

/** Width and height from the IHDR, or null when `buf` is not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number; colorType: number; bitDepth: number } | null {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24]!, colorType: buf[25]! };
}

/** Decodes `buf` to RGBA (see the module comment); throws on anything else. */
export function decodePng(buf: Buffer): PngImage {
  const head = pngSize(buf);
  if (!head) throw new Error('png: not a PNG');
  const { width, height, bitDepth, colorType } = head;
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (bitDepth !== 8 || channels === undefined) throw new Error(`png: unsupported colour type ${colorType} / depth ${bitDepth}`);
  if (buf[28] !== 0) throw new Error('png: interlaced images are not supported');
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) throw new Error('png: bad size');
  const idat: Buffer[] = [];
  for (let p = 8; p + 12 <= buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (p + 12 + len > buf.length) throw new Error('png: truncated chunk');
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    if (type === 'IEND') break;
    p += 12 + len;
  }
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height + 1 });
  if (raw.length < (stride + 1) * height) throw new Error('png: not enough image data');
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= channels ? px[out + x - channels]! : 0;
      const b = y > 0 ? px[out - stride + x]! : 0;
      const c = x >= channels && y > 0 ? px[out - stride + x - channels]! : 0;
      let r: number;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: {
          const p0 = a + b - c;
          const pa = Math.abs(p0 - a), pb = Math.abs(p0 - b), pc = Math.abs(p0 - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`png: bad filter ${filter}`);
      }
      px[out + x] = r & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const [r, g, b, al] = channels === 1 ? [px[s]!, px[s]!, px[s]!, 255]
      : channels === 2 ? [px[s]!, px[s]!, px[s]!, px[s + 1]!]
        : channels === 3 ? [px[s]!, px[s + 1]!, px[s + 2]!, 255]
          : [px[s]!, px[s + 1]!, px[s + 2]!, px[s + 3]!];
    rgba.set([r, g, b, al], i * 4);
  }
  return { width, height, rgba, alpha: colorType === 4 || colorType === 6 };
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** An 8-bit PNG of `pixels` (RGB, 3 bytes a pixel, or RGBA, 4), filter 0. */
export function encodePng(width: number, height: number, pixels: Uint8Array, channels: 3 | 4): Buffer {
  if (pixels.length !== width * height * channels) throw new Error('png: pixel count mismatch');
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 3 ? 2 : 6;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A `size`×`size` RGB PNG of one colour (`rrggbb`, six hex digits). */
export function solidPng(size: number, rgbHex: string): Buffer {
  if (!/^[0-9a-f]{6}$/i.test(rgbHex)) throw new Error('png: not a colour');
  const rgb = [0, 2, 4].map((i) => parseInt(rgbHex.slice(i, i + 2), 16));
  const px = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i++) px.set(rgb, i * 3);
  return encodePng(size, size, px, 3);
}

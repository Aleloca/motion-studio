/** Small real PNG and JPEG files for the store pack suites (Phase 12, Task 6). */
import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A real PNG: `colorType` 2 (RGB) or 6 (RGBA), one colour; `extra` chunks before IDAT. */
export function makePng(w: number, h: number, colorType: 2 | 6 | 4 | 0 | 3 = 2, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colorType;
  const bpp = colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 2 ? 3 : 1;
  const row = Buffer.alloc(1 + w * bpp, 0x80); row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A JPEG header: SOI, an APP0, a SOFn with the size, then SOS and EOI. */
export function makeJpeg(w: number, h: number, sof = 0xc0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sofSeg = Buffer.from([0xff, sof, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0x00, 0x00, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sofSeg, sos]);
}


/** The colour type and the first pixel (RGB or RGBA bytes) of a PNG made by ffmpeg (no interlace, filter 0 on the first row). */
export function firstPixel(png: Buffer): { colorType: number; pixel: number[] } {
  const colorType = png[25]!;
  const parts: Buffer[] = [];
  for (let at = 8; at + 8 <= png.length;) {
    const len = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('latin1');
    if (type === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const bpp = colorType === 6 ? 4 : 3;
  return { colorType, pixel: [...raw.subarray(1, 1 + bpp)] };
}

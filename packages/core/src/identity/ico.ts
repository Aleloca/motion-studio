import { PNG_SIGNATURE, pngSize } from './png.ts';

/**
 * The `.ico` container of `favicon.ico` (Phase 14, spec §4.2): written by the core, no dependency. ICONDIR (6 bytes:
 * reserved 0, type 1 = icon, count), then one 16-byte ICONDIRENTRY per image (width and height, 0 meaning 256; colour count
 * 0; reserved 0; planes 1; 32 bits a pixel; payload size; payload offset), then the payloads: whole PNG files (supported by
 * every browser and by Windows since Vista).
 */

const DIR = 6;
const ENTRY = 16;

/** The ICO of `pngs` (each a PNG of `size`×`size`, 1–256), in the order given. */
export function writeIco(pngs: Array<{ size: number; png: Buffer }>): Buffer {
  if (pngs.length === 0 || pngs.length > 255) throw new Error('ico: 1 to 255 images');
  const head = Buffer.alloc(DIR + ENTRY * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, png }, k) => {
    const dims = pngSize(png);
    if (!dims) throw new Error('ico: an image is not a PNG');
    if (!Number.isInteger(size) || size < 1 || size > 256 || dims.width !== size || dims.height !== size) throw new Error(`ico: the ${size} px image is ${dims.width}×${dims.height}`);
    const e = DIR + k * ENTRY;
    head[e] = size === 256 ? 0 : size;
    head[e + 1] = size === 256 ? 0 : size;
    head[e + 2] = 0;
    head[e + 3] = 0;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.png)]);
}

/** The images of an ICO with PNG payloads (tests and the set check); throws on anything else. */
export function readIco(buf: Buffer): Array<{ width: number; height: number; png: Buffer }> {
  if (buf.length < DIR || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('ico: not an icon file');
  const count = buf.readUInt16LE(4);
  if (count === 0 || buf.length < DIR + ENTRY * count) throw new Error('ico: truncated directory');
  const out: Array<{ width: number; height: number; png: Buffer }> = [];
  for (let k = 0; k < count; k++) {
    const e = DIR + k * ENTRY;
    const width = buf[e] || 256;
    const height = buf[e + 1] || 256;
    const len = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    if (off + len > buf.length || off < DIR + ENTRY * count) throw new Error('ico: an image is outside the file');
    const png = buf.subarray(off, off + len);
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('ico: an image is not a PNG');
    const dims = pngSize(png);
    if (!dims || dims.width !== width || dims.height !== height) throw new Error('ico: an entry does not match its PNG');
    out.push({ width, height, png: Buffer.from(png) });
  }
  return out;
}

import { inflateSync } from 'node:zlib';

/** Minimal PNG decoder (8-bit RGB/RGBA, not interlaced), ported from the spike, to compare screenshots without dependencies. */
export interface Image { w: number; h: number; px(x: number, y: number): [number, number, number] }

export function decodePng(buf: Buffer): Image {
  let pos = 8; let w = 0; let h = 0; let ct = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos + 4, pos + 8); const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]!; if (data[8] !== 8 || data[12]) throw new Error('unsupported png'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!bpp) throw new Error(`png colour type ${ct}`);
  const raw = inflateSync(Buffer.concat(idat)); const stride = w * bpp; const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!; const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)); const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp]! : 0; const b = y ? out[row - stride + x]! : 0; const c = x >= bpp && y ? out[row - stride + x - bpp]! : 0;
      let v = src[x]!;
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[row + x] = v & 255;
    }
  }
  return { w, h, px: (x, y) => { const i = y * stride + x * bpp; return [out[i]!, out[i + 1]!, out[i + 2]!]; } };
}

/** Fraction of pixels whose largest channel difference exceeds `channelTolerance`. */
export function diffRatio(a: Image, b: Image, channelTolerance = 8): number {
  if (a.w !== b.w || a.h !== b.h) return 1;
  let bad = 0;
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
    const p = a.px(x, y); const q = b.px(x, y);
    if (Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2])) > channelTolerance) bad++;
  }
  return bad / (a.w * a.h);
}

/** Mean grey of a square of side `size` centred on (x, y). */
export function meanGrey(img: Image, x: number, y: number, size = 6): number {
  let sum = 0; let n = 0;
  for (let dy = -size / 2; dy < size / 2; dy++) for (let dx = -size / 2; dx < size / 2; dx++) {
    const [r, g, b] = img.px(Math.round(x + dx), Math.round(y + dy)); sum += (r + g + b) / 3; n++;
  }
  return sum / n;
}

// Writes build/icon.png (1024x1024): violet rounded square with a white play triangle. Pure zlib PNG encoder, works offline.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const N = 1024, R = 200, SS = 3;
const bg = [0x6d, 0x28, 0xd9];
// Triangle vertices (play button, optically centred).
const T = [[400, 300], [400, 724], [770, 512]];
const edge = (a, b, x, y) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
const inTri = (x, y) => { const d = T.map((v, i) => edge(v, T[(i + 1) % 3], x, y)); return d.every((v) => v >= 0) || d.every((v) => v <= 0); };
const inRound = (x, y) => {
  const cx = Math.min(Math.max(x, R), N - R), cy = Math.min(Math.max(y, R), N - R);
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
};
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    let a = 0, w = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
      if (inRound(px, py)) { a++; if (inTri(px, py)) w++; }
    }
    const o = y * (N * 4 + 1) + 1 + x * 4, t = SS * SS;
    const k = a ? w / a : 0;
    for (let c = 0; c < 3; c++) raw[o + c] = Math.round(bg[c] * (1 - k) + 255 * k);
    raw[o + 3] = Math.round((a / t) * 255);
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);

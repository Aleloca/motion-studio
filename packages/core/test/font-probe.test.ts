/**
 * The bounded font probe (decisions log 261): fvar `wght` range, else OS/2 usWeightClass, for sfnt, WOFF and WOFF2. Real
 * static fixtures (OFL, already in the repo) plus synthetic minimal fonts built here; malformed files give null quickly.
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { FONT_PROBE_MAX_FILE, fontWeightRangeOf, probeFontWeights } from '../src/media/font-probe.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', 'composition-runtime', 'test', 'fixtures', 'fonts');
/** The OFL @fontsource files the web package depends on (installed locally, never downloaded by the test). */
const FONTSOURCE = (pkg: string, file: string) => join(import.meta.dirname, '..', '..', 'web', 'node_modules', '@fontsource', pkg, 'files', file);
const dir = mkdtempSync(join(tmpdir(), 'ms-font-probe-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function os2(weight: number): Buffer {
  const t = Buffer.alloc(78);
  t.writeUInt16BE(4, 0);
  t.writeUInt16BE(weight, 4);
  return t;
}
function fvar(axes: Array<{ tag: string; min: number; def: number; max: number }>): Buffer {
  const t = Buffer.alloc(16 + axes.length * 20);
  t.writeUInt16BE(1, 0); t.writeUInt16BE(0, 2); t.writeUInt16BE(16, 4); t.writeUInt16BE(2, 6);
  t.writeUInt16BE(axes.length, 8); t.writeUInt16BE(20, 10); t.writeUInt16BE(0, 12); t.writeUInt16BE(0, 14);
  axes.forEach((a, i) => {
    const o = 16 + i * 20;
    t.write(a.tag, o, 'latin1');
    t.writeInt32BE(Math.round(a.min * 65536), o + 4); t.writeInt32BE(Math.round(a.def * 65536), o + 8); t.writeInt32BE(Math.round(a.max * 65536), o + 12);
  });
  return t;
}
type Table = { tag: string; data: Buffer };
/** A minimal sfnt: the header, the table records, the tables (4-byte aligned). Checksums are not checked by the probe. */
function sfnt(tables: Table[]): Buffer {
  const head = Buffer.alloc(12 + tables.length * 16);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(tables.length, 4);
  let offset = head.length;
  const bodies: Buffer[] = [];
  tables.forEach((t, i) => {
    const r = 12 + i * 16;
    head.write(t.tag, r, 'latin1');
    head.writeUInt32BE(offset, r + 8);
    head.writeUInt32BE(t.data.length, r + 12);
    const padded = Buffer.concat([t.data, Buffer.alloc((4 - (t.data.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  });
  return Buffer.concat([head, ...bodies]);
}
function woff(tables: Table[], compress = true): Buffer {
  const head = Buffer.alloc(44 + tables.length * 20);
  head.write('wOFF', 0, 'latin1');
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt16BE(tables.length, 12);
  let offset = head.length;
  const bodies: Buffer[] = [];
  tables.forEach((t, i) => {
    const r = 44 + i * 20;
    const z = compress ? deflateSync(t.data) : t.data;
    const stored = z.length < t.data.length ? z : t.data;
    head.write(t.tag, r, 'latin1');
    head.writeUInt32BE(offset, r + 4); head.writeUInt32BE(stored.length, r + 8); head.writeUInt32BE(t.data.length, r + 12);
    const padded = Buffer.concat([stored, Buffer.alloc((4 - (stored.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  });
  head.writeUInt32BE(offset, 8);
  return Buffer.concat([head, ...bodies]);
}
const KNOWN: Record<string, number> = { 'OS/2': 6, fvar: 47, name: 5 };
function base128(n: number): Buffer {
  const out: number[] = [];
  do { out.unshift(n & 0x7f); n = Math.floor(n / 128); } while (n > 0);
  return Buffer.from(out.map((b, i) => (i < out.length - 1 ? b | 0x80 : b)));
}
function woff2(tables: Table[]): Buffer {
  const dirParts: Buffer[] = [];
  for (const t of tables) {
    const known = KNOWN[t.tag];
    dirParts.push(known !== undefined ? Buffer.from([known]) : Buffer.concat([Buffer.from([0x3f]), Buffer.from(t.tag, 'latin1')]));
    dirParts.push(base128(t.data.length));
  }
  const stream = brotliCompressSync(Buffer.concat(tables.map((t) => t.data)));
  const head = Buffer.alloc(48);
  head.write('wOF2', 0, 'latin1');
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt16BE(tables.length, 12);
  head.writeUInt32BE(stream.length, 20);
  const out = Buffer.concat([head, ...dirParts, stream]);
  out.writeUInt32BE(out.length, 8);
  return out;
}

const variable = [{ tag: 'OS/2', data: os2(400) }, { tag: 'fvar', data: fvar([{ tag: 'wdth', min: 75, def: 100, max: 100 }, { tag: 'wght', min: 200, def: 400, max: 800 }]) }];
const fixedW = [{ tag: 'name', data: Buffer.from('xx') }, { tag: 'OS/2', data: os2(700) }];

describe('font probe: real static fixtures (OFL)', () => {
  it('reads the OS/2 weight of WOFF and WOFF2 files (400, 700, 800)', async () => {
    expect(await probeFontWeights(join(FIXTURES, 'jetbrains-mono-latin-400-normal.woff2'))).toEqual({ min: 400, max: 400 });
    expect(await probeFontWeights(FONTSOURCE('jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff'))).toEqual({ min: 400, max: 400 });
    expect(await probeFontWeights(FONTSOURCE('schibsted-grotesk', 'schibsted-grotesk-latin-700-normal.woff'))).toEqual({ min: 700, max: 700 });
    expect(await probeFontWeights(FONTSOURCE('schibsted-grotesk', 'schibsted-grotesk-latin-700-normal.woff2'))).toEqual({ min: 700, max: 700 });
    expect(await probeFontWeights(FONTSOURCE('schibsted-grotesk', 'schibsted-grotesk-latin-800-normal.woff2'))).toEqual({ min: 800, max: 800 });
  });
});

describe('font probe: synthetic minimal fonts', () => {
  it('a variable font (fvar wght) gives its range in sfnt, WOFF and WOFF2', () => {
    expect(fontWeightRangeOf(sfnt(variable))).toEqual({ min: 200, max: 800 });
    expect(fontWeightRangeOf(woff(variable))).toEqual({ min: 200, max: 800 });
    expect(fontWeightRangeOf(woff(variable, false))).toEqual({ min: 200, max: 800 });
    expect(fontWeightRangeOf(woff2(variable))).toEqual({ min: 200, max: 800 });
  });
  it('a static font gives its OS/2 weight; an fvar without wght falls back to OS/2', () => {
    expect(fontWeightRangeOf(sfnt(fixedW))).toEqual({ min: 700, max: 700 });
    expect(fontWeightRangeOf(woff2(fixedW))).toEqual({ min: 700, max: 700 });
    const otto = sfnt(fixedW); otto.write('OTTO', 0, 'latin1');
    expect(fontWeightRangeOf(otto)).toEqual({ min: 700, max: 700 });
    expect(fontWeightRangeOf(sfnt([{ tag: 'OS/2', data: os2(300) }, { tag: 'fvar', data: fvar([{ tag: 'wdth', min: 50, def: 100, max: 100 }]) }]))).toEqual({ min: 300, max: 300 });
  });
  it('a file the probe reads through a path: a link is not followed', async () => {
    const f = join(dir, 'v.ttf');
    writeFileSync(f, sfnt(variable));
    expect(await probeFontWeights(f)).toEqual({ min: 200, max: 800 });
    symlinkSync(f, join(dir, 'link.ttf'));
    expect(await probeFontWeights(join(dir, 'link.ttf'))).toBeNull();
  });
});

describe('font probe: malformed files give null, in bounded time', () => {
  it('no tables, truncated headers, unknown signatures, a collection', () => {
    for (const b of [Buffer.alloc(0), Buffer.from('true'), sfnt([]), Buffer.from('ttcf\0\0\0\0'), Buffer.from('hello world, not a font'), sfnt(variable).subarray(0, 20), woff(variable).subarray(0, 50), woff2(variable).subarray(0, 52)]) {
      expect(fontWeightRangeOf(b)).toBeNull();
    }
    const ttc = woff2(variable); ttc.write('ttcf', 4, 'latin1');
    expect(fontWeightRangeOf(ttc)).toBeNull();
  });
  it('offsets and lengths out of bounds, huge counts', () => {
    const big = sfnt(variable); big.writeUInt16BE(0xffff, 4);
    expect(fontWeightRangeOf(big)).toBeNull();
    const far = sfnt(fixedW); far.writeUInt32BE(0x7fffffff, 12 + 16 + 8);
    expect(fontWeightRangeOf(far)).toBeNull();
    const long = sfnt(fixedW); long.writeUInt32BE(0xfffffff0, 12 + 16 + 12);
    expect(fontWeightRangeOf(long)).toBeNull();
    const axes = sfnt([{ tag: 'fvar', data: (() => { const t = fvar([{ tag: 'wght', min: 100, def: 400, max: 900 }]); t.writeUInt16BE(0xffff, 8); return t; })() }]);
    expect(fontWeightRangeOf(axes)).toBeNull();
    const w = woff(fixedW); w.writeUInt16BE(0xffff, 12);
    expect(fontWeightRangeOf(w)).toBeNull();
    const w2 = woff2(variable); w2.writeUInt32BE(0x7fffffff, 20);
    expect(fontWeightRangeOf(w2)).toBeNull();
  });
  it('a WOFF table that claims a huge original size, or corrupt zlib/Brotli data', () => {
    const huge = woff(variable); huge.writeUInt32BE(0x7fffffff, 44 + 12);
    huge.writeUInt32BE(0x7fffffff, 44 + 20 + 12);
    expect(fontWeightRangeOf(huge)).toBeNull();
    const zb = woff(variable); zb.fill(0x55, 44 + 40, zb.length);
    expect(fontWeightRangeOf(zb)).toBeNull();
    const br = woff2(variable); br.fill(0x55, br.length - 8);
    expect(fontWeightRangeOf(br)).toBeNull();
  });
  it('a WOFF2 directory claiming tables far longer than its stream, and an overlong UIntBase128', () => {
    const lie = woff2([{ tag: 'OS/2', data: os2(400) }]);
    const at = 48 + 1;
    const bogus = Buffer.concat([lie.subarray(0, at), Buffer.from([0x8f, 0xff, 0xff, 0xff, 0x7f]), lie.subarray(at + 1)]);
    const t0 = Date.now();
    expect(fontWeightRangeOf(bogus)).toBeNull();
    const zeroLead = Buffer.concat([lie.subarray(0, at), Buffer.from([0x80, 0x01]), lie.subarray(at + 1)]);
    expect(fontWeightRangeOf(zeroLead)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('weights out of range are refused (OS/2 0 or > 1000), a reversed fvar range too', () => {
    expect(fontWeightRangeOf(sfnt([{ tag: 'OS/2', data: os2(0) }]))).toBeNull();
    expect(fontWeightRangeOf(sfnt([{ tag: 'OS/2', data: os2(5000) }]))).toBeNull();
    expect(fontWeightRangeOf(sfnt([{ tag: 'fvar', data: fvar([{ tag: 'wght', min: 900, def: 400, max: 100 }]) }]))).toBeNull();
  });
  it('a file larger than the limit is not read', async () => {
    const f = join(dir, 'big.ttf');
    const b = Buffer.alloc(FONT_PROBE_MAX_FILE + 1);
    sfnt(fixedW).copy(b);
    writeFileSync(f, b);
    expect(await probeFontWeights(f)).toBeNull();
  });
  it('random bytes after a valid signature never throw', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const t0 = Date.now();
    for (let i = 0; i < 300; i++) {
      const b = Buffer.from(Array.from({ length: 64 + Math.floor(rnd() * 400) }, () => Math.floor(rnd() * 256)));
      b.write(['wOFF', 'wOF2', 'OTTO', 'true'][i % 4]!, 0, 'latin1');
      expect(() => fontWeightRangeOf(b)).not.toThrow();
    }
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

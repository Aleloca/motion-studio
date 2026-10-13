import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { brotliDecompressSync, inflateSync } from 'node:zlib';

/**
 * A minimal, bounded, dependency-free font probe (Phase 10b final wave, decisions log 261): the weight range a font file
 * offers, read from its `fvar` table (a variable font with a `wght` axis: `[min, max]`) or else its `OS/2` table (a static
 * font: `usWeightClass`, `min === max`). TrueType/OpenType (`sfnt`), WOFF (zlib) and WOFF2 (Brotli; `fvar` and `OS/2`
 * are never transformed there) are read. A font collection, an unknown signature or anything malformed gives null (the
 * caller keeps its rule for an unknown weight).
 *
 * Read limits, so a hostile file costs bounded time and memory:
 * - at most {@link FONT_PROBE_MAX_FILE} bytes are read (a larger file is not probed);
 * - at most {@link MAX_TABLES} table records; every offset and length checked against the bytes actually there;
 * - a decompressed table at most {@link MAX_TABLE_BYTES}; the WOFF2 stream decompressed with a hard output cap;
 * - `fvar`: at most {@link MAX_AXES} axes; every loop is over a bounded count.
 */
export const FONT_PROBE_MAX_FILE = 32 * 1024 * 1024;
const MAX_TABLES = 512;
const MAX_TABLE_BYTES = 1024 * 1024;
const MAX_AXES = 64;

export interface FontWeightRange { min: number; max: number }

type TableReader = (tag: string) => Buffer | null;

const tagAt = (b: Buffer, o: number) => b.toString('latin1', o, o + 4);
const inBounds = (b: Buffer, offset: number, length: number) => Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && length >= 0 && offset + length <= b.length;

/** Plain sfnt: the table directory at 12, 16 bytes per record (tag, checksum, offset, length). */
function sfntTables(b: Buffer): TableReader | null {
  if (b.length < 12) return null;
  const n = b.readUInt16BE(4);
  if (n === 0 || n > MAX_TABLES || !inBounds(b, 12, n * 16)) return null;
  return (tag) => {
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16;
      if (tagAt(b, r) !== tag) continue;
      const offset = b.readUInt32BE(r + 8);
      const length = b.readUInt32BE(r + 12);
      return length <= MAX_TABLE_BYTES && inBounds(b, offset, length) ? b.subarray(offset, offset + length) : null;
    }
    return null;
  };
}

/** WOFF 1: header 44 bytes, then 20-byte records (tag, offset, compLength, origLength, checksum); zlib when compLength < origLength. */
function woffTables(b: Buffer): TableReader | null {
  if (b.length < 44) return null;
  const n = b.readUInt16BE(12);
  if (n === 0 || n > MAX_TABLES || !inBounds(b, 44, n * 20)) return null;
  return (tag) => {
    for (let i = 0; i < n; i++) {
      const r = 44 + i * 20;
      if (tagAt(b, r) !== tag) continue;
      const offset = b.readUInt32BE(r + 4);
      const comp = b.readUInt32BE(r + 8);
      const orig = b.readUInt32BE(r + 12);
      if (orig > MAX_TABLE_BYTES || comp > orig || !inBounds(b, offset, comp)) return null;
      const raw = b.subarray(offset, offset + comp);
      if (comp === orig) return raw;
      try {
        const out = inflateSync(raw, { maxOutputLength: orig });
        return out.length === orig ? out : null;
      } catch { return null; }
    }
    return null;
  };
}

/** The WOFF2 known-table tags, by their 6-bit index (WOFF2 spec, table 2). */
const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

/** UIntBase128 (WOFF2): at most 5 bytes, no leading zero byte, no overflow past 32 bits. */
function base128(b: Buffer, at: number): { value: number; next: number } | null {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    if (at + i >= b.length) return null;
    const byte = b[at + i]!;
    if (i === 0 && byte === 0x80) return null;
    if (v > 0x01ffffff) return null;
    v = v * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value: v, next: at + i + 1 };
  }
  return null;
}

/**
 * WOFF2: header 48 bytes, a variable-length table directory, then one Brotli stream of all the tables concatenated (no
 * padding), each `transformLength` long when transformed, else `origLength`. Only the stream up to the end of the last
 * table we want is needed, but Brotli decompresses from the start, so the output is capped instead.
 */
function woff2Tables(b: Buffer): TableReader | null {
  if (b.length < 48) return null;
  if (tagAt(b, 4) === 'ttcf') return null;
  const n = b.readUInt16BE(12);
  const compressed = b.readUInt32BE(20);
  if (n === 0 || n > MAX_TABLES) return null;
  let at = 48;
  const entries: { tag: string; offset: number; length: number }[] = [];
  let streamOffset = 0;
  for (let i = 0; i < n; i++) {
    if (at >= b.length) return null;
    const flags = b[at]!;
    at += 1;
    let tag: string;
    if ((flags & 0x3f) === 0x3f) {
      if (!inBounds(b, at, 4)) return null;
      tag = tagAt(b, at);
      at += 4;
    } else {
      tag = WOFF2_TAGS[flags & 0x3f]!;
    }
    const orig = base128(b, at);
    if (!orig) return null;
    at = orig.next;
    const version = (flags >> 6) & 0x03;
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    let length = orig.value;
    if (transformed) {
      const t = base128(b, at);
      if (!t) return null;
      at = t.next;
      length = t.value;
    }
    entries.push({ tag, offset: streamOffset, length: transformed ? -1 : length });
    streamOffset += length;
    if (streamOffset > 0xffffffff) return null;
  }
  if (!inBounds(b, at, compressed) || streamOffset > FONT_PROBE_MAX_FILE) return null;
  const total = streamOffset;
  let stream: Buffer | null = null;
  const decompressed = (): Buffer | null => {
    if (stream) return stream;
    try {
      stream = brotliDecompressSync(b.subarray(at, at + compressed), { maxOutputLength: Math.max(1, total) });
    } catch { return null; }
    return stream;
  };
  return (tag) => {
    const e = entries.find((x) => x.tag === tag);
    if (!e || e.length < 0 || e.length > MAX_TABLE_BYTES) return null;
    const s = decompressed();
    return s && inBounds(s, e.offset, e.length) ? s.subarray(e.offset, e.offset + e.length) : null;
  };
}

const fixed = (b: Buffer, o: number) => b.readInt32BE(o) / 65536;
const clampWeight = (w: number) => Math.min(1000, Math.max(1, Math.round(w)));

/** `fvar`'s `wght` axis as `[min, max]`; null when there is none or the table is malformed. */
function fvarWeight(t: Buffer): FontWeightRange | null {
  if (t.length < 16) return null;
  const axesOffset = t.readUInt16BE(4);
  const axisCount = t.readUInt16BE(8);
  const axisSize = t.readUInt16BE(10);
  if (axisCount === 0 || axisCount > MAX_AXES || axisSize < 20 || !inBounds(t, axesOffset, axisCount * axisSize)) return null;
  for (let i = 0; i < axisCount; i++) {
    const r = axesOffset + i * axisSize;
    if (tagAt(t, r) !== 'wght') continue;
    const min = fixed(t, r + 4);
    const max = fixed(t, r + 12);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
    return { min: clampWeight(min), max: clampWeight(max) };
  }
  return null;
}

/** `OS/2`'s `usWeightClass` (1–1000); null when out of range or the table is too short. */
function os2Weight(t: Buffer): number | null {
  if (t.length < 6) return null;
  const w = t.readUInt16BE(4);
  return w >= 1 && w <= 1000 ? w : null;
}

/** The weight range of a font held in memory (see the module comment). */
export function fontWeightRangeOf(b: Buffer): FontWeightRange | null {
  if (b.length < 4 || b.length > FONT_PROBE_MAX_FILE) return null;
  const sig = tagAt(b, 0);
  const reader = sig === 'wOFF' ? woffTables(b)
    : sig === 'wOF2' ? woff2Tables(b)
      : sig === 'OTTO' || sig === 'true' || b.readUInt32BE(0) === 0x00010000 ? sfntTables(b)
        : null;
  if (!reader) return null;
  const fvar = reader('fvar');
  const range = fvar ? fvarWeight(fvar) : null;
  if (range) return range;
  const os2 = reader('OS/2');
  const w = os2 ? os2Weight(os2) : null;
  return w === null ? null : { min: w, max: w };
}

/** Reads `file` (no link followed; at most {@link FONT_PROBE_MAX_FILE} bytes) and probes it; null when it cannot. */
export async function probeFontWeights(file: string): Promise<FontWeightRange | null> {
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!fh) return null;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > FONT_PROBE_MAX_FILE) return null;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const { bytesRead } = await fh.read(buf, read, st.size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return fontWeightRangeOf(buf.subarray(0, read));
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

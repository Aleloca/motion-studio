import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/**
 * The size of an SVG from its root element's `width`/`height` (absolute units: px or none, also pt, pc, mm, cm, in), else
 * its `viewBox` (final wave P1). A plain text scan, linear in the text (final wave S1: `indexOf` only, no backtracking
 * regex over the file): nothing is parsed as XML, no entity, DTD, `xlink:href`, `<image>` or other external reference is
 * ever resolved, and no tool reads the file. Bounded: at most `MAX_BYTES` read, the root tag found within them and at most
 * `MAX_TAG` long. Null when no size can be told (percentages, `em`, no viewBox, no root tag in reach).
 */
const MAX_BYTES = 256 * 1024;
const MAX_TAG = 16 * 1024;
const PER_UNIT: Record<string, number> = { '': 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** The attributes of the root `<svg …>` start tag (text between `<svg` and `>`), or null. Linear. */
function rootTag(text: string): string | null {
  const end = Math.min(text.length, MAX_BYTES);
  let i = 0;
  while (i < end) {
    const lt = text.indexOf('<', i);
    if (lt < 0 || lt >= end) return null;
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      if (close < 0) return null; // an unterminated comment hides the rest
      i = close + 3;
      continue;
    }
    if (text.slice(lt + 1, lt + 4).toLowerCase() === 'svg') {
      const next = text[lt + 4];
      if (next === '>' || next === '/' || isSpace(next)) {
        const gt = text.indexOf('>', lt + 4);
        if (gt < 0 || gt - lt > MAX_TAG) return null;
        return text.slice(lt + 4, gt);
      }
    }
    i = lt + 1;
  }
  return null;
}

/** `name="value"` / `name='value'` pairs of a tag, by a single left-to-right pass (lower-cased names, first wins). */
function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  const n = tag.length;
  while (i < n) {
    while (i < n && (isSpace(tag[i]) || tag[i] === '/')) i++;
    const start = i;
    while (i < n && !isSpace(tag[i]) && tag[i] !== '=' && tag[i] !== '/') i++;
    const name = tag.slice(start, i).toLowerCase();
    while (i < n && isSpace(tag[i])) i++;
    if (tag[i] !== '=') { if (i === start) i++; continue; }
    i++;
    while (i < n && isSpace(tag[i])) i++;
    const q = tag[i];
    if (q !== '"' && q !== "'") { while (i < n && !isSpace(tag[i])) i++; continue; }
    const close = tag.indexOf(q, i + 1);
    if (close < 0) break;
    if (name && !out.has(name)) out.set(name, tag.slice(i + 1, close).trim());
    i = close + 1;
  }
  return out;
}

const NUMBER = /^([0-9]{1,12}(?:\.[0-9]{1,12})?|\.[0-9]{1,12})(?:e[+-]?[0-9]{1,3})?\s*(px|pt|pc|mm|cm|in)?$/i;

export function svgSizeOf(text: string): { width: number; height: number } | null {
  const tag = rootTag(text);
  if (tag === null) return null;
  const attrs = attributes(tag);
  const length = (v: string | undefined) => {
    const m = v === undefined || v.length > 64 ? null : NUMBER.exec(v);
    if (!m) return null;
    const x = Number(v!.replace(/\s*(px|pt|pc|mm|cm|in)$/i, '')) * PER_UNIT[(m[2] ?? '').toLowerCase()]!;
    return Number.isFinite(x) && x > 0 && x <= 1e6 ? Math.round(x) : null;
  };
  const rawBox = attrs.get('viewbox') ?? '';
  const box = rawBox.length > 256 ? [] : rawBox.split(/[\s,]+/).filter(Boolean).map(Number);
  const vb = box.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0 && box[2]! <= 1e6 && box[3]! <= 1e6 ? { width: box[2]!, height: box[3]! } : null;
  let width = length(attrs.get('width'));
  let height = length(attrs.get('height'));
  if (width === null && height === null && vb) return { width: Math.round(vb.width), height: Math.round(vb.height) };
  // One side given: the other from the viewBox's ratio.
  if (vb && width !== null && height === null) height = Math.round((width * vb.height) / vb.width);
  if (vb && height !== null && width === null) width = Math.round((height * vb.width) / vb.height);
  return width !== null && height !== null && width > 0 && height > 0 ? { width, height } : null;
}

/**
 * `svgSizeOf` of a file's first 256 KB; null when unreadable or not a regular file (opened non-blocking, checked with
 * fstat: a FIFO, socket or device is never read).
 */
export async function svgSize(file: string): Promise<{ width: number; height: number } | null> {
  const fh = await open(file, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!fh) return null;
  try {
    if (!(await fh.stat()).isFile()) return null;
    const buf = Buffer.alloc(MAX_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MAX_BYTES, 0);
    return svgSizeOf(buf.subarray(0, bytesRead).toString('utf8'));
  } catch { return null; } finally { await fh.close().catch(() => {}); }
}

/** An SVG by its name (`.svg`, `.svgz`). Content is not looked at: an SVG under another name is probed among the
 * whitelisted demuxers (no `svg_pipe`) and simply fails to read. */
export const isSvgName = (file: string) => /\.svgz?$/i.test(file);

import { open } from 'node:fs/promises';

/**
 * The size of an SVG from its root element's `width`/`height` (absolute units: px or none, also pt, pc, mm, cm, in), else
 * its `viewBox` (final wave P1). A plain text scan of the file's first 256 KB: nothing is parsed as XML, no entity, DTD,
 * `xlink:href`, `<image>` or other external reference is ever resolved, and no tool reads the file. Null when no size can
 * be told (percentages, `em`, no viewBox).
 */
const MAX_BYTES = 256 * 1024;
const PER_UNIT: Record<string, number> = { '': 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };

export function svgSizeOf(text: string): { width: number; height: number } | null {
  // The root element: the first `<svg` start tag (comments, a prolog or a DOCTYPE may come first; their contents are text).
  const noComments = text.replace(/<!--[\s\S]*?-->/g, '');
  const tag = /<svg\b([^>]*)>/i.exec(noComments)?.[1];
  if (tag === undefined) return null;
  const attr = (name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  const value = (name: string) => { const m = attr(name); return m ? (m[1] ?? m[2] ?? '').trim() : null; };
  const length = (v: string | null) => {
    const m = v === null ? null : /^([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?$/i.exec(v);
    if (!m) return null;
    const n = Number(m[1]) * PER_UNIT[(m[2] ?? '').toLowerCase()]!;
    return Number.isFinite(n) && n > 0 && n <= 1e6 ? Math.round(n) : null;
  };
  const box = (value('viewBox') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
  const vb = box.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0 && box[2]! <= 1e6 && box[3]! <= 1e6 ? { width: box[2]!, height: box[3]! } : null;
  let width = length(value('width'));
  let height = length(value('height'));
  if (width === null && height === null && vb) return { width: Math.round(vb.width), height: Math.round(vb.height) };
  // One side given: the other from the viewBox's ratio.
  if (vb && width !== null && height === null) height = Math.round((width * vb.height) / vb.width);
  if (vb && height !== null && width === null) width = Math.round((height * vb.width) / vb.height);
  return width !== null && height !== null && width > 0 && height > 0 ? { width, height } : null;
}

/** `svgSizeOf` of a file's first 256 KB (read as a plain file); null when unreadable. */
export async function svgSize(file: string): Promise<{ width: number; height: number } | null> {
  const fh = await open(file, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(MAX_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MAX_BYTES, 0);
    return svgSizeOf(buf.subarray(0, bytesRead).toString('utf8'));
  } catch { return null; } finally { await fh.close().catch(() => {}); }
}

/** An SVG by name or by its first bytes (`<svg`, or an XML prolog followed by one). */
export const isSvgName = (file: string) => /\.svgz?$/i.test(file);

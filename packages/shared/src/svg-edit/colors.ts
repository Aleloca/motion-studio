import type { SvgDoc } from './tree.ts';

/**
 * Colours of an SVG (SVG inner editor, Task 1): where they are, how they are written, and their replacement.
 *
 * - **Sources:** the attributes {@link COLOR_PROPS} of every element, the same properties in its `style=""`, and the
 *   declarations of those properties in `<style>` text (text and CDATA nodes). Other properties, selectors (`#fab {…}` is
 *   an id, not a colour) and comments are never read.
 * - **Literals:** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` and the 148 CSS named colours, any case.
 *   `none`, `currentColor`, `inherit`, `transparent` and `url(…)` are not colours here.
 * - **One entry per colour:** every spelling is normalised to `#rrggbb` (or `#rrggbbaa` when not opaque), lower case.
 * - **Replacement** writes the new hex in place of the old token only: the rest of the text stays byte for byte.
 */

/** The paint properties read as colours, as attributes and as CSS declarations. */
export const COLOR_PROPS = ['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color', 'color'] as const;
const COLOR_PROP_SET = new Set<string>(COLOR_PROPS);
const SVG_NS = 'http://www.w3.org/2000/svg';

// The CSS named colours (CSS Color 4: 147 names plus rebeccapurple), as `name:rrggbb`.
const NAMED_TABLE = 'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 '
  + 'black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 '
  + 'chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff '
  + 'darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b '
  + 'darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a '
  + 'darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 '
  + 'deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 '
  + 'forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 '
  + 'green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 '
  + 'khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 '
  + 'lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 '
  + 'lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 '
  + 'lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 '
  + 'mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 '
  + 'mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 '
  + 'mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 '
  + 'olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 '
  + 'paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd '
  + 'powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 '
  + 'salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb '
  + 'slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 '
  + 'thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 '
  + 'yellowgreen:9acd32';
const NAMED = new Map(NAMED_TABLE.split(' ').map((e) => { const [n, h] = e.split(':'); return [n!, `#${h!}`] as const; }));

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

/** `#rrggbb` or `#rrggbbaa` (lower case) of one colour literal, or null when `token` is not one (see the module comment). */
export function parseColor(token: string): string | null {
  const t = token.trim();
  if (t.startsWith('#')) {
    const h = t.slice(1).toLowerCase();
    if (!/^[0-9a-f]+$/.test(h)) return null;
    const full = h.length === 3 || h.length === 4 ? [...h].map((c) => c + c).join('') : h.length === 6 || h.length === 8 ? h : null;
    if (full === null) return null;
    return full.length === 8 && full.endsWith('ff') ? `#${full.slice(0, 6)}` : `#${full}`;
  }
  const fn = /^(rgba?)\s*\(([^)]*)\)$/i.exec(t);
  if (fn) {
    const parts = fn[2]!.trim().split(/\s*[,/]\s*|\s+/).filter((p) => p !== '');
    if (parts.length !== 3 && parts.length !== 4) return null;
    const num = (p: string, scale: number): number | null => {
      const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(p);
      if (!m) return null;
      const v = Number(m[1]);
      return Number.isFinite(v) ? (m[2] ? (v / 100) * scale : v) : null;
    };
    const rgb = parts.slice(0, 3).map((p) => num(p, 255));
    const alpha = parts[3] === undefined ? 1 : num(parts[3], 1);
    if (rgb.some((v) => v === null) || alpha === null) return null;
    const a = Math.min(1, Math.max(0, alpha));
    const base = `#${rgb.map((v) => hex2(v!)).join('')}`;
    return a >= 1 ? base : `${base}${hex2(a * 255)}`;
  }
  return /^[a-z]+$/i.test(t) ? NAMED.get(t.toLowerCase()) ?? null : null;
}

/** A colour literal found in a text: its place and its normalised hex. */
interface Token { start: number; end: number; hex: string }
type Mode = 'value' | 'decls' | 'sheet';

/** `css` with its comments turned into spaces (same length, so positions still match the original). */
const blankComments = (css: string) => css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (c) => ' '.repeat(c.length));

/** The colour tokens of one CSS value (`url(…)` skipped), at `offset` in the whole text. */
function valueTokens(v: string, offset: number, out: Token[]): void {
  const re = /url\s*\([^)]*\)?|#[0-9a-zA-Z]+|rgba?\s*\([^)]*\)|[a-zA-Z_-][a-zA-Z0-9_-]*/gi;
  for (let m = re.exec(v); m; m = re.exec(v)) {
    if (/^url/i.test(m[0]) && m[0].includes('(')) continue;
    const hex = parseColor(m[0]);
    if (hex) out.push({ start: offset + m.index, end: offset + m.index + m[0].length, hex });
  }
}

/** Declarations of a declaration list (`a: b; c: d`) between `from` and `to`: property (lower case) and value range. */
export function declarations(css: string, from = 0, to = css.length): Array<{ prop: string; start: number; end: number }> {
  const out: Array<{ prop: string; start: number; end: number }> = [];
  let i = from;
  while (i < to) {
    const semi = css.indexOf(';', i);
    const end = semi < 0 || semi > to ? to : semi;
    const colon = css.indexOf(':', i);
    if (colon >= 0 && colon < end) out.push({ prop: css.slice(i, colon).trim().toLowerCase(), start: colon + 1, end });
    i = end + 1;
  }
  return out;
}

/** The colour tokens of a source text: a whole value, a declaration list (`style=""`) or a style sheet (`<style>`). */
function tokensOf(text: string, mode: Mode): Token[] {
  const out: Token[] = [];
  if (mode === 'value') { valueTokens(text, 0, out); return out; }
  const css = blankComments(text);
  const lists: Array<[number, number]> = [];
  if (mode === 'decls') lists.push([0, css.length]);
  else {
    // A `<style>` of a checked SVG has no at-rule, so blocks never nest: `selector { declarations }`.
    for (let i = css.indexOf('{'); i >= 0; i = css.indexOf('{', i + 1)) {
      const close = css.indexOf('}', i + 1);
      lists.push([i + 1, close < 0 ? css.length : close]);
      if (close < 0) break;
      i = close;
    }
  }
  for (const [from, to] of lists) {
    for (const d of declarations(css, from, to)) if (COLOR_PROP_SET.has(d.prop)) valueTokens(css.slice(d.start, d.end), d.start, out);
  }
  return out;
}

/** One place colours are written: its text, how to read it, and how to write it back. */
interface Source { text: string; mode: Mode; write: (text: string) => void }

/** Every colour source of the document, in document order (see the module comment). */
function sources(doc: SvgDoc): Source[] {
  const out: Source[] = [];
  const all = doc.getElementsByTagName('*');
  for (let k = 0; k < all.length; k++) {
    const el = all[k]!;
    for (const name of COLOR_PROPS) {
      const v = el.getAttribute(name);
      if (v !== null) out.push({ text: v, mode: 'value', write: (t) => el.setAttribute(name, t) });
    }
    const style = el.getAttribute('style');
    if (style !== null) out.push({ text: style, mode: 'decls', write: (t) => el.setAttribute('style', t) });
    if (el.localName === 'style' && el.namespaceURI === SVG_NS) {
      for (const node of Array.from(el.childNodes)) {
        // Text and CDATA nodes: each keeps its own kind (a CDATA section stays one).
        if (node.nodeType === 3 || node.nodeType === 4) out.push({ text: node.nodeValue ?? '', mode: 'sheet', write: (t) => { node.nodeValue = t; } });
      }
    }
  }
  return out;
}

export interface SvgColor { hex: string; count: number }

/** The distinct colours of the document, with how many times each is written: by count (descending), then first appearance. */
export function listColors(doc: SvgDoc): SvgColor[] {
  const counts = new Map<string, number>();
  for (const s of sources(doc)) for (const t of tokensOf(s.text, s.mode)) counts.set(t.hex, (counts.get(t.hex) ?? 0) + 1);
  // Map order is first appearance; the sort is stable.
  return [...counts].map(([hex, count]) => ({ hex, count })).sort((a, b) => b.count - a.count);
}

/** A colour the editor writes: `#rrggbb`/`#rrggbbaa` of any literal, or an Error. */
export function colorOrThrow(value: string): string {
  const hex = parseColor(value);
  if (!hex) throw new Error(`not a colour: ${value.slice(0, 40)}`);
  return hex;
}

/** Replaces every occurrence of the colour `fromHex` (any spelling) with `toHex`, written as hex. Returns how many changed. */
export function replaceColor(doc: SvgDoc, fromHex: string, toHex: string): number {
  const from = colorOrThrow(fromHex);
  const to = colorOrThrow(toHex);
  let changed = 0;
  for (const s of sources(doc)) {
    const hits = tokensOf(s.text, s.mode).filter((t) => t.hex === from);
    if (hits.length === 0) continue;
    let text = s.text;
    for (const t of hits.reverse()) text = text.slice(0, t.start) + to + text.slice(t.end);
    s.write(text);
    changed += hits.length;
  }
  return changed;
}

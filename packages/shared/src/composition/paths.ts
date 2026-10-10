/** Longest path a composition may reference (UTF-16 code units). */
export const COMPOSITION_PATH_MAX = 512;

/**
 * Whether `p` is a path a composition may reference (spec §3.2): relative to the composition folder, under `assets/` or
 * `layers/`. Rejected:
 * - anything not starting with exactly `assets/` or `layers/` (so absolute paths, `C:/…`, `../…` and schemes like `https://…`);
 * - an empty segment (`a//b`), a trailing slash, a `.` or `..` segment;
 * - a backslash, a colon (schemes, drive letters), `%` (percent-encoded traversal once the path is a URL), `?` and `#`
 *   (they would cut the path when it becomes a URL);
 * - a segment that is blank or only whitespace (`assets/ /x`);
 * - NUL and every control character (C0, DEL, C1), the line/paragraph separators U+2028/U+2029, invisible and bidi
 *   format characters (U+200B–U+200F, U+202A–U+202E, U+2060–U+206F, U+FEFF) and unpaired UTF-16 surrogates;
 * - more than `COMPOSITION_PATH_MAX` characters.
 * A single linear pass, no regex: safe on any input.
 */
export function isCompositionPath(p: string): boolean {
  if (typeof p !== 'string' || p.length > COMPOSITION_PATH_MAX) return false;
  if (!p.startsWith('assets/') && !p.startsWith('layers/')) return false;
  let segmentStart = 0;
  for (let i = 0; i <= p.length; i++) {
    if (i === p.length || p.charCodeAt(i) === 0x2f /* / */) {
      const segment = p.slice(segmentStart, i);
      if (segment.trim() === '' || segment === '.' || segment === '..') return false;
      segmentStart = i + 1;
      continue;
    }
    const c = p.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return false;
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff) return false;
    if (c >= 0xd800 && c <= 0xdbff) {
      // A high surrogate must be followed by a low one (the pair is one character); skip the low half.
      const next = p.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return false;
    if (c === 0x5c /* \ */ || c === 0x3a /* : */ || c === 0x25 /* % */ || c === 0x3f /* ? */ || c === 0x23 /* # */) return false;
  }
  return true;
}

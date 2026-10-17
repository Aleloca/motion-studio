import type { Composition } from '@motion-studio/shared';

/**
 * Vector mode of the identity formats (Phase 14, spec §4.2, decisions 726–728) and the strict SVG check (decision 727).
 *
 * An identity SVG ends up in the user's websites and apps (`favicon.svg`, `logo.svg`, the brand kit), so it must be inert:
 * no script, no event handler, nothing that loads anything. The check parses the file with a strict XML tokenizer written
 * here (no dependency): anything it does not understand is refused, never guessed.
 *
 * - **Malformed XML is refused**: unbalanced or unclosed tags, a stray `<` or `&`, an undefined entity, a duplicate attribute,
 *   control characters, text after the root.
 * - **No DTD**: `<!DOCTYPE`, `<!ENTITY` and any other `<!…>` declaration (XXE, entity expansion), and no processing
 *   instruction other than the leading `<?xml …?>` declaration (`<?xml-stylesheet?>` loads a stylesheet).
 * - **Elements**: every element must be in the SVG namespace (prefixes are resolved, so `svg:script` is `script`) and on an
 *   allowlist of drawing, paint-server, filter and text elements. `script`, `foreignObject`, `image`/`feImage`, links (`a`),
 *   animation (`animate`, `set`, …) and everything else are refused. Names are case-sensitive in XML, so `<SCRIPT>` is not
 *   on the allowlist either.
 * - **Attributes**: no `on*` (any case, any prefix); `href`/`xlink:href` only to a local `#id`; prefixed attributes only
 *   `xlink:href`/`xlink:title`, `xml:space`/`xml:lang` (no `xml:base`). Values are checked after entity decoding, so
 *   `&#x6A;avascript:` is `javascript:`.
 * - **CSS** (`style` attributes, `<style>` text and CDATA, and every presentation value): comments removed first; no
 *   backslash (CSS escapes could spell `url`), `url(…)` only to a local `#id`, no `image()`, `image-set()`, `cross-fade()`,
 *   `element()`, `src()`, `expression()`, no `@import`; a `<style>` element has no at-rule at all.
 * - **Scalable**: the root `<svg>` has a `viewBox` with a positive size (every PNG is drawn from it at its exact size).
 * - **Size**: at most 512 KB (UTF-8).
 * - `<text>` (and `tspan`, `textPath`) is accepted with a warning: its look depends on the fonts installed.
 */

export const MAX_VECTOR_SVG_BYTES = 512 * 1024;

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
  'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR',
  'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
  'feSpotLight', 'feTile', 'feTurbulence',
  'title', 'desc', 'metadata', 'style', 'text', 'tspan', 'textPath',
]);
const TEXT_ELEMENTS = new Set(['text', 'tspan', 'textPath']);
const ANIMATION_ELEMENTS = new Set(['animate', 'animateMotion', 'animateTransform', 'animateColor', 'set', 'discard']);
/** Attributes whose value is plain text, never CSS (no presentation check). */
const TEXT_ATTRIBUTES = new Set(['id', 'class', 'lang', 'role', 'tabindex']);
const LOCAL_REF_RE = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;
const MAX_DEPTH = 256;
/** Attributes on one element, namespace declarations on one element and in the whole file (quadratic-work guards). */
const MAX_ATTRIBUTES = 256;
const MAX_NS_DECLS_PER_ELEMENT = 64;
const MAX_NS_DECLS = 256;
/** `<use>` elements in the file, and the elements they may add once expanded. */
const MAX_USES = 256;
const MAX_EXPANDED_ELEMENTS = 50_000;
const MAX_REASONS = 20;
// eslint-disable-next-line no-control-regex
const WS_RE = /[ \t\r\n]/;
const BAD_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

class Malformed extends Error {}

/** Text taken from the file, in a reason: cut to 40 characters and quoted JSON-style (never a line break or a bare quote). */
const quoteFound = (v: string) => JSON.stringify(v.slice(0, 40)).replace(/[\u2028\u2029\u0085]/g, ' ');

interface RawAttr { name: string; value: string }
type Tok =
  | { kind: 'open'; name: string; attrs: RawAttr[]; selfClosing: boolean }
  | { kind: 'close'; name: string }
  | { kind: 'text'; text: string };

/** Decodes the five XML entities and numeric references; anything else is malformed (there is no DTD to define it). */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&([^;&\s<]*);?/g, (whole, body: string) => {
    if (!whole.endsWith(';')) throw new Malformed(`a bare "&" (write &amp;)`);
    switch (body) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return "'";
      default: break;
    }
    const m = /^#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}))$/.exec(body);
    if (!m) throw new Malformed(`undefined entity &${body.slice(0, 20)};`);
    const cp = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2]!, 10);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new Malformed('a character reference outside Unicode');
    const ch = String.fromCodePoint(cp);
    if (BAD_CHARS_RE.test(ch)) throw new Malformed('a character reference to a control character');
    return ch;
  });
}

/** The tokens of `src` (see the module comment); throws `Malformed`, or returns a refusal for a DTD or instruction. */
function tokenize(src: string): { tokens: Tok[] } | { refused: string } {
  const tokens: Tok[] = [];
  let i = 0;
  const n = src.length;
  const startsAt = (s: string) => src.startsWith(s, i);
  if (startsAt('<?xml') && /[\s?]/.test(src[5] ?? '')) {
    const end = src.indexOf('?>', i);
    if (end < 0) throw new Malformed('the XML declaration is not closed');
    const decl = src.slice(5, end);
    if (!/^\s+version\s*=\s*(["'])1\.[0-9]\1(\s+encoding\s*=\s*(["'])[A-Za-z][A-Za-z0-9._-]*\3)?(\s+standalone\s*=\s*(["'])(yes|no)\5)?\s*$/.test(decl)) {
      throw new Malformed('a bad XML declaration');
    }
    i = end + 2;
  }
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt !== i) {
      const end = lt < 0 ? n : lt;
      const raw = src.slice(i, end);
      if (raw.includes(']]>')) throw new Malformed('"]]>" in text');
      tokens.push({ kind: 'text', text: decodeEntities(raw) });
      i = end;
      continue;
    }
    if (startsAt('<!--')) {
      const end = src.indexOf('-->', i + 4);
      if (end < 0) throw new Malformed('a comment is not closed');
      const body = src.slice(i + 4, end);
      if (body.includes('--') || body.endsWith('-')) throw new Malformed('"--" inside a comment');
      i = end + 3;
      continue;
    }
    if (startsAt('<![CDATA[')) {
      const end = src.indexOf(']]>', i + 9);
      if (end < 0) throw new Malformed('a CDATA section is not closed');
      tokens.push({ kind: 'text', text: src.slice(i + 9, end) });
      i = end + 3;
      continue;
    }
    if (startsAt('<!')) return { refused: 'DOCTYPE and ENTITY declarations are not allowed (<!…>)' };
    if (startsAt('<?')) return { refused: 'processing instructions are not allowed (<?…?>), only the leading <?xml …?> declaration' };
    if (startsAt('</')) {
      const m = /^<\/([^ \t\r\n>/]+)[ \t\r\n]*>/.exec(src.slice(i, i + 300));
      if (!m || !NAME_RE.test(m[1]!)) throw new Malformed('a bad closing tag');
      tokens.push({ kind: 'close', name: m[1]! });
      i += m[0].length;
      continue;
    }
    // A start tag.
    let j = i + 1;
    const nameM = /^[^ \t\r\n>/]+/.exec(src.slice(j, j + 300));
    if (!nameM || !NAME_RE.test(nameM[0])) throw new Malformed('a bad tag name');
    const name = nameM[0];
    j += name.length;
    const attrs: RawAttr[] = [];
    const seen = new Set<string>();
    let selfClosing = false;
    for (;;) {
      const wsStart = j;
      while (j < n && WS_RE.test(src[j]!)) j++;
      if (j >= n) throw new Malformed(`the tag <${name}> is not closed`);
      if (src[j] === '>') { j++; break; }
      if (src.startsWith('/>', j)) { selfClosing = true; j += 2; break; }
      if (j === wsStart) throw new Malformed(`attributes of <${name}> must be separated by spaces`);
      const an = /^[^ \t\r\n=>/]+/.exec(src.slice(j, j + 300));
      if (!an || !NAME_RE.test(an[0])) throw new Malformed(`a bad attribute name in <${name}>`);
      j += an[0].length;
      while (j < n && WS_RE.test(src[j]!)) j++;
      if (src[j] !== '=') throw new Malformed(`attribute ${an[0]} of <${name}> has no value`);
      j++;
      while (j < n && WS_RE.test(src[j]!)) j++;
      const q = src[j];
      if (q !== '"' && q !== "'") throw new Malformed(`attribute ${an[0]} of <${name}> is not quoted`);
      const close = src.indexOf(q, j + 1);
      if (close < 0) throw new Malformed(`attribute ${an[0]} of <${name}> is not closed`);
      const rawValue = src.slice(j + 1, close);
      if (rawValue.includes('<')) throw new Malformed(`"<" in attribute ${an[0]} of <${name}>`);
      if (seen.has(an[0])) throw new Malformed(`attribute ${an[0]} appears twice in <${name}>`);
      if (attrs.length >= MAX_ATTRIBUTES) throw new Malformed(`more than ${MAX_ATTRIBUTES} attributes on <${name}>`);
      seen.add(an[0]);
      attrs.push({ name: an[0], value: decodeEntities(rawValue).replace(/[\t\n\r]/g, ' ') });
      j = close + 1;
    }
    tokens.push({ kind: 'open', name, attrs, selfClosing });
    i = j;
  }
  return { tokens };
}

/** Problems of a CSS text (a `style` value, a `<style>` element, a presentation attribute value). */
function cssProblems(css: string, where: string, o: { atRules: boolean }): string[] {
  const out: string[] = [];
  // Comments go first: `ur/**/l(` is not a function, but checking both forms costs nothing.
  let text = '';
  for (let k = 0; ;) {
    const open = css.indexOf('/*', k);
    if (open < 0) { text += css.slice(k); break; }
    const close = css.indexOf('*/', open + 2);
    if (close < 0) return [`${where}: a CSS comment is not closed`];
    text += css.slice(k, open);
    k = close + 2;
  }
  if (text.includes('\\') || css.includes('\\')) out.push(`${where}: backslashes (CSS escapes) are not allowed`);
  for (const t of [text.toLowerCase(), css.toLowerCase()]) {
    if (/@import/.test(t)) out.push(`${where}: @import is not allowed`);
    if (!o.atRules && /@[a-z-]/.test(t)) out.push(`${where}: CSS at-rules (@…) are not allowed`);
    // Any vendor-prefixed function (`-webkit-cross-fade(`) too: decision 757 refuses what it cannot vouch for.
    const fn = /(?:^|[^a-z0-9_-])(-[a-z]+-[a-z-]*|image-set|image|cross-fade|element|src|expression|paint)[ \t\r\n\f]*\(/.exec(t);
    if (fn) out.push(`${where}: ${fn[1]}() is not allowed`);
    // Bounded argument: an unclosed `url(` never makes the scan quadratic (no `)` within 2048 characters is a refusal).
    const urlRe = /url[ \t\r\n\f]*\(([^)]{0,2048})(\)?)/g;
    for (let m = urlRe.exec(t); m; m = urlRe.exec(t)) {
      const arg = m[1]!.trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
      if (m[2] !== ')' || !LOCAL_REF_RE.test(arg)) out.push(`${where}: url(…) may only point to a local #id (found url(${quoteFound(arg)}))`);
    }
  }
  return [...new Set(out)];
}

/**
 * The strict SVG check of an identity format (see the module comment). `warnings`: accepted, but worth telling (`<text>`).
 */
export function checkVectorSvg(svg: string): { ok: true; warnings: string[] } | { ok: false; reasons: string[] } {
  if (Buffer.byteLength(svg, 'utf8') > MAX_VECTOR_SVG_BYTES) return { ok: false, reasons: [`the SVG is over ${MAX_VECTOR_SVG_BYTES / 1024} KB`] };
  const src = svg.startsWith('\uFEFF') ? svg.slice(1) : svg;
  // U+FFFD is what a lenient decoder leaves for bytes that are not UTF-8: refused, so every reader agrees on the text.
  if (src.includes('\uFFFD')) return { ok: false, reasons: ['the SVG is not valid UTF-8 (or contains U+FFFD)'] };
  let tokens: Tok[];
  try {
    if (BAD_CHARS_RE.test(src)) throw new Malformed('control characters');
    const t = tokenize(src);
    if ('refused' in t) return { ok: false, reasons: [t.refused] };
    tokens = t.tokens;
  } catch (e) {
    if (e instanceof Malformed) return { ok: false, reasons: [`malformed XML: ${e.message}`] };
    throw e;
  }
  const reasons: string[] = [];
  // Reasons quote the file: line and paragraph separators (U+0085, U+2028, U+2029) and control characters become spaces.
  const refuse = (raw: string) => {
    const r = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
    if (reasons.length < MAX_REASONS && !reasons.includes(r)) reasons.push(r);
  };
  const warnings: string[] = [];
  interface Frame { name: string; local: string; ns: Map<string, string>; style: string[] | null; id: string | null; count: number; uses: string[] }
  const stack: Frame[] = [];
  const rootNs = new Map([['xml', XML_NS]]);
  let roots = 0;
  let closedRoot = false;
  let nsDecls = 0;
  let useCount = 0;
  /** Per `id`: the elements of its subtree and the `<use>` targets inside it (the `<use>` expansion estimate). */
  const byId = new Map<string, { count: number; uses: string[] }>();
  let rootInfo: { count: number; uses: string[] } | null = null;
  const closeFrame = (f: Frame) => {
    if (f.style) for (const r of cssProblems(f.style.join(''), '<style>', { atRules: false })) refuse(r);
    if (f.id !== null && !byId.has(f.id)) byId.set(f.id, { count: f.count, uses: f.uses });
    const parent = stack[stack.length - 1];
    if (parent) { parent.count += f.count; for (const u of f.uses) parent.uses.push(u); } else rootInfo = { count: f.count, uses: f.uses };
  };
  try {
    for (const tok of tokens) {
      if (tok.kind === 'text') {
        if (stack.length === 0) { if (tok.text.trim() !== '') throw new Malformed('text outside the root element'); continue; }
        stack[stack.length - 1]!.style?.push(tok.text);
        continue;
      }
      if (tok.kind === 'close') {
        const top = stack.pop();
        if (!top || top.name !== tok.name) throw new Malformed(`</${tok.name}> does not close ${top ? `<${top.name}>` : 'anything'}`);
        closeFrame(top);
        if (stack.length === 0) closedRoot = true;
        continue;
      }
      if (stack.length === 0) {
        if (closedRoot || roots > 0) throw new Malformed('more than one root element');
        roots++;
      }
      if (stack.length >= MAX_DEPTH) throw new Malformed('elements nested too deeply');
      // Namespaces: declarations of this element first, then the element's own prefix. The map is the parent's own object
      // unless this element declares something (copy on write); declarations are capped per element and per file.
      const parentNs = stack.length ? stack[stack.length - 1]!.ns : rootNs;
      const decls = tok.attrs.filter((a) => a.name === 'xmlns' || a.name.startsWith('xmlns:'));
      if (decls.length > MAX_NS_DECLS_PER_ELEMENT) throw new Malformed(`more than ${MAX_NS_DECLS_PER_ELEMENT} namespace declarations on <${tok.name}>`);
      nsDecls += decls.length;
      if (nsDecls > MAX_NS_DECLS) throw new Malformed(`more than ${MAX_NS_DECLS} namespace declarations`);
      const ns = decls.length > 0 ? new Map(parentNs) : parentNs;
      for (const a of decls) {
        if (a.name === 'xmlns') ns.set('', a.value);
        else {
          const p = a.name.slice(6);
          if (p === 'xml' || p === 'xmlns' || a.value === '') throw new Malformed(`a bad namespace declaration ${a.name}`);
          ns.set(p, a.value);
        }
      }
      const colon = tok.name.indexOf(':');
      const prefix = colon < 0 ? '' : tok.name.slice(0, colon);
      const local = colon < 0 ? tok.name : tok.name.slice(colon + 1);
      const elNs = ns.get(prefix);
      if (prefix !== '' && elNs === undefined) throw new Malformed(`the prefix ${prefix}: is not declared`);
      const shown = `<${tok.name}>`;
      if (stack.length === 0 && (local !== 'svg' || elNs !== SVG_NS)) refuse(`the root element must be <svg xmlns="${SVG_NS}">`);
      if (stack.length === 0 && parseViewBox(tok.attrs.find((a) => a.name === 'viewBox')?.value) === null) {
        refuse('the root <svg> needs a viewBox="0 0 W H" with W and H above 0, so it scales to every size');
      }
      if (elNs !== SVG_NS) refuse(`${shown} is outside the SVG namespace`);
      else if (local === 'script') refuse(`${shown}: scripts are not allowed`);
      else if (local === 'foreignObject') refuse(`${shown}: foreignObject is not allowed`);
      else if (local === 'image' || local === 'feImage') refuse(`${shown}: images (embedded or external) are not allowed, draw with paths`);
      else if (local === 'a') refuse(`${shown}: links are not allowed`);
      else if (ANIMATION_ELEMENTS.has(local)) refuse(`${shown}: animation elements are not allowed`);
      else if (!ALLOWED_ELEMENTS.has(local)) refuse(`${shown} is not allowed`);
      if (elNs === SVG_NS && TEXT_ELEMENTS.has(local) && warnings.length === 0) {
        warnings.push('the SVG has <text>: convert text to paths, or it will look different where the font is not installed');
      }
      // Expanded names (namespace + local name): `xlink:href` and `q:href` bound to the same namespace are the same attribute.
      const expanded = new Set<string>();
      for (const a of tok.attrs) {
        if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
        const c = a.name.indexOf(':');
        const ap = c < 0 ? '' : a.name.slice(0, c);
        const al = c < 0 ? a.name : a.name.slice(c + 1);
        const key = `${ap === '' ? '' : ns.get(ap) ?? `?${ap}`} ${al}`;
        if (expanded.has(key)) throw new Malformed(`attribute ${a.name} of ${`<${tok.name}>`} repeats another one with the same namespace and name`);
        expanded.add(key);
        const where = `${shown} ${a.name}`;
        if (/^on/i.test(al)) { refuse(`${where}: event handler attributes are not allowed`); continue; }
        let isHref = false;
        if (ap !== '') {
          const an = ns.get(ap);
          if (an === undefined) throw new Malformed(`the prefix ${ap}: is not declared`);
          if (an === XMLNS_NS) throw new Malformed(`a bad attribute ${a.name}`);
          if (an === XLINK_NS && al === 'href') isHref = true;
          else if (an === XLINK_NS && al === 'title') continue;
          else if (an === XML_NS && (al === 'space' || al === 'lang')) continue;
          else { refuse(`${where}: this attribute is not allowed`); continue; }
        } else if (al === 'href') isHref = true;
        if (isHref) {
          if (!LOCAL_REF_RE.test(a.value.trim())) refuse(`${where}: links may only point to a local #id (found ${quoteFound(a.value.trim())})`);
          continue;
        }
        if (TEXT_ATTRIBUTES.has(al) || al.startsWith('aria-')) continue;
        for (const r of cssProblems(a.value, where, { atRules: al !== 'style' })) refuse(r);
      }
      const idValue = tok.attrs.find((a) => a.name === 'id')?.value.trim() ?? null;
      const frame: Frame = { name: tok.name, local, ns, style: elNs === SVG_NS && local === 'style' ? [] as string[] : null, id: idValue, count: 1, uses: [] };
      if (elNs === SVG_NS && local === 'use') {
        if (++useCount > MAX_USES) throw new Malformed(`more than ${MAX_USES} <use> elements`);
        const href = tok.attrs.find((a) => { const c = a.name.indexOf(':'); return a.name === 'href' || (c > 0 && a.name.slice(c + 1) === 'href' && ns.get(a.name.slice(0, c)) === XLINK_NS); });
        if (href && LOCAL_REF_RE.test(href.value.trim())) frame.uses.push(href.value.trim().slice(1));
      }
      if (frame.style) {
        const type = tok.attrs.find((a) => a.name === 'type')?.value.trim().toLowerCase();
        if (type !== undefined && type !== '' && type !== 'text/css') refuse(`<style type=${quoteFound(type)}> is not allowed`);
      }
      if (stack.length > 0 && stack[stack.length - 1]!.style) refuse('<style> may only contain CSS text');
      if (tok.selfClosing) {
        closeFrame(frame);
        if (stack.length === 0) closedRoot = true;
        continue;
      }
      stack.push(frame);
    }
    if (stack.length > 0) throw new Malformed(`<${stack[stack.length - 1]!.name}> is not closed`);
    if (roots === 0) throw new Malformed('there is no root element');
    const expandedCount = useExpansion(rootInfo, byId);
    if (expandedCount === 'cycle') refuse('<use> references form a cycle');
    else if (expandedCount > MAX_EXPANDED_ELEMENTS) refuse(`<use> references add more than ${MAX_EXPANDED_ELEMENTS} elements once expanded: draw the shapes directly`);
  } catch (e) {
    if (e instanceof Malformed) return { ok: false, reasons: [`malformed XML: ${e.message}`] };
    throw e;
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, warnings };
}

/**
 * The elements the `<use>`s of the file add once expanded: for each `<use>`, its target's subtree (with the `<use>`s
 * inside it, recursively). Memoised per id, capped just above the limit; a cycle is reported.
 */
function useExpansion(root: { count: number; uses: string[] } | null, byId: ReadonlyMap<string, { count: number; uses: string[] }>): number | 'cycle' {
  if (!root) return 0;
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const cap = MAX_EXPANDED_ELEMENTS + 1;
  const cost = (info: { count: number; uses: string[] }): number | 'cycle' => {
    let total = info.count;
    for (const id of info.uses) {
      const c = costOf(id);
      if (c === 'cycle') return c;
      total = Math.min(cap, total + c);
    }
    return total;
  };
  const costOf = (id: string): number | 'cycle' => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 'cycle';
    const info = byId.get(id);
    if (!info) return 0;
    visiting.add(id);
    const c = cost(info);
    visiting.delete(id);
    if (c !== 'cycle') memo.set(id, c);
    return c;
  };
  // The root's own elements are not counted: only what the `<use>`s add.
  return cost({ count: 0, uses: root.uses });
}

/** `[minX, minY, width, height]` of a `viewBox` value, or null when it is missing or not four numbers with a positive size. */
function parseViewBox(v: string | undefined): [number, number, number, number] | null {
  if (v === undefined) return null;
  const parts = v.trim().split(/[\s,]+/);
  if (parts.length !== 4 || !parts.every((x) => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(x))) return null;
  const [x, y, w, h] = parts.map(Number) as [number, number, number, number];
  return w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h) ? [x, y, w, h] : null;
}

/** The width:height of a checked SVG's `viewBox` (`checkVectorSvg` requires one), or null. */
export function svgAspect(svg: string): { width: number; height: number } | null {
  try {
    const t = tokenize(svg.startsWith('\uFEFF') ? svg.slice(1) : svg);
    if ('refused' in t) return null;
    const root = t.tokens.find((x) => x.kind === 'open');
    const vb = root && root.kind === 'open' ? parseViewBox(root.attrs.find((a) => a.name === 'viewBox')?.value) : null;
    return vb ? { width: vb[2], height: vb[3] } : null;
  } catch {
    return null;
  }
}

/** The id of the optional simplified variant clip of an identity composition (decision 728). */
export const SMALL_VARIANT_CLIP_ID = 'small';
/** The id of the logo's negative clip, for dark backgrounds (note 9, decision 876): required for the logo format. */
export const DARK_VARIANT_CLIP_ID = 'dark';
const VARIANT_IDS = new Set([SMALL_VARIANT_CLIP_ID, DARK_VARIANT_CLIP_ID]);

/**
 * Whether `c` is a vector composition (spec §4.2, decision 726): a still (`duration` 0) made of ONE visible `svg` clip that
 * fills the frame (x, y 0 or absent; width, height the composition's or absent; `fit: 'contain'`, explicitly; no rotation,
 * scale, opacity below 1, animations or Ken Burns), and nothing else.
 *
 * The optional `small` variant (decision 728) is a second `svg` clip with id `small`, hidden (`hidden: true`, so the
 * composition still shows the main drawing), full frame like the main one: its file is used for the sizes up to 48 px.
 * The `dark` clip (decision 876) has the same shape: the negative logo for dark backgrounds. Here it is optional for every
 * kind, so an older logo without it still renders; the turn check requires it for the logo (`identityProblems`).
 * `svgFile`, `small` and `dark` are the clips' `src` (`assets/…`), relative to the composition folder. `reason` is English,
 * for the agent's repair turn.
 */
export function checkVectorComposition(c: Composition): { ok: true; svgFile: string; small?: string; dark?: string } | { ok: false; reason: string } {
  if (c.duration !== 0) return { ok: false, reason: 'an identity composition is a still: set duration to 0' };
  const clips = c.tracks.flatMap((t) => t.clips.map((clip) => ({ clip, trackHidden: t.hidden === true })));
  const mains = clips.filter(({ clip }) => !VARIANT_IDS.has(clip.id));
  if (mains.length !== 1) return { ok: false, reason: `an identity composition has exactly one svg clip and no other clip (found ${mains.length})` };
  const { clip: main, trackHidden } = mains[0]!;
  if (main.type !== 'svg') return { ok: false, reason: `the only clip must be an svg clip, not ${main.type}` };
  if (main.hidden || trackHidden) return { ok: false, reason: 'the svg clip must be visible' };
  if (c.scenes.length > 1) return { ok: false, reason: 'an identity composition has at most one scene' };
  const shape = (clip: (typeof clips)[number]['clip'], label: string): string | null => {
    if (clip.type !== 'svg') return `the ${label} must be an svg clip`;
    if (clip.start !== 0) return `the ${label} must start at 0`;
    const p = clip.props;
    if ((p.x ?? 0) !== 0 || (p.y ?? 0) !== 0 || (p.width ?? c.width) !== c.width || (p.height ?? c.height) !== c.height) {
      return `the ${label} must fill the frame (x 0, y 0, width ${c.width}, height ${c.height})`;
    }
    if ((p.rotation ?? 0) !== 0 || (p.scale ?? 1) !== 1 || (p.opacity ?? 1) !== 1) return `the ${label} has no rotation, scale or opacity: put them in the SVG`;
    if (p.kenBurns || (clip.animations?.length ?? 0) > 0) return `the ${label} has no animation`;
    // The runtime's default for an svg clip is `cover`, which crops a drawing that is not square (fix round 1).
    if (p.fit !== 'contain') return `the ${label} needs "fit": "contain" in its props, so a drawing that is not square is never cropped`;
    if (!/\.svg$/i.test(clip.src)) return `the ${label}'s file must be an .svg file`;
    return null;
  };
  const bad = shape(main, 'svg clip');
  if (bad) return { ok: false, reason: bad };
  const out: { ok: true; svgFile: string; small?: string; dark?: string } = { ok: true, svgFile: main.src };
  const variants = [
    { id: SMALL_VARIANT_CLIP_ID, label: '"small" variant clip', use: 'it is used only for the sizes up to 48 px' },
    { id: DARK_VARIANT_CLIP_ID, label: '"dark" negative clip', use: 'it is the logo for dark backgrounds, exported as logo-dark' },
  ] as const;
  for (const v of variants) {
    const found = clips.filter(({ clip }) => clip.id === v.id);
    if (found.length > 1) return { ok: false, reason: `there is at most one "${v.id}" clip` };
    if (found.length === 0) continue;
    const clip = found[0]!.clip;
    const badVariant = shape(clip, v.label);
    if (badVariant || clip.type !== 'svg') return { ok: false, reason: badVariant ?? `the ${v.label} must be an svg clip` };
    if (!clip.hidden) return { ok: false, reason: `the ${v.label} must be hidden (hidden: true): ${v.use}` };
    out[v.id] = clip.src;
  }
  return out;
}

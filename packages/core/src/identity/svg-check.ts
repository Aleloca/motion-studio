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
const MAX_REASONS = 20;
// eslint-disable-next-line no-control-regex
const WS_RE = /[ \t\r\n]/;
const BAD_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

class Malformed extends Error {}

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
      if (attrs.some((a) => a.name === an[0])) throw new Malformed(`attribute ${an[0]} appears twice in <${name}>`);
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
    const fn = /(?:^|[^a-z0-9_-])(-webkit-image-set|image-set|image|cross-fade|element|src|expression|paint)\s*\(/.exec(t);
    if (fn) out.push(`${where}: ${fn[1]}() is not allowed`);
    const urlRe = /url\s*\(([^)]*)\)?/g;
    for (let m = urlRe.exec(t); m; m = urlRe.exec(t)) {
      const arg = m[1]!.trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
      if (!m[0].endsWith(')') || !LOCAL_REF_RE.test(arg)) out.push(`${where}: url(…) may only point to a local #id (found url(${arg.slice(0, 40)}))`);
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
  const refuse = (r: string) => { if (reasons.length < MAX_REASONS && !reasons.includes(r)) reasons.push(r); };
  const warnings: string[] = [];
  const stack: Array<{ name: string; local: string; ns: Map<string, string>; style: string[] | null }> = [];
  let roots = 0;
  let closedRoot = false;
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
        if (top.style) for (const r of cssProblems(top.style.join(''), '<style>', { atRules: false })) refuse(r);
        if (stack.length === 0) closedRoot = true;
        continue;
      }
      if (stack.length === 0) {
        if (closedRoot || roots > 0) throw new Malformed('more than one root element');
        roots++;
      }
      if (stack.length >= MAX_DEPTH) throw new Malformed('elements nested too deeply');
      // Namespaces: declarations of this element first, then the element's own prefix.
      const ns = new Map(stack.length ? stack[stack.length - 1]!.ns : [['xml', XML_NS]]);
      for (const a of tok.attrs) {
        if (a.name === 'xmlns') ns.set('', a.value);
        else if (a.name.startsWith('xmlns:')) {
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
      for (const a of tok.attrs) {
        if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
        const c = a.name.indexOf(':');
        const ap = c < 0 ? '' : a.name.slice(0, c);
        const al = c < 0 ? a.name : a.name.slice(c + 1);
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
          if (!LOCAL_REF_RE.test(a.value.trim())) refuse(`${where}: links may only point to a local #id (found "${a.value.trim().slice(0, 40)}")`);
          continue;
        }
        if (TEXT_ATTRIBUTES.has(al) || al.startsWith('aria-')) continue;
        for (const r of cssProblems(a.value, where, { atRules: al !== 'style' })) refuse(r);
      }
      const frame = { name: tok.name, local, ns, style: elNs === SVG_NS && local === 'style' ? [] as string[] : null };
      if (frame.style) {
        const type = tok.attrs.find((a) => a.name === 'type')?.value.trim().toLowerCase();
        if (type !== undefined && type !== '' && type !== 'text/css') refuse(`<style type="${type.slice(0, 30)}"> is not allowed`);
      }
      if (tok.selfClosing) {
        if (stack.length === 0) closedRoot = true;
        continue;
      }
      if (stack.length > 0 && stack[stack.length - 1]!.style) refuse('<style> may only contain CSS text');
      stack.push(frame);
    }
    if (stack.length > 0) throw new Malformed(`<${stack[stack.length - 1]!.name}> is not closed`);
    if (roots === 0) throw new Malformed('there is no root element');
  } catch (e) {
    if (e instanceof Malformed) return { ok: false, reasons: [`malformed XML: ${e.message}`] };
    throw e;
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, warnings };
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

/**
 * Whether `c` is a vector composition (spec §4.2, decision 726): a still (`duration` 0) made of ONE visible `svg` clip that
 * fills the frame (x, y 0 or absent; width, height the composition's or absent; no rotation, scale, opacity below 1,
 * animations or Ken Burns), and nothing else.
 *
 * The optional `small` variant (decision 728) is a second `svg` clip with id `small`, hidden (`hidden: true`, so the
 * composition still shows the main drawing), full frame like the main one: its file is used for the sizes up to 48 px.
 * `svgFile` and `small` are the clips' `src` (`assets/…`), relative to the composition folder. `reason` is English, for the
 * agent's repair turn.
 */
export function checkVectorComposition(c: Composition): { ok: true; svgFile: string; small?: string } | { ok: false; reason: string } {
  if (c.duration !== 0) return { ok: false, reason: 'an identity composition is a still: set duration to 0' };
  const clips = c.tracks.flatMap((t) => t.clips.map((clip) => ({ clip, trackHidden: t.hidden === true })));
  const mains = clips.filter(({ clip }) => clip.id !== SMALL_VARIANT_CLIP_ID);
  const smalls = clips.filter(({ clip }) => clip.id === SMALL_VARIANT_CLIP_ID);
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
    if (!/\.svg$/i.test(clip.src)) return `the ${label}'s file must be an .svg file`;
    return null;
  };
  const bad = shape(main, 'svg clip');
  if (bad) return { ok: false, reason: bad };
  if (smalls.length > 1) return { ok: false, reason: 'there is at most one "small" clip' };
  if (smalls.length === 0) return { ok: true, svgFile: main.src };
  const small = smalls[0]!.clip;
  const badSmall = shape(small, '"small" variant clip');
  if (badSmall || small.type !== 'svg') return { ok: false, reason: badSmall ?? 'the "small" variant clip must be an svg clip' };
  if (!small.hidden) return { ok: false, reason: 'the "small" variant clip must be hidden (hidden: true): it is used only for the sizes up to 48 px' };
  return { ok: true, svgFile: main.src, small: small.src };
}

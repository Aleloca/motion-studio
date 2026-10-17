import { colorOrThrow, declarations, parseColor } from './colors.ts';

/**
 * The SVG-edit model's document, paths, texts and elements (SVG inner editor, Task 1). Browser APIs only (`DOMParser`,
 * `XMLSerializer`): the web runs it as it is, the tests under jsdom.
 *
 * - **The document** is an XML document parsed with `DOMParser` (`image/svg+xml`): never inserted into a page, so nothing
 *   in it runs or loads.
 * - **Paths** are child-element indexes from the root `<svg>`, joined by `/` ("0/2/1"); the root is "". The same path
 *   names the same element in a clone of the root (the stage's shadow-root copy), so a click maps back with `pathOf`.
 * - **Elements** are the drawn ones ({@link LISTED}), in document order, inside groups (`g`, nested `svg`) only: what is
 *   in `<defs>`, `<symbol>`, masks, patterns and the like is not drawn on its own, and a `<text>`'s tspans belong to it.
 * - **Labels:** the element's `id`, else the text of its own `<title>`, else `<tag> <index>` ("path 5", `named: false`),
 *   where `index` counts the listed elements of that tag from 1. The web shows a named label as it is and translates the
 *   unnamed ones from `tag` and `index` ("Tracciato 5").
 */

export type SvgDoc = XMLDocument;

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The elements the list shows. */
const LISTED = new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'use']);
/** The elements whose children are drawn as they are (and so listed). */
const GROUPS = new Set(['g', 'svg']);
/** The children of a `<text>` that hold its lines. */
const LINE_ELEMENTS = new Set(['tspan', 'textPath']);

const isSvg = (el: Element, local?: string) => el.namespaceURI === SVG_NS && (local === undefined || el.localName === local);

/** The SVG text as a document, or why not: `parse` (not well-formed XML), `not-svg` (the root is not an SVG `<svg>`). */
export function parseSvg(text: string): { ok: true; doc: SvgDoc } | { ok: false; reason: 'parse' | 'not-svg' } {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  } catch {
    return { ok: false, reason: 'parse' };
  }
  // A parse error is a `<parsererror>` element: the root (Firefox, jsdom) or inside it (Chromium, WebKit).
  if (doc.getElementsByTagName('parsererror').length > 0) return { ok: false, reason: 'parse' };
  const root = doc.documentElement;
  if (!root || !isSvg(root, 'svg')) return { ok: false, reason: 'not-svg' };
  return { ok: true, doc: doc as SvgDoc };
}

/** The document as SVG text. */
export function serializeSvg(doc: SvgDoc): string {
  return new XMLSerializer().serializeToString(doc);
}

/** The element at `path` (see the module comment), or null. */
export function elementAt(doc: SvgDoc, path: string): Element | null {
  let el: Element | null = doc.documentElement;
  if (path === '') return el;
  for (const part of path.split('/')) {
    if (!/^\d{1,6}$/.test(part) || !el) return null;
    el = el.children[Number(part)] ?? null;
  }
  return el;
}

/** The path of `el` under `root` (the root itself is ""), or null when `el` is not inside `root`. */
export function pathOf(root: Element, el: Element): string | null {
  const parts: number[] = [];
  for (let cur: Element = el; cur !== root;) {
    const parent: Element | null = cur.parentElement;
    if (!parent) return null;
    parts.push(Array.prototype.indexOf.call(parent.children, cur));
    cur = parent;
  }
  return parts.reverse().join('/');
}

const elementOrThrow = (doc: SvgDoc, path: string): Element => {
  const el = elementAt(doc, path);
  if (!el) throw new Error(`no element at ${path.slice(0, 40)}`);
  return el;
};

// ---------- texts ----------

export interface SvgText { path: string; text: string }

/** The line elements of a `<text>` (its direct tspans and textPaths). */
const linesOf = (el: Element) => Array.from(el.children).filter((c) => isSvg(c) && LINE_ELEMENTS.has(c.localName));

/** The text nodes directly in `el` (not those of its child elements: a `<title>`, a `<desc>`, a tspan). */
const directTexts = (el: Element): Text[] => Array.from(el.childNodes).filter((n): n is Text => n.nodeType === 3 || n.nodeType === 4) as Text[];
/** A direct text as the SVG draws it by default: no line breaks, tabs as spaces, runs of spaces as one. */
const drawn = (t: string) => t.replace(/[\r\n]+/g, '').replace(/\t/g, ' ').replace(/ {2,}/g, ' ');

/**
 * The lines of a `<text>`. With tspans: one per direct tspan, and the text written directly in the `<text>` (outside its
 * tspans) belongs to the first line, in document order. Without: its direct text, never that of a `<title>` or another child.
 */
function linesOfText(el: Element): string[] {
  const spans = linesOf(el);
  if (spans.length === 0) return [directTexts(el).map((n) => n.data).join('')];
  let first = '';
  for (const n of Array.from(el.childNodes)) {
    if (n === spans[0]) first += spans[0]!.textContent ?? '';
    else if ((n.nodeType === 3 || n.nodeType === 4) && (n as Text).data.trim() !== '') first += drawn((n as Text).data);
  }
  return [first.trimStart(), ...spans.slice(1).map((l) => l.textContent ?? '')];
}

/** Every `<text>` of the document with its content: its lines (see `linesOfText`) joined by "\n". */
export function listTexts(doc: SvgDoc): SvgText[] {
  const root = doc.documentElement;
  return Array.from(doc.getElementsByTagNameNS(SVG_NS, 'text')).map((el) => ({ path: pathOf(root, el)!, text: linesOfText(el).join('\n') }));
}

/**
 * Sets the content of the `<text>` at `path`; only the content changes (fonts, sizes and positions stay, and so do child
 * elements such as a `<title>`). With tspans, line i goes in tspan i, the lines beyond the last tspan go in it (joined by
 * spaces), tspans with no line are emptied, and the text written directly in the `<text>` (part of the first line) is
 * emptied, its whitespace kept. Without tspans, the text goes in its first direct text node (one is added after the child
 * elements when there is none) and the other direct text nodes are emptied.
 */
export function setText(doc: SvgDoc, path: string, text: string): void {
  const el = elementOrThrow(doc, path);
  if (!isSvg(el, 'text')) throw new Error(`not a <text> at ${path.slice(0, 40)}`);
  const lines = text.split('\n');
  const spans = linesOf(el);
  const direct = directTexts(el);
  if (spans.length === 0) {
    const target = direct.find((n) => n.data.trim() !== '') ?? direct[0] ?? el.appendChild(doc.createTextNode(''));
    for (const n of direct) if (n !== target) n.data = '';
    target.data = lines.join(' ');
    return;
  }
  for (const n of direct) if (n.data.trim() !== '') n.data = '';
  spans.forEach((span, i) => {
    span.textContent = i < spans.length - 1 ? lines[i] ?? '' : lines.slice(i).join(' ');
  });
}

// ---------- elements ----------

export interface SvgElement {
  path: string; tag: string; label: string;
  /** Whether `label` comes from the element (`id` or `<title>`); false: it is `<tag> <index>`, for the web to translate. */
  named: boolean;
  /** The element's place among the listed elements of its tag, from 1. */
  index: number;
  depth: number;
  /** Its own paint (`style` over the attribute): a colour as `#rrggbb`/`#rrggbbaa`, else the value as written (`none`, `url(#g)`). */
  fill?: string; stroke?: string;
  /** `display="none"` on the element. */
  hidden: boolean;
}

/** The value range of the last `prop` declaration in a `style` text, or null. */
function styleDecl(style: string, prop: string): { start: number; end: number } | null {
  // Comments blanked so a declaration inside one is never taken; positions are unchanged.
  const css = style.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (c) => ' '.repeat(c.length));
  const d = declarations(css).filter((x) => x.prop === prop).at(-1);
  return d ? { start: d.start, end: d.end } : null;
}

/** The element's own paint `prop` (see `SvgElement.fill`), or undefined. */
function paintOf(el: Element, prop: 'fill' | 'stroke'): string | undefined {
  const style = el.getAttribute('style');
  const d = style !== null ? styleDecl(style, prop) : null;
  const raw = d ? style!.slice(d.start, d.end).replace(/!\s*important\s*$/i, '') : el.getAttribute(prop);
  if (raw === null) return undefined;
  const v = raw.trim();
  return parseColor(v) ?? v;
}

/** The drawn elements of the document (see the module comment). */
export function listElements(doc: SvgDoc): SvgElement[] {
  const root = doc.documentElement;
  const out: SvgElement[] = [];
  const counters = new Map<string, number>();
  const walk = (parent: Element, depth: number) => {
    for (const el of Array.from(parent.children)) {
      if (!isSvg(el)) continue;
      const tag = el.localName;
      if (LISTED.has(tag)) {
        const index = (counters.get(tag) ?? 0) + 1;
        counters.set(tag, index);
        const id = el.getAttribute('id')?.trim();
        const title = Array.from(el.children).find((c) => isSvg(c, 'title'))?.textContent?.trim();
        const name = id || title || '';
        const fill = paintOf(el, 'fill');
        const stroke = paintOf(el, 'stroke');
        out.push({
          path: pathOf(root, el)!, tag, label: name || `${tag} ${index}`, named: name !== '', index, depth,
          ...(fill !== undefined ? { fill } : {}), ...(stroke !== undefined ? { stroke } : {}),
          hidden: el.getAttribute('display')?.trim() === 'none',
        });
      }
      if (GROUPS.has(tag)) walk(el, LISTED.has(tag) ? depth + 1 : depth);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Sets the element's own fill and/or stroke to a colour (written as hex) or `none`: in its `style` when the property is
 * there (only the value changes, `!important` kept), else as the attribute. Anything else throws.
 */
export function setElementPaint(doc: SvgDoc, path: string, paint: { fill?: string; stroke?: string }): void {
  const el = elementOrThrow(doc, path);
  for (const prop of ['fill', 'stroke'] as const) {
    const value = paint[prop];
    if (value === undefined) continue;
    const v = value.trim().toLowerCase() === 'none' ? 'none' : colorOrThrow(value);
    const style = el.getAttribute('style');
    const d = style !== null ? styleDecl(style, prop) : null;
    if (style === null || !d) { el.setAttribute(prop, v); continue; }
    const raw = style.slice(d.start, d.end);
    const lead = /^\s*/.exec(raw)![0];
    const tail = /\s*(?:!\s*important\s*)?$/i.exec(raw)![0];
    el.setAttribute('style', style.slice(0, d.start) + lead + v + tail + style.slice(d.end));
  }
}

/** Hides (`display="none"`) or shows (the attribute removed) the element at `path`. */
export function setHidden(doc: SvgDoc, path: string, hidden: boolean): void {
  const el = elementOrThrow(doc, path);
  if (hidden) el.setAttribute('display', 'none');
  else el.removeAttribute('display');
}

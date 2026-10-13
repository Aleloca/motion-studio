// A small CSS tokenizer for brand analysis (inspect_site_fonts): comments, strings, url(), at-rules and blocks, in one
// linear pass over untrusted text. It never runs a regex over the whole file and every collection it fills is capped,
// so a hostile stylesheet costs at most its (already capped) size in time and a bounded amount of memory.

export type FontRole = 'heading' | 'body' | 'button' | 'other';
export interface Usage { roles: Set<FontRole>; weights: Set<number>; italic: boolean; count: number; family: string }
export interface FontFaceFile { url: string; format: string | null }
export interface FontFace { family: string; weights: number[]; italic: boolean; files: FontFaceFile[]; embedded: boolean }
/** A `font-family: var(--x)` use, resolved once every stylesheet is read (the variable may live in another sheet). */
export interface VarUse { name: string; roles: FontRole[]; weights: number[]; italic: boolean }
/** Shared by every stylesheet of one inspection: the @font-face count is a global limit. */
export interface ScanBudget { maxFaces: number; faces: number; facesTruncated: boolean }
export interface CssScan {
  families: Map<string, Usage>; faces: FontFace[]; imports: URL[]; googleLinks: URL[];
  variables: Map<string, string>; varUses: VarUse[];
  /** url() values left out: neither http(s) nor data: (file:, javascript:, …) or unparsable. */
  rejected: number;
}

export const newScanBudget = (maxFaces = 2000): ScanBudget => ({ maxFaces, faces: 0, facesTruncated: false });

const MAX_FAMILIES = 300;
const MAX_VARIABLES = 500;
const MAX_VAR_USES = 500;
const MAX_IMPORTS = 30;
const MAX_FILES_PER_FACE = 8;
const MAX_URL = 2000;
const MAX_FAMILY = 100;
const MAX_VALUE = 1000;
/** Deeper blocks are only counted (not stacked): a file of `{{{{…` costs a counter, not memory. */
const MAX_DEPTH = 64;

/** Generic families, CSS-wide keywords and platform aliases: never a brand font. */
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong', '-apple-system', 'blinkmacsystemfont', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default']);
/** At-rules whose block holds rules (scanned); any other block at-rule (keyframes, page, …) is skipped. */
const GROUPING = new Set(['media', 'supports', 'layer', 'container', 'document', '-moz-document', 'scope', 'starting-style']);

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

/** Index just past the string that starts at `i` (quote char at i); an unterminated string ends at the newline or EOF. */
function skipString(s: string, i: number): number {
  const q = s.charCodeAt(i);
  let j = i + 1;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; } // backslash escape
    if (c === q) return j + 1;
    if (c === 10) return j;
    j++;
  }
  return s.length;
}

/** Splits `value` on top-level commas (outside strings and parentheses). Linear. */
export function splitTopLevel(value: string, limit = Infinity): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 34 || c === 39) { i = skipString(value, i) - 1; continue; }
    if (c === 40) depth++;
    else if (c === 41) depth = Math.max(0, depth - 1);
    else if (c === 44 && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
      if (out.length >= limit) return out;
    }
  }
  out.push(value.slice(start));
  return out;
}

/** `"Open Sans"` → `Open Sans`; CSS escapes of quotes kept simple; whitespace collapsed. */
function unquote(raw: string): string {
  let v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
  else if (v[0] === '"' || v[0] === "'") v = v.slice(1);
  return v.replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim();
}

/** A usable family name: printable, not generic, not a var() or a keyword. */
export function cleanFamily(raw: string): string | null {
  const v = unquote(raw);
  if (!v || v.length > MAX_FAMILY || /[\u0000-\u001f\u007f{}();<>]/.test(v) || v.startsWith('var(') || v.startsWith('--')) return null;
  if (GENERIC.has(v.toLowerCase())) return null;
  return v;
}

/** The families of a `font-family` value: `{ first, vars }`, `first` being the first non-generic name. */
function familyStack(value: string): { first: string | null; vars: string[] } {
  const vars: string[] = [];
  let first: string | null = null;
  // Only the head of the stack matters: the brand font comes first, fallbacks follow.
  for (const part of splitTopLevel(value, 16)) {
    const p = part.trim();
    const v = /^var\(\s*(--[A-Za-z0-9_-]{1,100})/.exec(p);
    if (v) { vars.push(v[1]!); continue; }
    if (first === null) first = cleanFamily(p);
  }
  return { first, vars };
}

const SIZE_KEYWORDS = new Set(['xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large', 'smaller', 'larger']);
const SIZE_FUNCTIONS = new Set(['calc', 'clamp', 'min', 'max', 'var']);
/** One way only to split digits (no `\.?` between two digit runs): a run of digits that ends without a unit fails in linear time. */
const LENGTH = /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:px|pt|em|rem|%|vw|vh|ex|ch|pc|cm|mm|in|q|vmin|vmax)$/i;
/** No real font size is longer: anything longer is not tested at all. */
const MAX_SIZE_TOKEN = 32;

/** End of the top-level token starting at `i` (whitespace ends it outside parentheses and strings); -1 if a parenthesis never closes. */
function tokenEnd(v: string, i: number): number {
  let depth = 0;
  for (let j = i; j < v.length; j++) {
    const c = v.charCodeAt(j);
    if (c === 34 || c === 39) { j = skipString(v, j) - 1; continue; }
    if (c === 40) depth++;
    else if (c === 41) { if (depth > 0) depth--; }
    else if (depth === 0 && (isSpace(c) || c === 47)) return j; // '/' ends a size token too (16px/1.5)
  }
  return depth === 0 ? v.length : -1;
}

/** A font-size token: a length or percentage, a size keyword, or a balanced calc()/clamp()/min()/max()/var(). */
function isSize(tok: string): boolean {
  if (tok.length <= MAX_SIZE_TOKEN && (LENGTH.test(tok) || SIZE_KEYWORDS.has(tok.toLowerCase()))) return true;
  const open = tok.indexOf('(');
  return open > 0 && tok.endsWith(')') && SIZE_FUNCTIONS.has(tok.slice(0, open).toLowerCase());
}

/**
 * The family part of a `font` shorthand: everything after the size (and an optional `/ line-height`). A single walk over
 * top-level tokens (no regex over the value): an unbalanced function ends the walk with no family.
 */
function shorthandFamily(value: string): string | null {
  const v = value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) : value;
  let i = 0;
  const skipWs = () => { while (i < v.length && isSpace(v.charCodeAt(i))) i++; };
  for (let n = 0; n < 6; n++) { // style, variant, weight, stretch, then the size at the latest
    skipWs();
    if (i >= v.length) return null;
    const end = tokenEnd(v, i);
    if (end < 0) return null;
    if (end === i) return null; // a stray '/'
    const tok = v.slice(i, end);
    i = end;
    if (!isSize(tok)) continue;
    skipWs();
    if (v.charCodeAt(i) === 47) { // '/' line-height
      i++;
      skipWs();
      const lh = tokenEnd(v, i);
      if (lh < 0) return null;
      i = lh;
    }
    skipWs();
    const rest = v.slice(i);
    // `font: var(--brand-font)`: the whole shorthand in one variable, resolved later like a font-family stack.
    if (!rest && /^var\(/i.test(tok)) return tok;
    return rest || null;
  }
  return null;
}

/** CSS font-weight value → numbers (a variable range gives both ends). */
export function parseWeights(value: string): number[] {
  if (value.length === 3) { const n = Number(value); if (Number.isInteger(n) && n >= 1 && n <= 1000) return [n]; }
  const out: number[] = [];
  for (const tok of value.trim().toLowerCase().split(/\s+/).slice(0, 2)) {
    const n = tok === 'normal' ? 400 : tok === 'bold' ? 700 : Number(tok);
    if (Number.isFinite(n) && n >= 1 && n <= 1000) out.push(Math.round(n));
  }
  return out;
}

/** The roles of a selector list: only the subject (last compound) of each selector counts. */
export function selectorRoles(selector: string): FontRole[] {
  const roles = new Set<FontRole>();
  for (const sel of splitTopLevel(selector.length > MAX_VALUE ? selector.slice(0, MAX_VALUE) : selector, 64)) {
    const parts = sel.trim().split(/[\s>+~]+/);
    const subject = parts[parts.length - 1] ?? '';
    const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(subject)?.[0].toLowerCase() ?? '';
    const classes = new Set([...subject.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]!.toLowerCase()));
    if (tag === 'body' || tag === 'p' || tag === 'html') roles.add('body');
    else if (tag === 'h1' || tag === 'h2' || tag === 'h3') roles.add('heading');
    else if (tag === 'button' || classes.has('btn')) roles.add('button');
    else roles.add('other');
  }
  return [...roles];
}

/** Parses `url(...)` or a string at the start of `value`; returns the raw address or null. */
function leadingUrl(value: string): string | null {
  const v = value.trim();
  const m = /^url\(\s*/i.exec(v);
  if (m) {
    const rest = v.slice(m[0].length);
    if (rest[0] === '"' || rest[0] === "'") return unquoteUrl(rest.slice(0, skipString(rest, 0)));
    const end = rest.indexOf(')');
    return (end < 0 ? rest : rest.slice(0, end)).trim();
  }
  if (v[0] === '"' || v[0] === "'") return unquoteUrl(v.slice(0, skipString(v, 0)));
  return null;
}
const unquoteUrl = (s: string) => {
  const q = s[0];
  const inner = s.length >= 2 && s[s.length - 1] === q ? s.slice(1, -1) : s.slice(1);
  return inner.replace(/\\(.)/g, '$1').trim();
};

/** Resolves a CSS address: http(s) URL, the data: marker, or null (other schemes or unparsable). */
export function resolveCssUrl(raw: string, base: URL): URL | 'data' | null {
  if (raw.length > MAX_URL) return /^\s*data:/i.test(raw) ? 'data' : null;
  if (/^\s*data:/i.test(raw)) return 'data';
  let u: URL;
  try { u = new URL(raw, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.href.length > MAX_URL) return null;
  return u;
}

type Frame = 'list' | 'decl' | 'face' | 'skip';
interface Ctx { frame: Frame; roles: FontRole[] | null; face: FaceDraft | null }
interface FaceDraft { family: string | null; weights: number[]; italic: boolean; src: string }

/**
 * Scans one stylesheet. `baseUrl` resolves relative addresses (the stylesheet's own URL). Linear in `css.length`;
 * `budget` caps the @font-face rules across sheets.
 */
export function scanCss(css: string, baseUrl: URL, budget: ScanBudget): CssScan {
  const out: CssScan = { families: new Map(), faces: [], imports: [], googleLinks: [], variables: new Map(), varUses: [], rejected: 0 };
  const stack: Ctx[] = [{ frame: 'list', roles: null, face: null }];
  const roleCache = new Map<string, FontRole[]>();
  const stackCache = new Map<string, ReturnType<typeof familyStack>>();
  let extraDepth = 0; // blocks below MAX_DEPTH (or inside skipped blocks), only counted
  const pieces: string[] = [];
  let start = 0;
  let paren = 0;
  const n = css.length;
  const chunk = (end: number) => {
    if (pieces.length === 0) return start === end ? '' : css.slice(start, end);
    pieces.push(css.slice(start, end));
    const c = pieces.join('');
    pieces.length = 0;
    return c;
  };

  const lower = new Map<string, string>();
  const useFamily = (family: string, roles: FontRole[], weights: number[], italic: boolean) => {
    let key = lower.get(family);
    if (key === undefined) { key = family.toLowerCase(); if (lower.size < MAX_FAMILIES * 2) lower.set(family, key); }
    let u = out.families.get(key);
    if (!u) {
      if (out.families.size >= MAX_FAMILIES) return;
      u = { family, roles: new Set(), weights: new Set(), italic: false, count: 0 };
      out.families.set(key, u);
    }
    u.count++;
    for (const r of roles) u.roles.add(r);
    for (const w of weights) u.weights.add(w);
    if (italic) u.italic = true;
  };

  /** One declaration of a style rule: font-family / font (and the weight / style of the same rule). */
  const declaration = (text: string, ctx: Ctx, rule: { family: string | null; vars: string[]; weights: number[]; italic: boolean }) => {
    const colon = text.indexOf(':');
    if (colon < 0) return;
    const prop = text.slice(0, colon).trim().toLowerCase();
    let value = text.slice(colon + 1).trim();
    const bang = value.lastIndexOf('!');
    if (bang >= 0 && /^!\s*important$/i.test(value.slice(bang))) value = value.slice(0, bang).trim();
    if (prop.startsWith('--')) {
      if (/font/i.test(prop) && value.length <= MAX_VALUE && out.variables.size < MAX_VARIABLES) out.variables.set(prop, value);
      return;
    }
    if (ctx.face) {
      const f = ctx.face;
      if (prop === 'font-family') f.family = cleanFamily(value);
      else if (prop === 'font-weight') f.weights = parseWeights(value);
      else if (prop === 'font-style') f.italic = /^(italic|oblique)/i.test(value);
      else if (prop === 'src') f.src = value;
      return;
    }
    if (prop === 'font-family' || prop === 'font') {
      const stackText = prop === 'font' ? shorthandFamily(value) : value;
      if (stackText === null) return;
      let s = stackCache.get(stackText);
      if (!s) { s = familyStack(stackText); if (stackCache.size < 2000 && stackText.length <= MAX_VALUE) stackCache.set(stackText, s); }
      if (s.first) rule.family = s.first;
      if (rule.vars.length < 4) rule.vars.push(...s.vars.slice(0, 4));
      if (prop === 'font') {
        const w = /(?:^|\s)(bold|[1-9]00)(?=\s)/i.exec(value);
        if (w && rule.weights.length < 8) rule.weights.push(...parseWeights(w[1]!));
        if (/(?:^|\s)italic(?=\s)/i.test(value)) rule.italic = true;
      }
    } else if (prop === 'font-weight') { if (rule.weights.length < 8) rule.weights.push(...parseWeights(value)); }
    else if (prop === 'font-style') { if (/^(italic|oblique)/i.test(value)) rule.italic = true; }
  };

  // Pending declarations of the innermost style rule, flushed when the rule closes.
  const rules: Array<{ family: string | null; vars: string[]; weights: number[]; italic: boolean }> = [];
  const flushRule = (ctx: Ctx) => {
    const r = rules.pop();
    if (!r || !ctx.roles) return;
    if (r.family) useFamily(r.family, ctx.roles, r.weights, r.italic);
    for (const name of r.vars.slice(0, 4)) if (out.varUses.length < MAX_VAR_USES) out.varUses.push({ name, roles: ctx.roles, weights: r.weights, italic: r.italic });
  };

  const finishFace = (f: FaceDraft) => {
    if (!f.family) return;
    if (budget.faces >= budget.maxFaces) { budget.facesTruncated = true; return; }
    budget.faces++;
    const files: FontFaceFile[] = [];
    let embedded = false;
    for (const item of splitTopLevel(f.src, 16)) {
      const raw = leadingUrl(item);
      if (raw === null) continue; // local(...)
      const u = resolveCssUrl(raw, baseUrl);
      if (u === 'data') { embedded = true; continue; }
      if (u === null) { out.rejected++; continue; }
      const fmt = /format\(\s*["']?([A-Za-z0-9-]{1,20})/i.exec(item)?.[1]?.toLowerCase() ?? null;
      if (files.length < MAX_FILES_PER_FACE) files.push({ url: u.href, format: fmt });
    }
    out.faces.push({ family: f.family, weights: f.weights, italic: f.italic, files, embedded });
  };

  const atStatement = (text: string) => {
    const m = /^@import\s+/i.exec(text);
    if (!m) return;
    const raw = leadingUrl(text.slice(m[0].length));
    if (raw === null) return;
    const u = resolveCssUrl(raw, baseUrl);
    if (u === null || u === 'data') { out.rejected++; return; }
    if (u.hostname === 'fonts.googleapis.com') { if (out.googleLinks.length < MAX_IMPORTS) out.googleLinks.push(u); }
    else if (out.imports.length < MAX_IMPORTS) out.imports.push(u);
  };

  const open = (prelude: string) => {
    const top = stack[stack.length - 1]!;
    if (extraDepth > 0 || top.frame === 'skip' || top.frame === 'face' || stack.length >= MAX_DEPTH) { extraDepth++; return; }
    const p = prelude.trim();
    if (p[0] === '@') {
      const name = /^@([A-Za-z-]+)/.exec(p)?.[1]?.toLowerCase() ?? '';
      if (name === 'font-face') { stack.push({ frame: 'face', roles: null, face: { family: null, weights: [], italic: false, src: '' } }); return; }
      stack.push({ frame: GROUPING.has(name) ? 'list' : 'skip', roles: top.roles, face: null });
      return;
    }
    // A style rule (or a nested one inside a rule): its own selector gives the roles.
    let r = roleCache.get(p);
    if (!r) { r = selectorRoles(p); if (roleCache.size < 2000) roleCache.set(p, r); }
    stack.push({ frame: 'decl', roles: r, face: null });
    rules.push({ family: null, vars: [], weights: [], italic: false });
  };

  const close = () => {
    if (extraDepth > 0) { extraDepth--; return; }
    if (stack.length <= 1) return; // stray '}'
    const ctx = stack.pop()!;
    if (ctx.frame === 'face' && ctx.face) finishFace(ctx.face);
    else if (ctx.frame === 'decl') flushRule(ctx);
  };

  const statement = (text: string) => {
    if (text === '') return;
    const t = text.trim();
    if (!t) return;
    const top = stack[stack.length - 1]!;
    if (extraDepth > 0 || top.frame === 'skip') return;
    if (top.frame === 'list') { if (t[0] === '@') atStatement(t); return; }
    if (top.frame === 'face') { declaration(t, top, { family: null, vars: [], weights: [], italic: false }); return; }
    const rule = rules[rules.length - 1];
    if (rule) declaration(t, top, rule);
  };

  let i = 0;
  while (i < n) {
    const c = css.charCodeAt(i);
    if (c === 47 && css.charCodeAt(i + 1) === 42) { // /* comment */
      pieces.push(css.slice(start, i));
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      start = i;
      continue;
    }
    if (c === 34 || c === 39) { i = skipString(css, i); continue; }
    if ((c === 117 || c === 85) && paren === 0 && /^url\(/i.test(css.slice(i, i + 4))) {
      // url( unquoted: everything up to ')' is the address (a data: URI may contain ';').
      let j = i + 4;
      while (j < n && isSpace(css.charCodeAt(j))) j++;
      if (j < n && css.charCodeAt(j) !== 34 && css.charCodeAt(j) !== 39) {
        const end = css.indexOf(')', j);
        i = end < 0 ? n : end + 1;
        continue;
      }
      paren++;
      i = j;
      continue;
    }
    if (c === 40) { paren++; i++; continue; }
    if (c === 41) { if (paren > 0) paren--; i++; continue; }
    if (c === 59 && paren === 0) { statement(chunk(i)); i++; start = i; continue; } // ;
    if (c === 123) { open(chunk(i)); paren = 0; i++; start = i; continue; } // {
    if (c === 125) { statement(chunk(i)); close(); paren = 0; i++; start = i; continue; } // }
    i++;
  }
  // Unterminated input: the last statement and every open block still count.
  statement(chunk(n));
  while (stack.length > 1 || extraDepth > 0) close();
  return out;
}

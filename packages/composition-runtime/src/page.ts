/**
 * Server-side helpers for the core (Task 3) and the tests: no DOM, no Node APIs. See README "Contracts".
 *
 * - `renderRuntimePage` turns `dist/index.html` into the page of one composition by replacing the placeholder with an
 *   inert JSON data block (`<script type="application/json">`, never executed, so no CSP exception is needed). The
 *   runtime reads it at start: no fetch, no network API.
 * - `injectLayerBootstrap` puts `<script src=".../runtime/layer.js">` first in a layer's HTML, before any layer script,
 *   so the layer gets the virtual clock, `msParams` and the seek bridge before its own code runs.
 */

/** The comment in `dist/index.html` that `renderRuntimePage` replaces. */
export const COMPOSITION_PLACEHOLDER = '<!--ms-composition-->';
/** Id of the data block. */
export const COMPOSITION_DATA_ID = 'ms-composition';
/** Attribute that marks the injected bootstrap script. */
export const LAYER_BOOTSTRAP_ATTR = 'data-ms-layer-bootstrap';
/** The files of `dist/` the core serves under `/<token>/runtime/`. */
export const RUNTIME_FILES = ['index.html', 'runtime.js', 'layer.js', 'clock.js'] as const;

export interface CompositionData {
  /**
   * The composition folder, relative to the page URL (`/<token>/runtime/index.html`), ending in `/`:
   * `../<versionDir>/compositions/<format>/`. Asset paths of the composition resolve against it.
   */
  base: string;
  /** The composition, normalised (`normalizeComposition`) and validated by the core. */
  composition: unknown;
}

/** Whether `base` is a relative folder path: no scheme, no host, no backslash, no query or fragment, ends in `/`. */
export function isRelativeBase(base: string): boolean {
  if (typeof base !== 'string' || base.length === 0 || base.length > 2048 || !base.endsWith('/')) return false;
  if (base.startsWith('/') || base.includes('\\') || base.includes(':') || base.includes('?') || base.includes('#')) return false;
  for (let i = 0; i < base.length; i++) { const c = base.charCodeAt(i); if (c < 0x21 || c === 0x7f) return false; }
  return true;
}

/** JSON that is safe inside a `<script>` element: `<`, `>`, `&`, U+2028 and U+2029 are escaped. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** `dist/index.html` with the composition inlined. Throws when the placeholder is missing or `base` is not a relative folder. */
export function renderRuntimePage(indexHtml: string, data: CompositionData): string {
  if (!isRelativeBase(data.base)) throw new Error('renderRuntimePage: base must be a relative folder path ending in "/"');
  const at = indexHtml.indexOf(COMPOSITION_PLACEHOLDER);
  if (at < 0) throw new Error('renderRuntimePage: placeholder not found');
  const block = `<script type="application/json" id="${COMPOSITION_DATA_ID}">${scriptSafeJson({ base: data.base, composition: data.composition })}</script>`;
  return indexHtml.slice(0, at) + block + indexHtml.slice(at + COMPOSITION_PLACEHOLDER.length);
}

/** Parses the text of the data block; null when it is not `{ base: string, composition: object }`. */
export function readCompositionData(text: string): CompositionData | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.base !== 'string' || typeof o.composition !== 'object' || o.composition === null) return null;
  return { base: o.base, composition: o.composition };
}

/**
 * Inserts the layer bootstrap script into a layer's HTML: right after the doctype when the document starts with one
 * (after an optional BOM, whitespace and comments), otherwise at the very start. Either way it precedes every script
 * of the layer, and a doctype stays first (no quirks mode). One linear scan, no regex.
 * `src` must be a root-relative path (`/<token>/runtime/layer.js`) with no quote, angle bracket or whitespace.
 */
export function injectLayerBootstrap(html: string, src: string): string {
  if (!/^\/[A-Za-z0-9._~/-]+$/.test(src) || src.startsWith('//')) throw new Error('injectLayerBootstrap: src must be a plain root-relative path');
  const tag = `<script src="${src}" ${LAYER_BOOTSTRAP_ATTR}></script>`;
  const at = doctypeEnd(html);
  return at < 0 ? tag + html : html.slice(0, at) + tag + html.slice(at);
}

/** Index just after a leading doctype, or -1. Skips a BOM, whitespace and complete comments. */
function doctypeEnd(html: string): number {
  let i = 0;
  if (html.charCodeAt(0) === 0xfeff) i = 1;
  for (;;) {
    while (i < html.length && /\s/.test(html[i]!)) i++;
    if (html.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i + 4);
      if (close < 0) return -1;
      i = close + 3;
      continue;
    }
    break;
  }
  if (html.slice(i, i + 9).toLowerCase() !== '<!doctype') return -1;
  const end = html.indexOf('>', i);
  return end < 0 ? -1 : end + 1;
}

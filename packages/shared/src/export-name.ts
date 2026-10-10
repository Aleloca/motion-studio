// Export file names (spec §3.3): a workspace pattern such as `{title}-{format}-v{v}` rendered for each exported file. Shared
// by the core (the names written to disk) and the web (the live preview), so the names on screen are the ones on disk.
// Every regex here is linear-time: single character classes, no nested or overlapping quantifiers.
import type { FormatPreset } from './formats.ts';

export const EXPORT_NAME_TOKENS = ['title', 'channel', 'format', 'ratio', 'v', 'date'] as const;
export type ExportNameToken = (typeof EXPORT_NAME_TOKENS)[number];
export type ExportNameVars = Record<ExportNameToken, string | number>;
export const DEFAULT_EXPORT_NAME_PATTERN = '{title}-{format}-v{v}';
/** The longest name, extension excluded. */
export const EXPORT_NAME_MAX = 120;

export type RenderedName =
  | { ok: true; name: string; unknown: string[] }
  | { ok: false; error: 'empty'; unknown: string[] };

const isSep = (c: string) => c === '-' || c === '_' || c === '.';
const isSafe = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || isSep(c);

/** A token value as a slug: accents dropped, lowercase, runs of other characters as one `-`, no `-` at the ends. */
export function slugToken(value: string): string {
  return trimSeps(value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'));
}

/** Drops separators (`-`, `_`, `.`) at both ends (a loop: no backtracking). */
function trimSeps(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isSep(s[a]!)) a++;
  while (b > a && isSep(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/** The first `max` UTF-16 units of `s`, one less when the cut would split a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * Renders `pattern` (spec §3.3):
 * - `{name}` with a known token is replaced by its value as a slug (`slugToken`); an unknown `{name}` (letters only, case
 *   sensitive) is left out and listed in `unknown`, for the preview to flag; any other brace is a literal;
 * - literals keep `[A-Za-z0-9._-]`, every other character becomes `-`;
 * - runs of separators collapse to their first one, separators at the ends are dropped (so never a leading dot);
 * - the result is cut to EXPORT_NAME_MAX characters (extension excluded) and trimmed again;
 * - an empty result is `{ ok: false, error: 'empty' }`.
 */
export function renderName(pattern: string, vars: ExportNameVars): RenderedName {
  const unknown: string[] = [];
  let raw = '';
  let close = -1; // the first `}` at or after i (cached: each `{` must not rescan, keeping this linear)
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '{') {
      if (close !== -2 && close < i) close = pattern.indexOf('}', i);
      if (close === -1) close = -2; // no `}` left: the rest is literal
      if (close >= 0) {
        const name = pattern.slice(i + 1, close);
        if (/^[A-Za-z]+$/.test(name)) {
          if ((EXPORT_NAME_TOKENS as readonly string[]).includes(name)) raw += slugToken(String(vars[name as ExportNameToken]));
          else if (!unknown.includes(name)) unknown.push(name);
          i = close;
          continue;
        }
      }
    }
    raw += isSafe(c) ? c : '-';
  }
  const collapsed = raw.replace(/[-_.]{2,}/g, (run) => run[0]!);
  const name = trimSeps(cut(trimSeps(collapsed), EXPORT_NAME_MAX));
  return name ? { ok: true, name, unknown } : { ok: false, error: 'empty', unknown };
}

/** Names that occur more than once, compared case-insensitively (macOS and Windows file systems), lowercased. */
export function exportNameCollisions(names: string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k)) twice.add(k); else seen.add(k);
  }
  return [...twice];
}

/** `YYYY-MM-DD` of `d` in local time. */
export function exportDate(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** The exported file's extension: the output's own, lowercased, characters other than `[a-z0-9]` as `_`; none for `.name`. */
export function exportExtension(file: string): string {
  const dot = file.lastIndexOf('.');
  const raw = dot > 0 ? file.slice(dot + 1).toLowerCase() : '';
  return raw ? `.${raw.replace(/[^a-z0-9]/g, '_')}` : '';
}

/** `9x16` for 1080×1920: the size reduced by its greatest common divisor; empty for a size that is not positive. */
export function ratioToken(width: number, height: number): string {
  if (!(width > 0 && height > 0) || !Number.isInteger(width) || !Number.isInteger(height)) return '';
  let a = width;
  let b = height;
  while (b) [a, b] = [b, a % b];
  return `${width / a}x${height / a}`;
}

/** The creative title as a token: its slug cut to 40 characters (the phase 7 rule); null without letters or digits. */
function titleBase(title: string | undefined): string | null {
  const s = slugToken(title ?? '').slice(0, 40);
  const t = trimSeps(s);
  return t || null;
}

/**
 * The variables of one exported file: the title (the creative slug when the title has no letters or digits), the preset's
 * channel and ratio (the output's size when the format is not in the catalog), the format id, the version and the date.
 */
export function exportNameVars(o: { title?: string; slug: string; format: string; preset: Pick<FormatPreset, 'channel' | 'width' | 'height'> | undefined;
  size?: { width: number; height: number }; version: number; date: Date }): ExportNameVars {
  const size = o.preset ?? o.size;
  return {
    title: titleBase(o.title) ?? slugToken(o.slug),
    channel: o.preset ? slugToken(o.preset.channel) : '',
    format: o.format,
    ratio: size ? ratioToken(size.width, size.height) : '',
    v: o.version,
    date: exportDate(o.date),
  };
}

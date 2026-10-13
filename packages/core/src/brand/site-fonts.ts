// inspect_site_fonts (brand analysis): reads a website's HTML and CSS within strict limits and reports the fonts it
// finds, with their source. The site is untrusted: every request goes through safeFetch (http(s) only, every resolved
// address checked on every redirect hop), bodies are read up to a cap, stylesheets are followed only on the page's own
// site and on known font CDNs, imports are depth-limited with cycle detection, and the whole inspection has a deadline.
// Whatever is refused or cut is reported as a warning; the fonts found so far are still returned.
import { messages, type Locale } from '@motion-studio/shared';
import { currentLocale } from '../i18n.ts';
import { BlockedUrlError, safeFetch, type SafeFetchDeps } from '../providers/safe-fetch.ts';
import { newScanBudget, scanCss, cleanFamily, splitTopLevel, type CssScan, type FontRole, type ScanBudget, type Usage } from './css-scan.ts';

export type SiteFontSource = 'google' | 'self-hosted' | 'adobe' | 'system';
export type SiteFont = {
  family: string; roles: FontRole[]; weights: number[]; italic: boolean; source: SiteFontSource;
  /** `url` is "embedded" for a font inlined as a data: URI (its bytes are never returned). */
  files: { url: string; format: string | null; weight: number | null }[];
};
export interface InspectDeps {
  fetch: SafeFetchDeps; signal: AbortSignal;
  /** Language of the warnings (the job's); default: the current one. */
  locale?: Locale;
  /** Tests only: the deadline of the whole inspection (default SITE_LIMITS.totalMs). */
  timeoutMs?: number;
}

const MB = 1024 * 1024;
export const SITE_LIMITS = { pageBytes: 2 * MB, sheetBytes: 2 * MB, maxSheets: 20, maxImportDepth: 3, maxFaces: 2000, totalMs: 30_000 } as const;
export const FONT_CDNS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'use.typekit.net', 'p.typekit.net', 'fonts.bunny.net', 'cdn.jsdelivr.net'] as const;
const ADOBE_HOSTS = new Set(['use.typekit.net', 'p.typekit.net']);
const MAX_FONTS = 40;
const MAX_FILES = 12;
/** Longer font addresses are left out of the answer (it goes back to the agent: kept small). */
const MAX_FILE_URL = 1000;
const MAX_WARNINGS = 20;
const MAX_LINKS = 100;
const MAX_STYLE_BLOCKS = 50;
const MAX_TAG = 4096;
export const EMBEDDED = 'embedded';

/** Second-level labels under which registrable names take three labels (co.uk, com.au, …): a small built-in list, no PSL. */
const MULTI_SUFFIX = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'nic', 'mil']);
/** The registrable part of a host ("www.shop.acme.co.uk" → "acme.co.uk"); an IP literal is its own site. */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return h;
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const sld = labels[labels.length - 2]!;
  const take = MULTI_SUFFIX.has(sld) && labels[labels.length - 1]!.length === 2 ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** What a warning shows of an outside address: host and path, capped (never a query or a long data URI). */
export function shownUrl(u: URL | string): string {
  if (typeof u === 'string') {
    const scheme = /^\s*([A-Za-z][A-Za-z0-9+.-]{0,20}):/.exec(u)?.[1];
    return scheme ? `${scheme.toLowerCase()}:…` : u.slice(0, 40);
  }
  const s = `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`;
  return s.length > 100 ? `${s.slice(0, 99)}…` : s;
}

type Warn = { key: string; text: string };
class Inspection {
  readonly warnings: Warn[] = [];
  readonly scans: Array<{ scan: CssScan; adobe: boolean }> = [];
  readonly googleLinks: URL[] = [];
  readonly budget: ScanBudget = newScanBudget(SITE_LIMITS.maxFaces);
  readonly visited = new Set<string>();
  fetched = 0;
  timedOut = false;
  constructor(readonly m: ReturnType<typeof messages>['brand'], readonly site: string) {}
  warn(key: string, text: string) {
    if (this.warnings.length >= MAX_WARNINGS || this.warnings.some((w) => w.key === key)) return;
    this.warnings.push({ key, text });
  }
}

class Timeout extends Error {}

/** GETs `url` through safeFetch and reads at most `max` bytes (the rest is never pulled from the socket). */
async function getText(deps: InspectDeps, signal: AbortSignal, url: URL, max: number): Promise<{ text: string; truncated: boolean }> {
  const res = await untilAborted(safeFetch(deps.fetch, url.href, { signal, headers: { accept: 'text/html,text/css,*/*;q=0.5' } }, { provider: url.hostname, allowHttp: true }), signal);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new StatusError(res.status);
  }
  const reader = res.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > max) {
        chunks.push(value.subarray(0, max - size));
        size = max;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  return { text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)), truncated };
}
/** Settles with `p`, or rejects as soon as `signal` aborts (a transport that ignores the signal cannot hold the deadline). */
function untilAborted(p: Promise<Response>, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<Response>((ok, fail) => {
    const onAbort = () => fail(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => {
      signal.removeEventListener('abort', onAbort);
      // Too late: a response that arrives after the abort is released.
      if (signal.aborted) { void v.body?.cancel().catch(() => {}); return; }
      ok(v);
    }, (e) => { signal.removeEventListener('abort', onAbort); fail(e); });
  });
}
class StatusError extends Error { constructor(readonly status: number) { super(`HTTP ${status}`); } }

/** The stylesheets and inline styles of an HTML page: a linear scan of its tags (comments and scripts skipped). */
export function scanHtml(html: string, base: URL): { sheets: URL[]; styles: string[]; rejected: string[] } {
  const lower = html.toLowerCase();
  const sheets: URL[] = [];
  const styles: string[] = [];
  const rejected: string[] = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = lower.indexOf('<', i);
    if (lt < 0) break;
    if (lower.startsWith('<!--', lt)) { const e = lower.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    const tag = /^<([a-z][a-z0-9-]*)/.exec(lower.slice(lt, lt + 20))?.[1];
    if (!tag) { i = lt + 1; continue; }
    if (tag === 'script' || tag === 'style' || tag === 'textarea' || tag === 'title') {
      const open = lower.indexOf('>', lt);
      if (open < 0) break;
      const close = lower.indexOf(`</${tag}`, open + 1);
      const end = close < 0 ? n : close;
      if (tag === 'style' && styles.length < MAX_STYLE_BLOCKS) styles.push(html.slice(open + 1, end));
      i = close < 0 ? n : close + tag.length + 2;
      continue;
    }
    const gt = lower.indexOf('>', lt);
    if (gt < 0) break;
    if (tag === 'link' && gt - lt <= MAX_TAG && sheets.length + rejected.length < MAX_LINKS) {
      const attrs = attributes(html.slice(lt + 5, gt));
      const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
      const isSheet = rel.includes('stylesheet') || (rel.includes('preload') && (attrs.get('as') ?? '').toLowerCase() === 'style');
      const href = attrs.get('href');
      if (isSheet && href) {
        let u: URL | null = null;
        try { u = new URL(href.trim(), base); } catch { /* unparsable */ }
        if (u && (u.protocol === 'http:' || u.protocol === 'https:')) { if (!sheets.some((s) => s.href === u!.href)) sheets.push(u); }
        else rejected.push(href);
      }
    }
    i = gt + 1;
  }
  return { sheets, styles, rejected };
}

/** Attributes of one tag (bounded text): name → value, first occurrence wins. */
function attributes(s: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const m of s.matchAll(re)) {
    const name = m[1]!.toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** Families of a Google Fonts css/css2 link: `family=Inter:wght@400;700` (css2) or `family=Roboto:400,700i|Lato` (css). */
export function googleFamilies(u: URL): Array<{ family: string; weights: number[]; italic: boolean }> {
  const out: Array<{ family: string; weights: number[]; italic: boolean }> = [];
  const specs = u.searchParams.getAll('family').slice(0, 20).flatMap((f) => (u.pathname.startsWith('/css2') ? [f] : f.split('|').slice(0, 20)));
  for (const spec of specs) {
    const colon = spec.indexOf(':');
    const family = cleanFamily(colon < 0 ? spec : spec.slice(0, colon));
    if (!family) continue;
    const axes = colon < 0 ? '' : spec.slice(colon + 1, colon + 400);
    const weights = new Set<number>();
    let italic = false;
    if (u.pathname.startsWith('/css2')) {
      const at = axes.indexOf('@');
      const names = (at < 0 ? axes : axes.slice(0, at)).split(',');
      const wIdx = names.indexOf('wght');
      const iIdx = names.indexOf('ital');
      for (const tuple of (at < 0 ? '' : axes.slice(at + 1)).split(';').slice(0, 40)) {
        const vals = tuple.split(',');
        if (iIdx >= 0 && vals[iIdx] === '1') italic = true;
        const w = wIdx >= 0 ? vals[wIdx] : undefined;
        if (w) for (const x of w.split('..')) { const v = Number(x); if (Number.isInteger(v) && v >= 1 && v <= 1000) weights.add(v); }
      }
    } else {
      for (const v of axes.split(',').slice(0, 40)) {
        const m = /^(\d{3})?(i|italic)?$/.exec(v.trim());
        if (!m) { if (/^(bold)?italic$/.test(v.trim())) italic = true; continue; }
        if (m[1]) weights.add(Number(m[1]));
        if (m[2]) italic = true;
      }
    }
    out.push({ family, weights: [...weights].sort((a, b) => a - b), italic });
  }
  return out;
}

const isAllowedHost = (host: string, site: string) => siteOf(host) === site || (FONT_CDNS as readonly string[]).includes(host.toLowerCase());

/**
 * Inspects `url`: the page (2 MB), its stylesheets and their imports (20 sheets of 2 MB, depth 3, cycles cut), up to
 * 2000 @font-face rules, within 30 s. Throws only when the job is cancelled; every other failure becomes a warning.
 */
export async function inspectSiteFonts(deps: InspectDeps, url: string): Promise<{ fonts: SiteFont[]; warnings: string[] }> {
  const m = messages(deps.locale ?? currentLocale()).brand;
  let page: URL;
  try { page = new URL(url); } catch { return { fonts: [], warnings: [m.siteFontsNote({ text: m.siteScheme({ url: shownUrl(url) }) })] }; }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return { fonts: [], warnings: [m.siteFontsNote({ text: m.siteScheme({ url: shownUrl(url) }) })] };
  const ins = new Inspection(m, siteOf(page.hostname));
  const deadline = new AbortController();
  const timer = setTimeout(() => { ins.timedOut = true; deadline.abort(new Timeout()); }, deps.timeoutMs ?? SITE_LIMITS.totalMs);
  const signal = AbortSignal.any([deps.signal, deadline.signal]);
  const cancelled = () => deps.signal.aborted;

  /** One request; failures become warnings (null). A cancelled job throws. */
  const fetchText = async (u: URL, max: number): Promise<string | null> => {
    try {
      const { text, truncated } = await getText(deps, signal, u, max);
      if (truncated) ins.warn(`big:${u.href}`, m.siteTooLarge({ url: shownUrl(u), mb: max / MB }));
      return text;
    } catch (e) {
      if (cancelled()) throw e;
      if (ins.timedOut) return null;
      if (e instanceof BlockedUrlError) ins.warn(`blocked:${u.href}`, m.siteBlocked({ url: shownUrl(u) }));
      else if (e instanceof StatusError) ins.warn(`status:${u.href}`, m.siteStatus({ url: shownUrl(u), status: e.status }));
      else ins.warn(`down:${u.href}`, m.siteUnreachable({ url: shownUrl(u) }));
      return null;
    }
  };

  const scanSheet = (css: string, base: URL, adobe: boolean) => {
    const scan = scanCss(css, base, ins.budget);
    ins.scans.push({ scan, adobe });
    ins.googleLinks.push(...scan.googleLinks);
    return scan;
  };

  const visit = async (u: URL, depth: number, chain: string[]): Promise<void> => {
    if (ins.timedOut) return;
    const key = u.href.split('#')[0]!;
    if (chain.includes(key)) { ins.warn(`cycle:${key}`, m.siteImportCycle({ url: shownUrl(u) })); return; }
    if (ins.visited.has(key)) return;
    if (u.hostname === 'fonts.googleapis.com') { ins.googleLinks.push(u); return; }
    if (!isAllowedHost(u.hostname, ins.site)) { ins.warn(`off:${u.hostname}`, m.siteOffSite({ url: shownUrl(u) })); return; }
    if (depth > SITE_LIMITS.maxImportDepth) { ins.warn(`depth:${key}`, m.siteImportDepth({ url: shownUrl(u), max: SITE_LIMITS.maxImportDepth })); return; }
    if (ins.fetched >= SITE_LIMITS.maxSheets) { ins.warn('sheets', m.siteTooManySheets({ max: SITE_LIMITS.maxSheets })); return; }
    ins.visited.add(key);
    ins.fetched++;
    const css = await fetchText(u, SITE_LIMITS.sheetBytes);
    if (css === null) return;
    const scan = scanSheet(css, u, ADOBE_HOSTS.has(u.hostname.toLowerCase()));
    for (const imp of scan.imports) await visit(imp, depth + 1, [...chain, key]);
  };

  try {
    const html = await fetchText(page, SITE_LIMITS.pageBytes);
    if (html !== null) {
      const found = scanHtml(html, page);
      if (found.rejected.length) ins.warn('scheme', m.siteScheme({ url: shownUrl(found.rejected[0]!) }));
      for (const style of found.styles) {
        const scan = scanSheet(style, page, false);
        for (const imp of scan.imports) await visit(imp, 1, []);
      }
      for (const sheet of found.sheets) await visit(sheet, 0, []);
    }
  } catch (e) {
    if (cancelled()) throw e;
  } finally {
    clearTimeout(timer);
  }
  if (ins.timedOut) ins.warn('timeout', m.siteTimeout({ seconds: Math.round((deps.timeoutMs ?? SITE_LIMITS.totalMs) / 1000) }));
  if (ins.budget.facesTruncated) ins.warn('faces', m.siteTooManyFaces({ max: SITE_LIMITS.maxFaces }));
  const rejected = ins.scans.reduce((n, s) => n + s.scan.rejected, 0);
  if (rejected > 0) ins.warn('rejected', m.siteFontUrlsIgnored({ count: rejected }));
  return { fonts: collect(ins), warnings: ins.warnings.map((w) => m.siteFontsNote({ text: w.text })) };
}

interface Draft { family: string; roles: Set<FontRole>; weights: Set<number>; italic: boolean; source: SiteFontSource | null; files: SiteFont['files']; uses: number; faces: number }

/** Merges every sheet's findings into one list per family, most used first. */
function collect(ins: Inspection): SiteFont[] {
  const fonts = new Map<string, Draft>();
  const get = (family: string) => {
    const key = family.toLowerCase();
    let d = fonts.get(key);
    if (!d) { d = { family, roles: new Set(), weights: new Set(), italic: false, source: null, files: [], uses: 0, faces: 0 }; fonts.set(key, d); }
    return d;
  };
  const addUsage = (u: Pick<Usage, 'family' | 'italic'> & { roles: Iterable<FontRole>; weights: Iterable<number>; count: number }) => {
    const d = get(u.family);
    for (const r of u.roles) d.roles.add(r);
    for (const w of u.weights) d.weights.add(w);
    if (u.italic) d.italic = true;
    d.uses += u.count;
  };
  const variables = new Map<string, string>();
  for (const { scan } of ins.scans) for (const [k, v] of scan.variables) variables.set(k, v);
  for (const { scan, adobe } of ins.scans) {
    for (const u of scan.families.values()) addUsage(u);
    // A variable holding a font stack (one level of var() indirection is followed).
    for (const vu of scan.varUses) {
      let value = variables.get(vu.name);
      const inner = value ? /^\s*var\(\s*(--[A-Za-z0-9_-]{1,100})/.exec(value) : null;
      if (inner) value = variables.get(inner[1]!);
      const family = value ? cleanFamily(splitTopLevel(value, 1)[0] ?? '') : null;
      if (family) addUsage({ family, roles: vu.roles, weights: vu.weights, italic: vu.italic, count: 1 });
    }
    for (const f of scan.faces) {
      const d = get(f.family);
      d.faces++;
      for (const w of f.weights) d.weights.add(w);
      if (f.italic) d.italic = true;
      const hosts = f.files.map((x) => new URL(x.url).hostname.toLowerCase());
      const src: SiteFontSource = adobe || hosts.some((h) => ADOBE_HOSTS.has(h)) ? 'adobe' : hosts.some((h) => h === 'fonts.gstatic.com') ? 'google' : 'self-hosted';
      if (d.source === null || d.source === 'self-hosted') d.source = src;
      const weight = f.weights.length === 1 ? f.weights[0]! : null;
      for (const file of f.files) if (d.files.length < MAX_FILES && file.url.length <= MAX_FILE_URL && !d.files.some((x) => x.url === file.url)) d.files.push({ url: file.url, format: file.format, weight });
      if (f.embedded && d.files.length < MAX_FILES) d.files.push({ url: EMBEDDED, format: null, weight });
    }
  }
  for (const link of ins.googleLinks) {
    for (const g of googleFamilies(link)) {
      const d = get(g.family);
      d.source = 'google';
      for (const w of g.weights) d.weights.add(w);
      if (g.italic) d.italic = true;
    }
  }
  const rank = (d: Draft) => (d.roles.has('heading') || d.roles.has('body') ? 2 : d.roles.has('button') ? 1 : 0);
  return [...fonts.values()]
    .sort((a, b) => rank(b) - rank(a) || b.uses - a.uses || b.faces - a.faces || a.family.localeCompare(b.family))
    .slice(0, MAX_FONTS)
    .map((d) => ({
      family: d.family,
      roles: d.roles.size ? (['heading', 'body', 'button', 'other'] as const).filter((r) => d.roles.has(r)) : ['other'],
      weights: [...d.weights].sort((a, b) => a - b).slice(0, 20),
      italic: d.italic,
      source: d.source ?? 'system',
      files: d.files,
    }));
}

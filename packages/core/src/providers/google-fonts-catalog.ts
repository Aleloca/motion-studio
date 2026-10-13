import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { downloadBytes, safeDownload } from './safe-url.ts';
import { ProviderError, type HttpDeps } from './http.ts';
import { parseFontCss, validFamily } from './google-fonts.ts';
import { t } from '../i18n.ts';

/** What the web needs of a family (the catalog's other fields are dropped on parse). */
export interface GoogleFamily { family: string; category: string; weights: number[]; italic: boolean; variable: boolean }
export interface GoogleSearch { stale: boolean; fallback: boolean; families: GoogleFamily[] }
type Stored = GoogleFamily & { popularity?: number };

export const CATALOG_URL = 'https://fonts.google.com/metadata/fonts';
export const CATALOG_MAX_BYTES = 8 * 1024 * 1024;
export const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PREVIEW_MAX_BYTES = 200 * 1024;
export const PREVIEW_CACHE_MAX = 300;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
const PROVIDER = 'Google Fonts';
const SAMPLE = 'AaBbGg 0123';
// A current browser: with it css2 answers woff2 (the downloads of the add flow keep the curl user agent and get ttf).
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const entrySchema = z.object({
  family: z.string().min(1).max(80),
  category: z.string().max(40).default(''),
  fonts: z.record(z.string(), z.unknown()),
  axes: z.array(z.object({ tag: z.string() }).passthrough()).optional(),
  popularity: z.number().finite().optional(),
});
const wireSchema = z.object({ familyMetadataList: z.array(z.unknown()) });
const storedSchema = z.object({
  fetchedAt: z.number().finite(),
  families: z.array(z.object({
    family: z.string(), category: z.string(), weights: z.array(z.number().int()), italic: z.boolean(), variable: z.boolean(), popularity: z.number().optional(),
  })),
});

/** Parses the catalog body (with or without the anti-JSON prefix); null when the shape is not the expected one. */
export function parseCatalog(body: string): Stored[] | null {
  let json: unknown;
  try { json = JSON.parse(body.replace(/^\)\]\}'\s*/, '')); } catch { return null; }
  const wire = wireSchema.safeParse(json);
  if (!wire.success) return null;
  const out: Stored[] = [];
  for (const raw of wire.data.familyMetadataList) {
    const e = entrySchema.safeParse(raw);
    if (!e.success || !validFamily(e.data.family)) continue;
    const weights = new Set<number>();
    let italic = false;
    for (const key of Object.keys(e.data.fonts)) {
      const m = /^([1-9]00)(i?)$/.exec(key);
      if (!m) continue;
      weights.add(Number(m[1]));
      if (m[2]) italic = true;
    }
    if (!weights.size) continue;
    out.push({
      family: e.data.family, category: e.data.category, weights: [...weights].sort((a, b) => a - b), italic,
      variable: Boolean(e.data.axes?.some((a) => a.tag === 'wght')), ...(e.data.popularity !== undefined ? { popularity: e.data.popularity } : {}),
    });
  }
  return out.length ? out : null; // a list with no usable family is a changed shape
}

/** Prefix before substring, then popularity (1 = most popular) when present, then alphabetical. */
export function rank(families: Stored[], q: string): Stored[] {
  const needle = q.trim().toLowerCase();
  const scored = families.flatMap((f) => {
    const name = f.family.toLowerCase();
    const tier = !needle ? 2 : name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : -1;
    return tier < 0 ? [] : [{ f, tier }];
  });
  return scored.sort((a, b) => a.tier - b.tier || (a.f.popularity ?? Infinity) - (b.f.popularity ?? Infinity) || a.f.family.localeCompare(b.f.family)).map((s) => s.f);
}

export interface CatalogOptions { configDir: string; http: HttpDeps; now?: () => number }

export class GoogleFontsCatalog {
  private readonly dir: string;
  private memo: { fetchedAt: number; families: Stored[] } | null = null;
  private refreshing: Promise<boolean> | null = null;
  private failedAt = -Infinity;
  private evicting: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  constructor(private readonly o: CatalogOptions) {
    this.dir = join(o.configDir, 'cache');
    this.now = o.now ?? Date.now;
  }

  private get catalogPath() { return join(this.dir, 'google-fonts-catalog.json'); }
  private get previewDir() { return join(this.dir, 'font-previews'); }

  private async readCache(): Promise<void> {
    if (this.memo) return;
    try {
      const parsed = storedSchema.safeParse(JSON.parse(await readFile(this.catalogPath, 'utf8')));
      if (parsed.success && parsed.data.families.length) this.memo = parsed.data;
    } catch { /* no cache, or an unreadable one: treated as none */ }
  }

  private async download(): Promise<boolean> {
    try {
      const { bytes } = await downloadBytes({ ...this.o.http, timeoutMs: this.o.http.timeoutMs ?? 30_000 }, CATALOG_URL, { headers: { 'user-agent': BROWSER_UA } }, { provider: PROVIDER, secrets: [], maxBytes: CATALOG_MAX_BYTES });
      const families = parseCatalog(bytes.toString('utf8'));
      if (!families) return false;
      this.memo = { fetchedAt: this.now(), families };
    } catch { return false; }
    // A cache that cannot be written still serves from memory.
    try {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.catalogPath}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, JSON.stringify(this.memo));
      await rename(tmp, this.catalogPath).catch(async (e) => { await rm(tmp, { force: true }); throw e; });
    } catch { /* memory only */ }
    return true;
  }

  /** The catalog, fresh when possible: stale cache when the refresh fails, null when there is neither. */
  private async load(): Promise<{ families: Stored[]; stale: boolean } | null> {
    await this.readCache();
    const fresh = this.memo && this.now() - this.memo.fetchedAt < CATALOG_TTL_MS;
    if (fresh) return { families: this.memo!.families, stale: false };
    if (this.now() - this.failedAt >= RETRY_AFTER_FAILURE_MS) {
      this.refreshing ??= this.download().finally(() => { this.refreshing = null; });
      if (!(await this.refreshing)) this.failedAt = this.now();
      else return { families: this.memo!.families, stale: false };
    }
    return this.memo ? { families: this.memo.families, stale: true } : null;
  }

  async search(q: { q?: string; category?: string; limit?: number }, signal?: AbortSignal): Promise<GoogleSearch> {
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? 50) || 50, 1), 200);
    const name = (q.q ?? '').trim();
    const cat = (q.category ?? '').trim().toLowerCase();
    const cat0 = (f: Stored) => !cat || f.category.toLowerCase() === cat;
    const loaded = await this.load();
    if (loaded) {
      const families = rank(loaded.families.filter(cat0), name).slice(0, limit).map(({ popularity: _p, ...f }) => f);
      return { stale: loaded.stale, fallback: false, families };
    }
    return { stale: false, fallback: true, families: await this.exactName(name, signal) };
  }

  /** No catalog at all: the typed name is looked up on css2 as it is; the weights offered are the common pair (the add reports what is missing). */
  private async exactName(name: string, signal?: AbortSignal): Promise<GoogleFamily[]> {
    if (!validFamily(name)) return [];
    try {
      const { bytes } = await downloadBytes(this.o.http, `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}`, { headers: { 'user-agent': 'curl/8' }, ...(signal ? { signal } : {}) }, { provider: PROVIDER, secrets: [], maxBytes: 1024 * 1024 });
      if (!parseFontCss(bytes.toString('utf8')).length) return [];
      return [{ family: name, category: '', weights: [400, 700], italic: false, variable: false }];
    } catch { return []; }
  }

  /** The woff2 subset that shows the family at one weight, from the cache or downloaded once. */
  async preview(family: string, weight: number, signal?: AbortSignal): Promise<Buffer> {
    const name = family.trim();
    if (!validFamily(name)) throw new ProviderError(400, t().providers.invalidFontName);
    if (!Number.isInteger(weight) || weight < 100 || weight > 900 || weight % 100 !== 0) throw new ProviderError(400, t().providers.invalidFontWeights);
    const file = join(this.previewDir, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${weight}.woff2`);
    try {
      const bytes = await readFile(file);
      const at = new Date(this.now());
      await utimes(file, at, at).catch(() => {});
      return bytes;
    } catch { /* not cached */ }
    const text = encodeURIComponent(`${SAMPLE} ${name}`);
    const url = `https://fonts.googleapis.com/css2?family=${name.replace(/ /g, '+')}:wght@${weight}&text=${text}`;
    const init: RequestInit = { headers: { 'user-agent': BROWSER_UA }, ...(signal ? { signal } : {}) };
    let css: string;
    try {
      css = (await downloadBytes(this.o.http, url, init, { provider: PROVIDER, secrets: [], maxBytes: 64 * 1024 })).bytes.toString('utf8');
    } catch (e) {
      if (e instanceof ProviderError && e.upstreamStatus === 400) throw new ProviderError(404, t().providers.fontNotFound({ family: name }));
      throw e;
    }
    const src = parseFontCss(css)[0];
    if (!src) throw new ProviderError(404, t().providers.fontNotFound({ family: name }));
    const { bytes } = await safeDownload({ ...this.o.http }, src.url, signal ? { signal } : {}, { provider: PROVIDER, secrets: [], maxBytes: PREVIEW_MAX_BYTES });
    await mkdir(this.previewDir, { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, file);
    const at = new Date(this.now());
    await utimes(file, at, at).catch(() => {});
    this.evicting = this.evicting.then(() => this.evict()).catch(() => {});
    await this.evicting;
    return bytes;
  }

  /** LRU: the least recently used previews (by mtime, touched on every hit) go once there are more than PREVIEW_CACHE_MAX. */
  private async evict(): Promise<void> {
    const names = (await readdir(this.previewDir)).filter((n) => n.endsWith('.woff2'));
    if (names.length <= PREVIEW_CACHE_MAX) return;
    const dated = await Promise.all(names.map(async (n) => ({ n, at: (await stat(join(this.previewDir, n)).catch(() => null))?.mtimeMs ?? 0 })));
    dated.sort((a, b) => a.at - b.at || a.n.localeCompare(b.n));
    await Promise.all(dated.slice(0, names.length - PREVIEW_CACHE_MAX).map((d) => rm(join(this.previewDir, d.n), { force: true })));
  }
}

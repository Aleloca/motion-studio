import { ProviderError, requestJson, type HttpDeps } from './http.ts';
import { safeDownload, safeHttpsUrl } from './safe-url.ts';
import { t } from '../i18n.ts';

export type StockProvider = 'pexels' | 'unsplash';
export interface StockResult { id: string; provider: StockProvider; kind: 'photo' | 'video'; width: number; height: number; durationSec: number | null; thumb: string; author: string; pageUrl: string }
const MAX = 200 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const extOf = (type: string, fallback: string) => (type.includes('png') ? 'png' : type.includes('jpeg') || type.includes('jpg') ? 'jpg' : type.includes('mp4') ? 'mp4' : type.includes('webp') ? 'webp' : fallback);

const headers = (p: StockProvider, key: string): Record<string, string> => (p === 'pexels' ? { authorization: key } : { authorization: `Client-ID ${key}`, 'accept-version': 'v1' });
const isUnsplashApi = (u: string | undefined): u is string => { try { return !!u && new URL(u).origin === 'https://api.unsplash.com'; } catch { return false; } };
const isSafe = (u: unknown, provider: string) => { try { safeHttpsUrl(typeof u === 'string' ? u : undefined, provider); return true; } catch { return false; } };
const name = (p: StockProvider) => (p === 'pexels' ? 'Pexels' : 'Unsplash');

export async function stockSearch(deps: HttpDeps & { apiKey: string }, q: { provider: StockProvider; query: string; kind: 'photo' | 'video'; orientation?: 'landscape' | 'portrait' | 'square'; limit: number }): Promise<StockResult[]> {
  const o = { provider: name(q.provider), secrets: [deps.apiKey] };
  const limit = Number.isFinite(q.limit) ? Math.min(20, Math.max(1, Math.trunc(q.limit))) : 10;
  const params = new URLSearchParams({ query: q.query.slice(0, 200), per_page: String(limit) });
  if (q.provider === 'unsplash') {
    if (q.kind === 'video') throw new ProviderError(400, t().providers.unsplashNoVideo);
    if (q.orientation) params.set('orientation', q.orientation === 'square' ? 'squarish' : q.orientation);
    type U = { results?: Array<{ id: string; width: number; height: number; user?: { name?: string }; links?: { html?: string }; urls?: { small?: string } }> };
    const r = await requestJson<U>(deps, `https://api.unsplash.com/search/photos?${params}`, { headers: headers('unsplash', deps.apiKey) }, o);
    return (r.results ?? []).map((p) => ({ id: p.id, provider: 'unsplash', kind: 'photo', width: p.width, height: p.height, durationSec: null, thumb: p.urls?.small ?? '', author: p.user?.name ?? '', pageUrl: p.links?.html ?? '' }));
  }
  if (q.orientation) params.set('orientation', q.orientation);
  if (q.kind === 'video') {
    type V = { videos?: Array<{ id: number; width: number; height: number; duration?: number; url: string; image?: string; user?: { name?: string } }> };
    const r = await requestJson<V>(deps, `https://api.pexels.com/videos/search?${params}`, { headers: headers('pexels', deps.apiKey) }, o);
    return (r.videos ?? []).map((v) => ({ id: String(v.id), provider: 'pexels', kind: 'video', width: v.width, height: v.height, durationSec: v.duration ?? null, thumb: v.image ?? '', author: v.user?.name ?? '', pageUrl: v.url }));
  }
  type P = { photos?: Array<{ id: number; width: number; height: number; url: string; photographer?: string; src?: { medium?: string } }> };
  const r = await requestJson<P>(deps, `https://api.pexels.com/v1/search?${params}`, { headers: headers('pexels', deps.apiKey) }, o);
  return (r.photos ?? []).map((p) => ({ id: String(p.id), provider: 'pexels', kind: 'photo', width: p.width, height: p.height, durationSec: null, thumb: p.src?.medium ?? '', author: p.photographer ?? '', pageUrl: p.url }));
}

export async function stockDownload(deps: HttpDeps & { apiKey: string }, d: { provider: StockProvider; id: string; kind: 'photo' | 'video' }) {
  if (!ID.test(d.id)) throw new ProviderError(400, t().providers.invalidStockId);
  const o = { provider: name(d.provider), secrets: [deps.apiKey] };
  const h = headers(d.provider, deps.apiKey);
  if (d.provider === 'unsplash') {
    if (d.kind === 'video') throw new ProviderError(400, t().providers.unsplashNoVideo);
    type U = { user?: { name?: string }; links?: { html?: string; download_location?: string } };
    const p = await requestJson<U>(deps, `https://api.unsplash.com/photos/${d.id}`, { headers: h }, o);
    if (!isUnsplashApi(p.links?.download_location)) throw new ProviderError(502, t().providers.invalidResponse({ provider: 'Unsplash' }));
    const tracked = await requestJson<{ url?: string }>(deps, p.links.download_location, { headers: h }, o);
    if (!tracked.url) throw new ProviderError(502, t().providers.invalidResponse({ provider: 'Unsplash' }));
    const { bytes, contentType } = await safeDownload(deps, tracked.url, {}, { ...o, maxBytes: MAX });
    const author = p.user?.name ?? t().providers.unknownAuthor;
    return { bytes, ext: extOf(contentType, 'jpg'), author, attribution: t().providers.photoBy({ author, provider: 'Unsplash' }), sourceUrl: `${p.links.html ?? 'https://unsplash.com'}?utm_source=motion_studio&utm_medium=referral` };
  }
  if (d.kind === 'video') {
    type V = { url: string; user?: { name?: string }; video_files?: Array<{ width?: number; file_type?: string; link: string }> };
    const v = await requestJson<V>(deps, `https://api.pexels.com/videos/videos/${d.id}`, { headers: h }, o);
    const mp4 = (v.video_files ?? []).filter((f) => f.file_type === 'video/mp4' && typeof f.link === 'string' && isSafe(f.link, 'Pexels'));
    const hd = mp4.filter((f) => (f.width ?? 0) <= 1920).sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
      ?? mp4.sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0];
    if (!hd) throw new ProviderError(502, t().providers.noPexelsVideo);
    const { bytes } = await safeDownload(deps, hd.link, {}, { ...o, maxBytes: MAX });
    const author = v.user?.name ?? t().providers.unknownAuthor;
    return { bytes, ext: 'mp4', author, attribution: t().providers.videoBy({ author, provider: 'Pexels' }), sourceUrl: v.url };
  }
  type P = { url: string; photographer?: string; src?: { original?: string } };
  const p = await requestJson<P>(deps, `https://api.pexels.com/v1/photos/${d.id}`, { headers: h }, o);
  if (!p.src?.original) throw new ProviderError(502, t().providers.invalidResponse({ provider: 'Pexels' }));
  const { bytes, contentType } = await safeDownload(deps, p.src.original, {}, { ...o, maxBytes: MAX });
  const author = p.photographer ?? t().providers.unknownAuthor;
  return { bytes, ext: extOf(contentType, 'jpg'), author, attribution: t().providers.photoBy({ author, provider: 'Pexels' }), sourceUrl: p.url };
}

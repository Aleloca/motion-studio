import { isPrivateHost } from '../brand/brand-store.ts';
import { ProviderError, requestBytes, type HttpDeps } from './http.ts';

const MAX_REDIRECTS = 3;

/** Parses a provider-supplied URL; only https URLs whose host is not a private/loopback/link-local literal pass. */
export function safeHttpsUrl(raw: string | undefined, provider: string): URL {
  let u: URL | undefined;
  try { u = raw ? new URL(raw) : undefined; } catch { /* invalid */ }
  if (!u || u.protocol !== 'https:' || isPrivateHost(u.hostname)) throw new ProviderError(502, `Risposta non valida da ${provider}`);
  return u;
}

/**
 * Downloads a provider-supplied URL: validates it, follows at most 3 redirects by hand (each Location re-validated,
 * relative ones resolved against the current URL), and delegates body reading, limits and error mapping to requestBytes.
 */
export async function safeDownload(
  deps: HttpDeps, raw: string, init: RequestInit, o: { provider: string; secrets: string[]; maxBytes: number },
): Promise<{ bytes: Buffer; contentType: string }> {
  const first = safeHttpsUrl(raw, o.provider);
  let rejected: ProviderError | undefined;
  const follow = (async (_url: string, i: RequestInit = {}) => {
    let current = first;
    for (let hop = 0; ; hop++) {
      const res = await deps.fetch(current.href, { ...i, redirect: 'manual' });
      if (res.status < 300 || res.status >= 400) return res;
      await res.body?.cancel().catch(() => {});
      const loc = res.headers.get('location');
      try {
        if (hop >= MAX_REDIRECTS || !loc) throw new ProviderError(502, `Risposta non valida da ${o.provider}`);
        current = safeHttpsUrl(new URL(loc, current).href, o.provider);
      } catch (e) {
        rejected = e instanceof ProviderError ? e : new ProviderError(502, `Risposta non valida da ${o.provider}`);
        throw rejected;
      }
    }
  }) as typeof fetch;
  try {
    return await requestBytes({ ...deps, fetch: follow }, first.href, init, o);
  } catch (e) {
    throw rejected ?? e;
  }
}

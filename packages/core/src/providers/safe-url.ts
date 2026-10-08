import { isPrivateHost } from '../brand/brand-store.ts';
import { ProviderError, requestBytes, type HttpDeps } from './http.ts';
import { BlockedUrlError, safeFetch } from './safe-fetch.ts';
import { t } from '../i18n.ts';

const PROVIDER_MAX_REDIRECTS = 3;

/** Parses a provider-supplied URL; only https URLs whose host is not a private/loopback/link-local literal pass. */
export function safeHttpsUrl(raw: string | undefined, provider: string): URL {
  let u: URL | undefined;
  try { u = raw ? new URL(raw) : undefined; } catch { /* invalid */ }
  if (!u || u.protocol !== 'https:' || isPrivateHost(u.hostname)) throw new ProviderError(502, t().providers.invalidResponse({ provider }));
  return u;
}

/**
 * Downloads an outside URL through safeFetch (resolved addresses checked on every hop, redirects followed by hand)
 * and delegates body reading, limits and error mapping to requestBytes. A refused target surfaces as BlockedUrlError.
 */
export async function downloadBytes(
  deps: HttpDeps, url: string, init: RequestInit,
  o: { provider: string; secrets: string[]; maxBytes: number; allowHttp?: boolean; maxRedirects?: number },
): Promise<{ bytes: Buffer; contentType: string }> {
  let rejected: ProviderError | undefined;
  const follow = (async (u: string, i: RequestInit = {}) => {
    try {
      return await safeFetch({ transport: deps.transport, lookup: deps.lookup, maxRedirects: o.maxRedirects }, u, i, { provider: o.provider, allowHttp: o.allowHttp });
    } catch (e) {
      if (e instanceof ProviderError) rejected = e;
      throw e;
    }
  }) as typeof fetch;
  try {
    return await requestBytes({ ...deps, fetch: follow }, url, init, o);
  } catch (e) {
    throw rejected ?? e;
  }
}

/** Downloads a provider-supplied https URL; a refused target is reported as an invalid provider response. */
export async function safeDownload(
  deps: HttpDeps, raw: string, init: RequestInit, o: { provider: string; secrets: string[]; maxBytes: number },
): Promise<{ bytes: Buffer; contentType: string }> {
  const first = safeHttpsUrl(raw, o.provider);
  try {
    return await downloadBytes(deps, first.href, init, { ...o, maxRedirects: PROVIDER_MAX_REDIRECTS });
  } catch (e) {
    if (e instanceof BlockedUrlError) throw new ProviderError(502, t().providers.invalidResponse({ provider: o.provider }));
    throw e;
  }
}

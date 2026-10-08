import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { ProviderError } from './http.ts';

export type Address = { address: string; family: 4 | 6 };
export type LookupFn = (host: string) => Promise<Address[]>;
/** Resolves a hostname to addresses that are all allowed, or throws BlockedUrlError. */
export type Resolver = (host: string) => Promise<Address[]>;
/**
 * Performs ONE request (no redirects followed). The transport must reach the server only through `resolve`,
 * so that the address it connects to is one that was checked.
 */
export type Transport = (url: URL, init: RequestInit, resolve: Resolver) => Promise<Response>;
export interface SafeFetchDeps {
  /** Default: nodeTransport (the socket connects to exactly the validated address). */
  transport?: Transport;
  /** Default: dns.promises.lookup(host, { all: true, verbatim: true }). */
  lookup?: LookupFn;
  /** Default: isBlockedAddress. */
  isBlocked?: (ip: string) => boolean;
  /** Default: 5. */
  maxRedirects?: number;
}

/** A download target refused by policy (scheme, credentials, port, private or reserved address, redirects). */
export class BlockedUrlError extends ProviderError {
  constructor(message = 'Indirizzo non consentito per il download') { super(502, message); this.name = 'BlockedUrlError'; }
}

const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'xi-api-key', 'x-api-key', 'api-key'];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const bare = (host: string) => {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const zone = h.indexOf('%');
  return zone >= 0 ? h.slice(0, zone) : h;
};

function blockedV4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b! >= 64 && b! <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a! >= 224;
}

/** 16 bytes of a valid IPv6 address (isIP must already say 6). */
function v6Bytes(ip: string): number[] {
  let s = ip.toLowerCase();
  let tail: number[] = [];
  const last = s.slice(s.lastIndexOf(':') + 1);
  if (last.includes('.')) {
    tail = last.split('.').map(Number);
    s = `${s.slice(0, s.lastIndexOf(':') + 1)}0:0`;
  }
  const [head, rest] = s.includes('::') ? s.split('::') as [string, string] : [s, null];
  const groups = (p: string) => (p ? p.split(':') : []);
  const h = groups(head);
  const r = rest === null ? [] : groups(rest);
  const all = [...h, ...Array(8 - h.length - r.length).fill('0'), ...r].map((g) => parseInt(g, 16));
  const bytes = all.flatMap((g) => [g >> 8, g & 0xff]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** True for any address a download must never reach: private, loopback, link-local, CGNAT, reserved, multicast (IPv4 embedded in IPv6 included). Non-IP input is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const host = bare(ip);
  const v = isIP(host);
  if (v === 4) return blockedV4(host.split('.').map(Number));
  if (v !== 6) return true;
  const b = v6Bytes(host);
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 12)) return true; // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return blockedV4(b.slice(12)); // ::ffff:a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return blockedV4(b.slice(12)); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return blockedV4(b.slice(2, 6)); // 6to4
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7
  if (b[0] === 0xfe && (b[1]! & 0x80) === 0x80) return true; // fe80::/10 link-local and fec0::/10 site-local
  return b[0] === 0xff; // multicast
}

const defaultLookup: LookupFn = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

/** A resolver that throws BlockedUrlError unless EVERY address of the host is allowed. */
export function pinnedResolver(lookup: LookupFn = defaultLookup, isBlocked: (ip: string) => boolean = isBlockedAddress): Resolver {
  return async (host) => {
    const h = bare(host);
    const literal = isIP(h);
    if (literal) {
      if (isBlocked(h)) throw new BlockedUrlError();
      return [{ address: h, family: literal === 6 ? 6 : 4 }];
    }
    const addrs = await lookup(h);
    if (addrs.length === 0 || addrs.some((a) => isBlocked(a.address))) throw new BlockedUrlError();
    return addrs;
  };
}

/**
 * Production transport: node:http(s) with a custom `lookup`, so the socket connects to the very address that was
 * validated (no second DNS resolution, hence no rebinding window). TLS SNI and certificate checks use the hostname.
 */
export const nodeTransport: Transport = (url, init, resolve) => new Promise<Response>((ok, fail) => {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  headers['user-agent'] ??= 'MotionStudio';
  const lookup = ((hostname: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    resolve(hostname).then(
      (addrs) => (opts.all ? cb(null, addrs) : cb(null, addrs[0]!.address, addrs[0]!.family)),
      (e) => cb(e),
    );
  }) as unknown as LookupFunction;
  const method = init.method ?? 'GET';
  const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers, agent: false, lookup, signal: init.signal ?? undefined }, (res) => {
    const status = res.statusCode ?? 502;
    const h = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (Array.isArray(v)) for (const x of v) h.append(k, x);
      else if (v !== undefined) h.set(k, v);
    }
    const noBody = method === 'HEAD' || [204, 205, 304].includes(status);
    if (noBody) res.resume();
    try { ok(new Response(noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, headers: h })); }
    catch (e) { res.destroy(); fail(e); }
  });
  req.on('error', fail);
  req.end();
});

/** Transport over a fetch implementation (tests): the host is checked through `resolve` before the request. */
export function fetchTransport(f: typeof fetch): Transport {
  return async (url, init, resolve) => {
    await resolve(url.hostname);
    return f(url.href, init);
  };
}

function checkUrl(raw: string, allowHttp: boolean): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new BlockedUrlError(); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new BlockedUrlError();
  if (u.username || u.password) throw new BlockedUrlError();
  if (u.port !== '' && u.port !== '443' && u.port !== '80') throw new BlockedUrlError();
  return u;
}

function withoutCredentials(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  for (const h of CREDENTIAL_HEADERS) headers.delete(h);
  return { ...init, headers };
}

/**
 * Fetches a URL that comes from outside (provider responses, websites): only http(s) to public addresses, every hop
 * re-validated (redirects followed by hand, no https→http downgrade, credential headers dropped on origin change).
 * Returns the final response, whatever its status.
 */
export async function safeFetch(deps: SafeFetchDeps, url: string, init: RequestInit, o: { provider: string; allowHttp?: boolean }): Promise<Response> {
  const transport = deps.transport ?? nodeTransport;
  const isBlocked = deps.isBlocked ?? isBlockedAddress;
  const resolve = pinnedResolver(deps.lookup, isBlocked);
  const max = deps.maxRedirects ?? 5;
  let current = checkUrl(url, o.allowHttp === true);
  let req: RequestInit = { ...init, redirect: 'manual' };
  for (let hop = 0; ; hop++) {
    const host = bare(current.hostname);
    if (isIP(host) && isBlocked(host)) throw new BlockedUrlError();
    const res = await transport(current, req, resolve);
    const loc = REDIRECTS.has(res.status) ? res.headers.get('location') : null;
    if (loc === null) return res;
    await res.body?.cancel().catch(() => {});
    if (hop >= max) throw new BlockedUrlError('Troppi reindirizzamenti');
    let next: URL;
    try { next = checkUrl(new URL(loc, current).href, o.allowHttp === true); } catch { throw new BlockedUrlError(); }
    if (current.protocol === 'https:' && next.protocol === 'http:') throw new BlockedUrlError();
    if (next.origin !== current.origin) req = withoutCredentials(req);
    if (res.status === 303 && req.method && !['GET', 'HEAD'].includes(req.method.toUpperCase())) req = { ...req, method: 'GET', body: undefined };
    current = next;
  }
}

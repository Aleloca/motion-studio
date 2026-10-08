import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchTransport, isBlockedAddress, nodeTransport, pinnedResolver, safeFetch, type LookupFn } from '../src/providers/safe-fetch.ts';

const PUBLIC = '93.184.216.34';
const table = (map: Record<string, string[]>): LookupFn => async (host) => (map[host] ?? [PUBLIC]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
const recorder = (handler: (url: string) => Response) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return handler(url); }) as unknown as typeof fetch;
  return { calls, transport: fetchTransport(f) };
};
const P = { provider: 'Sito' };

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.9.9.9', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.8', '192.168.1.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%en0', 'febf::1', 'ff02::1', '[::1]',
    '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:7f00:1', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '2002:7f00:1::', '2002:c0a8:101::1',
    'not-an-ip', '',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each([
    PUBLIC, '8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '192.0.1.1', '192.169.0.1', '198.17.0.1', '198.20.0.1', '223.255.255.255',
    '2606:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1',
  ])('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('safeFetch', () => {
  it('rejects a hostname resolving to a private address without fetching it', async () => {
    const { calls, transport } = recorder(() => new Response('x'));
    const e = await safeFetch({ transport, lookup: table({ 'evil.example': ['10.0.0.1'] }) }, 'https://evil.example/a', {}, P).catch((x) => x);
    expect(e).toMatchObject({ status: 502, message: 'Indirizzo non consentito per il download' });
    expect(calls).toHaveLength(0);
  });
  it('rejects a host with one public and one private address', async () => {
    const { calls, transport } = recorder(() => new Response('x'));
    const e = await safeFetch({ transport, lookup: table({ 'mixed.example': [PUBLIC, '::1'] }) }, 'https://mixed.example/a', {}, P).catch((x) => x);
    expect(e.message).toBe('Indirizzo non consentito per il download');
    expect(calls).toHaveLength(0);
  });
  it('rejects a host that resolves to nothing, and private IP literals', async () => {
    const { calls, transport } = recorder(() => new Response('x'));
    expect((await safeFetch({ transport, lookup: table({ 'none.example': [] }) }, 'https://none.example/a', {}, P).catch((x) => x)).status).toBe(502);
    for (const u of ['https://127.0.0.1/a', 'https://[::1]/a', 'https://[::ffff:169.254.169.254]/a']) {
      expect((await safeFetch({ transport, lookup: table({}) }, u, {}, P).catch((x) => x)).message).toBe('Indirizzo non consentito per il download');
    }
    expect(calls).toHaveLength(0);
  });
  it('rejects a redirect to a hostname resolving to a private address', async () => {
    const { calls, transport } = recorder((u) => (u === 'https://ok.example/a' ? redirect('https://rebind.example/b') : new Response('x')));
    const e = await safeFetch({ transport, lookup: table({ 'rebind.example': ['192.168.0.10'] }) }, 'https://ok.example/a', {}, P).catch((x) => x);
    expect(e.message).toBe('Indirizzo non consentito per il download');
    expect(calls.map((c) => c.url)).toEqual(['https://ok.example/a']);
  });
  it('rejects a redirect chain longer than the maximum', async () => {
    const { calls, transport } = recorder(() => redirect('/again'));
    const e = await safeFetch({ transport, lookup: table({}), maxRedirects: 2 }, 'https://loop.example/a', {}, P).catch((x) => x);
    expect(e).toMatchObject({ status: 502, message: 'Troppi reindirizzamenti' });
    expect(calls).toHaveLength(3);
    const def = recorder(() => redirect('/again'));
    await safeFetch({ transport: def.transport, lookup: table({}) }, 'https://loop.example/a', {}, P).catch(() => {});
    expect(def.calls).toHaveLength(6);
  });
  it('rejects an https→http downgrade even when http is allowed, and http when it is not', async () => {
    const { transport } = recorder(() => redirect('http://ok.example/b'));
    expect((await safeFetch({ transport, lookup: table({}) }, 'https://ok.example/a', {}, { ...P, allowHttp: true }).catch((x) => x)).status).toBe(502);
    const plain = recorder(() => new Response('x'));
    expect((await safeFetch({ transport: plain.transport, lookup: table({}) }, 'http://ok.example/a', {}, P).catch((x) => x)).status).toBe(502);
    expect(plain.calls).toHaveLength(0);
    expect((await safeFetch({ transport: plain.transport, lookup: table({}) }, 'http://ok.example/a', {}, { ...P, allowHttp: true })).status).toBe(200);
  });
  it('rejects credentials in the URL, odd ports and other schemes', async () => {
    const { calls, transport } = recorder(() => new Response('x'));
    for (const u of ['https://user:pass@ok.example/a', 'https://user@ok.example/a', 'https://ok.example:8443/a', 'ftp://ok.example/a', 'file:///etc/passwd', 'nonsense']) {
      expect((await safeFetch({ transport, lookup: table({}) }, u, {}, { ...P, allowHttp: true }).catch((x) => x)).message).toBe('Indirizzo non consentito per il download');
    }
    expect(calls).toHaveLength(0);
    const r = redirect('https://u:p@ok.example/b');
    const viaRedirect = recorder(() => r);
    expect((await safeFetch({ transport: viaRedirect.transport, lookup: table({}) }, 'https://ok.example/a', {}, P).catch((x) => x)).status).toBe(502);
  });
  it('strips credential headers on an origin change and follows normal redirects in manual mode', async () => {
    const { calls, transport } = recorder((u) => {
      if (u === 'https://a.example/1') return redirect('/2', 301);
      if (u === 'https://a.example/2') return redirect('https://b.example/3', 307);
      return new Response('done');
    });
    const res = await safeFetch({ transport, lookup: table({}) }, 'https://a.example/1', { headers: { authorization: 'secret', cookie: 'c', accept: 'x' } }, P);
    expect(await res.text()).toBe('done');
    expect(calls.map((c) => c.url)).toEqual(['https://a.example/1', 'https://a.example/2', 'https://b.example/3']);
    expect(calls.every((c) => c.init.redirect === 'manual')).toBe(true);
    expect(calls.map((c) => new Headers(c.init.headers).get('authorization'))).toEqual(['secret', 'secret', null]);
    expect(new Headers(calls[2]!.init.headers).get('cookie')).toBeNull();
    expect(new Headers(calls[2]!.init.headers).get('accept')).toBe('x');
  });
  it('returns non-redirect responses as they are', async () => {
    const { transport } = recorder(() => new Response('nope', { status: 404 }));
    expect((await safeFetch({ transport, lookup: table({}) }, 'https://ok.example/a', {}, P)).status).toBe(404);
  });
});

describe('nodeTransport (real sockets, pinned DNS)', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => { await close?.(); close = null; });
  const serve = async () => {
    const seen: IncomingMessage[] = [];
    const server = createServer((req, res) => { seen.push(req); res.end('ciao'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    close = () => new Promise((r) => server.close(() => r()));
    return { seen, port: (server.address() as AddressInfo).port };
  };

  it('refuses before connecting when the public-looking hostname resolves to loopback', async () => {
    const { seen, port } = await serve();
    const resolve = pinnedResolver(table({ 'public.example': ['127.0.0.1'] }));
    const e = await nodeTransport(new URL(`http://public.example:${port}/x`), {}, resolve).catch((x) => x);
    expect(e).toMatchObject({ status: 502, message: 'Indirizzo non consentito per il download' });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(0);
  });
  it('connects to exactly the validated address and keeps the hostname in the Host header', async () => {
    const { seen, port } = await serve();
    const looked: string[] = [];
    const lookup: LookupFn = async (host) => { looked.push(host); return [{ address: '127.0.0.1', family: 4 }]; };
    const resolve = pinnedResolver(lookup, (ip) => ip !== '127.0.0.1');
    const res = await nodeTransport(new URL(`http://public.example:${port}/x`), { headers: { accept: 'image/*' } }, resolve);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ciao');
    expect(looked).toEqual(['public.example']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.host).toBe(`public.example:${port}`);
    expect(seen[0]!.headers.accept).toBe('image/*');
  });
});

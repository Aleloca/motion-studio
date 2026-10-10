import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.ts';

afterEach(() => { vi.unstubAllGlobals(); });

describe('api · keepalive deletes', () => {
  it('passes keepalive to fetch only when asked', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.deleteAsset('acme', 'a b.png', { keepalive: true });
    await api.deleteReference('acme', 'leaf.jpg', { keepalive: true });
    await api.removeBrandSource('acme', 's-1', { keepalive: true });
    await api.deleteAsset('acme', 'x.png');
    const inits = fetchMock.mock.calls.map((c) => (c as unknown as [string, RequestInit])[1]);
    expect(inits.slice(0, 3).every((i) => i.keepalive === true && i.method === 'DELETE')).toBe(true);
    expect(inits[3]!.keepalive).toBeUndefined();
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/projects/acme/assets/item/a%20b.png');
  });
});

describe('api · coded errors', () => {
  it('carries the code and the Retry-After seconds of a refusal; the turn takes formats', async () => {
    const { ApiError } = await import('../src/api.ts');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'busy hashing', code: 'hashes-pending' }), { status: 503, headers: { 'retry-after': '5' } })));
    const err = await api.setExportPick('acme', 'c1', 'reel', 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, code: 'hashes-pending', retryAfterSec: 5, message: 'busy hashing' });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.sendCreativeTurn('acme', 'c1', { text: 'x', formats: ['reel'] });
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ text: 'x', formats: ['reel'] });
  });
});

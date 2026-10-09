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

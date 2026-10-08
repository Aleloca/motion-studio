import { describe, expect, it } from 'vitest';
import { stockDownload, stockSearch } from '../src/providers/stock.ts';

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const bytes = (type: string) => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': type } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const recorder = (handler: (url: string) => Response) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return { calls, fetchImpl: (async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return handler(url); }) as unknown as typeof fetch };
};

describe('stockSearch', () => {
  it('maps Pexels photos and Unsplash photos', async () => {
    const { calls, fetchImpl } = recorder((u) => (u.includes('pexels')
      ? json({ photos: [{ id: 1, width: 4000, height: 3000, url: 'https://pexels.com/p/1', photographer: 'Ana', src: { medium: 'https://img/m.jpg' } }] })
      : json({ results: [{ id: 'abc', width: 3000, height: 2000, user: { name: 'Bo' }, links: { html: 'https://unsplash.com/photos/abc' }, urls: { small: 'https://img/s.jpg' } }] })));
    expect(await stockSearch({ fetch: fetchImpl, apiKey: 'pk' }, { provider: 'pexels', query: 'caffè', kind: 'photo', orientation: 'square', limit: 5 }))
      .toEqual([{ id: '1', provider: 'pexels', kind: 'photo', width: 4000, height: 3000, durationSec: null, thumb: 'https://img/m.jpg', author: 'Ana', pageUrl: 'https://pexels.com/p/1' }]);
    expect(calls[0]!.url).toBe('https://api.pexels.com/v1/search?query=caff%C3%A8&per_page=5&orientation=square');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('pk');
    const u = await stockSearch({ fetch: fetchImpl, apiKey: 'uk' }, { provider: 'unsplash', query: 'coffee', kind: 'photo', orientation: 'square', limit: 3 });
    expect(u[0]).toMatchObject({ id: 'abc', author: 'Bo' });
    expect(calls[1]!.url).toContain('orientation=squarish');
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Client-ID uk');
  });
  it('refuses Unsplash videos', async () => {
    const { fetchImpl } = recorder(() => json({}));
    expect((await stockSearch({ fetch: fetchImpl, apiKey: 'k' }, { provider: 'unsplash', query: 'x', kind: 'video', limit: 1 }).catch((e) => e)).status).toBe(400);
  });
});

describe('stockDownload', () => {
  it('downloads a Pexels video picking an HD mp4', async () => {
    const { calls, fetchImpl } = recorder((u) => (u.includes('/videos/videos/')
      ? json({ id: 9, url: 'https://pexels.com/v/9', user: { name: 'Cy' }, video_files: [
        { width: 3840, file_type: 'video/mp4', link: 'https://v/4k.mp4' }, { width: 1920, file_type: 'video/mp4', link: 'https://v/hd.mp4' }, { width: 640, file_type: 'video/mp4', link: 'https://v/sd.mp4' }] })
      : bytes('video/mp4')));
    const d = await stockDownload({ fetch: fetchImpl, apiKey: 'pk' }, { provider: 'pexels', id: '9', kind: 'video' });
    expect(calls[1]!.url).toBe('https://v/hd.mp4');
    expect(d).toMatchObject({ ext: 'mp4', attribution: 'Video di Cy su Pexels', sourceUrl: 'https://pexels.com/v/9' });
  });
  it('tracks Unsplash downloads', async () => {
    const { calls, fetchImpl } = recorder((u) => {
      if (u.endsWith('/photos/abc')) return json({ id: 'abc', user: { name: 'Bo' }, links: { html: 'https://unsplash.com/photos/abc', download_location: 'https://api.unsplash.com/photos/abc/download?ixid=1' } });
      if (u.includes('/download')) return json({ url: 'https://images.unsplash.com/raw.jpg' });
      return bytes('image/jpeg');
    });
    const d = await stockDownload({ fetch: fetchImpl, apiKey: 'uk' }, { provider: 'unsplash', id: 'abc', kind: 'photo' });
    expect(calls.map((c) => c.url)).toEqual(['https://api.unsplash.com/photos/abc', 'https://api.unsplash.com/photos/abc/download?ixid=1', 'https://images.unsplash.com/raw.jpg']);
    expect(d).toMatchObject({ ext: 'jpg', attribution: 'Foto di Bo su Unsplash', sourceUrl: 'https://unsplash.com/photos/abc?utm_source=motion_studio&utm_medium=referral' });
  });
  it('rejects odd ids', async () => {
    const { fetchImpl } = recorder(() => json({}));
    expect((await stockDownload({ fetch: fetchImpl, apiKey: 'k' }, { provider: 'pexels', id: '../x', kind: 'photo' }).catch((e) => e)).status).toBe(400);
  });
});

describe('stockDownload SSRF hardening', () => {
  const photo = (original: string) => (u: string) => (u.includes('/v1/photos/') ? json({ url: 'https://pexels.com/p/1', photographer: 'Ana', src: { original } }) : bytes('image/jpeg'));
  const dl = (fetchImpl: typeof fetch) => stockDownload({ fetch: fetchImpl, apiKey: 'pk' }, { provider: 'pexels', id: '1', kind: 'photo' });

  it('rejects provider URLs that are http or private, without fetching them', async () => {
    for (const bad of ['http://127.0.0.1/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'http://images.pexels.com/x.jpg']) {
      const { calls, fetchImpl } = recorder(photo(bad));
      const e = await dl(fetchImpl).catch((x) => x);
      expect(e.status).toBe(502);
      expect(e.message).toBe('Risposta non valida da Pexels');
      expect(calls).toHaveLength(1);
    }
  });
  it('rejects an Unsplash tracked url that is private', async () => {
    const { fetchImpl } = recorder((u) => (u.endsWith('/photos/abc') ? json({ user: { name: 'Bo' }, links: { download_location: 'https://api.unsplash.com/photos/abc/download' } })
      : json({ url: 'https://10.0.0.5/raw.jpg' })));
    const e = await stockDownload({ fetch: fetchImpl, apiKey: 'uk' }, { provider: 'unsplash', id: 'abc', kind: 'photo' }).catch((x) => x);
    expect(e.message).toBe('Risposta non valida da Unsplash');
  });
  it('rejects a redirect to a private host', async () => {
    const { calls, fetchImpl } = recorder((u) => (u === 'https://cdn.example/a.jpg' ? redirect('https://192.168.1.1/secret') : photo('https://cdn.example/a.jpg')(u)));
    const e = await dl(fetchImpl).catch((x) => x);
    expect(e.status).toBe(502);
    expect(e.message).toBe('Risposta non valida da Pexels');
    expect(calls.map((c) => c.url)).not.toContain('https://192.168.1.1/secret');
  });
  it('rejects a redirect downgraded to http and redirect loops', async () => {
    const { fetchImpl } = recorder((u) => (u.includes('/v1/photos/') ? photo('https://a.example/x')(u) : redirect('/again')));
    expect((await dl(fetchImpl).catch((x) => x)).message).toBe('Risposta non valida da Pexels');
    const { fetchImpl: f2 } = recorder((u) => (u.includes('/v1/photos/') ? photo('https://a.example/x')(u) : redirect('http://a.example/y')));
    expect((await dl(f2).catch((x) => x)).message).toBe('Risposta non valida da Pexels');
  });
  it('follows a normal redirect to another https CDN (manual mode, relative Location)', async () => {
    const { calls, fetchImpl } = recorder((u) => {
      if (u === 'https://cdn.example/a.jpg') return redirect('https://other-cdn.example/b.jpg');
      if (u === 'https://other-cdn.example/b.jpg') return redirect('/c.jpg');
      return photo('https://cdn.example/a.jpg')(u);
    });
    const d = await dl(fetchImpl);
    expect(d.ext).toBe('jpg');
    expect(calls.map((c) => c.url).slice(1)).toEqual(['https://cdn.example/a.jpg', 'https://other-cdn.example/b.jpg', 'https://other-cdn.example/c.jpg']);
    expect(calls.slice(1).every((c) => c.init.redirect === 'manual')).toBe(true);
  });
});

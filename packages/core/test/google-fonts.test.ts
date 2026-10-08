import { describe, expect, it } from 'vitest';
import { fetchGoogleFont, parseFontCss } from '../src/providers/google-fonts.ts';

const CSS = `@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/manrope/v1/a.ttf) format('truetype');
}
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/manrope/v1/b.ttf) format('truetype');
}`;

describe('parseFontCss', () => {
  it('extracts weight, style and url', () => {
    expect(parseFontCss(CSS)).toEqual([
      { weight: 400, italic: false, url: 'https://fonts.gstatic.com/s/manrope/v1/a.ttf' },
      { weight: 700, italic: false, url: 'https://fonts.gstatic.com/s/manrope/v1/b.ttf' },
    ]);
  });
});

describe('fetchGoogleFont', () => {
  it('requests the css2 API and downloads the files', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      urls.push(url);
      if (url.startsWith('https://fonts.googleapis.com/')) {
        expect((init.headers as Record<string, string>)['user-agent']).toBe('curl/8');
        return new Response(CSS, { status: 200, headers: { 'content-type': 'text/css' } });
      }
      return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'font/ttf' } });
    }) as unknown as typeof fetch;
    const files = await fetchGoogleFont({ fetch: fetchImpl }, { family: 'Source Sans 3', weights: [400, 700], italic: false });
    expect(urls[0]).toBe('https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;700');
    expect(files.map((f) => [f.weight, f.ext])).toEqual([[400, 'ttf'], [700, 'ttf']]);
  });
  it('validates the family and maps unknown fonts', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 400 })) as unknown as typeof fetch;
    expect((await fetchGoogleFont({ fetch: fetchImpl }, { family: 'Bad;Name', weights: [400], italic: false }).catch((e) => e)).status).toBe(400);
    expect((await fetchGoogleFont({ fetch: fetchImpl }, { family: 'Nope Font', weights: [400], italic: false }).catch((e) => e)).message).toBe('Font "Nope Font" non trovato su Google Fonts');
  });
  it('follows a redirect to another https host but refuses one to a private host', async () => {
    const make = (target: string) => (async (url: string, init: RequestInit = {}) => {
      if (url.startsWith('https://fonts.googleapis.com/')) return new Response(CSS, { status: 200 });
      if (url.endsWith('/a.ttf')) return new Response(null, { status: 302, headers: { location: target } });
      expect(init.redirect).toBe('manual');
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await fetchGoogleFont({ fetch: make('https://fonts.example/moved.ttf') }, { family: 'Manrope', weights: [400], italic: false });
    expect(ok).toHaveLength(2);
    const e = await fetchGoogleFont({ fetch: make('https://127.0.0.1/moved.ttf') }, { family: 'Manrope', weights: [400], italic: false }).catch((x) => x);
    expect(e.message).toBe('Risposta non valida da Google Fonts');
  });
});

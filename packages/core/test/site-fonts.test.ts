import { describe, expect, it } from 'vitest';
import { fetchTransport, type LookupFn } from '../src/providers/safe-fetch.ts';
import { googleFamilies, inspectSiteFonts, scanHtml, siteOf, type SiteFont } from '../src/brand/site-fonts.ts';

// Local fixtures only: a fake fetch serves the hostile site; the injected DNS answers decide which hosts are private.
type Route = (url: URL) => Response | Promise<Response>;
const PRIVATE = new Set(['intranet.acme.example', 'rebind.acme.example']);
const lookup: LookupFn = async (host) => [{ address: PRIVATE.has(host) ? '10.0.0.7' : '93.184.216.34', family: 4 }];
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
const css = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/css' } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

function site(routes: Record<string, Route | string>) {
  const sent: string[] = [];
  const f = (async (raw: string, init?: RequestInit) => {
    const u = new URL(raw);
    sent.push(u.href);
    if (init?.signal?.aborted) throw init.signal.reason;
    const r = routes[`${u.host}${u.pathname}`] ?? routes[u.href];
    if (r === undefined) return new Response('not found', { status: 404 });
    if (typeof r === 'string') return u.pathname.endsWith('.css') ? css(r) : html(r);
    return r(u);
  }) as unknown as typeof fetch;
  return { sent, deps: (o: { signal?: AbortSignal; timeoutMs?: number } = {}) => ({ fetch: { transport: fetchTransport(f), lookup }, signal: o.signal ?? new AbortController().signal, locale: 'en' as const, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) }) };
}
const byFamily = (fonts: SiteFont[], family: string) => fonts.find((f) => f.family === family);
const page = (head: string, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('inspectSiteFonts · a real-world page', () => {
  it('reports Google, Adobe, self-hosted and system fonts with roles, weights and files', async () => {
    const s = site({
      'acme.example/': page(`
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Lora:ital,wght@0,400;1,700&display=swap" rel="stylesheet">
        <link rel="stylesheet" href="https://use.typekit.net/abc1234.css">
        <link rel=stylesheet href="/css/site.css?v=3">
        <!-- <link rel="stylesheet" href="/css/commented.css"> -->
        <script>document.write('<link rel="stylesheet" href="/css/scripted.css">')</script>
        <style>body{font-family:Inter,sans-serif}p{font-family:"Lora",serif}</style>`),
      'use.typekit.net/abc1234.css': `@import url("https://p.typekit.net/p.css?s=1");@font-face{font-family:"proxima-nova";src:url("https://use.typekit.net/af/123/l?primer=x") format("woff2");font-weight:600;font-style:normal}h2{font-family:proxima-nova,sans-serif}`,
      'p.typekit.net/p.css': '/* tracking */',
      'acme.example/css/site.css': `@font-face{font-family:"Acme Display";src:url(../fonts/acme-display.woff2) format("woff2");font-weight:800}
        @font-face{font-family:"Acme Icons";src:url("data:font/woff2;base64,AAAA") format("woff2")}
        h1{font-family:"Acme Display",Georgia,serif}.btn,button{font-family:"Helvetica Neue",Arial,sans-serif;font-weight:700}`,
    });
    const out = await inspectSiteFonts(s.deps(), 'https://acme.example/');
    expect(out.warnings).toEqual([]);
    expect(byFamily(out.fonts, 'Inter')).toEqual({ family: 'Inter', roles: ['body'], weights: [400, 700], italic: false, source: 'google', files: [] });
    expect(byFamily(out.fonts, 'Lora')).toMatchObject({ roles: ['body'], weights: [400, 700], italic: true, source: 'google' });
    expect(byFamily(out.fonts, 'proxima-nova')).toMatchObject({ roles: ['heading'], weights: [600], source: 'adobe' });
    expect(byFamily(out.fonts, 'Acme Display')).toEqual({ family: 'Acme Display', roles: ['heading'], weights: [800], italic: false, source: 'self-hosted', files: [{ url: 'https://acme.example/fonts/acme-display.woff2', format: 'woff2', weight: 800 }] });
    expect(byFamily(out.fonts, 'Acme Icons')).toMatchObject({ roles: ['other'], source: 'self-hosted', files: [{ url: 'embedded', format: null, weight: null }] });
    expect(byFamily(out.fonts, 'Helvetica Neue')).toMatchObject({ roles: ['button'], weights: [700], source: 'system', files: [] });
    // Never the Google css (parsed from the link), never commented or scripted links, never the font files.
    expect(s.sent).toEqual(['https://acme.example/', 'https://use.typekit.net/abc1234.css', 'https://p.typekit.net/p.css?s=1', 'https://acme.example/css/site.css?v=3']);
  });

  it('follows font variables across stylesheets', async () => {
    const s = site({
      'acme.example/': page('<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css">'),
      'acme.example/a.css': ':root{--font-sans:"Manrope",system-ui;--font-body:var(--font-sans)}',
      'acme.example/b.css': 'body{font-family:var(--font-body)}h1{font:700 3rem/1 var(--font-sans)}',
    });
    const out = await inspectSiteFonts(s.deps(), 'https://acme.example/');
    expect(byFamily(out.fonts, 'Manrope')).toMatchObject({ roles: ['heading', 'body'], source: 'system' });
  });

  it('parses css and css2 Google links', () => {
    expect(googleFamilies(new URL('https://fonts.googleapis.com/css?family=Roboto:400,700italic|Open+Sans'))).toEqual([
      { family: 'Roboto', weights: [400, 700], italic: true }, { family: 'Open Sans', weights: [], italic: false },
    ]);
    expect(googleFamilies(new URL('https://fonts.googleapis.com/css2?family=Inter:wght@100..900&family=Noto+Serif'))).toEqual([
      { family: 'Inter', weights: [100, 900], italic: false }, { family: 'Noto Serif', weights: [], italic: false },
    ]);
  });

  it('siteOf groups hosts by registrable name', () => {
    expect(siteOf('www.acme.example')).toBe('acme.example');
    expect(siteOf('cdn.shop.acme.co.uk')).toBe('acme.co.uk');
    expect(siteOf('93.184.216.34')).toBe('93.184.216.34');
  });

  it('scanHtml takes stylesheets and preloaded styles, never other schemes', () => {
    const r = scanHtml('<LINK REL="Stylesheet" HREF="a.css"><link rel="preload" as="style" href="b.css" onload="this.rel=\'stylesheet\'"><link rel="stylesheet" href="javascript:alert(1)"><link rel="icon" href="x.ico">', new URL('https://acme.example/dir/'));
    expect(r.sheets.map((u) => u.href)).toEqual(['https://acme.example/dir/a.css', 'https://acme.example/dir/b.css']);
    expect(r.rejected).toEqual(['javascript:alert(1)']);
  });
});

describe('inspectSiteFonts · hostile sites (Review Focus 1)', () => {
  it.each([['127.0.0.1'], ['169.254.169.254']])('refuses a page that redirects to %s', async (ip) => {
    const s = site({ 'acme.example/': () => redirect(`http://${ip}/latest/meta-data/`) });
    const out = await inspectSiteFonts(s.deps(), 'https://acme.example/');
    expect(out.fonts).toEqual([]);
    expect(out.warnings).toEqual(['Site fonts: acme.example not read (address not allowed)']);
    expect(s.sent.some((u) => u.includes(ip))).toBe(false);
  });

  it('refuses stylesheets that redirect to private addresses or resolve to one, keeping the rest', async () => {
    const s = site({
      'acme.example/': page('<link rel="stylesheet" href="/evil.css"><link rel="stylesheet" href="https://intranet.acme.example/x.css"><link rel="stylesheet" href="/ok.css">'),
      'acme.example/evil.css': () => redirect('http://169.254.169.254/latest/meta-data/iam'),
      'acme.example/ok.css': 'body{font-family:Karla}',
    });
    const out = await inspectSiteFonts(s.deps(), 'https://acme.example/');
    expect(out.fonts.map((f) => f.family)).toEqual(['Karla']);
    expect(out.warnings).toEqual([
      'Site fonts: acme.example/evil.css not read (address not allowed)',
      'Site fonts: intranet.acme.example/x.css not read (address not allowed)',
    ]);
    expect(s.sent.some((u) => u.includes('169.254') || u.includes('intranet'))).toBe(false);
  });

  it('cuts @import cycles and reads each sheet once', async () => {
    const s = site({
      'acme.example/': page('<link rel="stylesheet" href="/a.css">'),
      'acme.example/a.css': '@import "b.css";h1{font-family:Alpha}',
      'acme.example/b.css': '@import url(/a.css);@import "b.css";body{font-family:Beta}',
    });
    const out = await inspectSiteFonts(s.deps(), 'https://acme.example/');
    expect(out.fonts.map((f) => f.family).sort()).toEqual(['Alpha', 'Beta']);
    expect(s.sent.filter((u) => u.endsWith('.css'))).toEqual(['https://acme.example/a.css', 'https://acme.example/b.css']);
    expect(out.warnings).toEqual(['Site fonts: acme.example/a.css imports itself in a loop: read once', 'Site fonts: acme.example/b.css imports itself in a loop: read once']);
  });

  it('stops imports nested deeper than 3 levels', async () => {
    const s = site({
      'acme.example/': page('<link rel="stylesheet" href="/l0.css">'),
      'acme.example/l0.css': '@import "l1.css";', 'acme.example/l1.css': '@import "l2.css";', 'acme.example/l2.css': '@import "l3.css";',
      'acme.example/l3.css': '@import "l4.css";h1{font-family:Deep}', 'acme.example/l4.css': 'body{font-family:TooDeep}',
    });
    const out = await inspectSiteFonts(s.deps(), 'https://acme.example/');
    expect(out.fonts.map((f) => f.family)).toEqual(['Deep']);
    expect(s.sent).not.toContain('https://acme.example/l4.css');
    expect(out.warnings).toEqual(['Site fonts: acme.example/l4.css not read (imports nested deeper than 3 levels)']);
  });

  it('reads at most 2 MB of a 50 MB stylesheet and keeps what it found', async () => {
    let produced = 0;
    const s = site({
      'acme.example/': page('<link rel="stylesheet" href="/huge.css">'),
      'acme.example/huge.css': () => {
        const head = new TextEncoder().encode('h1{font-family:"Big Sans"}');
        const block = new TextEncoder().encode(`.x{color:red}${' '.repeat(64 * 1024 - 13)}`);
        let first = true;
        return new Response(new ReadableStream<Uint8Array>({
          pull(c) {
            if (produced >= 50 * 1024 * 1024) { c.close(); return; }
            const chunk = first ? head : block;
            first = false;
            produced += chunk.byteLength;
            c.enqueue(chunk);
          },
        }), { status: 200, headers: { 'content-type': 'text/css' } });
      },
    });
    const out = await inspectSiteFonts(s.deps(), 'https://acme.example/');
    expect(out.fonts.map((f) => f.family)).toEqual(['Big Sans']);
    expect(produced).toBeLessThan(3 * 1024 * 1024);
    expect(out.warnings).toEqual(['Site fonts: acme.example/huge.css is larger than 2 MB: only the start was read']);
  });

  it('reads at most 2 MB of the page', async () => {
    const s = site({ 'acme.example/': `<style>body{font-family:Early}</style>${'x'.repeat(3 * 1024 * 1024)}<style>h1{font-family:Late}</style>` });
    const out = await inspectSiteFonts(s.deps(), 'https://acme.example/');
    expect(out.fonts.map((f) => f.family)).toEqual(['Early']);
    expect(out.warnings).toEqual(['Site fonts: acme.example is larger than 2 MB: only the start was read']);
  });

  it('keeps at most 2000 @font-face rules across stylesheets', async () => {
    const faces = (from: number) => Array.from({ length: 1500 }, (_, i) => `@font-face{font-family:F${from + i};src:url(/f/${from + i}.woff2)}`).join('');
    const s = site({
      'acme.example/': page('<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css">'),
      'acme.example/a.css': `${faces(0)}body{font-family:F1}`, 'acme.example/b.css': faces(1500),
    });
    const out = await inspectSiteFonts(s.deps(), 'https://acme.example/');
    expect(out.fonts).toHaveLength(40); // the reported list is capped too
    expect(out.fonts[0]!.family).toBe('F1');
    expect(out.warnings).toEqual(['Site fonts: more than 2000 @font-face rules: the others were ignored']);
  });

  it('reports data: fonts as embedded and ignores file: and javascript: addresses', async () => {
    const s = site({
      'acme.example/': page('<link rel="stylesheet" href="/f.css"><link rel="stylesheet" href="file:///etc/passwd">'),
      'acme.example/f.css': `@import url("file:///etc/fonts.css");@font-face{font-family:Inline;src:url(data:font/woff2;base64,AAAA)}@font-face{font-family:Local;src:url(file:///Library/Fonts/x.ttf),url("javascript:alert(1)")}body{font-family:Inline}`,
    });
    const out = await inspectSiteFonts(s.deps(), 'https://acme.example/');
    expect(byFamily(out.fonts, 'Inline')!.files).toEqual([{ url: 'embedded', format: null, weight: null }]);
    expect(byFamily(out.fonts, 'Local')!.files).toEqual([]);
    expect(out.warnings).toEqual(['Site fonts: file:… ignored (only http and https addresses)', 'Site fonts: 3 font addresses ignored (only http and https)']);
    expect(s.sent).toEqual(['https://acme.example/', 'https://acme.example/f.css']);
  });

  it('does not follow stylesheets on other domains unless they are font CDNs', async () => {
    const s = site({
      'acme.example/': page('<link rel="stylesheet" href="https://tracker.example/x.css"><link rel="stylesheet" href="https://static.acme.example/s.css"><link rel="stylesheet" href="https://fonts.bunny.net/css?family=nunito:400"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/fira-code/index.css">'),
      'static.acme.example/s.css': 'body{font-family:Static}',
      'fonts.bunny.net/css': '@font-face{font-family:Nunito;src:url(https://fonts.bunny.net/nunito/files/nunito-latin-400-normal.woff2) format("woff2");font-weight:400}',
      'cdn.jsdelivr.net/npm/@fontsource/fira-code/index.css': '@font-face{font-family:"Fira Code";src:url(./files/fira-code-latin-400-normal.woff2) format("woff2")}',
    });
    const out = await inspectSiteFonts(s.deps(), 'https://www.acme.example/'.replace('www.', ''));
    expect(out.fonts.map((f) => f.family).sort()).toEqual(['Fira Code', 'Nunito', 'Static']);
    expect(s.sent.some((u) => u.includes('tracker.example'))).toBe(false);
    expect(out.warnings).toEqual(['Site fonts: tracker.example/x.css not read (stylesheet on another site)']);
  });

  it('fetches at most 20 stylesheets', async () => {
    const routes: Record<string, string> = { 'acme.example/': page(Array.from({ length: 30 }, (_, i) => `<link rel="stylesheet" href="/s${i}.css">`).join('')) };
    for (let i = 0; i < 30; i++) routes[`acme.example/s${i}.css`] = `.c${i}{font-family:S${i}}`;
    const s = site(routes);
    const out = await inspectSiteFonts(s.deps(), 'https://acme.example/');
    expect(s.sent.filter((u) => u.endsWith('.css'))).toHaveLength(20);
    expect(out.fonts).toHaveLength(20);
    expect(out.warnings).toEqual(['Site fonts: more than 20 stylesheets: the others were not read']);
  });

  it('stops at the deadline with a partial result', async () => {
    const s = site({
      'acme.example/': page('<style>body{font-family:Fast}</style><link rel="stylesheet" href="/slow.css">'),
      'acme.example/slow.css': (u) => new Promise<Response>(() => { void u; }),
    });
    const t0 = Date.now();
    const out = await inspectSiteFonts(s.deps({ timeoutMs: 100 }), 'https://acme.example/');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out.fonts.map((f) => f.family)).toEqual(['Fast']);
    expect(out.warnings).toEqual(['Site fonts: stopped after 0 s: partial result']);
  });

  it('stops a body that never ends at the deadline', async () => {
    const s = site({
      'acme.example/': page('<link rel="stylesheet" href="/drip.css">'),
      'acme.example/drip.css': () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('body{font-family:Drip}')); } }), { status: 200 }),
    });
    const out = await inspectSiteFonts(s.deps({ timeoutMs: 100 }), 'https://acme.example/');
    expect(out.warnings).toEqual(['Site fonts: stopped after 0 s: partial result']);
  });

  it('throws when the job is cancelled', async () => {
    const ac = new AbortController();
    const s = site({ 'acme.example/': () => { ac.abort(new Error('cancelled')); return html('<style>body{font-family:X}</style>'); } });
    await expect(inspectSiteFonts(s.deps({ signal: ac.signal }), 'https://acme.example/')).rejects.toThrow();
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'ftp://acme.example/'])('refuses the page address %s without a request', async (url) => {
    const s = site({});
    const out = await inspectSiteFonts(s.deps(), url);
    expect(out.fonts).toEqual([]);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/ignored \(only http and https addresses\)$/);
    expect(s.sent).toEqual([]);
  });

  it('reports an error status and an unreachable host as warnings', async () => {
    const s = site({
      'acme.example/': page('<link rel="stylesheet" href="/missing.css"><link rel="stylesheet" href="/down.css">'),
      'acme.example/down.css': () => { throw new TypeError('fetch failed'); },
    });
    const out = await inspectSiteFonts(s.deps(), 'https://acme.example/');
    expect(out.warnings).toEqual(['Site fonts: acme.example/missing.css answered 404', 'Site fonts: acme.example/down.css not reachable']);
  });

  it('words the warnings in the job language', async () => {
    const s = site({ 'acme.example/': () => redirect('http://127.0.0.1/') });
    const out = await inspectSiteFonts({ ...s.deps(), locale: 'it' }, 'https://acme.example/');
    expect(out.warnings).toEqual(['Font del sito: acme.example non letto (indirizzo non consentito)']);
  });
});

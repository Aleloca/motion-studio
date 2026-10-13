import { describe, expect, it } from 'vitest';
import { newScanBudget, scanCss, selectorRoles } from '../src/brand/css-scan.ts';

const base = new URL('https://acme.example/css/site.css');
const scan = (css: string, budget = newScanBudget()) => scanCss(css, base, budget);
const roles = (css: string, family: string) => [...(scan(css).families.get(family.toLowerCase())?.roles ?? [])].sort();

describe('scanCss · fixtures', () => {
  it('maps selectors to roles and keeps the first non-generic family of each stack', () => {
    const css = `
      body { font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif; }
      h1, h2 { font-family: 'Playfair Display', Georgia, serif; font-weight: 700 }
      .hero h3 { font: italic 600 2rem/1.1 "Playfair Display", serif; }
      button, .btn { font-family: "Space Grotesk", system-ui; }
      .nav a { font-family: Inter; }
      code { font-family: ui-monospace, monospace; }`;
    const s = scan(css);
    expect([...s.families.keys()].sort()).toEqual(['inter', 'playfair display', 'space grotesk']);
    expect(roles(css, 'Inter')).toEqual(['body', 'other']);
    expect(roles(css, 'Playfair Display')).toEqual(['heading']);
    expect(roles(css, 'Space Grotesk')).toEqual(['button']);
    const pf = s.families.get('playfair display')!;
    expect([...pf.weights].sort()).toEqual([600, 700]);
    expect(pf.italic).toBe(true);
  });

  it('reads @font-face rules with relative, absolute and data: sources', () => {
    const css = `@font-face{font-family:"Acme Sans";src:url(../fonts/acme-400.woff2) format("woff2"),url('https://cdn.acme.example/acme-400.woff') format('woff');font-weight:400;font-style:normal}
@font-face { font-family: 'Acme Sans'; src: local("Acme"), url("data:font/woff2;base64,d09GMgABAAAAA{};}") format("woff2"); font-weight: 100 900; font-style: italic; }`;
    const s = scan(css);
    expect(s.faces).toEqual([
      { family: 'Acme Sans', weights: [400], italic: false, embedded: false, files: [
        { url: 'https://acme.example/fonts/acme-400.woff2', format: 'woff2' },
        { url: 'https://cdn.acme.example/acme-400.woff', format: 'woff' },
      ] },
      { family: 'Acme Sans', weights: [100, 900], italic: true, embedded: true, files: [] },
    ]);
  });

  it('survives minified CSS, comments and strings containing braces and semicolons', () => {
    const css = '/* body { font-family: Nope } */.a{content:"}{;"}p{font-family:"Lora"/* } */;color:red}h2::before{content:\'{\'}h2{font-family:Merriweather}@media (min-width:600px){h1{font-family:"Bebas Neue"}}@keyframes x{from{font-family:Nope2}}';
    const s = scan(css);
    expect([...s.families.keys()].sort()).toEqual(['bebas neue', 'lora', 'merriweather']);
    expect(roles(css, 'Lora')).toEqual(['body']);
    expect(roles(css, 'Bebas Neue')).toEqual(['heading']);
  });

  it('collects @import addresses and Google Fonts links, resolving relative ones', () => {
    const s = scan(`@charset "utf-8";@import url("base.css");@import 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap';@import url(//use.typekit.net/abc1234.css) screen;`);
    expect(s.imports.map((u) => u.href)).toEqual(['https://acme.example/css/base.css', 'https://use.typekit.net/abc1234.css']);
    expect(s.googleLinks.map((u) => u.hostname)).toEqual(['fonts.googleapis.com']);
  });

  it('records font variables and their uses for later resolution', () => {
    const s = scan(':root{--font-heading:"Fraunces",serif;--brand-color:#fff}h1{font-family:var(--font-heading)}');
    expect(s.variables.get('--font-heading')).toBe('"Fraunces",serif');
    expect(s.variables.has('--brand-color')).toBe(false);
    expect(s.varUses).toEqual([{ name: '--font-heading', roles: ['heading'], weights: [], italic: false }]);
  });

  it.each([
    ['700 16px/1.5 "Inter", sans-serif', 'Inter'],
    ['italic bold 12px / 30px Georgia, serif', 'Georgia'],
    ['clamp(1rem, 2vw + .5rem, 2rem)/1.2 "Fraunces"', 'Fraunces'],
    ['small-caps 600 calc(1rem + 2px) Lato', 'Lato'],
    ['1.25em "Open Sans",Arial', 'Open Sans'],
    ['100% Karla', 'Karla'],
    ['x-large/110% "New Century Schoolbook", serif', 'New Century Schoolbook'],
  ])('reads the family of the font shorthand %s', (value, family) => {
    expect([...scan(`h1{font:${value}}`).families.values()].map((u) => u.family)).toEqual([family]);
  });
  it('keeps a shorthand made of one variable for later resolution', () => {
    expect(scan('h1{font:var(--font-display)}').varUses).toEqual([{ name: '--font-display', roles: ['heading'], weights: [], italic: false }]);
  });
  it('ignores a font shorthand without a size or with unbalanced functions', () => {
    expect(scan('h1{font:caption}h2{font:bold calc(1rem "X"}').families.size).toBe(0);
  });
  it('handles nested rules (CSS nesting) with their own selector', () => {
    const s = scan('.card { font-family: Inter; & h2 { font-family: Outfit } }');
    expect([...s.families.get('outfit')!.roles]).toEqual(['heading']);
    expect([...s.families.get('inter')!.roles]).toEqual(['other']);
  });

  it('selectorRoles: only the subject of each selector counts', () => {
    expect(selectorRoles('h1 span')).toEqual(['other']);
    expect(selectorRoles('main > p.lead')).toEqual(['body']);
    expect(selectorRoles('a.btn:hover, .footer button')).toEqual(['button']);
    expect(selectorRoles('h4')).toEqual(['other']);
  });
});

describe('scanCss · hostile input', () => {
  it('refuses file:, javascript: and other schemes in url(), counting them', () => {
    const s = scan(`@import url("file:///etc/passwd");@import "javascript:alert(1)";@font-face{font-family:X;src:url(file:///etc/x.woff2),url("javascript:alert(1)"),url(ftp://acme.example/x.woff),url(/ok.woff2)}`);
    expect(s.imports).toEqual([]);
    expect(s.faces[0]!.files).toEqual([{ url: 'https://acme.example/ok.woff2', format: null }]);
    expect(s.rejected).toBe(5);
  });

  it('stops collecting @font-face rules at the shared budget', () => {
    const budget = newScanBudget(2000);
    const one = (i: number) => `@font-face{font-family:F${i};src:url(/f${i}.woff2)}`;
    const s1 = scan(Array.from({ length: 1500 }, (_, i) => one(i)).join(''), budget);
    const s2 = scan(Array.from({ length: 1500 }, (_, i) => one(i + 1500)).join(''), budget);
    expect(s1.faces).toHaveLength(1500);
    expect(s2.faces).toHaveLength(500);
    expect(budget.facesTruncated).toBe(true);
  });

  it('caps the families it keeps', () => {
    const s = scan(Array.from({ length: 5000 }, (_, i) => `.c${i}{font-family:Family${i}}`).join(''));
    expect(s.families.size).toBe(300);
  });

  const MB5 = 5 * 1024 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(MB5 / unit.length)).slice(0, MB5);
  it.each([
    ['deeply nested braces', fill('{')],
    ['unbalanced closing braces', fill('}')],
    ['an unterminated comment', `a{font-family:X}/*${fill('x')}`],
    ['unterminated strings', fill('"{;\n')],
    ['unterminated url(', fill('url(')],
    ['open parentheses', fill('(')],
    ['many tiny rules', fill('h1{font-family:A;font-weight:700}')],
    ['many @font-face rules', fill('@font-face{font-family:F;src:url(/a.woff2) format("woff2"),url(data:x;base64,AAAA)}')],
    ['huge selector lists', fill('h1,p,.btn,a b>c~d+e,') + '{font-family:Z}'],
    ['font shorthands with unclosed calc( chains', fill('p{font: calc( calc( calc( calc( }')],
    ['font shorthands with long unclosed functions', fill(`h1{font:bold ${'min( '.repeat(200)}x}`)],
    ['one huge declaration', `p{font-family:${fill('A,')}}`],
    ['a mix', fill('@media x{@supports y{.a{font:700 1em/1 "Q",serif;--font-x:"R";font-family:var(--font-x)}}}/**/"\'}')],
  ])('scans 5 MB of %s in under 200 ms', (_name, css) => {
    // The best of two runs: a GC pause or a busy machine must not make a linear scan look slow.
    const times = [0, 1].map(() => { const t0 = performance.now(); scanCss(css, base, newScanBudget()); return performance.now() - t0; });
    expect(Math.min(...times)).toBeLessThan(200);
  });
});

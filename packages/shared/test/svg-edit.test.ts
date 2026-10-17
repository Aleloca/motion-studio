// @vitest-environment jsdom
/**
 * The SVG-edit model (SVG inner editor, Task 1): colours (attributes, `style`, `<style>`, stop-color; one entry per colour
 * however it is written), replacement that touches only the colour tokens, texts with tspans, the element list with
 * labels, paint, visibility, the path round trip and serialisation.
 */
import { describe, expect, it } from 'vitest';
import {
  elementAt, listColors, listElements, listTexts, parseSvg, pathOf, replaceColor, serializeSvg, setElementPaint, setHidden, setText,
  type SvgDoc,
} from '../src/index.ts';

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const doc = (inner: string, attrs = 'viewBox="0 0 100 100"'): SvgDoc => {
  const r = parseSvg(`<svg ${NS} ${attrs}>${inner}</svg>`);
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};
const canonical = (text: string) => {
  const r = parseSvg(text);
  if (!r.ok) throw new Error(r.reason);
  return serializeSvg(r.doc);
};

describe('parseSvg', () => {
  it('parses an SVG, refuses malformed XML and a root that is not <svg> in the SVG namespace', () => {
    expect(parseSvg(`<svg ${NS}/>`).ok).toBe(true);
    expect(parseSvg(`<svg ${NS}><g>`)).toEqual({ ok: false, reason: 'parse' });
    expect(parseSvg('not xml at all <')).toEqual({ ok: false, reason: 'parse' });
    expect(parseSvg('<html xmlns="http://www.w3.org/1999/xhtml"/>')).toEqual({ ok: false, reason: 'not-svg' });
    expect(parseSvg('<svg/>')).toEqual({ ok: false, reason: 'not-svg' });
  });

  it('serialising an untouched document keeps it equivalent', () => {
    const src = `<?xml version="1.0"?><svg ${NS} viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>`
      + `<style><![CDATA[.a{fill:red}]]></style><!-- note --><g id="x"><path d="M0 0h10" fill="url(#g)"/></g><text x="1">Hi <tspan>there</tspan></text></svg>`;
    const once = canonical(src);
    expect(canonical(once)).toBe(once);
    expect(once).toContain('<![CDATA[.a{fill:red}]]>');
    expect(once).toContain('fill="url(#g)"');
  });
});

describe('colours', () => {
  it('reads attributes, style properties, <style> text and stop-color; counts and orders them', () => {
    const d = doc(
      '<style>.a { fill: #ff0000; stroke: blue } #logo .b{stop-color:#00f}</style>'
      + '<defs><linearGradient id="g"><stop offset="0" stop-color="#00FF00"/><stop offset="1" style="stop-color: #0f0"/></linearGradient></defs>'
      + '<rect fill="#ff0000" stroke="#000"/><circle style="fill:red;opacity:0.5"/><path flood-color="#123456" lighting-color="#123456" color="#123456"/>',
    );
    expect(listColors(d)).toEqual([
      { hex: '#ff0000', count: 3 },
      { hex: '#123456', count: 3 },
      { hex: '#0000ff', count: 2 },
      { hex: '#00ff00', count: 2 },
      { hex: '#000000', count: 1 },
    ]);
  });

  it('orders by count, then first appearance', () => {
    const d = doc('<rect fill="#111"/><rect fill="#222"/><rect fill="#222"/><rect fill="#333"/>');
    expect(listColors(d).map((c) => c.hex)).toEqual(['#222222', '#111111', '#333333']);
  });

  it('one entry for every spelling of a colour, with alpha kept apart', () => {
    const d = doc('<rect fill="#FFF"/><rect fill="#ffffff"/><rect fill="white"/><rect fill="rgb(255,255,255)"/><rect fill="rgb(255 255 255)"/>'
      + '<rect fill="WHITE"/><rect fill="#ffff"/><rect fill="rgba(255, 255, 255, 0.5)"/><rect fill="#ffffff80"/>');
    expect(listColors(d)).toEqual([{ hex: '#ffffff', count: 7 }, { hex: '#ffffff80', count: 2 }]);
  });

  it('ignores none, currentColor, inherit, transparent, url(…) and non-colour attributes', () => {
    const d = doc('<rect fill="none" stroke="currentColor"/><rect fill="inherit" stroke="transparent"/><rect fill="url(#abc)"/>'
      + '<rect id="red" class="blue" fill="url(#g) #f00"/><style>#fab { fill: url(#bad) } .red { stroke: none }</style>');
    expect(listColors(d)).toEqual([{ hex: '#ff0000', count: 1 }]);
  });

  it('replaces every spelling and returns the occurrences changed', () => {
    const d = doc('<rect fill="#FFF"/><rect stroke="white"/><rect style="fill: rgb(255,255,255)"/><style>.a{fill:#fff}</style><rect fill="#000"/>');
    expect(replaceColor(d, '#ffffff', '#ff5a1f')).toBe(4);
    expect(listColors(d)).toEqual([{ hex: '#ff5a1f', count: 4 }, { hex: '#000000', count: 1 }]);
    expect(replaceColor(d, '#abcdef', '#000000')).toBe(0);
  });

  it('CSS stays byte-identical except the colour tokens', () => {
    const css = '/* keep: fill:white */ #logo .b path, .fab{ fill : White !important; stroke-width:2px; clip-path:url(#c1); stop-color:#FFF }';
    const d = doc(`<style>${css}</style><rect style="  fill:white ;opacity: .5;mask:url(#fff)"/>`);
    expect(replaceColor(d, '#fff', '#0a0b0c')).toBe(3);
    const out = serializeSvg(d);
    expect(out).toContain('/* keep: fill:white */ #logo .b path, .fab{ fill : #0a0b0c !important; stroke-width:2px; clip-path:url(#c1); stop-color:#0a0b0c }');
    expect(out).toContain('style="  fill:#0a0b0c ;opacity: .5;mask:url(#fff)"');
  });

  it('refuses a target that is not a colour', () => {
    const d = doc('<rect fill="#000"/>');
    expect(() => replaceColor(d, '#000', 'red;}')).toThrow();
  });
});

describe('texts', () => {
  it('lists <text> elements, tspans joined by line, and sets them', () => {
    const d = doc('<g><text x="1">Acme</text></g><text><tspan x="0" dy="1em">Hello</tspan><tspan x="0" dy="1em">world</tspan></text>');
    expect(listTexts(d)).toEqual([{ path: '0/0', text: 'Acme' }, { path: '1', text: 'Hello\nworld' }]);
    setText(d, '0/0', 'Acme & Co <1>');
    setText(d, '1', 'Ciao\nmondo');
    expect(listTexts(d)).toEqual([{ path: '0/0', text: 'Acme & Co <1>' }, { path: '1', text: 'Ciao\nmondo' }]);
    expect(serializeSvg(d)).toContain('<tspan x="0" dy="1em">Ciao</tspan><tspan x="0" dy="1em">mondo</tspan>');
    expect(serializeSvg(d)).toContain('Acme &amp; Co &lt;1&gt;');
    // More lines than tspans: the rest go on the last one; fewer: the others are emptied.
    setText(d, '1', 'a\nb\nc');
    expect(listTexts(d)[1]!.text).toBe('a\nb c');
    setText(d, '1', 'solo');
    expect(listTexts(d)[1]!.text).toBe('solo\n');
  });

  it('mixed content: direct text is part of the first line, and a <title> or other child elements stay', () => {
    const d = doc('<text><title>Brand line</title>Acme <desc>d</desc>Corp</text>'
      + '<text>\n  Hello <tspan x="0" dy="1em">world</tspan>\n  <tspan x="0" dy="1em">again</tspan>\n</text>');
    expect(listTexts(d)).toEqual([{ path: '0', text: 'Acme Corp' }, { path: '1', text: 'Hello world\nagain' }]);
    setText(d, '0', 'Beta');
    setText(d, '1', 'Ciao mondo\nancora');
    const out = serializeSvg(d);
    expect(out).toContain('<title>Brand line</title>');
    expect(out).toContain('<desc>d</desc>');
    expect(out).toContain('<tspan x="0" dy="1em">Ciao mondo</tspan>');
    expect(out).toContain('<tspan x="0" dy="1em">ancora</tspan>');
    expect(listTexts(d)).toEqual([{ path: '0', text: 'Beta' }, { path: '1', text: 'Ciao mondo\nancora' }]);
    // A <text> with only a title gets its text after it.
    const e = doc('<text><title>t</title></text>');
    expect(listTexts(e)).toEqual([{ path: '0', text: '' }]);
    setText(e, '0', 'New');
    expect(serializeSvg(e)).toContain('<title>t</title>New');
  });

  it('setText on a path that is not a <text> throws', () => {
    const d = doc('<rect/>');
    expect(() => setText(d, '0', 'x')).toThrow();
    expect(() => setText(d, '5', 'x')).toThrow();
  });
});

describe('elements', () => {
  const sample = () => doc(
    '<title>Logo</title><defs><path id="inner" d="M0 0"/></defs>'
    + '<g id="mark"><path d="M0 0" fill="#F00"/><rect style="stroke: blue" fill="url(#g)"/></g>'
    + '<g><title>Scritta</title><text>Acme</text><circle display="none"/></g><path d="M1 1"/><use href="#inner"/>',
  );

  it('lists the drawn elements with labels, depth, paint and visibility; defs and metadata are left out', () => {
    expect(listElements(sample())).toEqual([
      { path: '2', tag: 'g', label: 'mark', named: true, index: 1, depth: 0, hidden: false },
      { path: '2/0', tag: 'path', label: 'path 1', named: false, index: 1, depth: 1, fill: '#ff0000', hidden: false },
      { path: '2/1', tag: 'rect', label: 'rect 1', named: false, index: 1, depth: 1, fill: 'url(#g)', stroke: '#0000ff', hidden: false },
      { path: '3', tag: 'g', label: 'Scritta', named: true, index: 2, depth: 0, hidden: false },
      { path: '3/1', tag: 'text', label: 'text 1', named: false, index: 1, depth: 1, hidden: false },
      { path: '3/2', tag: 'circle', label: 'circle 1', named: false, index: 1, depth: 1, hidden: true },
      { path: '4', tag: 'path', label: 'path 2', named: false, index: 2, depth: 0, hidden: false },
      { path: '5', tag: 'use', label: 'use 1', named: false, index: 1, depth: 0, hidden: false },
    ]);
  });

  it('setElementPaint changes only that element: a style property in place, else the attribute', () => {
    const d = sample();
    setElementPaint(d, '2/1', { stroke: '#112233' });
    setElementPaint(d, '2/0', { fill: '#00ff00', stroke: '#000000' });
    const els = listElements(d);
    expect(els.find((e) => e.path === '2/1')).toMatchObject({ fill: 'url(#g)', stroke: '#112233' });
    expect(els.find((e) => e.path === '2/0')).toMatchObject({ fill: '#00ff00', stroke: '#000000' });
    expect(serializeSvg(d)).toContain('style="stroke: #112233"');
    expect(els.find((e) => e.path === '4')).not.toHaveProperty('fill');
    setElementPaint(d, '4', { fill: 'none' });
    expect(elementAt(d, '4')!.getAttribute('fill')).toBe('none');
    expect(() => setElementPaint(d, '4', { fill: 'url(http://x)' })).toThrow();
  });

  it('setHidden puts display="none" on and removes it off', () => {
    const d = sample();
    setHidden(d, '2', true);
    expect(elementAt(d, '2')!.getAttribute('display')).toBe('none');
    expect(listElements(d).find((e) => e.path === '2')!.hidden).toBe(true);
    setHidden(d, '3/2', false);
    expect(elementAt(d, '3/2')!.hasAttribute('display')).toBe(false);
    expect(listElements(d).find((e) => e.path === '3/2')!.hidden).toBe(false);
  });

  it('pathOf and elementAt are inverse, also on a clone with the same structure', () => {
    const d = sample();
    const root = d.documentElement;
    for (const e of listElements(d)) expect(pathOf(root, elementAt(d, e.path)!)).toBe(e.path);
    expect(elementAt(d, '')).toBe(root);
    expect(pathOf(root, root)).toBe('');
    expect(elementAt(d, '9/9')).toBeNull();
    expect(elementAt(d, 'x')).toBeNull();
    const clone = root.cloneNode(true) as Element;
    const inClone = clone.children[3]!.children[2]!;
    expect(pathOf(clone, inClone)).toBe('3/2');
    expect(pathOf(clone, root.children[0]!)).toBeNull();
  });
});

// @vitest-environment node
/**
 * The strict SVG check of the identity formats (Phase 14, spec §4.2, decision 727; plan Review Focus 3) and the vector
 * composition check (decision 726, 728).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Composition, FormatPreset } from '@motion-studio/shared';
import { checkTargets, identityProblems } from '../src/creatives/composition-contract.ts';
import { checkVectorComposition, checkVectorSvg, svgAspect } from '../src/identity/svg-check.ts';

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const svg = (body: string, attrs = '') => `<svg ${NS} viewBox="0 0 100 100"${attrs}>${body}</svg>`;
const refused = (s: string) => {
  const r = checkVectorSvg(s);
  expect(r.ok, s.slice(0, 200)).toBe(false);
  return r.ok ? [] : r.reasons;
};
const accepted = (s: string) => {
  const r = checkVectorSvg(s);
  expect(r, s.slice(0, 200)).toMatchObject({ ok: true });
  return r.ok ? r.warnings : [];
};

describe('checkVectorSvg: accepted', () => {
  it('a clean logo with gradients, clip paths, local use, filters and a style element', () => {
    const s = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512" width="512" height="512">
  <title>Acme</title>
  <defs>
    <linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>
    <clipPath id="c"><circle cx="256" cy="256" r="200"/></clipPath>
    <filter id="f"><feGaussianBlur stdDeviation="2"/></filter>
    <path id="p" d="M0 0L10 10Z"/>
    <style><![CDATA[ .a { fill: url(#g); } ]]></style>
  </defs>
  <g clip-path="url(#c)" filter="url( '#f' )" style="fill:url(#g);stroke:#000">
    <rect class="a" width="512" height="512" fill="url(#g)"/>
    <use href="#p"/><use xlink:href="#p" x="10"/>
  </g>
</svg>`;
    expect(accepted(s)).toEqual([]);
  });

  it('<text> is accepted with a warning', () => {
    const w = accepted(svg('<text x="10" y="50">Acme</text>'));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/text/);
  });

  it('a prefixed SVG namespace is fine when it is the SVG namespace', () => {
    accepted('<s:svg xmlns:s="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><s:rect width="10" height="10"/></s:svg>');
  });

  it('svgAspect reads the viewBox', () => {
    expect(svgAspect(`<svg ${NS} viewBox="0 0 400 100"/>`)).toEqual({ width: 400, height: 100 });
    expect(svgAspect(`<svg ${NS}/>`)).toBeNull();
  });
});

describe('checkVectorSvg: refused (Review Focus 3)', () => {
  it('<script>, in any spelling of the namespace', () => {
    expect(refused(svg('<script>alert(1)</script>')).join()).toMatch(/script/);
    expect(refused(`<svg ${NS} xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><svg:script>alert(1)</svg:script></svg>`).join()).toMatch(/script/);
    // XML names are case-sensitive: <SCRIPT> is not the script element, and not on the allowlist either.
    refused(svg('<SCRIPT>alert(1)</SCRIPT>'));
    // An inner element that switches to the XHTML namespace.
    expect(refused(svg('<g xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></g>')).join()).toMatch(/namespace/);
  });

  it('on* event handlers, any case, any prefix', () => {
    expect(refused(svg('<rect width="1" height="1"/>', ' onload="alert(1)"')).join()).toMatch(/event handler/);
    refused(svg('<rect ONCLICK="x()" width="1" height="1"/>'));
    refused(svg('<rect onmouseover = \'x()\' width="1" height="1"/>'));
    refused(`<svg ${NS} xmlns:x="urn:x" viewBox="0 0 1 1"><rect x:onload="a()"/></svg>`);
  });

  it('<foreignObject>', () => {
    expect(refused(svg('<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>')).join()).toMatch(/foreignObject/);
  });

  it('external, javascript: and data: links, entity tricks included', () => {
    const xl = `xmlns:xlink="http://www.w3.org/1999/xlink"`;
    expect(refused(`<svg ${NS} ${xl} viewBox="0 0 1 1"><use xlink:href="https://evil.example/a.svg#x"/></svg>`).join()).toMatch(/local #id/);
    refused(svg('<use href="other.svg#x"/>'));
    refused(svg('<use href="  //evil.example/x.svg#a"/>'));
    refused(svg('<use href="&#x6A;avascript:alert(1)"/>'));
    refused(svg('<use href="&#106;avascript:alert(1)"/>'));
    refused(svg('<use href="data:image/svg+xml;base64,PHN2Zy8+"/>'));
    // Another prefix bound to the XLink namespace is still xlink:href.
    refused(`<svg ${NS} xmlns:q="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><use q:href="https://evil.example/x"/></svg>`);
    refused(svg('<a href="#x"><rect width="1" height="1"/></a>'));
  });

  it('<image href="data:…">, and images of any kind', () => {
    expect(refused(svg('<image href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"/>')).join()).toMatch(/images/);
    refused(svg('<image href="#a"/>'));
    refused(svg('<filter id="f"><feImage href="https://x.example/a.png"/></filter>'));
  });

  it('url(…) in a style attribute, a presentation attribute or a <style>, unless it is a local #id', () => {
    expect(refused(svg('<rect width="1" height="1" style="background:url(https://evil.example/a.png)"/>')).join()).toMatch(/url/);
    refused(svg('<rect width="1" height="1" fill="url(https://evil.example/p.svg#g)"/>'));
    refused(svg('<rect width="1" height="1" style="fill:url( \'data:image/png;base64,AA\' )"/>'));
    refused(svg('<style>rect { fill: url("//evil.example/x#a") }</style>'));
    // CSS escapes and comments cannot spell url or import.
    refused(svg('<rect width="1" height="1" style="fill:u\\72l(https://evil.example/a)"/>'));
    refused(svg('<rect width="1" height="1" style="background:ur/**/l(https://evil.example/a)"/>'));
    refused(svg('<rect width="1" height="1" style="background-image:image-set(\'https://evil.example/a.png\' 1x)"/>'));
    refused(svg('<style>/* unclosed comment</style>'));
    refused(svg('<rect width="1" height="1" style="fill:url(#a" />'));
  });

  it('@import in a <style>, plain, as an entity or in CDATA', () => {
    expect(refused(svg('<style>@import url(#x); rect{fill:red}</style>')).join()).toMatch(/@import/);
    refused(svg('<style>&#64;import "https://evil.example/a.css";</style>'));
    refused(svg('<style><![CDATA[@import "https://evil.example/a.css";]]></style>'));
    refused(svg('<style>@font-face { font-family: x; }</style>'));
    refused(svg('<style type="text/ecmascript">x</style>'));
  });

  it('a file over 512 KB', () => {
    const big = svg(`<path d="M0 0${' L1 1'.repeat(130_000)}"/>`);
    expect(Buffer.byteLength(big)).toBeGreaterThan(600_000);
    expect(refused(big).join()).toMatch(/512 KB/);
  });

  it('malformed XML: an unclosed tag and its friends', () => {
    expect(refused(`<svg ${NS} viewBox="0 0 1 1"><g><rect/></svg>`).join()).toMatch(/malformed/);
    expect(refused(`<svg ${NS} viewBox="0 0 1 1"><rect`).join()).toMatch(/malformed/);
    refused(`<svg ${NS} viewBox="0 0 1 1">`);
    refused(`<svg ${NS} viewBox="0 0 1 1"><rect width=1/></svg>`);
    refused(`<svg ${NS} viewBox="0 0 1 1"><rect width="1" width="2"/></svg>`);
    refused(`<svg ${NS} viewBox="0 0 1 1"><title>a & b</title></svg>`);
    refused(`<svg ${NS} viewBox="0 0 1 1"><title>&nbsp;</title></svg>`);
    refused(`<svg ${NS} viewBox="0 0 1 1"/><svg ${NS} viewBox="0 0 1 1"/>`);
    refused(`<svg ${NS} viewBox="0 0 1 1"/>trailing`);
    refused(`<svg ${NS} viewBox="0 0 1 1"><!-- a -- b --></svg>`);
    refused(`<svg ${NS} viewBox="0 0 1 1"><![CDATA[x</svg>`);
    refused(`<svg ${NS} viewBox="0 0 1 1"><x:rect/></svg>`);
    refused(`<svg ${NS} viewBox="0 0 1 1"><title>\u0001</title></svg>`);
    refused('');
  });

  it('DOCTYPE, ENTITY (XXE) and processing instructions', () => {
    expect(refused(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg ${NS} viewBox="0 0 1 1"><title>&x;</title></svg>`).join()).toMatch(/DOCTYPE/);
    refused(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg ${NS} viewBox="0 0 1 1"/>`);
    refused(`<?xml-stylesheet href="https://evil.example/a.css"?><svg ${NS} viewBox="0 0 1 1"/>`);
    refused(svg('<?php echo 1 ?>'));
  });

  it('a root that is not an SVG in the SVG namespace, or without a viewBox', () => {
    refused('<svg viewBox="0 0 1 1"/>');
    refused(`<html xmlns="http://www.w3.org/1999/xhtml"/>`);
    expect(refused(`<svg ${NS} width="10" height="10"/>`).join()).toMatch(/viewBox/);
    refused(`<svg ${NS} viewBox="0 0 0 10"/>`);
  });

  it('animation, xml:base and foreign attributes', () => {
    refused(svg('<rect width="1" height="1"><set attributeName="href" to="javascript:alert(1)"/></rect>'));
    refused(svg('<animate attributeName="x" values="0;1"/>'));
    refused(svg('<g xml:base="https://evil.example/"><use href="#a"/></g>'));
    refused(`<svg ${NS} xmlns:i="http://ns.adobe.com/x" viewBox="0 0 1 1"><rect i:data="x"/></svg>`);
  });
});

describe('checkVectorComposition (decisions 726, 728)', () => {
  const base = (clips: unknown[], extra: Partial<Composition> = {}): Composition => ({
    $schema: 'motion-studio/composition@1', width: 1024, height: 1024, fps: 30, duration: 0, background: '#00000000', fonts: [], scenes: [],
    tracks: [{ id: 't', kind: 'visual', clips }], ...extra,
  }) as unknown as Composition;
  const mark = { id: 'mark', type: 'svg', src: 'assets/logo.svg', start: 0, duration: 0, props: { fit: 'contain' } };

  it('one full-frame svg clip passes, with or without an explicit box', () => {
    expect(checkVectorComposition(base([mark]))).toEqual({ ok: true, svgFile: 'assets/logo.svg' });
    expect(checkVectorComposition(base([{ ...mark, props: { x: 0, y: 0, width: 1024, height: 1024, fit: 'contain' } }]))).toMatchObject({ ok: true });
  });

  it('a hidden "small" svg clip is the small variant', () => {
    const small = { ...mark, id: 'small', src: 'assets/small.svg', hidden: true };
    expect(checkVectorComposition(base([mark, small]))).toEqual({ ok: true, svgFile: 'assets/logo.svg', small: 'assets/small.svg' });
    expect(checkVectorComposition(base([mark, { ...small, hidden: false }]))).toMatchObject({ ok: false, reason: expect.stringMatching(/hidden/) });
  });

  it('a hidden "dark" svg clip is the negative logo (note 9); it can sit with "small", must be hidden and full frame', () => {
    const dark = { ...mark, id: 'dark', src: 'assets/logo-dark.svg', hidden: true };
    const small = { ...mark, id: 'small', src: 'assets/small.svg', hidden: true };
    expect(checkVectorComposition(base([mark, dark]))).toEqual({ ok: true, svgFile: 'assets/logo.svg', dark: 'assets/logo-dark.svg' });
    expect(checkVectorComposition(base([mark, small, dark]))).toEqual({ ok: true, svgFile: 'assets/logo.svg', small: 'assets/small.svg', dark: 'assets/logo-dark.svg' });
    expect(checkVectorComposition(base([mark, { ...dark, hidden: false }]))).toMatchObject({ ok: false, reason: expect.stringMatching(/"dark".*hidden/) });
    expect(checkVectorComposition(base([mark, { ...dark, props: { fit: 'contain', x: 5 } }]))).toMatchObject({ ok: false, reason: expect.stringMatching(/fill the frame/) });
    expect(checkVectorComposition(base([mark, dark, { ...dark, src: 'assets/d2.svg' }]))).toMatchObject({ ok: false, reason: expect.stringMatching(/at most one "dark"/) });
  });

  it('refuses a video, other clips, a non-svg clip, a box that does not fill, animation and transforms', () => {
    expect(checkVectorComposition(base([mark], { duration: 3 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/still/) });
    expect(checkVectorComposition(base([mark, { id: 'tx', type: 'text', start: 0, duration: 0, props: { text: 'A' } }]))).toMatchObject({ ok: false });
    expect(checkVectorComposition(base([{ ...mark, type: 'image', src: 'assets/a.png' }]))).toMatchObject({ ok: false, reason: expect.stringMatching(/svg/) });
    expect(checkVectorComposition(base([{ ...mark, props: { x: 10, fit: 'contain' } }]))).toMatchObject({ ok: false, reason: expect.stringMatching(/fill the frame/) });
    expect(checkVectorComposition(base([{ ...mark, props: { scale: 0.8, fit: 'contain' } }]))).toMatchObject({ ok: false });
    expect(checkVectorComposition(base([{ ...mark, animations: [{ preset: 'fadeIn', start: 0, duration: 1 }] }]))).toMatchObject({ ok: false });
    expect(checkVectorComposition(base([{ ...mark, hidden: true }]))).toMatchObject({ ok: false });
    expect(checkVectorComposition(base([]))).toMatchObject({ ok: false });
  });

  it('the svg clip must say fit: contain (the runtime default, cover, crops a wide logo); so must the small clip', () => {
    expect(checkVectorComposition(base([{ ...mark, props: {} }]))).toMatchObject({ ok: false, reason: expect.stringMatching(/"fit": "contain"/) });
    expect(checkVectorComposition(base([{ ...mark, props: { fit: 'cover' } }]))).toMatchObject({ ok: false });
    expect(checkVectorComposition(base([mark, { ...mark, id: 'small', src: 'assets/s.svg', hidden: true, props: { fit: 'fill' } }]))).toMatchObject({ ok: false });
  });
});

describe('the turn check of an identity format (repair turn)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ms-test-identity-check-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const ICON: FormatPreset = { id: 'test-favicon', channel: 'Test', name: 'Favicon', width: 64, height: 64, kind: 'image', extensions: ['png'], identity: 'favicon' };
  let k = 0;
  function version(svg: string, clips?: unknown[]): string {
    const vdir = join(root, `c${k++}`, 'outputs', 'v1');
    const dir = join(vdir, 'compositions', ICON.id);
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'mark.svg'), svg);
    writeFileSync(join(dir, 'composition.json'), JSON.stringify({
      $schema: 'motion-studio/composition@1', width: 64, height: 64, fps: 30, duration: 0, background: '#ffffff', fonts: [], scenes: [],
      tracks: [{ id: 't', kind: 'visual', clips: clips ?? [{ id: 'mark', type: 'svg', src: 'assets/mark.svg', start: 0, duration: 0, props: { fit: 'contain' } }] }],
    }));
    return vdir;
  }
  const check = (vdir: string) => checkTargets({ versionDir: vdir, targets: [ICON.id], presets: [ICON], briefDurationSec: null, locale: 'en' });

  it('a refused SVG is a problem with its reason, so the repair turn gets it', async () => {
    const r = await check(version(`<svg ${NS} viewBox="0 0 1 1" onload="x()"><rect width="1" height="1"/></svg>`));
    expect(r.problems.join()).toMatch(/assets\/mark\.svg.*event handler/);
  });

  it('a composition that is not vector is a problem; <text> is only a warning; a clean one passes', async () => {
    const shape = [{ id: 'box', type: 'shape', start: 0, duration: 0, props: { fill: '#000000' } }];
    expect((await check(version(svg('<rect width="1" height="1"/>'), shape))).problems.join()).toMatch(/vector/);
    const t = await check(version(svg('<text>A</text>')));
    expect(t.problems).toEqual([]);
    expect(t.warnings.join()).toMatch(/text/);
    expect((await check(version(svg('<rect width="1" height="1"/>')))).problems).toEqual([]);
  });
});

describe('the turn check of a logo: the negative "dark" clip is required (note 9)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ms-test-logo-dark-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const LOGO: FormatPreset = { id: 'test-logo', channel: 'Test', name: 'Logo', width: 64, height: 64, kind: 'image', extensions: ['png'], identity: 'logo' };
  const ICON: FormatPreset = { id: 'test-favicon', channel: 'Test', name: 'Favicon', width: 64, height: 64, kind: 'image', extensions: ['png'], identity: 'favicon' };
  const clip = (id: string, src: string, hidden = false) => ({ id, type: 'svg', src, start: 0, duration: 0, ...(hidden ? { hidden: true } : {}), props: { fit: 'contain' } });
  let k = 0;
  function version(preset: FormatPreset, files: Record<string, string>, clips: unknown[]): string {
    const vdir = join(root, `c${k++}`, 'outputs', 'v1');
    const dir = join(vdir, 'compositions', preset.id);
    mkdirSync(join(dir, 'assets'), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'assets', name), text);
    writeFileSync(join(dir, 'composition.json'), JSON.stringify({
      $schema: 'motion-studio/composition@1', width: 64, height: 64, fps: 30, duration: 0, background: '#00000000', fonts: [], scenes: [],
      tracks: [{ id: 't', kind: 'visual', clips }],
    }));
    return vdir;
  }
  const check = (vdir: string, preset: FormatPreset) => checkTargets({ versionDir: vdir, targets: [preset.id], presets: [preset], briefDurationSec: null, locale: 'en' });
  const good = svg('<rect width="1" height="1" fill="#111111"/>');

  it('a logo without "dark" is a problem the agent is told to fix', async () => {
    const r = await check(version(LOGO, { 'logo.svg': good }, [clip('mark', 'assets/logo.svg')]), LOGO);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/negative.*"dark"/i);
  });

  it('a logo with a clean "dark" passes; a "dark" SVG that fails checkVectorSvg is refused like the main one', async () => {
    const ok = await check(version(LOGO, { 'logo.svg': good, 'logo-dark.svg': svg('<rect width="1" height="1" fill="#ffffff"/>') }, [clip('mark', 'assets/logo.svg'), clip('dark', 'assets/logo-dark.svg', true)]), LOGO);
    expect(ok.problems).toEqual([]);
    const bad = await check(version(LOGO, { 'logo.svg': good, 'logo-dark.svg': `<svg ${NS} viewBox="0 0 1 1" onload="x()"><rect width="1" height="1"/></svg>` }, [clip('mark', 'assets/logo.svg'), clip('dark', 'assets/logo-dark.svg', true)]), LOGO);
    expect(bad.problems.join()).toMatch(/assets\/logo-dark\.svg.*event handler/);
  });

  it('favicon and app icon never need "dark"', async () => {
    expect((await check(version(ICON, { 'mark.svg': good }, [clip('mark', 'assets/mark.svg')]), ICON)).problems).toEqual([]);
  });

  it('the render-time check (identityProblems without the requirement) still accepts an old logo without "dark"', async () => {
    const vdir = version(LOGO, { 'logo.svg': good }, [clip('mark', 'assets/logo.svg')]);
    const c = JSON.parse(readFileSync(join(vdir, 'compositions', LOGO.id, 'composition.json'), 'utf8'));
    expect((await identityProblems(join(vdir, 'compositions', LOGO.id), c)).problems).toEqual([]);
  });
});

describe('checkVectorSvg: hostile sizes stay fast (fix round 1)', () => {
  const timed = (s: string) => {
    expect(Buffer.byteLength(s)).toBeGreaterThan(400_000);
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(512 * 1024);
    const t0 = performance.now();
    const r = checkVectorSvg(s);
    const ms = performance.now() - t0;
    // A loose bound (final wave M8): it catches a quadratic blow-up, not a busy machine.
    expect(ms, `took ${Math.round(ms)} ms`).toBeLessThan(3000);
    return r;
  };
  const fill = (unit: string, budget = 480_000) => unit.repeat(Math.floor(budget / unit.length));

  it('one element with tens of thousands of attributes', () => {
    const r = timed(`<svg ${NS} viewBox="0 0 1 1"><rect ${Array.from({ length: 40_000 }, (_, k) => `a${k}="1"`).join(' ')}/></svg>`);
    expect(r).toMatchObject({ ok: false, reasons: [expect.stringMatching(/more than 256 attributes/)] });
  });

  it('a namespace declaration on every element', () => {
    const r = timed(`<svg ${NS} viewBox="0 0 1 1">${fill('<g xmlns:p="urn:p"></g>')}</svg>`);
    expect(r).toMatchObject({ ok: false, reasons: [expect.stringMatching(/namespace declarations/)] });
    const many = `<svg ${NS} viewBox="0 0 1 1"><g ${Array.from({ length: 65 }, (_, k) => `xmlns:p${k}="urn:p"`).join(' ')}/></svg>`;
    expect(checkVectorSvg(many)).toMatchObject({ ok: false, reasons: [expect.stringMatching(/more than 64 namespace declarations/)] });
  });

  it('many nested and sibling elements (deep chains of 250, repeated)', () => {
    const chain = `${'<g>'.repeat(250)}<rect/>${'</g>'.repeat(250)}`;
    expect(timed(`<svg ${NS} viewBox="0 0 1 1">${fill(chain)}</svg>`)).toMatchObject({ ok: true });
  });

  it('prefixed attributes deep in the tree resolve fast', () => {
    const xl = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
    const deep = `${'<g>'.repeat(250)}${fill('<rect xlink:title="t" xml:space="preserve"/>', 470_000)}${'</g>'.repeat(250)}`;
    expect(timed(`<svg ${NS} ${xl} viewBox="0 0 1 1"><rect id="r"/>${deep}</svg>`)).toMatchObject({ ok: true });
  });

  it('an unclosed url( repeated in one style attribute, and in a <style>', () => {
    const r = timed(`<svg ${NS} viewBox="0 0 1 1"><rect style="${fill('url(')}"/></svg>`);
    expect(r.ok).toBe(false);
    expect(timed(`<svg ${NS} viewBox="0 0 1 1"><style>${fill('url(#a ')}</style></svg>`).ok).toBe(false);
  });

  it('many entity references, comments and text', () => {
    expect(timed(`<svg ${NS} viewBox="0 0 1 1"><title>${fill('&#x41;&amp;')}</title></svg>`)).toMatchObject({ ok: true });
    expect(timed(`<svg ${NS} viewBox="0 0 1 1">${fill('<!-- c -->')}</svg>`)).toMatchObject({ ok: true });
  });
});

describe('checkVectorSvg: fix round 1 rules', () => {
  it('two attributes with the same namespace and local name are one attribute twice (malformed)', () => {
    const s = `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:q="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><use xlink:href="#a" q:href="#b"/></svg>`;
    expect(refused(s).join()).toMatch(/malformed.*same namespace/);
  });

  it('a self-closing child of <style> is refused', () => {
    expect(refused(svg('<style><rect/></style>')).join()).toMatch(/only contain CSS/);
  });

  it('vendor-prefixed CSS functions are refused', () => {
    expect(refused(svg('<rect width="1" height="1" style="background:-webkit-cross-fade(#a, #b, 50%)"/>')).join()).toMatch(/-webkit-cross-fade/);
    refused(svg('<rect width="1" height="1" fill="-moz-element(#a)"/>'));
  });

  it('<use> fan-out: a reference cycle, an exponential chain and too many <use> are refused; a few uses pass', () => {
    expect(refused(svg('<g id="a"><use href="#a"/></g>')).join()).toMatch(/cycle/);
    // 10 levels, each using the previous one 4 times: 4^10 elements.
    let chain = '<defs><rect id="l0" width="1" height="1"/>';
    for (let k = 1; k <= 10; k++) chain += `<g id="l${k}">${`<use href="#l${k - 1}"/>`.repeat(4)}</g>`;
    chain += '</defs><use href="#l10"/>';
    expect(refused(svg(chain)).join()).toMatch(/add more than/);
    expect(refused(svg(`<rect id="r" width="1" height="1"/>${'<use href="#r"/>'.repeat(257)}`)).join()).toMatch(/more than 256 <use>/);
    accepted(svg(`<defs><path id="p" d="M0 0L1 1"/></defs>${'<use href="#p"/>'.repeat(20)}`));
  });

  it('line separators in a quoted reason become spaces', () => {
    const r = refused(svg('<use href="https://x.example/\u2028a\u0085b"/>'));
    expect(r.join()).not.toMatch(/[\u2028\u0085]/);
  });
});

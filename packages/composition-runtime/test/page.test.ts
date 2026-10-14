import { describe, expect, it } from 'vitest';
import { COMPOSITION_DATA_ID, COMPOSITION_PLACEHOLDER, injectLayerBootstrap, layerBootstrapScanWork, readCompositionData, renderRuntimePage } from '../src/page.ts';

const INDEX = `<!doctype html><html><head>${COMPOSITION_PLACEHOLDER}</head><body><script src="runtime.js"></script></body></html>`;

describe('runtime page', () => {
  it('inlines the composition as an inert JSON data block that cannot close the script', () => {
    const composition = { tracks: [{ name: '</script><script>alert(1)</script>', x: 'a & b \u2028' }] };
    const html = renderRuntimePage(INDEX, { base: '../v1/compositions/story/', composition });
    expect(html).not.toContain(COMPOSITION_PLACEHOLDER);
    expect(html).toContain(`<script type="application/json" id="${COMPOSITION_DATA_ID}">`);
    expect(html.match(/<\/script>/g)).toHaveLength(2); // the data block's own end and runtime.js's
    const json = html.slice(html.indexOf('>', html.indexOf(COMPOSITION_DATA_ID)) + 1, html.indexOf('</script>'));
    expect(readCompositionData(json)).toEqual({ base: '../v1/compositions/story/', composition });
  });
  it('refuses a page without the placeholder and a base that is not a relative folder', () => {
    expect(() => renderRuntimePage('<html></html>', { base: './', composition: {} })).toThrow();
    for (const base of ['http://evil/', '//evil/', 'v1/compositions/story', 'javascript:x/', '../a\\b/']) {
      expect(() => renderRuntimePage(INDEX, { base, composition: {} })).toThrow();
    }
  });
  it('carries the format\'s safe zone when it is one (four finite insets), and drops anything else (final wave P6)', () => {
    const at = (html: string) => html.slice(html.indexOf('>', html.indexOf(COMPOSITION_DATA_ID)) + 1, html.indexOf('</script>'));
    const safeZone = { top: 220, bottom: 420, left: 60, right: 120 };
    expect(readCompositionData(at(renderRuntimePage(INDEX, { base: './', composition: {}, safeZone })))).toEqual({ base: './', composition: {}, safeZone });
    for (const bad of [{ top: -1, bottom: 0, left: 0, right: 0 }, { top: 1, bottom: 2, left: 3 }, { top: '1', bottom: 0, left: 0, right: 0 }, null]) {
      const html = renderRuntimePage(INDEX, { base: './', composition: {}, safeZone: bad as never });
      expect(html).not.toContain('safeZone');
      expect(readCompositionData(`{"base":"./","composition":{},"safeZone":${JSON.stringify(bad)}}`)).toEqual({ base: './', composition: {} });
    }
  });
  it('readCompositionData rejects malformed data', () => {
    expect(readCompositionData('nope')).toBeNull();
    expect(readCompositionData('{"base":1,"composition":{}}')).toBeNull();
    expect(readCompositionData('{"base":"./"}')).toBeNull();
  });
});

describe('layer bootstrap injection', () => {
  const TAG = '<script src="/tok/runtime/layer.js" data-ms-layer-bootstrap></script>';
  it('goes right after the doctype, before any layer script', () => {
    expect(injectLayerBootstrap('<!DOCTYPE html>\n<html><head><script>x()</script>', '/tok/runtime/layer.js'))
      .toBe(`<!DOCTYPE html>${TAG}\n<html><head><script>x()</script>`);
  });
  it('skips a BOM, whitespace and comments before the doctype', () => {
    const html = '\uFEFF  <!-- a --><!--b--> <!doctype html><p>';
    expect(injectLayerBootstrap(html, '/tok/runtime/layer.js')).toBe(`\uFEFF  <!-- a --><!--b--> <!doctype html>${TAG}<p>`);
  });
  it('goes first when there is no doctype (or it comes later)', () => {
    expect(injectLayerBootstrap('<html><script>x()</script>', '/tok/runtime/layer.js')).toBe(`${TAG}<html><script>x()</script>`);
    expect(injectLayerBootstrap('<p>hi</p><!doctype html>', '/tok/runtime/layer.js')).toBe(`${TAG}<p>hi</p><!doctype html>`);
    expect(injectLayerBootstrap('<!-- never closed <!doctype html>', '/tok/runtime/layer.js')).toBe(`${TAG}<!-- never closed <!doctype html>`);
  });
  it('refuses a source that could break out of the attribute', () => {
    expect(() => injectLayerBootstrap('<p>', '/x" onload="y')).toThrow();
    expect(() => injectLayerBootstrap('<p>', 'https://evil/layer.js')).toThrow();
  });
  it('is linear on hostile input (work count, not wall clock)', () => {
    for (const unit of ['<!--', '<!---->', ' ', '<!-- -->\n', '<!doctype']) {
      for (const n of [1_000, 100_000]) {
        const hostile = unit.repeat(n);
        expect(layerBootstrapScanWork(hostile)).toBeLessThanOrEqual(2 * hostile.length + 16);
        expect(injectLayerBootstrap(hostile, '/tok/runtime/layer.js').length).toBeGreaterThan(hostile.length);
      }
    }
  });
});

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { renderRuntimePage } from '../src/page.ts';
import { startRuntime } from '../src/runtime-main.ts';

const INDEX = '<!doctype html><html><head><!--ms-composition--></head><body><div id="ms-root"></div></body></html>';

function runtimeIn(composition: unknown, base = '../v1/compositions/story/') {
  const html = renderRuntimePage(INDEX, { base, composition });
  const w = new JSDOM(html, { url: 'http://127.0.0.1:9999/tok/runtime/index.html?mode=render', pretendToBeVisual: true }).window;
  w.console.warn = () => {};
  return startRuntime(w);
}

describe('startRuntime fatal errors', () => {
  it('a composition the mount cannot handle fails ready() with compositionInvalid instead of throwing', async () => {
    const api = runtimeIn({ width: 10, height: 10, fps: 30, duration: 1, background: '#000000', fonts: [], scenes: [], tracks: [{ id: 't', kind: 'visual', clips: [null] }] });
    await expect(api.ready()).rejects.toThrow(/compositionInvalid/);
    expect(api.errors.map((e) => e.code)).toEqual(['compositionInvalid']);
  });
  it('a malformed composition fails ready() with compositionInvalid', async () => {
    const api = runtimeIn({ width: 10 });
    await expect(api.ready()).rejects.toThrow(/compositionInvalid/);
  });
});

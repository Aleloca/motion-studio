import { describe, expect, it } from 'vitest';
import { isCompositionPath } from '../src/index.ts';

describe('isCompositionPath', () => {
  it.each([
    ['assets/photo.jpg', true],
    ['layers/outro.html', true],
    ['assets/sub/dir/font.woff2', true],
    ['assets/a b (1).png', true],
    ['assets/caffè.png', true],
    ['assets/.hidden', true],
    ['assets/x..y.png', true],
    ['', false],
    ['assets', false],
    ['assets/', false],
    ['layers/', false],
    ['assets/dir/', false],
    ['assets//x.png', false],
    ['assets/./x.png', false],
    ['assets/../x.png', false],
    ['assets/sub/..', false],
    ['../assets/x.png', false],
    ['/assets/x.png', false],
    ['/etc/passwd', false],
    ['other/x.png', false],
    ['Assets/x.png', false],
    ['assetsx/y.png', false],
    ['composition.json', false],
    ['assets\\x.png', false],
    ['assets/x\\..\\..\\y', false],
    ['assets/x\u0000.png', false],
    ['assets/x\n.png', false],
    ['assets/x\t.png', false],
    ['assets/x\u007f.png', false],
    ['assets/x\u0085.png', false],
    ['assets/x\u2028.png', false],
    ['https://example.com/x.png', false],
    ['assets/http://example.com/x.png', false],
    ['file:///etc/passwd', false],
    ['C:/assets/x.png', false],
    ['assets/%2e%2e/x.png', false],
    ['assets/x.png?v=1', false],
    ['assets/x.png#frag', false],
    [`assets/${'a'.repeat(600)}`, false],
  ])('%j → %s', (p, expected) => {
    expect(isCompositionPath(p)).toBe(expected);
  });
  it('rejects non-strings', () => {
    for (const v of [null, undefined, 42, {}, ['assets/x.png']]) expect(isCompositionPath(v as unknown as string)).toBe(false);
  });
});

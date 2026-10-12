import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compositionHash, sha256Hex } from '../src/index.ts';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('sha256Hex (pure JS, no node:crypto so the web can use it)', () => {
  it.each(['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'caffè ☕ 𝄞', 'x\ny\tz'])('matches node:crypto for %j', (s) => {
    expect(sha256Hex(new TextEncoder().encode(s))).toBe(sha(s));
  });
});

describe('compositionHash', () => {
  const entries = [
    { path: 'composition.json', sha256: 'a'.repeat(64) },
    { path: 'assets/photo.jpg', sha256: 'b'.repeat(64) },
    { path: 'layers/outro.html', sha256: 'c'.repeat(64) },
  ];

  it('is the sha256 of the sorted "path\\tsha" lines joined with \\n', () => {
    const canonical = ['assets/photo.jpg\t' + 'b'.repeat(64), 'composition.json\t' + 'a'.repeat(64), 'layers/outro.html\t' + 'c'.repeat(64)].join('\n');
    expect(compositionHash(entries)).toBe(sha(canonical));
  });
  it('is stable under the order of the entries', () => {
    const h = compositionHash(entries);
    expect(compositionHash([...entries].reverse())).toBe(h);
    expect(compositionHash([entries[1]!, entries[2]!, entries[0]!])).toBe(h);
  });
  it('changes when a file content or a path changes', () => {
    const h = compositionHash(entries);
    expect(compositionHash([{ ...entries[0]!, sha256: 'd'.repeat(64) }, entries[1]!, entries[2]!])).not.toBe(h);
    expect(compositionHash([{ ...entries[0]!, path: 'composition2.json' }, entries[1]!, entries[2]!])).not.toBe(h);
    expect(compositionHash(entries.slice(1))).not.toBe(h);
  });
  it('normalises paths to NFC and stays case-sensitive', () => {
    const nfc = [{ path: 'assets/caffè.png', sha256: 'a'.repeat(64) }];
    const nfd = [{ path: 'assets/caffè.png', sha256: 'a'.repeat(64) }];
    expect(compositionHash(nfd)).toBe(compositionHash(nfc));
    expect(compositionHash([{ path: 'assets/A.png', sha256: 'a'.repeat(64) }])).not.toBe(compositionHash([{ path: 'assets/a.png', sha256: 'a'.repeat(64) }]));
  });
  it('sorts by code unit, not by locale', () => {
    const e = [{ path: 'assets/b', sha256: 'a'.repeat(64) }, { path: 'assets/B', sha256: 'a'.repeat(64) }, { path: 'assets/a', sha256: 'a'.repeat(64) }];
    expect(compositionHash(e)).toBe(sha(['assets/B', 'assets/a', 'assets/b'].map((p) => `${p}\t${'a'.repeat(64)}`).join('\n')));
  });
  it('accepts uppercase hex by lowering it', () => {
    expect(compositionHash([{ path: 'x', sha256: 'A'.repeat(64) }])).toBe(compositionHash([{ path: 'x', sha256: 'a'.repeat(64) }]));
  });
  it('the empty folder has a hash too', () => {
    expect(compositionHash([])).toBe(sha(''));
  });
  it.each([
    ['a bad sha', [{ path: 'x', sha256: 'zz' }]],
    ['a tab in a path', [{ path: 'a\tb', sha256: 'a'.repeat(64) }]],
    ['a newline in a path', [{ path: 'a\nb', sha256: 'a'.repeat(64) }]],
    ['an empty path', [{ path: '', sha256: 'a'.repeat(64) }]],
    ['duplicate paths after NFC', [{ path: 'assets/caffè', sha256: 'a'.repeat(64) }, { path: 'assets/caffè', sha256: 'b'.repeat(64) }]],
  ])('throws on %s', (_n, e) => {
    expect(() => compositionHash(e)).toThrow();
  });
});

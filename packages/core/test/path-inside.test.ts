import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStrictlyInside, relativeInside } from '../src/path-inside.ts';

// Decision 1976 (user report 95): one containment check for absolute paths, as the platform reads them.
describe('relativeInside / isStrictlyInside', () => {
  it('posix: inside, equal, sibling prefix, outside, relative input', () => {
    expect(relativeInside('/w/proj/assets/a', '/w/proj', posix)).toBe('assets/a');
    expect(relativeInside('/w/proj', '/w/proj/', posix)).toBe('');
    expect(isStrictlyInside('/w/proj', '/w/proj', posix)).toBe(false);
    expect(isStrictlyInside('/w/proj2/x', '/w/proj', posix)).toBe(false);
    expect(isStrictlyInside('/w/proj/../other', '/w/proj', posix)).toBe(false);
    expect(isStrictlyInside('/w/proj/..foo', '/w/proj', posix)).toBe(true);
    expect(isStrictlyInside('w/proj/x', '/w/proj', posix)).toBe(false);
    // POSIX compares exactly: another case is another folder.
    expect(isStrictlyInside('/W/Proj/x', '/w/proj', posix)).toBe(false);
  });

  it('win32: backslashes, mixed separators, case, sibling prefix, other drive', () => {
    expect(relativeInside('C:\\p\\proj\\.studio\\cache\\analysis\\ab', 'C:\\p\\proj', win32)).toBe('.studio\\cache\\analysis\\ab');
    expect(isStrictlyInside('C:/p/proj/assets/x', 'C:\\p\\proj', win32)).toBe(true);
    expect(isStrictlyInside('c:\\P\\PROJ\\assets', 'C:\\p\\proj', win32)).toBe(true);
    expect(relativeInside('C:\\p\\proj\\', 'c:/p/proj', win32)).toBe('');
    expect(isStrictlyInside('C:\\p\\proj', 'C:\\p\\proj', win32)).toBe(false);
    expect(isStrictlyInside('C:\\p\\proj2', 'C:\\p\\proj', win32)).toBe(false);
    expect(isStrictlyInside('C:\\p\\proj2\\x', 'C:\\p\\proj', win32)).toBe(false);
    expect(isStrictlyInside('C:\\p\\proj\\..\\proj2\\x', 'C:\\p\\proj', win32)).toBe(false);
    expect(isStrictlyInside('D:\\p\\proj\\x', 'C:\\p\\proj', win32)).toBe(false);
    expect(isStrictlyInside('p\\proj\\x', 'C:\\p\\proj', win32)).toBe(false);
  });
});

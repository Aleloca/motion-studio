import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));
// Built from escapes on purpose: this file must itself stay free of the characters it looks for.
const INVISIBLE = new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\u061C\\uFEFF\\u2028\\u2029]', 'u');
const SOURCE = /\.(?:ts|tsx|mts|mjs|js)$/;

function walk(dir: string, out: string[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && SOURCE.test(e.name)) out.push(p);
  }
}

describe('source hygiene (Trojan Source)', () => {
  it('no source or test file contains raw bidi, zero-width or line-separator characters: write them as \\u escapes', () => {
    const files: string[] = [];
    for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      for (const sub of ['src', 'test']) {
        try { walk(join(PACKAGES, pkg.name, sub), files); } catch { /* the package has no such folder */ }
      }
    }
    expect(files.length).toBeGreaterThan(100);
    const offending = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (INVISIBLE.test(line) ? [`${f}:${i + 1}`] : [])));
    expect(offending).toEqual([]);
  });
});

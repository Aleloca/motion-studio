import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Screens and shell take every colour from theme tokens (CSS custom properties).
// The only exception is colour that is data (brand palette swatches, channel colours),
// marked with a `// color-data` comment on the same line.
const SRC = resolve(import.meta.dirname, '../src');
const ROOTS = ['screens', 'shell'];
const PATTERNS = [/#[0-9a-fA-F]{3,8}\b/, /rgb\(/, /hsl\(/];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('no literal colours in screens/ and shell/', () => {
  it('finds source files to scan', () => {
    for (const root of ROOTS) expect(files(join(SRC, root)).length, root).toBeGreaterThan(0);
  });

  it('uses tokens, except lines marked // color-data', () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of files(join(SRC, root))) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (line.includes('// color-data')) return;
          if (PATTERNS.some((p) => p.test(line))) hits.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});

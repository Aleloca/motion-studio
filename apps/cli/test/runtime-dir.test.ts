import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runtimeDirFor } from '../src/runtime-dir.ts';

const work = mkdtempSync(join(tmpdir(), 'ms-test-cli-runtime-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('composition runtime of the bundled CLI', () => {
  it('is dist/runtime next to the bundle when it is there, else the core default', () => {
    expect(runtimeDirFor(work)).toBeUndefined();
    mkdirSync(join(work, 'runtime'));
    writeFileSync(join(work, 'runtime', 'index.html'), '<!doctype html>');
    expect(runtimeDirFor(work)).toBe(join(work, 'runtime'));
  });

  it('the build copies the runtime into dist (published with "files": ["dist"]) and main passes it to the core', () => {
    const dir = join(import.meta.dirname, '..');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string>; files: string[]; bin: Record<string, string> };
    expect(pkg.scripts.build).toContain("fs.cpSync('../../packages/composition-runtime/dist','dist/runtime'");
    expect(pkg.files).toContain('dist');
    expect(pkg.bin['motion-studio']).toBe('dist/main.js');
    expect(readFileSync(join(dir, 'src', 'main.ts'), 'utf8')).toContain('renderOptions: { distDir: runtimeDir }');
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'check-i18n.mjs');
const dir = mkdtempSync(join(tmpdir(), 'check-i18n-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(name: string, source: string): { code: number; out: string } {
  const file = join(dir, name);
  writeFileSync(file, source);
  try {
    execFileSync('node', [script, file], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (e) {
    const err = e as { status: number; stderr: string };
    return { code: err.status, out: err.stderr };
  }
}

describe('check-i18n', () => {
  it('flags an Italian string and accepts an English one', () => {
    const bad = run('bad.ts', "export const m = 'Cartella non trovata';\n");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('bad.ts:1');
    expect(run('ok.ts', "export const m = 'Not found';\n").code).toBe(0);
  });

  it('flags accented letters, template literals and JSX text', () => {
    expect(run('a.ts', "export const m = 'città';\n").code).toBe(1);
    expect(run('t.ts', 'export const m = (n: number) => `Hai ${n} errore`;\n').code).toBe(1);
    expect(run('j.tsx', 'export const C = () => <p>Salva il progetto</p>;\n').code).toBe(1);
    expect(run('j2.tsx', 'export const C = () => <p>Save the project</p>;\n').code).toBe(0);
  });

  it('ignores identifiers, comments, English "per" and i18n-ignore', () => {
    const src = "// Cartella non trovata\nconst nonEmpty = 1; const il = 2;\nexport const m = 'one per format, non-empty';\n";
    expect(run('c.ts', src).code).toBe(0);
    expect(run('i.ts', "export const l = 'Italiano è'; // i18n-ignore language endonym\n").code).toBe(0);
  });
});

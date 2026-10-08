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

// Every case spawns node (which loads TypeScript) several times: under a full parallel run that can exceed 5 s.
describe('check-i18n', { timeout: 30_000 }, () => {
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

  it('is not confused by a regex literal holding a quote', () => {
    const bad = run('r.ts', "const q = /'/g; export const m = 'Cartella non trovata';\n");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('r.ts:1');
    expect(bad.out).toContain('"Cartella non trovata"');
    expect(run('r2.ts', "const q = /\"|'/g;\nexport const m = 'Folder not found';\n").code).toBe(0);
  });

  it('flags single common UI words in JSX text and attributes', () => {
    expect(run('w.tsx', 'export const C = () => <p>Apri</p>;\n').code).toBe(1);
    expect(run('w2.tsx', 'export const C = () => <button aria-label="Chiudi">x</button>;\n').code).toBe(1);
    const words = ['Modifica', 'Aggiungi', 'Rimuovi', 'Indietro', 'Lingua', 'Versione', 'Formati', 'Riprova', 'Caricamento', 'Conferma', 'Esporta'];
    const many = run('u.ts', words.map((w, i) => `export const m${i} = '${w}';\n`).join(''));
    expect(many.code).toBe(1);
    words.forEach((w, i) => expect(many.out, w).toContain(`u.ts:${i + 1}: Italian word "${w}"`));
    expect(run('w3.tsx', 'export const C = () => <p title="Open">Close the dialog and go back</p>;\n').code).toBe(0);
  });

  it('still needs two weak words, and supports i18n-ignore in JSX', () => {
    expect(run('p.ts', "export const m = 'lo dico per te';\n").code).toBe(1);
    expect(run('p2.ts', "export const m = 'lo so che';\n").code).toBe(1);
    expect(run('p3.ts', "export const m = 'one per format';\n").code).toBe(0);
    expect(run('ji.tsx', 'export const C = () => <p>Italiano {/* i18n-ignore endonym */}</p>;\n').code).toBe(0);
  });
});

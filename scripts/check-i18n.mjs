#!/usr/bin/env node
// Flags Italian text left in source code outside the i18n catalogs.
// Parses production sources with the TypeScript compiler and reports string literals, template literal parts,
// JSX text and JSX attribute values with Italian accented letters or frequent Italian whole words.
// Real exceptions: add `// i18n-ignore <reason>` on the same line (or `{/* i18n-ignore <reason> */}` in JSX).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ACCENTED = /[àèéìòùÀÈÉÌÒÙ]/;
const WORDS = [
  'il', 'della', 'delle', 'dei', 'non', 'una', 'uno', 'nella', 'nelle', 'nel', 'sono',
  'errore', 'errori', 'cartella', 'progetto', 'progetti', 'creatività', 'nessun', 'nessuna', 'questo', 'questa',
  'puoi', 'devi', 'trovato', 'trovata', 'impostazioni', 'scegli', 'salva', 'annulla', 'elimina', 'con',
  // Common UI words: one of them alone is enough.
  'apri', 'chiudi', 'modifica', 'aggiungi', 'rimuovi', 'indietro', 'lingua', 'versione', 'versioni', 'formati',
  'riprova', 'caricamento', 'conferma', 'esporta', 'nuovo', 'nuova', 'cerca', 'carica', 'scarica', 'invia',
  'aggiorna', 'copia', 'avvia', 'esci', 'immagine', 'immagini', 'anteprima', 'descrizione', 'benvenuto', 'attendi',
];
// Also English words ("one per format"): flagged only together with another Italian signal.
const WEAK_WORDS = ['per', 'lo', 'gli', 'che'];
const WEAK_RE = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${WEAK_WORDS.join('|')})(?![\\p{L}\\p{N}_-])`, 'iu');
const WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${WORDS.join('|')})(?![\\p{L}\\p{N}_-])`, 'iu');
const IGNORE_RE = /i18n-ignore\b/;
const ROOTS = ['packages', 'apps'];
const EXT = /\.(?:ts|tsx|mjs|js)$/;

/** Returns the reason a text looks Italian, or null. */
export function italianReason(text) {
  const accent = text.match(ACCENTED);
  if (accent) return `accented letter "${accent[0]}"`;
  const word = text.match(WORD_RE);
  if (word) return `Italian word "${word[0]}"`;
  const weak = text.match(new RegExp(WEAK_RE.source, 'giu')) ?? [];
  if (new Set(weak.map((w) => w.toLowerCase())).size >= 2) return `Italian words "${weak.join('", "')}"`;
  return null;
}

/** Extracts text fragments with their starting line: string literals (JSX attribute values included), template literal parts, JSX text. */
export function extractFragments(source, { jsx = false } = {}) {
  const sf = ts.createSourceFile(jsx ? 'source.tsx' : 'source.ts', source, ts.ScriptTarget.Latest, true, jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
        out.push({ text: node.text, line: lineOf(node.getStart(sf)) });
        break;
      case ts.SyntaxKind.JsxText: {
        const raw = sf.text.slice(node.pos, node.end);
        const text = raw.trim();
        if (text) out.push({ text, line: lineOf(node.pos + (raw.length - raw.trimStart().length)) });
        break;
      }
      default:
        break;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Findings for one source file: [{ line, text, reason }]. */
export function checkSource(source, { jsx = false } = {}) {
  const lines = source.split('\n');
  const findings = [];
  for (const frag of extractFragments(source, { jsx })) {
    const reason = italianReason(frag.text);
    if (!reason) continue;
    const ignored = IGNORE_RE.test(lines[frag.line - 1] ?? '');
    if (ignored) continue;
    findings.push({ line: frag.line, text: frag.text.trim().slice(0, 80), reason });
  }
  return findings;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'release' || name === 'resources' || name === 'test' || name === 'tests') continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (path.split(sep).join('/').endsWith('packages/shared/src/i18n')) continue;
      yield* walk(path);
    } else if (EXT.test(name) && !/\.(?:test|spec)\./.test(name) && !name.endsWith('.d.ts')) {
      yield path;
    }
  }
}

function main() {
  const root = join(fileURLToPath(import.meta.url), '..', '..');
  let failures = 0;
  // `node scripts/check-i18n.mjs <file>...` checks just those files (used by the script's test).
  const explicit = process.argv.slice(2);
  for (const file of explicit) {
    for (const f of checkSource(readFileSync(file, 'utf8'), { jsx: file.endsWith('.tsx') })) {
      failures++;
      console.error(`${file}:${f.line}: ${f.reason}: "${f.text}"`);
    }
  }
  for (const top of explicit.length ? [] : ROOTS) {
    for (const pkg of readdirSync(join(root, top))) {
      const src = join(root, top, pkg, 'src');
      try { if (!statSync(src).isDirectory()) continue; } catch { continue; }
      for (const file of walk(src)) {
        const findings = checkSource(readFileSync(file, 'utf8'), { jsx: file.endsWith('.tsx') });
        for (const f of findings) {
          failures++;
          console.error(`${relative(root, file)}:${f.line}: ${f.reason}: "${f.text}"`);
        }
      }
    }
  }
  if (failures) {
    console.error(`\ncheck:i18n found ${failures} suspicious string(s). Move user-visible text into packages/shared/src/i18n, or mark a real exception with "// i18n-ignore <reason>".`);
    process.exit(1);
  }
  console.log('check:i18n ok');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

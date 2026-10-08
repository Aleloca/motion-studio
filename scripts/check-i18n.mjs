#!/usr/bin/env node
// Flags Italian text left in source code outside the i18n catalogs.
// Scans string literals, template literals and JSX text of production sources and reports
// strings with Italian accented letters or frequent Italian whole words.
// Real exceptions: add `// i18n-ignore <reason>` on the same line (or `{/* i18n-ignore <reason> */}` in JSX).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCENTED = /[àèéìòùÀÈÉÌÒÙ]/;
const WORDS = [
  'il', 'della', 'delle', 'dei', 'non', 'una', 'uno', 'nella', 'nelle', 'nel', 'sono',
  'errore', 'errori', 'cartella', 'progetto', 'progetti', 'creatività', 'nessun', 'nessuna', 'questo', 'questa',
  'puoi', 'devi', 'trovato', 'trovata', 'impostazioni', 'scegli', 'salva', 'annulla', 'elimina', 'con',
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

/** Extracts text fragments with their starting line: strings, template literal parts, JSX text. */
export function extractFragments(source, { jsx = false } = {}) {
  const out = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  const stack = []; // template literal nesting: 'tpl' markers and brace depths
  const braceDepth = [];

  const readString = (quote) => {
    const startLine = line;
    let text = '';
    i++;
    while (i < n && source[i] !== quote) {
      if (source[i] === '\\') { text += source[i + 1] ?? ''; i += 2; continue; }
      if (source[i] === '\n') { line++; break; }
      text += source[i++];
    }
    i++;
    out.push({ text, line: startLine });
  };

  const readTemplate = () => {
    // Called after the opening backtick or after a closing `}` of an expression.
    let text = '';
    let startLine = line;
    while (i < n) {
      const c = source[i];
      if (c === '\\') { text += source[i + 1] ?? ''; i += 2; continue; }
      if (c === '`') { i++; out.push({ text, line: startLine }); return false; }
      if (c === '$' && source[i + 1] === '{') {
        i += 2;
        out.push({ text, line: startLine });
        return true; // inside an expression
      }
      if (c === '\n') line++;
      text += c;
      i++;
    }
    out.push({ text, line: startLine });
    return false;
  };

  while (i < n) {
    const c = source[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { if (source[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") { readString(c); continue; }
    if (c === '`') {
      i++;
      if (readTemplate()) { stack.push(braceDepth.length); braceDepth.push(0); }
      continue;
    }
    if (c === '{' && braceDepth.length) { braceDepth[braceDepth.length - 1]++; i++; continue; }
    if (c === '}' && braceDepth.length) {
      if (braceDepth[braceDepth.length - 1] === 0) {
        braceDepth.pop();
        stack.pop();
        i++;
        if (readTemplate()) { stack.push(braceDepth.length); braceDepth.push(0); }
        continue;
      }
      braceDepth[braceDepth.length - 1]--;
      i++;
      continue;
    }
    if (jsx && c === '>' && source[i - 1] !== '=' && source[i - 1] !== '-') {
      // JSX text: from '>' up to the next '<' or '{', when it holds no code punctuation.
      let j = i + 1;
      while (j < n && source[j] !== '<' && source[j] !== '{' && source[j] !== '>') j++;
      const chunk = source.slice(i + 1, j);
      if (source[j] === '<' || source[j] === '{') {
        const trimmed = chunk.trim();
        if (trimmed && /\p{L}/u.test(trimmed) && !/[;=()[\]]/.test(trimmed)) {
          const lead = chunk.length - chunk.trimStart().length;
          const before = source.slice(i + 1, i + 1 + lead);
          out.push({ text: trimmed, line: line + (before.match(/\n/g)?.length ?? 0) });
        }
      }
    }
    i++;
  }
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

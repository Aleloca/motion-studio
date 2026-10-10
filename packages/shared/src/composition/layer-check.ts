import type { CompositionProblem } from './problems.ts';

/**
 * Advisory static check of an html layer (spec §3.2, "forbidden"). It is defence in depth only: obfuscated code
 * (`self['fe'+'tch']`, `fetch`, eval) passes it. The real boundary is the runtime isolation of the composition page.
 *
 * Flagged, at the first occurrence of each API (with its line), at most `MAX_PROBLEMS`:
 * - network (`composition.layerNetwork`): `fetch` (called, read as a property or named in quotes), `XMLHttpRequest`,
 *   `WebSocket`, `EventSource`, `sendBeacon`, `RTCPeerConnection`, `WebTransport`, `import(…)` whose specifier is not a
 *   relative string literal (`./` or `../`), URLs with a scheme (`http`, `https`, `ws`, `wss`, `ftp`, `file`) except the
 *   w3.org namespaces of SVG/XHTML, and protocol-relative URLs (`"//host`, `'//host`, `(//host`);
 * - workers (`composition.layerWorker`): `new Worker` or `Worker(`, `SharedWorker`, `importScripts`, `serviceWorker`;
 * - audio (`composition.layerAudio`): `AudioContext`, `webkitAudioContext`, `OfflineAudioContext`;
 * - autoplay (`composition.layerAutoplay`): an `autoplay` attribute on `<video>`/`<audio>` (any case), or `.autoplay` in script.
 *
 * Words are matched whole (`prefetch`, `WorkerPool` are fine). The scan is one pass over the text with bounded look-ahead,
 * so the work is linear in the input size and there is no regex on the input (see `staticLayerCheckWork`).
 */
export function staticLayerCheck(html: string, file = 'layer'): CompositionProblem[] {
  return staticLayerCheckWork(html, file).problems;
}

const MAX_PROBLEMS = 20;
/** Look-ahead bound for whitespace after a word and for an `import(…)` specifier. */
const LOOKAHEAD = 256;

type Category = 'layerNetwork' | 'layerWorker' | 'layerAudio' | 'layerAutoplay';
const ALWAYS: ReadonlyMap<string, Category> = new Map([
  ['XMLHttpRequest', 'layerNetwork'], ['WebSocket', 'layerNetwork'], ['EventSource', 'layerNetwork'], ['sendBeacon', 'layerNetwork'],
  ['RTCPeerConnection', 'layerNetwork'], ['WebTransport', 'layerNetwork'],
  ['SharedWorker', 'layerWorker'], ['importScripts', 'layerWorker'], ['serviceWorker', 'layerWorker'],
  ['AudioContext', 'layerAudio'], ['webkitAudioContext', 'layerAudio'], ['OfflineAudioContext', 'layerAudio'],
]);
const SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'file']);
const ALLOWED_URL_PREFIXES = ['http://www.w3.org/', 'https://www.w3.org/'];

const isIdent = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x24;
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c;
const isAlnum = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39);

/** `staticLayerCheck` plus the number of character steps it took (for the linear-work test). */
export function staticLayerCheckWork(html: string, file = 'layer'): { problems: CompositionProblem[]; steps: number } {
  const problems: CompositionProblem[] = [];
  const seen = new Set<string>();
  let steps = 0;
  let line = 1;
  const n = html.length;

  const report = (category: Category, api: string) => {
    if (seen.has(api) || problems.length >= MAX_PROBLEMS) return;
    seen.add(api);
    problems.push({ key: `composition.${category}`, params: { file, line, api } });
  };
  /** Index of the next non-space character from `i`, within the look-ahead bound (or -1). */
  const skipSpace = (i: number): number => {
    for (let k = 0; k < LOOKAHEAD && i < n; k++, i++) { steps++; if (!isSpace(html.charCodeAt(i))) return i; }
    return -1;
  };
  /** Last non-space character before `i`, within the look-ahead bound (or -1). */
  const prevNonSpace = (i: number): number => {
    for (let k = 0; k < LOOKAHEAD && i > 0; k++) { i--; steps++; const c = html.charCodeAt(i); if (!isSpace(c)) return c; }
    return -1;
  };
  /** The `import(` at `open` (index of the parenthesis): is its specifier a relative string literal? */
  const relativeImport = (open: number): boolean => {
    const q = skipSpace(open + 1);
    if (q < 0) return false;
    const quote = html.charCodeAt(q);
    if (quote !== 0x27 && quote !== 0x22 && quote !== 0x60) return false;
    let spec = '';
    for (let i = q + 1, k = 0; i < n && k < LOOKAHEAD; i++, k++) {
      steps++;
      const c = html.charCodeAt(i);
      if (c === quote) return (spec.startsWith('./') || spec.startsWith('../')) && !(quote === 0x60 && spec.includes('${'));
      if (c === 0x0a || c === 0x5c) return false;
      spec += html[i];
    }
    return false;
  };

  // Tag state, for autoplay attributes: inside `<video …>` / `<audio …>` until the next `>`.
  let inTag = false;
  let mediaTag = false;
  let lastWordLower = '';
  let lastWordEnd = -1;
  let prevWord = '';
  let prevWordEnd = -1;

  let i = 0;
  while (i < n && problems.length < MAX_PROBLEMS) {
    steps++;
    const c = html.charCodeAt(i);
    if (c === 0x0a) { line++; i++; continue; }
    if (c === 0x3c /* < */) {
      let j = i + 1;
      let tag = '';
      while (j < n && isAlnum(html.charCodeAt(j)) && tag.length < 16) { steps++; tag += html[j]; j++; }
      tag = tag.toLowerCase();
      inTag = tag !== '';
      mediaTag = tag === 'video' || tag === 'audio';
      i = j;
      continue;
    }
    if (c === 0x3e /* > */) { inTag = false; mediaTag = false; i++; continue; }
    if (c === 0x3a /* : */ && html.charCodeAt(i + 1) === 0x2f && html.charCodeAt(i + 2) === 0x2f && lastWordEnd === i && SCHEMES.has(lastWordLower)) {
      const start = i - lastWordLower.length;
      const allowed = ALLOWED_URL_PREFIXES.some((p) => html.length - start >= p.length && html.slice(start, start + p.length).toLowerCase() === p);
      if (!allowed) report('layerNetwork', `${lastWordLower}://`);
      i += 3;
      continue;
    }
    if (c === 0x2f && html.charCodeAt(i + 1) === 0x2f && isAlnum(html.charCodeAt(i + 2))) {
      const before = i > 0 ? html.charCodeAt(i - 1) : -1;
      if (before === 0x22 || before === 0x27 || before === 0x28) report('layerNetwork', '//');
      i += 2;
      continue;
    }
    if (isIdent(c) && !(c >= 0x30 && c <= 0x39)) {
      const start = i;
      // Inside a tag, attribute names may contain '-' (data-autoplay is a different attribute).
      while (i < n && (isIdent(html.charCodeAt(i)) || (inTag && html.charCodeAt(i) === 0x2d))) { steps++; i++; }
      const word = html.slice(start, i);
      checkWord(word, start, i);
      prevWord = word; prevWordEnd = i;
      lastWordLower = word.toLowerCase(); lastWordEnd = i;
      continue;
    }
    if (c >= 0x30 && c <= 0x39) { while (i < n && isIdent(html.charCodeAt(i))) { steps++; i++; } continue; }
    i++;
  }
  return { problems, steps };

  function checkWord(word: string, start: number, end: number): void {
    const always = ALWAYS.get(word);
    if (always) { report(always, word); return; }
    if (word.toLowerCase() === 'autoplay') {
      if ((inTag && mediaTag) || prevNonSpace(start) === 0x2e /* . */) report('layerAutoplay', 'autoplay');
      return;
    }
    if (word === 'fetch') {
      const next = skipSpace(end);
      const after = next < 0 ? -1 : html.charCodeAt(next);
      const before = prevNonSpace(start);
      const quoted = (before === 0x27 || before === 0x22 || before === 0x60) && (html.charCodeAt(end) === before);
      if (after === 0x28 || before === 0x2e || quoted) report('layerNetwork', 'fetch');
      return;
    }
    if (word === 'Worker') {
      const next = skipSpace(end);
      // `new` right before, separated by whitespace only (the gap is bounded, so this stays constant work).
      const newBefore = prevWord === 'new' && prevWordEnd >= 0 && start - prevWordEnd <= LOOKAHEAD && html.slice(prevWordEnd, start).trim() === '';
      if (newBefore || (next >= 0 && html.charCodeAt(next) === 0x28)) report('layerWorker', 'Worker');
      return;
    }
    if (word === 'import') {
      const open = skipSpace(end);
      if (open >= 0 && html.charCodeAt(open) === 0x28 && !relativeImport(open)) report('layerNetwork', 'import()');
    }
  }
}

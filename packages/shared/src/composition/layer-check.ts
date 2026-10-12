import { compositionProblem, type CompositionProblem } from './problems.ts';

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
 * - audio (`composition.layerAudio`): `AudioContext`, `webkitAudioContext`, `OfflineAudioContext`, `new Audio`, an `<audio>`
 *   element and a `<video>` element without the `muted` attribute (sound belongs on the timeline's audio tracks);
 * - autoplay (`composition.layerAutoplay`): an `autoplay` attribute on `<video>`/`<audio>` (any case), or `.autoplay` in script.
 *
 * Not checked: the bodies of HTML comments, and of `//` and `/* … *\/` comments inside `<script>` (`/* … *\/` inside
 * `<style>`). Comment markers inside script strings are not comments (strings are tracked; regex literals are not, so a
 * quote inside one can shift the string state until the end of the line). `.autoplay = false` (or `0`, `null`) is fine.
 *
 * Words are matched whole (`prefetch`, `WorkerPool` are fine). The scan is one pass over the text with bounded look-ahead,
 * and comments are skipped forward, so the work is linear in the input size and there is no regex on the input (see
 * `staticLayerCheckWork`).
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
    problems.push(compositionProblem(`composition.${category}`, { file, line, api }));
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
  // The `<video>` start tag being read, and whether it carries `muted` as an attribute (M5): a name of its own, not part of
  // another name (`data-muted`) nor of a value (`src="muted.mp4"`, `title=muted`). `tagQuote` is the open value quote.
  let videoTag = false;
  let videoMuted = false;
  let tagQuote = 0;
  // Raw text elements: inside `<script>` or `<style>` until their end tag; `pendingRaw` is set while their start tag is open.
  let raw: '' | 'script' | 'style' = '';
  let pendingRaw: '' | 'script' | 'style' = '';
  // String state inside a script (0 or the quote character), so comment markers inside strings are not comments.
  let quote = 0;
  let lastWordLower = '';
  let lastWordEnd = -1;
  let prevWord = '';
  let prevWordEnd = -1;

  let i = 0;
  /** Moves `i` to `to` (exclusive), counting lines and steps: comment bodies are skipped without being checked. */
  const skipTo = (to: number) => {
    for (; i < to; i++) { steps++; if (html.charCodeAt(i) === 0x0a) line++; }
  };
  /** Skips from `i` past the next `marker` (or to the end of the input when it is missing). */
  const skipPast = (marker: string) => {
    const at = html.indexOf(marker, i);
    skipTo(at < 0 ? n : at + marker.length);
  };
  /**
   * Skips a comment inside a script or style: past `marker` (`*\/`), or up to the newline for a line comment (`marker`
   * '\n', not consumed). It also stops before `</script` / `</style`, which ends the element even inside a comment.
   */
  const skipRawComment = (marker: string) => {
    const end = `</${raw}`;
    while (i < n) {
      steps++;
      const ch = html.charCodeAt(i);
      if (ch === 0x3c && html.slice(i, i + end.length).toLowerCase() === end) return;
      if (html.startsWith(marker, i)) { if (marker !== '\n') i += marker.length; return; }
      if (ch === 0x0a) line++;
      i++;
    }
  };

  while (i < n && problems.length < MAX_PROBLEMS) {
    steps++;
    const c = html.charCodeAt(i);
    if (c === 0x0a) { line++; i++; if (quote === 0x27 || quote === 0x22) quote = 0; continue; }
    if (c === 0x3c /* < */) {
      if (raw !== '') {
        // Only the matching end tag leaves a script or style; any other `<` is text.
        const end = `</${raw}`;
        if (html.slice(i, i + end.length).toLowerCase() === end) { steps += end.length; i += end.length; raw = ''; quote = 0; inTag = true; mediaTag = false; continue; }
        i++;
        continue;
      }
      if (html.startsWith('<!--', i)) { i += 4; skipPast('-->'); continue; }
      let j = i + 1;
      let tag = '';
      while (j < n && isAlnum(html.charCodeAt(j)) && tag.length < 16) { steps++; tag += html[j]; j++; }
      tag = tag.toLowerCase();
      inTag = tag !== '';
      mediaTag = tag === 'video' || tag === 'audio';
      videoTag = tag === 'video'; videoMuted = false; tagQuote = 0;
      if (tag === 'audio') report('layerAudio', '<audio>');
      pendingRaw = tag === 'script' || tag === 'style' ? tag : '';
      i = j;
      continue;
    }
    if (c === 0x3e /* > */ && raw === '') {
      if (inTag && pendingRaw !== '') raw = pendingRaw;
      if (inTag && videoTag && !videoMuted) report('layerAudio', '<video> without muted');
      videoTag = false; tagQuote = 0;
      inTag = false; mediaTag = false; pendingRaw = '';
      i++;
      continue;
    }
    // Attribute value quotes of a start tag (only tracked, never skipped: URLs inside values are still checked).
    if (inTag && raw === '' && (c === 0x22 || c === 0x27)) { if (tagQuote === 0) tagQuote = c; else if (tagQuote === c) tagQuote = 0; }
    if (raw === 'script') {
      if (quote !== 0) {
        if (c === 0x5c /* \ */) { steps++; if (html.charCodeAt(i + 1) === 0x0a) line++; i += 2; continue; }
        if (c === quote) { quote = 0; i++; continue; }
      } else if (c === 0x27 || c === 0x22 || c === 0x60) {
        quote = c; i++; continue;
      }
    }
    if (c === 0x3a /* : */ && html.charCodeAt(i + 1) === 0x2f && html.charCodeAt(i + 2) === 0x2f && lastWordEnd === i && SCHEMES.has(lastWordLower)) {
      const start = i - lastWordLower.length;
      const allowed = ALLOWED_URL_PREFIXES.some((p) => html.length - start >= p.length && html.slice(start, start + p.length).toLowerCase() === p);
      if (!allowed) report('layerNetwork', `${lastWordLower}://`);
      i += 3;
      continue;
    }
    if (c === 0x2f /* / */) {
      const next = html.charCodeAt(i + 1);
      if (next === 0x2f && isAlnum(html.charCodeAt(i + 2))) {
        const before = i > 0 ? html.charCodeAt(i - 1) : -1;
        if (before === 0x22 || before === 0x27 || before === 0x28) { report('layerNetwork', '//'); i += 2; continue; }
      }
      // Comments: `//` to the end of the line in scripts, `/* … */` in scripts and styles (not inside a script string).
      if (raw === 'script' && quote === 0 && next === 0x2f) { i += 2; skipRawComment('\n'); continue; }
      if (raw !== '' && quote === 0 && next === 0x2a) { i += 2; skipRawComment('*/'); continue; }
      i += next === 0x2f ? 2 : 1;
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

  /** Whether `start..end` stands as an attribute name: after whitespace or `/`, before whitespace, `=`, `/`, `>` or the end. */
  function attributeName(start: number, end: number): boolean {
    const before = html.charCodeAt(start - 1), after = end < n ? html.charCodeAt(end) : -1;
    const space = (ch: number) => ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0x0c;
    return (space(before) || before === 0x2f) && (after === -1 || space(after) || after === 0x3d || after === 0x2f || after === 0x3e);
  }

  /** After `.autoplay`: is it set to a false value (`= false`, `= 0`, `= null`)? Bounded look-ahead. */
  function setFalse(end: number): boolean {
    const eq = skipSpace(end);
    if (eq < 0 || html.charCodeAt(eq) !== 0x3d || html.charCodeAt(eq + 1) === 0x3d) return false;
    const v = skipSpace(eq + 1);
    if (v < 0) return false;
    for (const lit of ['false', '0', 'null']) {
      if (html.startsWith(lit, v) && !isIdent(html.charCodeAt(v + lit.length))) return true;
    }
    return false;
  }

  function checkWord(word: string, start: number, end: number): void {
    const always = ALWAYS.get(word);
    if (always) { report(always, word); return; }
    if (inTag && videoTag && word.toLowerCase() === 'muted') { if (tagQuote === 0 && attributeName(start, end)) videoMuted = true; return; }
    if (word === 'Audio' && prevWord === 'new' && prevWordEnd >= 0 && start - prevWordEnd <= LOOKAHEAD && html.slice(prevWordEnd, start).trim() === '') { report('layerAudio', 'new Audio'); return; }
    if (word.toLowerCase() === 'autoplay') {
      if (inTag && mediaTag) report('layerAutoplay', 'autoplay');
      else if (prevNonSpace(start) === 0x2e /* . */ && !setFalse(end)) report('layerAutoplay', 'autoplay');
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

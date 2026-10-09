// A prudent shell tokenizer: it models a small, well-understood subset of POSIX sh and gives up (`parsed: false`)
// on everything else. Single pass, char by char, no regular expressions on the input: linear time.

export type RedirectOp = '>' | '>>' | '<' | '2>' | '&>';
export interface Redirect { op: RedirectOp; target: string }
export interface SimpleCommand {
  argv: string[];
  env: Record<string, string>;
  redirects: Redirect[];
  /** Prefixes stripped from argv, in order: time, sudo, nohup, env, nice, timeout, command, builtin. */
  wrappers: string[];
}
export type Separator = ';' | '&&' | '||' | '|' | '&' | '\n';
export interface Tokenized {
  commands: SimpleCommand[];
  parsed: boolean;
  /** `separators[i]` joins `commands[i]` and `commands[i + 1]`. */
  separators: Separator[];
}

export const MAX_COMMANDS = 50;
/** Words across the whole command: beyond this nobody can review it, and the work stays small. */
export const MAX_WORDS = 1000;

const fail = (): Tokenized => ({ commands: [], parsed: false, separators: [] });

/** Characters that change how text looks or reads without being visible: never accepted in a command. */
export function isInvisibleOrControl(code: number): boolean {
  if (code < 0x20) return code !== 0x09 && code !== 0x0a;
  if (code >= 0x7f && code <= 0x9f) return true;
  return code === 0x00ad || code === 0x034f || code === 0x061c || code === 0x115f || code === 0x1160 || code === 0x17b4 || code === 0x17b5
    || code === 0x180e || (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2060 && code <= 0x206f)
    || code === 0x3164 || (code >= 0xfe00 && code <= 0xfe0f) || code === 0xfeff || code === 0xffa0 || (code >= 0xfff9 && code <= 0xfffb)
    || code === 0xdb40; // high surrogate of the tag characters (U+E0000–U+E007F)
}

const isNameStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isNameChar = (c: string) => isNameStart(c) || (c >= '0' && c <= '9');
const isDigits = (s: string) => {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) { const c = s[i]!; if (c < '0' || c > '9') return false; }
  return true;
};

/** `NAME=value` with an unquoted, valid name. */
function assignment(w: Word): [string, string] | null {
  const eq = w.text.indexOf('=');
  if (eq <= 0 || (w.quotedAt !== -1 && w.quotedAt < eq) || !isNameStart(w.text[0]!)) return null;
  for (let i = 1; i < eq; i++) if (!isNameChar(w.text[i]!)) return null;
  return [w.text.slice(0, eq), w.text.slice(eq + 1)];
}

interface Word { text: string; quotedAt: number }

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox']);
/** Words that make the rest of the command impossible to analyze from its text. */
const OPAQUE = new Set([
  'eval', 'source', '.', 'exec', 'trap', 'alias', 'unalias', 'function', 'coproc', 'select', 'let',
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in',
  '{', '}', '[[', ']]', '!', '((', '))',
]);

/** True when argv runs a shell on a command string (`bash -c`, `sh -ec`, `zsh --command`) or is opaque by itself. */
export function isOpaqueCommand(argv: readonly string[]): boolean {
  const name = argv[0];
  if (name === undefined) return false;
  if (OPAQUE.has(name)) return true;
  const base = name.slice(name.lastIndexOf('/') + 1);
  if (!SHELLS.has(base)) return false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') return false;
    if (a.startsWith('--')) { if (a === '--command' || a.startsWith('--command=') || a === '--init-file' || a === '--rcfile') return true; continue; }
    if (a.startsWith('-') || a.startsWith('+')) { if (a.includes('c') || a.includes('O') || a.includes('o')) return true; continue; }
    return false;
  }
  return false;
}

const SUDO_VALUE = new Set(['-u', '-g', '-C', '-p', '-h', '-r', '-t', '-U', '-D', '-R', '-T', '--user', '--group', '--prompt', '--host', '--role', '--type', '--other-user', '--chdir', '--chroot', '--close-from', '--command-timeout']);

/**
 * Strips leading assignments and wrappers. Returns false when a wrapper is used in a way we don't model
 * (`env -S`, `sudo -s`, `sudo -e`, …).
 */
function finishCommand(words: Word[], redirects: Redirect[]): SimpleCommand | null {
  const env: Record<string, string> = {};
  const wrappers: string[] = [];
  let i = 0;
  const takeAssignments = () => {
    for (; i < words.length; i++) {
      const a = assignment(words[i]!);
      if (!a) break;
      env[a[0]] = a[1];
    }
  };
  takeAssignments();
  for (;;) {
    const w = words[i]?.text;
    if (w === undefined) break;
    if (w === 'time') {
      wrappers.push('time'); i++;
      while (words[i]?.text === '-p' || words[i]?.text === '--') i++;
      takeAssignments();
    } else if (w === 'nohup' || w === 'builtin') {
      wrappers.push(w); i++;
    } else if (w === 'command') {
      const next = words[i + 1]?.text;
      if (next === '-v' || next === '-V') break; // a lookup, explained as such
      wrappers.push(w); i++;
      while (words[i]?.text === '-p' || words[i]?.text === '--') i++;
    } else if (w === 'sudo') {
      wrappers.push('sudo'); i++;
      for (; i < words.length; i++) {
        const a = words[i]!.text;
        if (a === '--') { i++; break; }
        if (!a.startsWith('-') || a === '-') break;
        if (a === '-s' || a === '-i' || a === '-e' || a === '--shell' || a === '--login' || a === '--edit' || a === '-l' || a === '--list' || a === '-v' || a === '--validate') return null;
        if (SUDO_VALUE.has(a)) { i++; continue; }
        if (a.startsWith('--')) continue;
        // Short clusters: `-En`; a value flag at the end of a cluster takes the next word.
        const last = `-${a[a.length - 1]}`;
        if (a.length > 2 && SUDO_VALUE.has(last)) i++;
        for (const ch of a.slice(1)) if (ch === 's' || ch === 'i' || ch === 'e' || ch === 'l' || ch === 'v') return null;
      }
      takeAssignments();
      if (i >= words.length) return null; // `sudo` alone, `sudo -u x`: nothing we can explain
    } else if (w === 'env') {
      wrappers.push('env'); i++;
      for (; i < words.length; i++) {
        const a = words[i]!.text;
        if (a === '--') { i++; break; }
        if (a === '-i' || a === '-' || a === '--ignore-environment' || a === '-0' || a === '--null' || a === '-v') continue;
        if (a === '-u' || a === '--unset') { i++; continue; }
        if (a.startsWith('--unset=')) continue;
        if (a.startsWith('-')) return null; // -S, -C, -P, --split-string, …
        break;
      }
      takeAssignments();
    } else if (w === 'nice') {
      wrappers.push('nice'); i++;
      for (; i < words.length; i++) {
        const a = words[i]!.text;
        if (a === '-n') { i++; continue; }
        if (a.startsWith('-') && a !== '-') continue;
        break;
      }
    } else if (w === 'timeout' || w === 'gtimeout') {
      wrappers.push('timeout'); i++;
      for (; i < words.length; i++) {
        const a = words[i]!.text;
        if (a === '-s' || a === '-k' || a === '--signal' || a === '--kill-after') { i++; continue; }
        if (a.startsWith('-')) continue;
        break;
      }
      i++; // the duration
      if (i > words.length) return null;
    } else break;
  }
  const argv = words.slice(i).map((x) => x.text);
  if (isOpaqueCommand(argv)) return null;
  // A wrapper inside the arguments (`time time x`) is already handled by the loop; a wrapper with nothing after it
  // (`env`, `time`) keeps an empty argv.
  return { argv, env, redirects, wrappers };
}

/** Splits a shell command into simple commands. Any construct outside the modeled subset yields `parsed: false`. */
export function tokenize(command: string): Tokenized {
  const s = command;
  const n = s.length;
  for (let i = 0; i < n; i++) if (isInvisibleOrControl(s.charCodeAt(i))) return fail();

  const commands: SimpleCommand[] = [];
  const separators: Separator[] = [];
  let words: Word[] = [];
  let redirects: Redirect[] = [];
  let cur = '';
  let started = false;
  let quotedAt = -1;
  /** A redirect waiting for its target word: an op, or 'dup>' / 'dup<' for `>&` / `<&`. */
  let pending: RedirectOp | 'dup>' | 'dup<' | null = null;
  /** The last separator needs a command after it (`&&`, `||`, `|`). */
  let needCommand = false;
  let wordCount = 0;

  const markQuoted = () => { if (quotedAt === -1) quotedAt = cur.length; started = true; };

  /** Ends the current word. Returns false on an error. */
  const endWord = (): boolean => {
    if (!started) return true;
    const w: Word = { text: cur, quotedAt };
    cur = ''; started = false; quotedAt = -1;
    if (pending !== null) {
      const p = pending;
      pending = null;
      if (p === 'dup>' || p === 'dup<') {
        if (w.text === '-' || isDigits(w.text) || (w.text.endsWith('-') && isDigits(w.text.slice(0, -1)))) return true; // fd duplication
        if (p === 'dup<') return false;
        redirects.push({ op: '&>', target: w.text });
        return true;
      }
      redirects.push({ op: p, target: w.text });
      return true;
    }
    words.push(w);
    return ++wordCount <= MAX_WORDS;
  };

  /** Ends the current simple command at a separator (or at the end with `sep === null`). */
  const endCommand = (sep: Separator | null): boolean => {
    if (!endWord() || pending !== null) return false;
    if (words.length === 0 && redirects.length === 0) {
      if (sep === null) return !needCommand;
      if (sep === '\n') return true; // blank line, or a newline after && / || / |
      return false; // `; a`, `a ;; b`, `a && && b`
    }
    const c = finishCommand(words, redirects);
    if (!c) return false;
    commands.push(c);
    words = []; redirects = [];
    if (commands.length > MAX_COMMANDS) return false;
    if (sep !== null) separators.push(sep);
    needCommand = sep === '&&' || sep === '||' || sep === '|';
    return true;
  };

  /** Starts a redirect; `fdWord` is the digit word right before the operator, if any. */
  const startRedirect = (op: RedirectOp | 'dup>' | 'dup<', fd: string | null): boolean => {
    if (pending !== null) return false;
    if (fd !== null && op === '&>') return false;
    if (fd === '2' && (op === '>' || op === '>>')) op = '2>';
    pending = op;
    return true;
  };

  let i = 0;
  let inSingle = false;
  let inDouble = false;
  // `${…}` copied verbatim: returns the index after `}`, or -1 when unsupported.
  const braceParam = (from: number): number => {
    let depth = 0;
    for (let j = from; j < n; j++) {
      const c = s[j]!;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return j + 1; }
      else if (c === '$' && s[j + 1] === '(') return -1;
      else if (c === '`' || c === '"' || c === "'" || c === '\\' || c === '\n') return -1;
    }
    return -1;
  };

  while (i < n) {
    const c = s[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false; else cur += c;
      i++; continue;
    }
    if (inDouble) {
      if (c === '"') { inDouble = false; i++; continue; }
      if (c === '\\') {
        const next = s[i + 1];
        if (next === undefined) return fail();
        if (next === '\n') { i += 2; continue; }
        if (next === '$' || next === '`' || next === '"' || next === '\\') { cur += next; i += 2; continue; }
        cur += '\\'; i++; continue;
      }
      if (c === '`') return fail();
      if (c === '$') {
        const next = s[i + 1];
        if (next === '(') return fail();
        if (next === '{') { const end = braceParam(i + 1); if (end < 0) return fail(); cur += s.slice(i, end); i = end; continue; }
      }
      cur += c; i++; continue;
    }
    switch (c) {
      case ' ': case '\t':
        if (!endWord()) return fail();
        i++; break;
      case '\n':
        if (!endCommand('\n')) return fail();
        i++; break;
      case '\\': {
        const next = s[i + 1];
        if (next === undefined) return fail();
        if (next === '\n') { i += 2; break; }
        markQuoted(); cur += next; i += 2; break;
      }
      case "'": markQuoted(); inSingle = true; i++; break;
      case '"': markQuoted(); inDouble = true; i++; break;
      case '`': return fail();
      case '$': {
        const next = s[i + 1];
        if (next === '(' || next === "'" || next === '"') return fail();
        if (next === '{') { const end = braceParam(i + 1); if (end < 0) return fail(); started = true; cur += s.slice(i, end); i = end; break; }
        started = true; cur += c; i++; break;
      }
      case '#':
        if (!started) return fail(); // a comment: a shell that doesn't honour it would run the rest
        cur += c; i++; break;
      case ';':
        if (s[i + 1] === ';' || s[i + 1] === '&') return fail();
        if (!endCommand(';')) return fail();
        i++; break;
      case '&':
        if (s[i + 1] === '&') { if (!endCommand('&&')) return fail(); i += 2; break; }
        if (s[i + 1] === '>') {
          if (!endWord()) return fail();
          i += 2;
          if (s[i] === '>') i++;
          if (!startRedirect('&>', null)) return fail();
          break;
        }
        if (!endCommand('&')) return fail();
        i++; break;
      case '|':
        if (s[i + 1] === '|') { if (!endCommand('||')) return fail(); i += 2; break; }
        if (!endCommand('|')) return fail();
        i += s[i + 1] === '&' ? 2 : 1; break;
      case '>': case '<': {
        let fd: string | null = null;
        if (started && quotedAt === -1 && isDigits(cur)) { fd = cur; cur = ''; started = false; }
        else if (!endWord()) return fail();
        const next = s[i + 1];
        if (c === '<') {
          if (next === '<' || next === '(' || next === '>') return fail();
          if (next === '&') { if (!startRedirect('dup<', fd)) return fail(); i += 2; break; }
          if (!startRedirect('<', fd)) return fail();
          i++; break;
        }
        if (next === '(') return fail();
        if (next === '>') {
          if (s[i + 2] === '&' || s[i + 2] === '(' || s[i + 2] === '|') return fail();
          if (!startRedirect('>>', fd)) return fail();
          i += 2; break;
        }
        if (next === '&') { if (!startRedirect('dup>', fd)) return fail(); i += 2; break; }
        if (!startRedirect('>', fd)) return fail();
        i += next === '|' ? 2 : 1; break;
      }
      case '(': case ')': return fail();
      default:
        started = true; cur += c; i++;
    }
  }
  if (inSingle || inDouble) return fail();
  if (!endCommand(null)) return fail();
  if (commands.length === 0) return fail();
  return { commands, parsed: true, separators };
}

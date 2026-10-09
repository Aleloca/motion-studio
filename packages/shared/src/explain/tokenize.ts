// A prudent shell tokenizer: it models a small, well-understood subset of POSIX sh and gives up (`parsed: false`)
// on everything else. Single pass, char by char, no regular expressions on the input: linear time.
import { explainWork } from './work.ts';

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

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'ash']);
/**
 * Words that make the rest of the command impossible to analyze from its text: shell syntax, and programs that run a
 * command string or another command in ways we don't model (`su -c`, `watch`, `parallel`, debuggers, schedulers…).
 */
const OPAQUE = new Set([
  'eval', 'source', '.', 'exec', 'trap', 'alias', 'unalias', 'function', 'coproc', 'select', 'let',
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in',
  '{', '}', '[[', ']]', '!', '((', '))',
  'su', 'runuser', 'watch', 'parallel', 'flock', 'chroot', 'sandbox-exec', 'unbuffer', 'stdbuf', 'ionice', 'taskpolicy',
  'dtruss', 'strace', 'ltrace', 'lldb', 'gdb', 'expect', 'at', 'batch', 'emacs', 'vim', 'vi', 'nvim', 'ex', 'ed',
]);

/** System folders whose programs we recognise by name. Anything else with a `/` is "a file run directly". */
export const SYSTEM_BINS = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/sbin', '/usr/sbin', '/opt/local/bin', '/usr/local/sbin'];

/** `//bin//rm`, `/bin/./rm` → `/bin/rm` (no `..` handling: a path with `..` is not a system program). */
export function normalizeCommandPath(w: string): string {
  let out = '';
  for (const seg of w.split('/')) {
    if (seg === '' || seg === '.') continue;
    out += `/${seg}`;
  }
  return w.startsWith('/') ? out || '/' : out.slice(1);
}
/** The program name when `w` is a bare name or a program in a system folder; null for any other path. */
export function systemCommandName(w: string): string | null {
  if (!w.includes('/')) return w;
  const p = normalizeCommandPath(w);
  const slash = p.lastIndexOf('/');
  return SYSTEM_BINS.includes(p.slice(0, slash)) ? p.slice(slash + 1) : null;
}
/** How a command word is matched against wrappers and the shell's opaque words: system path stripped, lower case (macOS disks ignore case). */
const commandKey = (w: string): string => (systemCommandName(w) ?? w).toLowerCase();

/** True when argv runs a shell on a command string (`bash -c`, `sh -ec`, `zsh --command`) or is opaque by itself. */
export function isOpaqueCommand(argv: readonly string[]): boolean {
  const name = argv[0];
  if (name === undefined) return false;
  const key = commandKey(name);
  if (OPAQUE.has(key) || OPAQUE.has(name)) return true;
  const base = key.slice(key.lastIndexOf('/') + 1);
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
 * Strips leading assignments and wrappers (time, sudo/doas, nohup, env, nice, timeout, command, builtin, noglob,
 * caffeinate, xcrun, script, arch). Returns null when a wrapper is used in a way we don't model
 * (`env -S`, `sudo -s`, `script file cmd`, an unknown wrapper option, …).
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
  const text = (k: number) => words[k]?.text;
  takeAssignments();
  for (;;) {
    const raw = text(i);
    if (raw === undefined) break;
    const w = commandKey(raw);
    if (w === 'time') {
      wrappers.push('time'); i++;
      // bash `time -p`; /usr/bin/time `-l`, `-h`, `-p`, `-a`. `-o file` writes a file: not modeled.
      for (; i < words.length; i++) {
        const a = text(i)!;
        if (a === '--') { i++; break; }
        if (!a.startsWith('-') || a === '-') break;
        if (![...a.slice(1)].every((c) => 'plha'.includes(c))) return null;
      }
      takeAssignments();
    } else if (w === 'nohup' || w === 'builtin' || w === 'noglob' || w === 'nocorrect' || w === 'busybox') {
      wrappers.push(w); i++;
    } else if (w === 'command') {
      const next = text(i + 1);
      if (next === '-v' || next === '-V') break; // a lookup, explained as such
      wrappers.push(w); i++;
      while (text(i) === '-p' || text(i) === '--') i++;
    } else if (w === 'sudo' || w === 'doas') {
      wrappers.push(w); i++;
      for (; i < words.length; i++) {
        const a = text(i)!;
        if (a === '--') { i++; break; }
        if (!a.startsWith('-') || a === '-') break;
        if (w === 'doas') { if (a === '-u') { i++; continue; } if (a === '-n') continue; return null; }
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
        const a = text(i)!;
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
        const a = text(i)!;
        if (a === '-n' || a === '--adjustment') { i++; continue; }
        if (a.startsWith('--adjustment=') || (a.startsWith('-') && a.length > 1 && isDigits(a.slice(a[1] === '-' ? 2 : 1)))) continue;
        if (a.startsWith('-')) return null;
        break;
      }
    } else if (w === 'timeout' || w === 'gtimeout') {
      wrappers.push('timeout'); i++;
      for (; i < words.length; i++) {
        const a = text(i)!;
        if (a === '-s' || a === '-k' || a === '--signal' || a === '--kill-after') { i++; continue; }
        if (a === '--preserve-status' || a === '--foreground' || a === '-v' || a === '--verbose' || a.startsWith('--signal=') || a.startsWith('--kill-after=')) continue;
        if (a.startsWith('-')) return null;
        break;
      }
      i++; // the duration
      if (i >= words.length) return null;
    } else if (w === 'caffeinate' || w === 'arch' || w === 'xcrun' || w === 'script') {
      // These run the command that follows their options; alone (or as a lookup) they are explained by the dictionary.
      let k = i + 1;
      const VALUE: Record<string, string[]> = {
        caffeinate: ['-t', '-w'], arch: ['-arch', '-d', '-e'], xcrun: ['-sdk', '--sdk', '--toolchain'], script: ['-t', '-T'],
      };
      const NOVAL: Record<string, string[]> = {
        caffeinate: ['-d', '-i', '-m', '-s', '-u', '-di', '-dims', '-dimsu', '-is', '-im', '-ims'],
        arch: ['-x86_64', '-x86_64h', '-arm64', '-arm64e', '-i386', '-32', '-64', '-c', '-h'],
        xcrun: ['-l', '--log', '-v', '--verbose', '-n', '--no-cache', '-k', '--kill-cache', '-r', '--run'],
        script: ['-a', '-d', '-e', '-F', '-k', '-p', '-q', '-r', '-aq', '-qa', '-q', '-qF'],
      };
      let lookup = false;
      for (; k < words.length; k++) {
        const a = text(k)!;
        if (!a.startsWith('-')) break;
        if (VALUE[w]!.includes(a)) { if (w === 'arch' && a === '-e') { const asg = words[k + 1] && assignment(words[k + 1]!); if (asg) env[asg[0]] = asg[1]; } k++; continue; }
        if (NOVAL[w]!.includes(a)) continue;
        if (w === 'xcrun' && (a === '-f' || a === '--find' || a.startsWith('--show'))) { lookup = true; break; }
        return null;
      }
      if (lookup || k >= words.length) break;
      if (w === 'script') {
        if (text(k) !== '/dev/null') return null; // the typescript file is written: not modeled
        k++;
        if (k >= words.length) return null; // an interactive shell
      }
      wrappers.push(w);
      i = k;
    } else break;
  }
  // zsh `=cmd` expands to the program's path: the command itself.
  const first = words[i];
  if (first && first.text.length > 1 && first.text.startsWith('=') && first.quotedAt === -1) words[i] = { text: first.text.slice(1), quotedAt: -1 };
  const argv = words.slice(i).map((x) => x.text);
  if (isOpaqueCommand(argv)) return null;
  // A wrapper with nothing after it (`env`, `time`) keeps an empty argv.
  return { argv, env, redirects, wrappers };
}

/**
 * A subscript shape (`name[`, an identifier character right before `[`) followed later in the word by `$(` or a backtick:
 * arithmetic contexts run it (`printf %d 'a[$(id)]'`). `"frame[${i}]"`, `"[0:v]…${T}"` and `-m "fix: [x] ${y}"` are fine.
 * Linear: one pass to the first subscript shape, then two indexOf calls.
 */
export function hasSubscriptCode(word: string): boolean {
  for (let i = 1; i < word.length; i++) {
    if (word[i] !== '[') continue;
    const c = word[i - 1]!;
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_')) continue;
    // The subscript runs to the matching `]` (nested brackets included), or to the end of the word.
    let depth = 0;
    let j = i;
    for (; j < word.length; j++) {
      const ch = word[j]!;
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) break; }
      else if (ch === '`' || (ch === '$' && word[j + 1] === '(')) return true;
    }
    i = j; // continue after this subscript: every character is visited once
  }
  return false;
}

/** The same assignment and wrapper stripping, for a command run by another one (`find -exec`, `xargs`). */
export function commandFromArgv(argv: readonly string[]): SimpleCommand | null {
  if (argv.some(hasSubscriptCode)) return null;
  return finishCommand(argv.map((text) => ({ text, quotedAt: -1 })), []);
}

/** Splits a shell command into simple commands. Any construct outside the modeled subset yields `parsed: false`. */
export function tokenize(command: string): Tokenized {
  /** Characters visited, for the linear-work tests. */
  let steps = 0;
  try { return scan(); } finally { explainWork.add(steps); }
  function scan(): Tokenized {
  const s = command;
  const n = s.length;
  steps += n;
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
    // Arithmetic contexts evaluate `a[$(cmd)]` even from quotes (`printf %d 'a[$(cmd)]'`, `exit`, `wait -p`, `x='a[$(…)]'; printf %d x`):
    // any word with `[` followed by a command substitution or an expansion is not modeled.
    if (hasSubscriptCode(cur)) return false;
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
  // `${NAME}` and `${NAME:-word}` (also `:=`, `:+`, `:?`, without the colon too) with a simple word; returns the index
  // after `}`, or -1 for anything else: `${(e)X}`, `${X:Y}`, `${#X}`, `${X/a/b}`, `${X[…]}`, `${!X}`… can evaluate code.
  const braceParam = (from: number): number => {
    let j = from + 1; // after `{`
    const nameStart = j;
    if (j < n && (isNameStart(s[j]!))) { j++; while (j < n && isNameChar(s[j]!)) j++; }
    else while (j < n && s[j]! >= '0' && s[j]! <= '9') j++;
    if (j === nameStart) return -1;
    if (s[j] === ':') j++;
    if (s[j] === '-' || s[j] === '=' || s[j] === '+' || s[j] === '?') {
      j++;
      while (j < n) {
        const c = s[j]!;
        if (!(isNameChar(c) || c === '.' || c === '/' || c === '~' || c === '-')) break;
        j++;
      }
    } else if (s[j - 1] === ':') return -1;
    steps += j - from;
    if (s[j] !== '}') return -1;
    if (s[j + 1] === '[') return -1; // zsh subscript
    return j + 1;
  };
  /** `$NAME[` (a zsh subscript, evaluated arithmetically) and `$[` (old arithmetic): not modeled. */
  const badDollar = (at: number): boolean => {
    let j = at + 1;
    if (s[j] === '[') return true;
    while (j < n && isNameChar(s[j]!)) j++;
    steps += j - at;
    return j > at + 1 && s[j] === '[';
  };

  while (i < n) {
    steps++;
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
        if (next === '(' || badDollar(i)) return fail();
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
        if (next === '(' || next === "'" || next === '"' || badDollar(i)) return fail();
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
}

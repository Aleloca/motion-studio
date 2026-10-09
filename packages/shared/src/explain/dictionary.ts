// Per-command explanations. Each handler adds exactly one phrase and the indicators the command deserves.
// When a handler meets something it can't model it sets `st.parsed = false`: the caller then shows the generic phrase.
//
// RULE: default-deny argument shapes.
// - Every entry lists the option shapes it understands (an allow-list, `Spec`). An option that is not listed adds
//   `unknown-command` (medium) with `{ option }`, so an unmodelled flag can never leave a command at "low".
// - An unmodelled subcommand is `unknown-command` (medium) too.
// - Options known to run code or write somewhere we can't see (`git -c`, `--upload-pack`, `sed …/e`, `tar --to-command`,
//   `curl -K`, `rg --pre`, …) give `parsed: false` (the generic "complex" phrase) or a high indicator.
// - `any: true` is used only for pure readers: tools whose whole option set has no write or exec effect. Each use carries
//   a `pure reader:` comment saying why. Anything that can write or run code through an option has an allow-list.
// - Long options that run code are also matched by unambiguous prefix (`--upload-p`, `--to-comm`): see DANGER_OPTS.
// - A command run by another one (`find -exec`, `xargs`) goes through the same wrapper stripping as a top-level one.
// - The common, everyday shapes (ffmpeg encodes, pip/npm installs, sips, cwebp, mkdir/cp/mv) are modelled in full,
//   and the "common commands" group of the table test pins their exact result.
import type { IndicatorId, Phrase, Risk } from './types.ts';
import type { Indicators } from './indicators.ts';
import { commandFromArgv, isOpaqueCommand, normalizeCommandPath, systemCommandName, type SimpleCommand } from './tokenize.ts';
import { dirnameAbs, displayLoc, isHarmlessDevice, normalizeAbs, resolveLocs, type ExplainContext, type Loc } from './paths.ts';
import { explainWork } from './work.ts';

export interface State {
  ctx: ExplainContext;
  /** The folder relative paths start from (null: unknown). */
  cwd: string | null;
  /** Other folders the command may be running in (`cd x; …` when the cd may have failed): paths are rated against all of them. */
  altCwds: (string | null)[];
  ind: Indicators;
  phrases: Phrase[];
  parsed: boolean;
  /** This command reads its stdin from a pipe. */
  pipedIn: boolean;
  /** An earlier command of the same pipeline uses the network. */
  pipeNet: boolean;
  /** The current command used the network. */
  usedNet: boolean;
  /** An earlier command of the whole chain used the network (`curl -o x.sh … && sh x.sh`). */
  chainNet: boolean;
  /** Absolute paths written earlier in the chain (capped): running one of them is at least medium. */
  written: string[];
  /** Set by `cd`/`pushd`: where the next command runs if the `cd` succeeded (each null: unknown). */
  cdTarget?: (string | null)[];
  /** Words containing `token` stand for these locations (`find … -exec … {}`, `xargs` input). */
  found: { token: string; locs: Loc[] } | null;
  /** Display of the first stdout redirect target of the current command, if any. */
  stdout: string | null;
  /** Display of the first stdin redirect source of the current command, if any. */
  stdinFile: string | null;
}

type Handler = (args: string[], st: State, name: string) => void;

const P = (st: State, key: string, params: Record<string, string | number> = {}) => { st.phrases.push({ key: `explain.${key}`, params }); };
const add = (st: State, id: IndicatorId, risk: Risk, params?: Record<string, string>) => {
  if (id === 'uses-network') st.usedNet = true;
  st.ind.add(id, risk, params);
};
const unknownOpt = (st: State, option: string) => add(st, 'unknown-command', 'medium', { option });

const PLACEHOLDER_INPUT = '$MOTION_STUDIO_INPUT';
const MAX_WRITTEN = 200;

// ——— paths ———

const UNKNOWN_LOC = (raw: string): Loc => ({ cls: 'unknown', abs: null, raw, critical: true });
const isRelativeWord = (w: string) => !w.startsWith('/') && !w.startsWith('~') && !w.startsWith('$');
function locsOf(st: State, word: string, cwd: string | null = st.cwd): Loc[] {
  if (st.found && st.found.token !== '' && word.includes(st.found.token)) return st.found.locs;
  const locs = resolveLocs(word, cwd, st.ctx);
  // A relative path in a command that may run in several folders: every one of them counts (the caller rates the worst).
  if (cwd === st.cwd && st.altCwds.length > 0 && isRelativeWord(word)) for (const alt of st.altCwds) locs.push(...resolveLocs(word, alt, st.ctx));
  return locs;
}

export function fmtList(items: readonly string[]): string {
  const uniq = [...new Set(items.filter((x) => x !== ''))];
  if (uniq.length === 0) return '…';
  return uniq.length > 3 ? `${uniq.slice(0, 3).join(', ')} +${uniq.length - 3}` : uniq.join(', ');
}

/** Display of a list of path words: the first three resolved, the rest only counted. */
function dispN(st: State, words: readonly string[], cwd: string | null = st.cwd): { s: string; n: number } {
  const shown: string[] = [];
  const rest = new Set<string>();
  for (const w of words) {
    if (shown.length < 3) {
      const l = locsOf(st, w, cwd)[0];
      if (l) { const d = displayLoc(l, st.ctx); if (!shown.includes(d)) shown.push(d); }
    } else rest.add(w);
  }
  if (shown.length === 0) return { s: '…', n: 0 };
  return { s: rest.size ? `${shown.join(', ')} +${rest.size}` : shown.join(', '), n: shown.length + rest.size };
}
const disp = (st: State, words: readonly string[], cwd: string | null = st.cwd): string => dispN(st, words, cwd).s;
/** A phrase whose list parameter also carries its size `n`, so the catalogs can choose singular or plural. */
function PL(st: State, key: string, param: string, words: readonly string[], extra: Record<string, string> = {}): void {
  const d = dispN(st, words);
  P(st, key, { ...extra, [param]: d.s, n: d.n });
}

/** Arguments that look like paths: shown in phrases and checked for unknown commands and script arguments. */
const pathLike = (w: string) => w.startsWith('/') || w.startsWith('~') || w.startsWith('$') || w.startsWith('.') || w.includes('/');
/** Arguments that look like files (`logo.png`, `a/b`): for display among tool values like `80` or `photo`. */
const fileLike = (w: string) => {
  if (pathLike(w)) return true;
  const dot = w.lastIndexOf('.');
  const ext = w.slice(dot + 1);
  if (dot <= 0 || ext.length < 1 || ext.length > 5) return false;
  for (const c of ext) if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) return false;
  for (const c of w) if (c === ' ' || c === '=' || c === ':' || c === '\t') return false;
  return true;
};
/** Drops trailing slashes without a regex (`/\/+$/` backtracks quadratically on long runs of slashes). */
const trimSlashes = (w: string) => { let e = w.length; while (e > 1 && w[e - 1] === '/') e--; return w.slice(0, e); };
const isDigitsStr = (s: string) => s.length > 0 && [...s].every((c) => c >= '0' && c <= '9');

const wasWritten = (st: State, abs: string) => st.written.some((w) => abs === w || abs.startsWith(`${w}/`));

/** Writes into `.git/` (hooks, config) or a `bin` folder arrange for code to run later. Used by Bash writes and by Edit/Write. */
export function sensitiveWrite(ind: Indicators, abs: string | null, path: string): void {
  if (abs === null) return;
  const segs = abs.split('/');
  if (segs.includes('.git')) { ind.add('changes-git', 'medium', { path }); ind.add('runs-code', 'medium', { path }); }
  else if (segs.includes('bin') || segs.includes('.bin')) ind.add('runs-code', 'medium', { path });
}

function read(st: State, words: readonly string[], cwd: string | null = st.cwd): void {
  for (const w of words) for (const l of locsOf(st, w, cwd)) {
    if (isHarmlessDevice(l.abs)) continue;
    if (l.cls === 'outside' || l.cls === 'unknown') add(st, 'reads-outside-project', 'medium', { path: displayLoc(l, st.ctx) });
  }
}
function write(st: State, words: readonly string[], cwd: string | null = st.cwd): void {
  for (const w of words) for (const l of locsOf(st, w, cwd)) {
    if (isHarmlessDevice(l.abs)) continue;
    if (l.cls === 'outside' || l.cls === 'unknown') add(st, 'writes-outside-project', 'high', { path: displayLoc(l, st.ctx) });
    if (l.abs !== null) {
      if (st.written.length < MAX_WRITTEN) st.written.push(l.abs);
      sensitiveWrite(st.ind, l.abs, displayLoc(l, st.ctx));
    }
  }
}
function del(st: State, words: readonly string[], cwd: string | null = st.cwd): void {
  if (words.length === 0) { add(st, 'deletes-files', 'medium'); return; }
  for (const w of words) for (const l of locsOf(st, w, cwd)) {
    if (isHarmlessDevice(l.abs)) continue;
    const high = l.cls === 'outside' || l.cls === 'unknown' || l.critical;
    add(st, 'deletes-files', high ? 'high' : 'medium', { path: displayLoc(l, st.ctx) });
  }
}
/** Moving files away deletes their old location: outside, unknown or critical sources (`mv * /tmp/`, `mv . x`) are high. */
function delIfCritical(st: State, words: readonly string[]): void {
  for (const w of words) for (const l of locsOf(st, w)) {
    if (isHarmlessDevice(l.abs)) continue;
    if (l.cls === 'outside' || l.cls === 'unknown' || l.critical) add(st, 'deletes-files', 'high', { path: displayLoc(l, st.ctx) });
  }
}
/** Runs a script file: low inside the project, medium elsewhere, after a download, or when written earlier in the chain. */
function script(st: State, word: string): void {
  const ls = locsOf(st, word);
  const inProject = ls.every((l) => l.cls === 'work' || l.cls === 'project');
  const fresh = ls.some((l) => l.abs !== null && wasWritten(st, l.abs));
  add(st, 'runs-code', inProject && !st.chainNet && !fresh ? 'low' : 'medium');
  read(st, [word]);
}
/** A file or folder an interpreter loads code or configuration from (`-I`, `--require`, `-d auto_prepend_file`, `--env-file`). */
function codeFrom(st: State, word: string): void {
  const ls = locsOf(st, word);
  if (ls.some((l) => l.cls !== 'work' && l.cls !== 'project')) add(st, 'runs-code', 'medium', { path: displayLoc(ls[0]!, st.ctx) });
  read(st, [word]);
}
/** System font folders: reading a font there is expected (drawtext, -font) and adds nothing. */
const isSystemFont = (w: string) => ['/System/Library/Fonts/', '/Library/Fonts/', '/usr/share/fonts/', '/usr/local/share/fonts/', '/opt/homebrew/share/fonts/'].some((d) => w.startsWith(d)) && !w.includes('/../');
/** Arguments given to a script: a path outside the project may be written by it. */
function scriptArgs(st: State, args: readonly string[]): void {
  for (const a of args) {
    // `--out=/x` and `of=/dev/disk2` carry a path after `=`.
    const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : a;
    if (pathLike(v)) write(st, [v]); else if (pathLike(a) && !a.startsWith('-')) write(st, [a]);
  }
}
/** `/dev/stdin`, `//dev/fd/0`, `/proc/self/fd/0`: a script read from stdin. */
/** `/dev/stdin`, `//dev/stdin`, `/dev/../dev/stdin`, `/dev/fd/00`, `/proc/self/fd/0`: a script read from stdin. */
const isStdinPath = (w: string) => {
  if (['/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'].includes(normalizeCommandPath(w))) return true;
  if (!w.startsWith('/') || w.length > 256) return false;
  return /^\/(?:dev\/stdin|dev\/fd\/0+|proc\/(?:self|thread-self|[0-9]+)\/fd\/0+)$/.test(normalizeAbs(w));
};
/** Code read from stdin (`curl … | sh`): high when the pipeline downloads it. */
function runsInput(st: State, lang: 'python' | 'node' | 'shell'): void {
  if (st.stdinFile !== null) {
    P(st, lang === 'python' ? 'pythonScript' : lang === 'node' ? 'nodeScript' : 'runScript', { script: st.stdinFile });
    add(st, 'runs-code', 'medium');
    return;
  }
  P(st, 'runsInput');
  add(st, 'runs-code', st.pipedIn && st.pipeNet ? 'high' : 'medium');
}

const DELETE_TOKENS = ['rm_rf', 'rm_r', 'FileUtils.rm', 'File.delete', 'rmtree', 'os.remove', 'unlink', 'rmdir', 'remove(', 'rmSync', 'rimraf', 'fs.rm', 'shutil.move', "'rm'", '"rm"', 'rm -'];
const SPAWN_TOKENS = ['do shell script', 'doShellScript', 'system(', 'os.system', 'subprocess', 'os.popen', 'os.exec', 'os.spawn', 'pty.spawn', 'child_process', 'execSync', 'spawn(', 'exec(', 'eval(', '__import__', 'execFile', 'process.binding', 'shell_exec', 'passthru', 'popen', 'proc_open', 'Bun.spawn', 'Deno.run', 'Deno.Command'];
/** In perl, ruby, php and shell-like languages a backtick or `system `/`exec ` runs a command; in JavaScript a backtick is a template literal. */
const SHELLISH_SPAWN_TOKENS = ['`', 'system ', 'exec ', '%x(', '%x{', 'qx(', 'qx{', 'qx/'];
const NET_TOKENS = ['urllib', 'requests', 'http.client', 'httpx', 'socket', 'fetch(', 'http.get', 'https.get', 'http.request', 'https.request', 'net.connect', 'ftplib', 'smtplib', 'Net::', 'LWP', 'curl_', 'file_get_contents(\'http', 'open-uri'];
/** Inline code (`python3 -c`, `node -e`, `perl -e`…) can do anything: medium at least, more when it visibly deletes, spawns or connects. */
function inlineCode(st: State, code: string, lang: 'js' | 'python' | 'shellish' = 'shellish'): void {
  explainWork.add(code.length * 4);
  const spawns = SPAWN_TOKENS.some((t) => code.includes(t)) || (lang === 'shellish' && SHELLISH_SPAWN_TOKENS.some((t) => code.includes(t)));
  add(st, 'runs-code', spawns ? 'high' : 'medium');
  if (DELETE_TOKENS.some((t) => code.includes(t))) add(st, 'deletes-files', 'high');
  if (NET_TOKENS.some((t) => code.includes(t))) add(st, 'uses-network', 'medium');
}

// ——— option parsing ———

interface Spec {
  /** Options without a value (single letters `-r`, long `--force`, or single-dash long `-hide_banner`). */
  f?: readonly string[];
  /** Options taking one value (attached `-n5` / `--x=v`, or the next word). */
  v?: readonly string[];
  /** Every option is harmless for this tool (read-only tools only). */
  any?: boolean;
  /** `-5`, `-20`: numeric options (head, tail, kill). */
  num?: boolean;
  /** Single-dash long options only (`-lossless`, `-strip`): no letter clusters, a word matches whole or is unknown. */
  long1?: boolean;
}
interface Opts { flags: string[]; values: Map<string, string[]>; operands: string[] }

/** Splits options from operands. Options outside `spec` add `unknown-command` (medium) unless `spec.any`. */
function opts(st: State, args: readonly string[], spec: Spec = {}): Opts {
  explainWork.add(args.length);
  const f = new Set(spec.f ?? []);
  const v = new Set(spec.v ?? []);
  const flags: string[] = [];
  const values = new Map<string, string[]>();
  const operands: string[] = [];
  const put = (name: string, val: string | undefined) => {
    if (val === undefined) return;
    const list = values.get(name);
    if (list) list.push(val); else values.set(name, [val]);
  };
  const unknown = (name: string) => { if (!spec.any) unknownOpt(st, name); };
  let end = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // A word with `$` is an expansion, never an option cluster (`-rf${IFS}$HOME`, `-$X`).
    if (end || a === '-' || !a.startsWith('-') || a.includes('$')) { operands.push(a); continue; }
    if (a === '--') { end = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      flags.push(name);
      if (!f.has(name) && !v.has(name)) unknown(name);
      if (eq > 0) put(name, a.slice(eq + 1));
      else if (v.has(name)) put(name, args[++i]);
      continue;
    }
    if (v.has(a)) { flags.push(a); put(a, args[++i]); continue; }
    if (f.has(a)) { flags.push(a); continue; }
    if (spec.num && isDigitsStr(a.slice(1))) { flags.push(a); continue; }
    if (spec.long1) { flags.push(a); unknown(a); continue; }
    // A single-dash long option with `=` (`-ss=1` is not a thing; `-strip=all` is): name before `=`.
    for (let k = 1; k < a.length; k++) {
      const fl = `-${a[k]}`;
      flags.push(fl);
      if (v.has(fl)) { const rest = a.slice(k + 1); put(fl, rest !== '' ? rest : args[++i]); break; }
      if (!f.has(fl)) unknown(fl);
    }
  }
  return { flags, values, operands };
}
const has = (o: Opts, ...names: string[]) => names.some((n) => o.flags.includes(n));
const vals = (o: Opts, ...names: string[]) => names.flatMap((n) => o.values.get(n) ?? []);

function isUrl(w: string): boolean {
  const i = w.indexOf('://');
  if (i <= 0) return false;
  for (let k = 0; k < i; k++) {
    const c = w[k]!;
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '+' || c === '-' || c === '.')) return false;
  }
  return true;
}
/** `https://user:pw@host:8443/x?y` → `host:8443`; a bare `host/path` → `host`. Non-ASCII hosts are shown in punycode. */
export function hostOf(url: string): string {
  let s = url;
  const i = s.indexOf('://');
  if (i >= 0) s = s.slice(i + 3);
  let end = s.length;
  for (const c of ['/', '?', '#']) { const k = s.indexOf(c); if (k >= 0 && k < end) end = k; }
  s = s.slice(0, end);
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  if (s === '') return '…';
  let ascii = true;
  for (let k = 0; k < s.length; k++) if (s.charCodeAt(k) > 0x7e) { ascii = false; break; }
  if (!ascii) {
    try { return new URL(`http://${s}`).host; } catch { return '?'; }
  }
  return s;
}
/** A repository URL without credentials or query: `github.com/acme/kit.git`. */
function repoOf(url: string): string {
  if (!isUrl(url)) { const at = url.indexOf('@'); return at >= 0 ? url.slice(at + 1) : url; }
  const host = hostOf(url);
  const rest = url.slice(url.indexOf('://') + 3);
  const slash = rest.indexOf('/');
  let path = slash >= 0 ? rest.slice(slash) : '';
  for (const c of ['?', '#']) { const k = path.indexOf(c); if (k >= 0) path = path.slice(0, k); }
  return host + path;
}

// ——— the dictionary ———

const H = new Map<string, Handler>();
const def = (names: string[], h: Handler) => { for (const n of names) H.set(n, h); };

// Files.
def(['cd', 'pushd'], (args, st) => {
  const o = opts(st, args, { f: ['-P', '-L', '-e', '-@'] });
  const target = o.operands[0];
  if (target === undefined) { st.cdTarget = [st.ctx.home]; P(st, 'cd', { path: '~' }); return; }
  if (target === '-') { st.cdTarget = [null]; P(st, 'cd', { path: '-' }); return; }
  const ls = locsOf(st, target);
  P(st, 'cd', { path: disp(st, [target]) });
  st.cdTarget = [...new Set(ls.map((l) => (l.abs !== null && !l.abs.includes('*') && !l.abs.includes('?') ? l.abs : null)))];
});
def(['popd'], (_args, st) => { st.cdTarget = [null]; P(st, 'cd', { path: '…' }); });
def(['ls'], (args, st) => {
  // pure reader: ls (BSD and GNU) has no option that writes or runs anything.
  const o = opts(st, args, { any: true, v: ['-I', '--ignore', '-w', '--width', '-T', '--tabsize', '--format', '--sort', '--time-style', '-D', '--hide', '--block-size'] });
  const targets = o.operands.length ? o.operands : ['.'];
  read(st, targets);
  P(st, 'list', { paths: disp(st, targets) });
});
def(['cat'], (args, st) => {
  // pure reader: cat's options only change how the text is printed.
  const o = opts(st, args, { any: true });
  const files = o.operands.filter((x) => x !== '-');
  read(st, files);
  if (files.length) P(st, 'show', { paths: disp(st, files) }); else P(st, 'filterPipe');
});
def(['head', 'tail'], (args, st, name) => {
  // pure reader: head/tail options select lines or bytes, or follow a file.
  const o = opts(st, args, { any: true, num: true, v: ['-n', '-c', '-b', '--lines', '--bytes', '-s', '--sleep-interval', '--pid'] });
  const files = o.operands.filter((x) => x !== '-');
  read(st, files);
  const base = name === 'head' ? 'head' : 'tail';
  if (files.length) P(st, `${base}File`, { paths: disp(st, files) }); else P(st, `${base}Pipe`);
});
def(['file'], (args, st) => {
  // `-C` compiles a magic file (a write): not listed.
  const o = opts(st, args, { f: ['-b', '-i', '-I', '-L', '-h', '-z', '-Z', '-k', '-N', '-n', '-p', '-r', '-s', '-0', '-d', '-E', '--mime', '--mime-type', '--mime-encoding', '--brief', '--dereference', '--no-dereference', '--keep-going', '--extension', '--apple'], v: ['-m', '-M', '-F', '-P', '-e', '-f', '--magic-file', '--separator', '--exclude', '--files-from', '--parameter'] });
  read(st, [...o.operands, ...vals(o, '-f', '--files-from', '-m', '-M', '--magic-file')]);
  P(st, 'fileType', { paths: disp(st, o.operands) });
});
def(['wc'], (args, st) => {
  // pure reader: wc only counts; --files0-from reads a list (checked).
  const o = opts(st, args, { any: true, v: ['--files0-from'] });
  read(st, [...o.operands, ...vals(o, '--files0-from')]);
  if (o.operands.length) P(st, 'count', { paths: disp(st, o.operands) }); else P(st, 'countPipe');
});
def(['mkdir'], (args, st) => {
  const o = opts(st, args, { f: ['-p', '-v', '--parents', '--verbose'], v: ['-m', '--mode'] });
  write(st, o.operands);
  PL(st, 'mkdir', 'paths', o.operands);
});
const CP_SPEC: Spec = {
  f: ['-r', '-R', '-f', '-i', '-n', '-p', '-v', '-a', '-L', '-H', '-P', '-X', '-c', '-l', '-s', '-x', '-u', '-T', '-b', '-d',
    '--recursive', '--force', '--interactive', '--no-clobber', '--preserve', '--no-preserve', '--verbose', '--archive', '--update', '--parents',
    '--no-target-directory', '--backup', '--dereference', '--no-dereference', '--sparse', '--reflink', '--strip-trailing-slashes',
    '--link', '--symbolic-link', '--one-file-system', '--remove-destination', '--attributes-only', '--copy-contents'],
  v: ['-t', '--target-directory', '-S', '--suffix'],
};
const MV_SPEC: Spec = {
  f: ['-f', '-i', '-n', '-v', '-h', '-u', '-T', '-b', '--force', '--interactive', '--no-clobber', '--verbose', '--update', '--backup',
    '--strip-trailing-slashes', '--no-target-directory', '--no-copy'],
  v: ['-t', '--target-directory', '-S', '--suffix'],
};
def(['cp', 'mv'], (args, st, name) => {
  const o = opts(st, args, name === 'mv' ? MV_SPEC : CP_SPEC);
  const t = vals(o, '-t', '--target-directory');
  const dest = t.length ? t : o.operands.slice(-1);
  const sources = t.length ? o.operands : o.operands.slice(0, -1);
  if (name === 'mv') { delIfCritical(st, sources); write(st, sources); } else read(st, sources);
  write(st, dest);
  P(st, name === 'mv' ? 'move' : 'copy', { sources: disp(st, sources), dest: disp(st, dest) });
});
const RM_SPEC: Record<string, Spec> = {
  rm: { f: ['-r', '-R', '-f', '-i', '-I', '-d', '-v', '-P', '-W', '-x', '--recursive', '--force', '--verbose', '--dir', '--interactive', '--one-file-system', '--no-preserve-root', '--preserve-root'] },
  rmdir: { f: ['-p', '-v', '--parents', '--verbose', '--ignore-fail-on-non-empty'] },
  unlink: { f: [] },
  shred: { f: ['-f', '-u', '-v', '-x', '-z', '--remove', '--force', '--zero', '--exact', '--verbose'], v: ['-n', '--iterations', '-s', '--size'] },
  srm: { f: ['-r', '-R', '-f', '-i', '-v', '-s', '-m', '-z', '-n', '-d', '-x', '-D', '-E', '--recursive', '--force', '--verbose', '--simple', '--medium', '--zero'] },
  trash: { f: ['-F', '-v', '-s', '-y', '-d', '-f', '-r', '-i', '-R'] },
};
def(Object.keys(RM_SPEC), (args, st, name) => {
  const o = opts(st, args, RM_SPEC[name]);
  del(st, o.operands);
  P(st, 'delete', { paths: disp(st, o.operands) });
});
def(['touch'], (args, st) => {
  const o = opts(st, args, { f: ['-a', '-c', '-m', '-h', '--no-create', '--no-dereference'], v: ['-t', '-d', '-r', '-A', '--date', '--reference', '--time'] });
  write(st, o.operands);
  read(st, vals(o, '-r', '--reference'));
  P(st, 'touch', { paths: disp(st, o.operands) });
});
/** `chmod -x f`: a symbolic mode that starts with `-` is the mode, not an option. */
const isModeWord = (w: string) => w.length > 1 && [...w].every((c) => 'ugoa+-=rwxXst01234567,'.includes(c)) && /[rwxXst]/.test(w);
def(['chmod'], (args, st) => {
  let modeTaken = false;
  const rest: string[] = [];
  for (const a of args) {
    if (!modeTaken && !a.startsWith('--') && isModeWord(a) && !['-R', '-v', '-f', '-h'].includes(a)) { modeTaken = true; continue; }
    rest.push(a);
  }
  const o = opts(st, rest, { f: ['-R', '-v', '-f', '-h', '-H', '-L', '-P', '-c', '--recursive', '--verbose', '--changes', '--silent', '--quiet', '--no-preserve-root', '--preserve-root'], v: ['--reference'] });
  const files = modeTaken || has(o, '--reference') ? o.operands : o.operands.slice(1);
  write(st, files);
  P(st, 'chmod', { paths: disp(st, files) });
});
def(['chown', 'chgrp', 'chflags', 'xattr'], (args, st, name) => {
  const o = opts(st, args, name === 'xattr'
    ? { f: ['-l', '-r', '-s', '-v', '-x', '-c', '-d'], v: ['-p', '-w'] }
    : { f: ['-R', '-h', '-v', '-f', '-H', '-L', '-P', '-c', '-x', '--recursive', '--no-dereference', '--dereference', '--verbose', '--changes', '--silent', '--quiet'], v: ['--reference', '--from'] });
  const files = has(o, '--reference') || name === 'xattr' ? o.operands : o.operands.slice(1);
  write(st, files);
  P(st, 'runs', { cmd: name });
  add(st, 'unknown-command', 'medium');
});
def(['ln'], (args, st) => {
  const o = opts(st, args, { f: ['-s', '-f', '-n', '-h', '-i', '-v', '-F', '-L', '-P', '-r', '-T', '-b', '--symbolic', '--force', '--no-dereference', '--relative', '--verbose', '--interactive', '--backup', '--logical', '--physical'], v: ['-t', '--target-directory', '-S', '--suffix'] });
  const t = vals(o, '-t', '--target-directory');
  const link = t[0] ?? (o.operands.length >= 2 ? o.operands[o.operands.length - 1]! : '.');
  const targets = t.length ? o.operands : o.operands.length >= 2 ? o.operands.slice(0, -1) : o.operands;
  write(st, [link]);
  // A symbolic link's target is relative to the link's folder. A link to outside the project lets later writes escape it.
  const linkLoc = locsOf(st, link)[0];
  const symbolic = has(o, '-s', '--symbolic');
  const base = symbolic ? (linkLoc?.abs ? dirnameAbs(linkLoc.abs) : null) : st.cwd;
  for (const tg of targets) for (const l of locsOf(st, tg, base)) {
    if (l.cls === 'outside' || l.cls === 'unknown' || l.cls === 'tmp') add(st, 'writes-outside-project', 'high', { path: displayLoc(l, st.ctx) });
  }
  P(st, 'link', { link: disp(st, [link]), target: fmtList(targets) });
});
def(['du'], (args, st) => {
  // pure reader: du only measures.
  const o = opts(st, args, { any: true, v: ['-d', '-B', '--max-depth', '--block-size', '-t', '--threshold', '--exclude', '-I', '--files0-from'] });
  const targets = o.operands.length ? o.operands : ['.'];
  read(st, targets);
  P(st, 'size', { paths: disp(st, targets) });
});

// find: starts, then an expression of known primaries.
const FIND_VALUE = ['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-xtype', '-maxdepth', '-mindepth',
  '-mtime', '-mmin', '-ctime', '-cmin', '-atime', '-amin', '-newer', '-anewer', '-cnewer', '-size', '-perm', '-user', '-group', '-links', '-inum',
  '-samefile', '-regextype', '-printf', '-uid', '-gid', '-fstype', '-lname', '-ilname', '-newermt', '-newerct', '-newerat', '-Bmin', '-Btime', '-used'];
const FIND_NOVAL = ['-empty', '-print', '-print0', '-ls', '-prune', '-quit', '-follow', '-depth', '-true', '-false', '-not', '-and', '-or', '-a', '-o',
  '-nouser', '-nogroup', '-readable', '-writable', '-executable', '-mount', '-xdev', '-noleaf', '-delete', '(', ')', '!', ',', '-d'];
def(['find', 'gfind'], (args, st) => {
  let i = 0;
  while (i < args.length && ['-H', '-L', '-P', '-E', '-X', '-s', '-x', '-d', '-O0', '-O1', '-O2', '-O3'].includes(args[i]!)) i++;
  const starts: string[] = [];
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-f') { const v = args[++i]; if (v !== undefined) starts.push(v); continue; }
    if ((a.startsWith('-') && !a.includes('$')) || a === '(' || a === '!' || a === ')') break;
    starts.push(a);
  }
  if (starts.length === 0) starts.push('.');
  read(st, starts);
  let deletes = false;
  let execName: string | null = null;
  const inners: string[][] = [];
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-delete') deletes = true;
    else if (a === '-fprint' || a === '-fprint0' || a === '-fls') write(st, [args[++i] ?? '']);
    else if (a === '-fprintf') { write(st, [args[++i] ?? '']); i++; }
    else if (a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir') {
      const inner: string[] = [];
      for (i++; i < args.length && args[i] !== ';' && args[i] !== '+'; i++) inner.push(args[i]!);
      if (inner.length === 0 || isOpaqueCommand(inner)) { st.parsed = false; return; }
      execName ??= inner[0]!;
      inners.push(inner);
    } else if (FIND_VALUE.includes(a)) i++;
    else if (!FIND_NOVAL.includes(a)) unknownOpt(st, a);
  }
  // Every start counts with its own critical-path rules: `find . -name x -delete` deletes in `.` like `find . -delete`.
  if (deletes) del(st, starts);
  if (inners.length) {
    // `{}` stands for the start paths; starts that classify alike are explained once (linear in the input).
    const groups = new Map<string, Loc[]>();
    for (const s of starts) for (const l of locsOf(st, s)) {
      const key = `${l.cls}|${l.critical}|${l.abs === null}`;
      const g = groups.get(key);
      if (g) { if (g.length < 3) g.push(l); } else groups.set(key, [l]);
    }
    for (const locs of groups.values()) for (const inner of inners) subExplain(inner, st, { token: '{}', locs });
  }
  if (execName !== null) P(st, 'findExec', { cmd: execName, paths: disp(st, starts) });
  else if (deletes) P(st, 'findDelete', { paths: disp(st, starts) });
  else P(st, 'find', { paths: disp(st, starts) });
});
const TAR_LONG_OK = ['--create', '--append', '--update', '--extract', '--get', '--list', '--absolute-names', '--file', '--directory', '--gzip', '--gunzip',
  '--bzip2', '--xz', '--zstd', '--lzma', '--auto-compress', '--verbose', '--exclude', '--strip-components', '--keep-old-files', '--no-same-owner',
  '--no-same-permissions', '--to-stdout', '--totals', '--wildcards', '--exclude-vcs', '--remove-files', '--overwrite', '--skip-old-files',
  '--preserve-permissions', '--same-owner', '--numeric-owner', '--owner', '--group', '--mode', '--mtime', '--sort', '--format', '--transform',
  '--exclude-from', '--files-from', '--null', '--no-recursion', '--one-file-system', '--dereference', '--hard-dereference', '--quiet', '--warning'];
const TAR_DANGER = ['--to-command', '--checkpoint-action', '--use-compress-program', '--info-script', '--new-volume-script', '--rsh-command', '--rmt-command', '-I', '-F'];
def(['tar', 'bsdtar', 'gtar'], (args, st) => {
  let mode: 'c' | 'x' | 't' | null = null;
  let archive: string | null = null;
  let dir: string | null = null;
  let absolute = false;
  let removeFiles = false;
  const operands: string[] = [];
  const valueLetters = 'fCbTX';
  const okLetters = 'crutxvzjJaZOpPkmowqSlhLnsUB';
  const setValue = (letter: string, v: string | undefined) => {
    if (v === undefined) return;
    if (letter === 'f') archive = v; else if (letter === 'C') dir = v; else if (letter === 'T' || letter === 'X') read(st, [v]);
  };
  const letters = (cluster: string, i: number, attached: boolean): number => {
    for (let k = 0; k < cluster.length; k++) {
      const ch = cluster[k]!;
      if (ch === 'c' || ch === 'r' || ch === 'u') mode = 'c';
      else if (ch === 'x') mode = 'x';
      else if (ch === 't') mode = 't';
      else if (ch === 'P') absolute = true;
      if (ch === 'I' || ch === 'F') { st.parsed = false; return i; }
      if (valueLetters.includes(ch)) {
        const rest = cluster.slice(k + 1);
        if (attached && rest !== '') { setValue(ch, rest); return i; }
        setValue(ch, args[++i]);
      } else if (!okLetters.includes(ch)) unknownOpt(st, `-${ch}`);
    }
    return i;
  };
  const LONG_OK = TAR_LONG_OK;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (i === 0 && !a.startsWith('-')) { i = letters(a, i, false); if (!st.parsed) return; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      const v = eq > 0 ? a.slice(eq + 1) : undefined;
      if (['--to-command', '--use-compress-program', '--checkpoint-action', '--info-script', '--new-volume-script', '--rsh-command', '--rmt-command'].includes(name)) { st.parsed = false; return; }
      if (!LONG_OK.includes(name)) unknownOpt(st, name);
      if (name === '--create' || name === '--append' || name === '--update') mode = 'c';
      else if (name === '--extract' || name === '--get') mode = 'x';
      else if (name === '--list') mode = 't';
      else if (name === '--absolute-names') absolute = true;
      else if (name === '--remove-files') removeFiles = true;
      else if (name === '--file') archive = v ?? args[++i] ?? null;
      else if (name === '--directory') dir = v ?? args[++i] ?? null;
      else if (name === '--files-from' || name === '--exclude-from') read(st, [v ?? args[++i] ?? '']);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !a.includes('$')) { i = letters(a.slice(1), i, true); if (!st.parsed) return; continue; }
    operands.push(a);
  }
  const arch = archive as string | null;
  const d = dir as string | null;
  const real = arch !== null && arch !== '-' ? [arch] : [];
  const base = d !== null ? (locsOf(st, d)[0]?.abs ?? null) : st.cwd;
  if (mode === 'c') {
    write(st, real);
    read(st, operands, base);
    if (removeFiles) del(st, operands, base);
    P(st, 'archiveCreate', { archive: real.length ? disp(st, real) : '…' });
  } else if (mode === 'x') {
    read(st, real);
    const dest = d ?? '.';
    write(st, [dest]);
    if (absolute) add(st, 'writes-outside-project', 'high', { path: '/' });
    P(st, 'archiveExtract', { archive: real.length ? disp(st, real) : '…', dest: disp(st, [dest]) });
  } else if (mode === 't') {
    read(st, real);
    P(st, 'archiveList', { archive: real.length ? disp(st, real) : '…' });
  } else unknown(args, st, 'tar');
});
def(['unzip'], (args, st) => {
  if (args.includes('-:') || args.includes('-^')) add(st, 'writes-outside-project', 'high', { path: '..' });
  const exclusions = args.indexOf('-x');
  const own = (exclusions >= 0 ? args.slice(0, exclusions) : args).filter((a) => a !== '-:' && a !== '-^');
  const o = opts(st, own, { f: ['-o', '-n', '-q', '-qq', '-l', '-v', '-t', '-z', '-Z', '-p', '-c', '-j', '-a', '-aa', '-b', '-C', '-L', '-U', '-u', '-f', '-X', '-K', '-M', '-D', '-V', '-T', '-W'], v: ['-d', '-P'] });
  const archive = o.operands[0];
  const real = archive !== undefined ? [archive] : [];
  read(st, real);
  if (has(o, '-l', '-v', '-t', '-z', '-Z', '-p', '-c')) { P(st, 'archiveList', { archive: disp(st, real) }); return; }
  const dest = vals(o, '-d')[0] ?? '.';
  write(st, [dest]);
  P(st, 'archiveExtract', { archive: disp(st, real), dest: disp(st, [dest]) });
});
def(['zip'], (args, st) => {
  if (args.some((a) => a === '-TT' || a.startsWith('--unzip-command'))) { st.parsed = false; return; }
  // `-x` / `-i` take a list of patterns up to the next option; those are patterns, not files.
  const own: string[] = [];
  let inList = false;
  for (const a of args) {
    if (a === '-x' || a === '-i' || a === '--exclude' || a === '--include') { inList = true; continue; }
    if (a.startsWith('-')) inList = false;
    if (!inList) own.push(a);
  }
  const o = opts(st, own, { num: true, f: ['-r', '-q', '-j', '-m', '-u', '-f', '-D', '-X', '-y', '-v', '-T', '-o', '-l', '-ll', '-0', '-R', '-FS', '-g', '-k', '-A', '-J', '-e', '--recurse-paths', '--quiet', '--junk-paths', '--move', '--update', '--freshen', '--no-dir-entries', '--no-extra', '--symlinks', '--test', '--grow', '--filesync'], v: ['-b', '-n', '-t', '-tt', '-O', '--output-file', '-P', '--password', '-Z', '-s', '-sp', '--temp-path'] });
  const archive = o.operands[0];
  const real = archive !== undefined ? [archive] : [];
  const sources = o.operands.slice(1);
  write(st, [...real, ...vals(o, '-O', '--output-file')]);
  read(st, sources);
  if (has(o, '-m', '--move')) del(st, sources);
  P(st, 'archiveCreate', { archive: disp(st, real) });
});

// Media.
const FFMPEG_NOVAL = new Set([
  '-y', '-n', '-hide_banner', '-nostdin', '-stdin', '-stats', '-nostats', '-shortest', '-an', '-vn', '-sn', '-dn', '-re', '-benchmark',
  '-benchmark_all', '-copyts', '-start_at_zero', '-accurate_seek', '-noaccurate_seek', '-report', '-dump', '-hex', '-ignore_unknown',
  '-copy_unknown', '-debug_ts', '-xerror', '-autorotate', '-noautorotate', '-version', '-buildconf', '-formats', '-codecs', '-encoders',
  '-decoders', '-filters', '-pix_fmts', '-sample_fmts', '-layouts', '-L', '-protocols', '-muxers', '-demuxers', '-devices', '-bsfs',
  '-hwaccels', '-colors', '-sources', '-sinks', '-noautoscale', '-nostdin', '-h', '-help', '-copyinkf', '-intra', '-psnr', '-vstats',
]);
/** ffmpeg options taking one value; stream specifiers are stripped first (`-c:v` → `-c`, `-b:a` → `-b`). */
const FFMPEG_VALUE = new Set([
  '-i', '-c', '-codec', '-vcodec', '-acodec', '-scodec', '-b', '-r', '-s', '-pix_fmt', '-crf', '-preset', '-tune', '-profile', '-level', '-g',
  '-bf', '-vf', '-af', '-filter', '-filter_complex', '-lavfi', '-map', '-ss', '-t', '-to', '-f', '-frames', '-vframes', '-aframes', '-dframes',
  '-ar', '-ac', '-ab', '-aspect', '-movflags', '-loglevel', '-v', '-threads', '-fps_mode', '-vsync', '-metadata', '-map_metadata',
  '-map_chapters', '-framerate', '-loop', '-stream_loop', '-start_number', '-q', '-qscale', '-x264-params', '-x265-params', '-x264opts',
  '-tag', '-svtav1-params', '-aom-params', '-dump_attachment', '-max_muxing_queue_size', '-sample_fmt', '-channel_layout', '-ch_layout', '-minrate', '-maxrate', '-bufsize', '-pattern_type',
  '-itsoffset', '-sseof', '-fs', '-color_primaries', '-color_trc', '-colorspace', '-color_range', '-disposition', '-safe', '-probesize',
  '-analyzeduration', '-video_size', '-pixel_format', '-cq', '-qp', '-rc', '-deadline', '-cpu-used', '-row-mt', '-tile-columns',
  '-lag-in-frames', '-auto-alt-ref', '-quality', '-speed', '-compression_level', '-pred', '-lossless', '-sws_flags', '-vtag', '-atag',
  '-b_strategy', '-refs', '-keyint_min', '-sc_threshold', '-apad', '-async', '-frame_size', '-id3v2_version', '-write_id3v1', '-brand',
  '-timecode', '-max_interleave_delta', '-avoid_negative_ts', '-fflags', '-flags', '-strict', '-thread_queue_size', '-filter_threads',
  '-filter_complex_threads', '-hwaccel', '-hwaccel_output_format', '-hwaccel_device', '-init_hw_device', '-stats_period', '-x', '-y_pos',
  '-alpha_quality', '-pass', '-plays', '-final_delay', '-gifflags', '-dpi', '-update', '-frame_pts', '-strftime', '-qmin', '-qmax',
  '-allowed_extensions', '-allow_sw', '-realtime', '-vbr', '-application', '-cutoff', '-loop_output', '-intra_refresh', '-bsf', '-vbsf', '-absf', '-af_threads', '-bits_per_raw_sample',
]);
const FFMPEG_READ_VALUE = new Set(['-filter_complex_script', '-filter_script', '-attach', '-hls_key_info_file', '-key_info_file']);
/** Options whose value is a file ffmpeg writes (muxer side files included). */
const FFMPEG_WRITE_VALUE = new Set(['-vstats_file', '-passlogfile', '-progress', '-sdp_file', '-hls_segment_filename',
  '-segment_list', '-master_pl_name', '-hls_fmp4_init_filename', '-hls_base_url', '-dash_segment_filename', '-init_seg_name', '-media_seg_name',
  '-stats_file', '-report_file']);
const FFPROBE_VALUE = new Set(['-v', '-loglevel', '-print_format', '-of', '-output_format', '-select_streams', '-show_entries', '-read_intervals', '-i', '-o', '-f', '-analyzeduration', '-probesize', '-show_optional_fields', '-threads', '-sections']);
const FF_NET = ['http', 'https', 'tcp', 'udp', 'rtmp', 'rtmps', 'rtmpt', 'rtmpe', 'rtmpte', 'rtmpts', 'rtp', 'srt', 'ftp', 'sftp', 'tls', 'rtsp', 'rtsps',
  'mmsh', 'mmst', 'gopher', 'gophers', 'icecast', 'smb', 'srtp', 'zmq', 'ipfs', 'ipns', 'unix', 'librist', 'rist', 'hls', 'prompeg', 'httpproxy', 'ws', 'wss'];
/** Protocols that wrap another URL or path: `cache:x`, `async:x`, `crypto:x`, `hls+http://`. */
const FF_WRAP = ['cache', 'async', 'crypto'];
/**
 * Classifies one ffmpeg input or output, protocol prefix included: `file:` and `concat:a|b` resolve to paths, network
 * protocols use the network, `pipe:`/`data:` touch nothing. Returns false for what we can't resolve (`subfile`, `concatf`,
 * unknown protocols), so the whole command is not modeled.
 */
function ffTarget(st: State, w: string, writes: boolean, depth = 0): boolean {
  if (depth > 3) return false;
  if (w === '-' || w === '' || w.startsWith('pipe:')) return true;
  const colon = w.indexOf(':');
  const slash = w.indexOf('/');
  const scheme = colon > 1 && (slash < 0 || colon < slash) && !w.startsWith('.') && !w.startsWith('~') && !w.startsWith('$') ? w.slice(0, colon).toLowerCase() : '';
  // `subfile,,start,0,end,10,,:path` and other protocols with options before the colon: not modeled.
  if (scheme.includes(',')) return false;
  if (scheme === '' || ![...scheme].every((c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '+' || c === '-' || c === '.')) {
    if (writes) write(st, [w]); else read(st, [w]);
    return true;
  }
  const rest = w.slice(colon + 1);
  if (scheme === 'file') return ffTarget(st, rest.startsWith('//') ? rest.slice(2) : rest, writes, depth + 1);
  if (scheme === 'data') return true;
  if (scheme === 'concat') {
    const parts = rest.split('|');
    if (parts.some((x) => x === '')) return false;
    return parts.every((x) => ffTarget(st, x, writes, depth + 1));
  }
  const base = scheme.includes('+') ? scheme.slice(scheme.lastIndexOf('+') + 1) : scheme;
  if (FF_NET.includes(base) || FF_NET.includes(scheme)) { add(st, 'uses-network', 'medium', { host: hostOf(w) }); return true; }
  if (FF_WRAP.includes(scheme)) return ffTarget(st, rest, writes, depth + 1);
  return false; // subfile, concatf, fd, unknown protocols
}
/**
 * Splits `s` on `sep` at the top level of an ffmpeg filtergraph: quotes ('…') and backslash escapes protect separators,
 * and `[labels]` are skipped. Linear.
 */
function ffSplit(s: string, seps: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let bracket = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === "'") { quoted = !quoted; cur += c; continue; }
    if (!quoted) {
      if (c === '[') bracket++;
      else if (c === ']' && bracket > 0) bracket--;
      else if (bracket === 0 && seps.includes(c)) { out.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  out.push(cur);
  explainWork.add(s.length);
  return out;
}
/** Removes one level of ffmpeg quoting and escaping: `'a b'` → `a b`, `a\:b` → `a:b`. */
function ffUnquote(v: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c === "'") { quoted = !quoted; continue; }
    if (c === '\\' && !quoted && i + 1 < v.length) { out += v[i + 1]; i++; continue; }
    out += c;
  }
  return out.trim();
}
/** A filter value that looks like a file: `/x`, `~/x`, `./x`, `../x`, or `dir/name.ext` (not an expression like `(ow-iw)/2`). */
function ffPathLike(v: string): boolean {
  if (v.startsWith('/') || v.startsWith('~') || v.startsWith('./') || v.startsWith('../') || v.includes('/../') || v === '..') return true;
  if (!v.includes('/')) return false;
  if ([...v].some((c) => ' ()*+<>,='.includes(c))) return false;
  const dot = v.lastIndexOf('.');
  return dot > v.lastIndexOf('/') && v.length - dot - 1 >= 1 && v.length - dot - 1 <= 5;
}
/** Filter options that read a file (key, or `#n` for the n-th positional argument). */
const FF_READ_KEYS: Record<string, string[]> = {
  movie: ['filename', '#0'], amovie: ['filename', '#0'], subtitles: ['filename', 'f', '#0', 'fontsdir'], ass: ['filename', 'f', '#0', 'fontsdir'],
  drawtext: ['textfile', 'fontfile'], lut3d: ['file', '#0'], lut1d: ['file', '#0'], haldclut: [], sendcmd: ['filename', 'f', '#0'], asendcmd: ['filename', 'f', '#0'],
  vidstabtransform: ['input'], ocr: ['datapath'], select: [], coreimage: [], afir: [], headphone: [], sofalizer: ['sofa', '#0'], dnn_processing: ['model'], whisper: ['model', 'vad_model'],
};
/** Filter options that write a file. */
const FF_WRITE_KEYS: Record<string, string[]> = {
  psnr: ['stats_file', 'f', '#0'], ssim: ['stats_file', 'f', '#0'], libvmaf: ['log_path'], vmaf: ['log_path'], metadata: ['file'], ametadata: ['file'],
  signature: ['filename'], vidstabdetect: ['result'], ebur128: [], identity: ['stats_file', 'f'], msad: ['stats_file', 'f'], corr: ['stats_file', 'f'], whisper: ['destination'],
};
/** Filters that load plugins or talk to the outside: not modeled. */
const FF_OPAQUE_FILTERS = ['zmq', 'azmq', 'frei0r', 'frei0r_src', 'ladspa', 'lv2', 'lensfun'];
/**
 * Checks every filter of a filtergraph. Known reader keys are reads (system fonts excepted), known writer keys are writes,
 * and a path-like value under any other key is treated as a write (worst case). Returns false when not modeled.
 */
function ffmpegFilters(st: State, graph: string): boolean {
  for (const chain of ffSplit(graph, ';')) {
    for (const raw of ffSplit(chain, ',')) {
      let f = raw.trim();
      while (f.startsWith('[')) { const e = f.indexOf(']'); if (e < 0) return false; f = f.slice(e + 1).trim(); }
      // Trailing output labels.
      const eq = f.indexOf('=');
      let name = (eq >= 0 ? f.slice(0, eq) : f).trim();
      let argStr = eq >= 0 ? f.slice(eq + 1) : '';
      const lb = argStr.length ? -1 : name.indexOf('[');
      if (lb >= 0) name = name.slice(0, lb);
      { // strip output labels at the end of the arguments: `…:y=10[out]`
        let end = argStr.length;
        while (end > 0 && argStr[end - 1] === ']') { const o = argStr.lastIndexOf('[', end - 1); if (o < 0) break; end = o; }
        argStr = argStr.slice(0, end);
      }
      if (name.includes('@')) name = name.slice(0, name.indexOf('@'));
      name = name.trim();
      if (FF_OPAQUE_FILTERS.includes(name)) return false;
      if (argStr === '') continue;
      const reads = FF_READ_KEYS[name] ?? [];
      const writes = FF_WRITE_KEYS[name] ?? [];
      let pos = 0;
      for (const item of ffSplit(argStr, ':')) {
        const k = item.indexOf('=');
        const key = k >= 0 ? item.slice(0, k).trim() : `#${pos++}`;
        const value = ffUnquote(k >= 0 ? item.slice(k + 1) : item);
        if (value === '') continue;
        if (reads.includes(key)) {
          if ((key === 'fontfile' || key === 'fontsdir') && isSystemFont(value.endsWith('/') ? value : `${value}`)) continue;
          if (!ffTarget(st, value, false)) return false;
        } else if (writes.includes(key)) {
          if (!ffTarget(st, value, true)) return false;
        } else if (ffPathLike(value)) {
          if (!ffTarget(st, value, true)) return false;
        }
      }
    }
  }
  return true;
}
/**
 * A coarse check on a whole filtergraph, before and regardless of any parsing: these filters and keys read or write files
 * or take commands at run time, and ffmpeg's quoting levels make their values easy to misread. A graph that mentions any
 * of them gets a generic phrase and medium, whatever the fine parser finds (which can only add to it).
 */
const FF_FILE_WORDS = ['sendcmd', 'zmq', 'textfile', 'metadata', 'stats_file', 'psnr', 'ssim', 'signature', 'whisper'];
const FF_FILE_KEYS = ['file=', 'filename=', 'movie=', 'amovie=', 'destination='];
function ffTouchesFiles(graph: string): boolean {
  // Quotes and escapes dropped first, whatever level they belong to: `f'ile'=`, `file\=`, `m\etadata` all match.
  let g = '';
  for (const c of graph.toLowerCase()) if (c !== "'" && c !== '\\' && c !== '"') g += c;
  explainWork.add(g.length * (FF_FILE_WORDS.length + FF_FILE_KEYS.length));
  if (FF_FILE_WORDS.some((w) => g.includes(w))) return true;
  // Whole keys only: `fontfile=` is not `file=`.
  return FF_FILE_KEYS.some((k) => {
    for (let at = g.indexOf(k); at >= 0; at = g.indexOf(k, at + 1)) {
      const c = at === 0 ? '' : g[at - 1]!;
      if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_')) return true;
    }
    return false;
  });
}
/** `-x264-params k=v:k2=v2` and friends: the keys that write or read files. */
const CODEC_PARAM_WRITES = ['stats', 'dump-yuv', 'csv', 'analysis-save', 'analysis-reuse-file', 'recon', 'pass-stats', 'output'];
const CODEC_PARAM_READS = ['analysis-load', 'qpfile', 'cqmfile', 'cqm-file', 'zonefile', 'dhdr10-info', 'master-display-file', 'scaling-list', 'lambda-file'];
function codecParams(st: State, v: string): boolean {
  for (const item of ffSplit(v, ':')) {
    const k = item.indexOf('=');
    if (k < 0) continue;
    const key = item.slice(0, k).trim().toLowerCase();
    const value = ffUnquote(item.slice(k + 1));
    if (CODEC_PARAM_WRITES.includes(key)) { if (!ffTarget(st, value, true)) return false; }
    else if (CODEC_PARAM_READS.includes(key)) { if (!ffTarget(st, value, false)) return false; }
    else if (ffPathLike(value)) { if (!ffTarget(st, value, true)) return false; }
  }
  return true;
}
function media(st: State, args: string[], kind: 'ffmpeg' | 'ffprobe'): { inputs: string[]; outputs: string[]; fileFilters: boolean } | null {
  /** A filtergraph mentions filters or keys that touch files (`ffTouchesFiles`), or comes from a script we can't see. */
  let fileFilters = false;
  const inputs: string[] = [];
  const outputs: string[] = [];
  const isFfprobeNoval = (a: string) => (a.startsWith('-show_') && a !== '-show_entries' && a !== '-show_optional_fields') || a.startsWith('-count_')
    || ['-hide_banner', '-pretty', '-unit', '-prefix', '-byte_binary_prefix', '-sexagesimal', '-bitexact', '-version', '-h', '-help'].includes(a);
  /** `-f` applies to the next input or output. */
  let format: string | null = null;
  let lastConsumedIdx = -1;
  let lastWasInput = false;
  const target = (w: string, writes: boolean, fmt: string | null): boolean => {
    if (fmt === 'lavfi' && !writes) { if (ffTouchesFiles(w)) fileFilters = true; return ffmpegFilters(st, w); }
    if (fmt === 'tee' && writes) {
      return w.split('|').every((part) => {
        const p = part.startsWith('[') ? part.slice(part.indexOf(']') + 1) : part;
        return ffTarget(st, p, true);
      });
    }
    return ffTarget(st, w, writes);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-') && a.length > 1 && !a.includes('$')) {
      if (kind === 'ffmpeg' ? FFMPEG_NOVAL.has(a) : isFfprobeNoval(a)) continue;
      // `-/filter_complex file` (ffmpeg 7): an option value read from a file we can't see.
      if (a.startsWith('-/')) { fileFilters = true; read(st, [args[++i] ?? '']); lastConsumedIdx = i; continue; }
      const name = kind === 'ffmpeg' && a.includes(':') ? a.slice(0, a.indexOf(':')) : a;
      const known = kind === 'ffmpeg' ? FFMPEG_VALUE.has(name) || FFMPEG_READ_VALUE.has(name) || FFMPEG_WRITE_VALUE.has(name) : FFPROBE_VALUE.has(name);
      if (!known) unknownOpt(st, name);
      const v = args[++i];
      lastConsumedIdx = i;
      if (v === undefined) continue;
      if (name === '-f') { format = v; continue; }
      if (name === '-dump_attachment') return null; // writes attachments under names taken from the file
      if (['-x264-params', '-x265-params', '-x264opts', '-svtav1-params', '-aom-params', '-vpx-params', '-rav1e-params', '-kvazaar-params'].includes(name)) { if (!codecParams(st, v)) return null; continue; }
      if (name === '-i') { inputs.push(v); lastWasInput = true; if (!target(v, false, format)) return null; format = null; continue; }
      lastWasInput = false;
      if (kind === 'ffprobe' && name === '-o') { if (!ffTarget(st, v, true)) return null; outputs.push(v); continue; }
      if (FFMPEG_READ_VALUE.has(name)) { if (name.endsWith('_script')) fileFilters = true; read(st, [v]); continue; }
      if (FFMPEG_WRITE_VALUE.has(name)) { if (!ffTarget(st, v, true)) return null; continue; }
      if (['-vf', '-af', '-filter', '-filter_complex', '-lavfi'].includes(name)) {
        if (ffTouchesFiles(v)) fileFilters = true;
        if (!ffmpegFilters(st, v)) return null;
      }
      if ((v.startsWith('/') || v.startsWith('~') || v.startsWith('$') || v.startsWith('../')) && !isSystemFont(v)) read(st, [v]);
      continue;
    }
    lastWasInput = false;
    if (kind === 'ffmpeg') { outputs.push(a); if (!target(a, true, format)) return null; format = null; }
    else { inputs.push(a); if (!target(a, false, format)) return null; }
  }
  // ffmpeg's last word is always an output: catch it even after an option we don't know.
  const lastIdx = args.length - 1;
  const last = args[lastIdx];
  if (kind === 'ffmpeg' && last !== undefined && lastConsumedIdx === lastIdx && !lastWasInput && !last.startsWith('-')) {
    outputs.push(last);
    if (!ffTarget(st, last, true)) return null;
  }
  const files = (xs: string[]) => xs.filter((x) => !isUrl(x) && x !== '-' && !x.startsWith('pipe:'));
  return { inputs: files(inputs), outputs: files(outputs), fileFilters };
}
def(['ffmpeg'], (args, st) => {
  const m = media(st, args, 'ffmpeg');
  if (m === null) { st.parsed = false; return; }
  const { inputs, outputs } = m;
  if (m.fileFilters) { add(st, 'complex', 'medium'); P(st, 'filterFiles'); return; }
  if (outputs.length) P(st, 'mediaConvert', { inputs: disp(st, inputs), outputs: disp(st, outputs) });
  else P(st, 'mediaProcess', { inputs: disp(st, inputs) });
});
def(['ffprobe'], (args, st) => {
  const m = media(st, args, 'ffprobe');
  if (m === null) { st.parsed = false; return; }
  const { inputs } = m;
  if (m.fileFilters) { add(st, 'complex', 'medium'); P(st, 'filterFiles'); return; }
  P(st, 'mediaInfo', { paths: disp(st, inputs) });
});
def(['sips'], (args, st) => {
  const TWO = new Set(['-s', '--setProperty', '-z', '--resampleHeightWidth', '-c', '--cropToHeightWidth', '-p', '--padToHeightWidth', '--cropOffset']);
  const ONE = new Set(['-g', '--getProperty', '-d', '--deleteProperty', '-r', '--rotate', '-f', '--flip', '-Z', '--resampleHeightWidthMax',
    '--resampleWidth', '--resampleHeight', '--padColor', '-o', '--out', '-x', '--extractProfile', '-e', '--embedProfile', '-E',
    '--embedProfileIfNone', '-m', '--matchTo', '-M', '--matchToWithIntent', '-j', '--js', '--extractTag', '-X', '--setPropertiesWithJSON']);
  const NOVAL = new Set(['-1', '--oneLine', '-h', '--help', '-H', '--helpProperties', '--debug', '--formats', '-i', '--addIcon', '--optimizeColorForSharing', '--deleteColorManagementProperties']);
  const READ_ONLY = new Set(['-g', '--getProperty', '-1', '--oneLine', '-h', '--help', '-H', '--helpProperties', '--debug', '--formats']);
  const inputs: string[] = [];
  const out: string[] = [];
  let modifies = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-') || a.includes('$')) { inputs.push(a); continue; }
    if (!READ_ONLY.has(a)) modifies = true;
    if (TWO.has(a)) { i += 2; continue; }
    if (ONE.has(a)) {
      const v = args[++i];
      if (v === undefined) continue;
      if (a === '-o' || a === '--out' || a === '-x' || a === '--extractProfile') out.push(v);
      else if (a === '-j' || a === '--js') { add(st, 'runs-code', 'medium'); read(st, [v]); }
      else if (a === '-e' || a === '-E' || a === '-m' || a === '-M' || a.startsWith('--embed') || a.startsWith('--match') || a === '-X' || a === '--setPropertiesWithJSON') read(st, [v]);
      continue;
    }
    if (!NOVAL.has(a)) unknownOpt(st, a);
  }
  if (out.length) { read(st, inputs); write(st, out); P(st, 'imageConvert', { inputs: disp(st, inputs), outputs: disp(st, out) }); }
  else if (modifies) { write(st, inputs); PL(st, 'imageEdit', 'paths', inputs); }
  else { read(st, inputs); PL(st, 'imageInfo', 'paths', inputs); }
});
/** Strips ImageMagick coder prefixes: `png:out.png` → `out.png`, `histogram:info:-` → `-`. */
function stripCoder(w: string): string {
  let s = w;
  for (;;) {
    const c = s.indexOf(':');
    if (c <= 1 || isUrl(s)) return s;
    const prefix = s.slice(0, c);
    let letters = true;
    for (const ch of prefix) if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9'))) { letters = false; break; }
    if (!letters) return s;
    s = s.slice(c + 1);
  }
}
/**
 * ImageMagick options we model, with how many values follow `-opt` (`+opt` forms take none, except those listed).
 * Values are not options even when they start with `+`/`-` (`-annotate +100+200 'Hi'`, `-geometry +40+40`, `-repage +0+0`).
 */
const MAGICK_ARITY: Record<string, number> = {
  resize: 1, crop: 1, gravity: 1, extent: 1, background: 1, flatten: 0, colors: 1, format: 1, quality: 1, strip: 0, thumbnail: 1, fill: 1, font: 1,
  pointsize: 1, annotate: 2, geometry: 1, alpha: 1, colorspace: 1, depth: 1, density: 1, rotate: 1, flip: 0, flop: 0, trim: 0, repage: 1, define: 1,
  sharpen: 1, blur: 1, unsharp: 1, modulate: 1, level: 1, negate: 0, type: 1, units: 1, interlace: 1, 'sampling-factor': 1, append: 0, layers: 1,
  coalesce: 0, delay: 1, loop: 1, dispose: 1, deconstruct: 0, scale: 1, sample: 1, 'adaptive-resize': 1, 'auto-orient': 0, bordercolor: 1, border: 1,
  frame: 1, shadow: 1, channel: 1, separate: 0, combine: 0, compose: 1, composite: 0, page: 1, size: 1, 'unique-colors': 0, print: 1, verbose: 0,
  quiet: 0, limit: 2, transparent: 1, fuzz: 1, opaque: 1, threshold: 1, dither: 1, remap: 1, posterize: 1, monochrome: 0, grayscale: 1, normalize: 0,
  'contrast-stretch': 1, 'brightness-contrast': 1, gamma: 1, 'sigmoidal-contrast': 1, transpose: 0, transverse: 0, shave: 1, chop: 1, splice: 1,
  distort: 2, 'virtual-pixel': 1, interpolate: 1, filter: 1, vignette: 1, morphology: 2, kernel: 1, compress: 1, comment: 1, region: 1, colorize: 1,
  tint: 1, 'sepia-tone': 1, evaluate: 2, clut: 0, stroke: 1, strokewidth: 1, kerning: 1, 'interline-spacing': 1, 'interword-spacing': 1, family: 1,
  weight: 1, style: 1, stretch: 1, antialias: 0, resample: 1, extract: 1, orient: 1, delete: 1, swap: 1, clone: 1, duplicate: 1, reverse: 0, ping: 0,
  precision: 1, matte: 0, 'liquid-rescale': 1, edge: 1, charcoal: 1, paint: 1, sketch: 1, emboss: 1, polaroid: 1, roll: 1, shear: 1, 'motion-blur': 1,
  'radial-blur': 1, despeckle: 0, enhance: 0, equalize: 0, 'auto-level': 0, 'auto-gamma': 0, 'white-balance': 0, 'linear-stretch': 1, label: 1,
  caption: 1, mosaic: 0, mattecolor: 1, fx: 1, write: 1, draw: 1, identify: 0, set: 2, encoding: 1, 'gaussian-blur': 1, 'adaptive-sharpen': 1,
  'alpha-color': 1, 'auto-threshold': 1, 'background-color': 1, quantize: 1, 'transparent-color': 1, tile: 1, title: 1, 'fill-opacity': 1, path: 1,
};
const MAGICK_PLUS_ARITY: Record<string, number> = { distort: 2, level: 1, 'sigmoidal-contrast': 1, gamma: 1, write: 1 };
def(['magick', 'convert', 'mogrify', 'identify', 'montage', 'composite'], (args, st, name) => {
  let mode = name;
  let rest = args;
  if (name === 'magick' && ['convert', 'mogrify', 'identify', 'montage', 'composite', 'compare', 'stream', 'import', 'display', 'animate', 'conjure'].includes(args[0] ?? '')) {
    mode = args[0]!; rest = args.slice(1);
  }
  if (mode === 'conjure' || mode === 'import' || mode === 'display' || mode === 'animate' || mode === 'stream') { unknown(args, st, name); return; }
  const words: string[] = [];
  const writes: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if ((a.startsWith('-') || a.startsWith('+')) && a.length > 1 && !a.includes('$')) {
      const opt = a.slice(1);
      if (opt === 'script' || opt === 'process' || opt === 'monitor' || opt === 'authenticate') { st.parsed = false; return; }
      const arity = a.startsWith('+') ? (MAGICK_PLUS_ARITY[opt] ?? 0) : MAGICK_ARITY[opt];
      if (arity === undefined) { unknownOpt(st, a); continue; } // unknown: its values (if any) are classified as words
      const values = rest.slice(i + 1, i + 1 + arity);
      i += arity;
      if (opt === 'write') {
        // A run-time name (`%[filename:x]`) can point anywhere: not modeled, as for output words.
        if (values.some((v) => v.includes('%['))) { st.parsed = false; return; }
        for (const v of values) writes.push(stripCoder(v));
        continue;
      }
      const setKey = opt === 'set' ? (values[0] ?? '').toLowerCase() : '';
      // `-set filename:x …` (any case) names output files from image properties (`out_%[filename:x].png`): not modeled.
      if (setKey.startsWith('filename:')) { st.parsed = false; return; }
      // `-set comment|label|caption|title <text>`: the value is text, not a path (`@file` is still refused below).
      const textValue = ['comment', 'label', 'caption', 'title'].includes(setKey);
      if ((opt === 'set' && !textValue) || opt === 'define') for (const v of values) { const pv = v.includes('=') ? v.slice(v.indexOf('=') + 1) : v; if (pathLike(pv) && !isSystemFont(pv)) read(st, [pv]); }
      for (const v of values) {
        // Text and drawing values can read files (`@file`, `image Over … 'file'`, `url(…)`): not modeled.
        if (v.includes('@') && (opt === 'annotate' || opt === 'label' || opt === 'caption' || opt === 'comment' || opt === 'draw' || opt === 'title' || opt === 'set')) { st.parsed = false; return; }
        if (opt === 'draw' && (v.includes('url(') || v.includes('image'))) { st.parsed = false; return; }
        if (opt === 'font' || opt === 'remap' || opt === 'clut' || opt === 'kernel') { if (pathLike(v) && !isSystemFont(v)) read(st, [v]); }
      }
      continue;
    }
    const w = stripCoder(a);
    // An output name computed at run time (`%[filename:x]`, `%[fx:…]`) can point anywhere: not modeled.
    if (a.includes('%[')) { st.parsed = false; return; }
    // `@file` reads a list or text from a file; `msl:`/`mvg:` are scripts: not modeled.
    if (w.startsWith('@') || a.startsWith('msl:') || a.startsWith('mvg:') || a.includes(':@')) { st.parsed = false; return; }
    words.push(w);
  }
  write(st, writes);
  const net = words.filter(isUrl);
  if (net.length) add(st, 'uses-network', 'medium', { host: hostOf(net[0]!) });
  const files = words.filter((w) => !isUrl(w) && w !== '-' && w !== '');
  if (mode === 'mogrify') {
    write(st, files);
    for (let i = 0; i < rest.length; i++) if (rest[i] === '-path') write(st, [rest[i + 1] ?? '']);
    PL(st, 'imageEdit', 'paths', files.filter(fileLike));
    return;
  }
  if (mode === 'identify') { read(st, files); PL(st, 'imageInfo', 'paths', files.filter(fileLike)); return; }
  const lastWord = words[words.length - 1];
  const output = lastWord !== undefined && lastWord !== '-' && !isUrl(lastWord) && lastWord !== '' ? lastWord : null;
  const inputs = files.slice(0, output !== null && words.length > 1 ? -1 : files.length);
  read(st, inputs);
  if (output !== null && words.length > 1) {
    write(st, [output]);
    P(st, 'imageConvert', { inputs: disp(st, inputs.filter(fileLike)), outputs: disp(st, [output]) });
  } else PL(st, 'imageInfo', 'paths', inputs.filter(fileLike));
});
const CONVERTER_SPEC: Record<string, Spec> = {
  cwebp: {
    long1: true,
    f: ['-lossless', '-exact', '-mt', '-low_memory', '-af', '-strong', '-nostrong', '-sharp_yuv', '-noalpha', '-short', '-quiet', '-v', '-version', '-h', '-H',
      '-print_psnr', '-print_ssim', '-print_lsim', '-progress', '-jpeg_like', '-alpha_cleanup', '-noasm', '-blend_alpha'],
    v: ['-q', '-alpha_q', '-preset', '-z', '-m', '-segments', '-size', '-psnr', '-sns', '-f', '-sharpness', '-pass', '-qrange', '-crop', '-resize',
      '-metadata', '-alpha_method', '-alpha_filter', '-near_lossless', '-hint', '-map', '-partition_limit', '-o', '-d', '-s', '-af', '-pre', '-tune'],
  },
  dwebp: {
    long1: true,
    f: ['-pam', '-ppm', '-bmp', '-tiff', '-pgm', '-yuv', '-nofancy', '-nofilter', '-nodither', '-alpha_dither', '-mt', '-flip', '-alpha', '-incremental',
      '-v', '-quiet', '-noasm', '-version', '-h', '-png', '-webp'],
    v: ['-o', '-dither', '-crop', '-resize', '-scale'],
  },
  'rsvg-convert': {
    f: ['-a', '--keep-aspect-ratio', '--unlimited', '-u', '--keep-image-data', '--no-keep-image-data', '-v', '--version', '-?', '--help'],
    v: ['-w', '-h', '-z', '-x', '-y', '-f', '-o', '-b', '--width', '--height', '--zoom', '--x-zoom', '--y-zoom', '--format', '--output',
      '--background-color', '--dpi-x', '--dpi-y', '-d', '-p', '--page-width', '--page-height', '--left', '--top', '--stylesheet', '-s', '--export-id',
      '-i', '--accept-language'],
  },
  gif2webp: { long1: true, f: ['-lossy', '-mixed', '-min_size', '-loop_compatibility', '-mt', '-v', '-quiet', '-version', '-h'], v: ['-q', '-m', '-kmin', '-kmax', '-f', '-metadata', '-o'] },
  img2webp: { long1: true, f: ['-lossy', '-lossless', '-mixed', '-v', '-h', '-min_size'], v: ['-o', '-q', '-m', '-d', '-loop', '-kmin', '-kmax'] },
};
def(Object.keys(CONVERTER_SPEC), (args, st, name) => {
  const o = opts(st, args, CONVERTER_SPEC[name]);
  const outs = vals(o, '-o', '--output').filter((x) => x !== '-');
  if (name === 'cwebp') write(st, vals(o, '-d'));
  if (name === 'rsvg-convert') read(st, vals(o, '-s', '--stylesheet'));
  const inputs = o.operands;
  read(st, inputs);
  write(st, outs);
  const shownOut = outs.length ? disp(st, outs) : st.stdout;
  if (shownOut !== null) P(st, 'imageConvert', { inputs: disp(st, inputs.filter(fileLike)), outputs: shownOut });
  else PL(st, 'imageInfo', 'paths', inputs.filter(fileLike));
});
const OPTIMIZER_SPEC: Record<string, Spec & { out: string[] }> = {
  optipng: { out: ['-out', '-dir'], long1: true, f: ['-quiet', '-clobber', '-backup', '-keep', '-fix', '-force', '-preserve', '-snip', '-simulate', '-full', '-nb', '-nc', '-np', '-nz', '-nx', '-v', '-o0', '-o1', '-o2', '-o3', '-o4', '-o5', '-o6', '-o7'], v: ['-out', '-dir', '-log', '-strip', '-zc', '-zm', '-zs', '-zw', '-f', '-i'] },
  pngquant: { out: ['--output', '-o'], num: true, f: ['--force', '-f', '--skip-if-larger', '--strip', '--nofs', '--verbose', '-v', '--ordered', '--quiet', '-q', '--floyd'], v: ['--ext', '--quality', '--speed', '--posterize', '--output', '-o', '-Q', '-s'] },
  gifsicle: { out: ['-o', '--output'], f: ['-b', '--batch', '-O1', '-O2', '-O3', '-U', '--unoptimize', '-i', '--interlace', '-w', '--no-warnings', '--careful', '--no-comments', '--no-names', '--no-extensions'], v: ['-o', '--output', '--colors', '--lossy', '--resize', '--resize-width', '--resize-height', '--resize-fit', '--scale', '--delay', '-d', '--loopcount', '-O', '--optimize', '--crop'] },
  jpegoptim: { out: ['-d', '--dest'], f: ['--strip-all', '-s', '--strip-exif', '--strip-iptc', '--strip-icc', '-t', '--totals', '-o', '--overwrite', '-p', '--preserve', '-q', '--quiet', '-f', '--force', '--all-progressive', '--all-normal', '-n', '--noaction', '-v', '--verbose'], v: ['-m', '--max', '-d', '--dest', '-S', '--size', '-T', '--threshold'] },
  oxipng: { out: ['--out', '--dir'], f: ['-a', '--alpha', '-i', '-Z', '--zopfli', '-r', '--recursive', '-q', '--quiet', '-v', '--verbose', '--fix', '--force', '--preserve', '-p', '--nx', '--nz'], v: ['-o', '--opt', '--strip', '--out', '--dir', '-t', '--threads', '--interlace'] },
};
def(Object.keys(OPTIMIZER_SPEC), (args, st, name) => {
  const spec = OPTIMIZER_SPEC[name]!;
  const o = opts(st, args, spec);
  const outs = vals(o, ...spec.out).filter((x) => x !== '-');
  if (name === 'optipng') write(st, vals(o, '-log'));
  const inputs = o.operands;
  // Optimizers rewrite their inputs (or write next to them) unless told otherwise.
  write(st, [...inputs, ...outs]);
  PL(st, 'imageOptimize', 'paths', (outs.length ? [...inputs, ...outs] : inputs).filter(fileLike));
});

// Python.
const DANGEROUS_ENV = new Set(['PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'BASH_ENV', 'ENV', 'IFS', 'PROMPT_COMMAND', 'SHELLOPTS',
  'BASHOPTS', 'PS4', 'NODE_OPTIONS', 'PYTHONSTARTUP', 'PYTHONINSPECT', 'PYTHONHOME', 'PERL5OPT', 'PERL5LIB', 'PERLLIB', 'RUBYOPT', 'HOME', 'TMPDIR', 'PWD', 'OLDPWD',
  'CDPATH', 'GLOBIGNORE', 'ZDOTDIR', 'EDITOR', 'VISUAL', 'PAGER', 'LESSOPEN', 'LESSCLOSE', 'MANPAGER', 'GIT_DIR', 'GIT_WORK_TREE', 'PIP_TARGET', 'PIP_PREFIX',
  'BROWSER', 'SSH_ASKPASS', 'SUDO_ASKPASS', 'FPATH', 'MAILPATH']);
const SAFE_NPM_ENV = new Set(['npm_config_cache', 'NPM_CONFIG_CACHE', 'npm_config_yes', 'NPM_CONFIG_YES', 'npm_config_loglevel', 'NPM_CONFIG_LOGLEVEL', 'npm_config_update_notifier', 'NPM_CONFIG_UPDATE_NOTIFIER', 'npm_config_fund', 'NPM_CONFIG_FUND', 'npm_config_audit', 'NPM_CONFIG_AUDIT']);
/** PYTHON* variables that only change output or caching. Every other PYTHON* variable can load code (PYTHONBREAKPOINT…). */
const SAFE_PYTHON_ENV = new Set(['PYTHONPATH', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'PYTHONIOENCODING', 'PYTHONHASHSEED', 'PYTHONUTF8',
  'PYTHONWARNINGS', 'PYTHONFAULTHANDLER', 'PYTHONNOUSERSITE', 'PYTHONOPTIMIZE', 'PYTHONVERBOSE']);
/**
 * Always refused, whatever the value: names that load code or pick a config file (LD_*, DYLD_*, NODE_OPTIONS, PYTHONSTARTUP,
 * …_CONFIG_PATH, GIT_*, NPM_CONFIG_USERCONFIG and the other npm config keys, MAGICK_*_PATH, …_PRELOAD, …).
 */
export function isDangerousEnv(name: string): boolean {
  if (SAFE_NPM_ENV.has(name)) return false;
  if (DANGEROUS_ENV.has(name)) return true;
  const n = name.toUpperCase();
  if (n.startsWith('NPM_CONFIG_')) return true;
  if (n.startsWith('PYTHON')) return !SAFE_PYTHON_ENV.has(n);
  if (['DYLD_', 'LD_', 'GIT_', 'BASH_FUNC_', 'RUBYOPT', 'PERL5', 'NODE_REPL', 'ZDOTDIR'].some((p) => n.startsWith(p))) return true;
  if (n.startsWith('MAGICK_') && n.endsWith('_PATH')) return true;
  return n.endsWith('_CONFIG_PATH') || n.endsWith('USERCONFIG') || n.endsWith('GLOBALCONFIG') || n.endsWith('_PRELOAD') || n.endsWith('STARTUP')
    || n.endsWith('_MODULE_PATH') || n.endsWith('_PLUGIN_PATH') || n.endsWith('_PLUGINS');
}
/**
 * Refused only when the value points outside the project (a config, home, cache or plugin location elsewhere):
 * `XDG_CONFIG_HOME=/tmp/x`, `GEM_HOME=~/g`, `FFREPORT=file=~/x`. `HF_HOME=./cache`, `FONTCONFIG_FILE=./fonts.conf`,
 * `CONFIG=prod`, `MAGICK_THREAD_LIMIT=1` are fine.
 */
function isLocationEnv(name: string): boolean {
  const n = name.toUpperCase();
  if (CODE_PATH_ENV.includes(n)) return false; // PYTHONPATH, NODE_PATH…: their own rule (runs-code medium when outside)
  // Output locations: `OUT`, `OUTPUT`, `DEST`, `DIR` and the same as suffixes (`OUT_DIR`, `RENDER_OUT`, `BUILD_DEST`).
  if (['OUT', 'OUTPUT', 'DEST', 'DIR', 'OUTDIR'].includes(n) || ['_OUT', '_OUTPUT', '_DEST', 'OUTDIR'].some((x) => n.endsWith(x))) return true;
  return n.endsWith('CONFIG') || n.endsWith('_CONFIG_FILE') || n.endsWith('_FILE') || n.endsWith('_RC') || n.endsWith('RCFILE') || n.endsWith('_HOME')
    || n.endsWith('_DIR') || n.endsWith('_PATH') || ['XDG_', 'MAGICK_', 'RUBY', 'BUN_', 'DENO_', 'FFREPORT', 'LESS', 'RIPGREP_', 'CURL_', 'WGET', 'SSH_', 'GNUPG', 'GPG_', 'PIP_', 'GEM_', 'CARGO_', 'GO'].some((p) => n.startsWith(p));
}
/** A path-like part of an env value (`a:b` lists, `file=x` forms) outside the project, temp folders included. */
function envValueOutside(st: State, value: string): boolean {
  for (const part0 of value.split(':')) {
    const part = part0.includes('=') ? part0.slice(part0.lastIndexOf('=') + 1) : part0;
    if (part === '' || !pathLike(part)) continue;
    if (locsOf(st, part).some((l) => l.cls !== 'work' && l.cls !== 'project')) return true;
  }
  return false;
}
/** An env assignment we refuse to model: a loader or config name, or a location name pointing outside the project. */
export function envRisky(st: State, name: string, value: string): boolean {
  // `GIT_PAGER=cat git log`, `PAGER=cat`: no pager at all.
  if ((name === 'GIT_PAGER' || name === 'PAGER') && value === 'cat') return false;
  // `TMPDIR=./tmp`: a temp folder inside the project.
  if (name === 'TMPDIR' && value !== '' && !value.includes('$')) return locsOf(st, value).some((l) => l.cls !== 'work' && l.cls !== 'project');
  return isDangerousEnv(name) || (isLocationEnv(name) && envValueOutside(st, value));
}
/** Variables that make an interpreter load code from a folder: outside the project, that's code we can't see. */
const CODE_PATH_ENV = ['PYTHONPATH', 'NODE_PATH', 'GEM_PATH', 'CLASSPATH'];

const PIP_INSTALL_SPEC: Spec = {
  f: ['-U', '--upgrade', '--user', '--no-deps', '--force-reinstall', '--no-cache-dir', '-q', '--quiet', '-v', '--verbose', '--pre', '--no-index',
    '--break-system-packages', '-I', '--ignore-installed', '--no-build-isolation', '--require-hashes', '--no-warn-script-location',
    '--disable-pip-version-check', '--isolated', '--dry-run', '--compile', '--no-compile', '--prefer-binary', '--no-input', '--exists-action',
    '--use-pep517', '--no-use-pep517', '--no-clean', '--upgrade-strategy', '--progress-bar', '--root-user-action', '--no-color', '--editable', '-e'],
  v: ['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-t', '--target', '--prefix', '--root', '-i', '--index-url', '--extra-index-url',
    '-f', '--find-links', '--cache-dir', '--src', '--upgrade-strategy', '--platform', '--python-version', '--implementation', '--abi',
    '--only-binary', '--no-binary', '--progress-bar', '--log', '--timeout', '--retries', '--proxy', '--trusted-host', '--cert', '--client-cert',
    '-C', '--config-settings', '-d', '--dest', '-w', '--wheel-dir', '--report', '--root-user-action', '--python'],
};
function pip(args: string[], st: State): void {
  let i = 0;
  const GLOBAL_VALUE = ['--python', '--log', '--proxy', '--cache-dir', '--retries', '--timeout', '--exists-action', '--trusted-host', '--cert', '--client-cert', '--keyring-provider', '--use-feature', '--use-deprecated'];
  const GLOBAL_NOVAL = ['-q', '--quiet', '-v', '--verbose', '--isolated', '--no-cache-dir', '--disable-pip-version-check', '--no-color', '--no-input', '--require-virtualenv', '-V', '--version', '-h', '--help'];
  while (i < args.length && args[i]!.startsWith('-')) {
    const a = args[i]!;
    if (a === '-V' || a === '--version') { P(st, 'pipInfo'); return; }
    if (GLOBAL_VALUE.includes(a)) { if (a === '--log' || a === '--cache-dir') write(st, [args[i + 1] ?? '']); i++; }
    else if (!GLOBAL_NOVAL.includes(a) && !GLOBAL_VALUE.includes(a.split('=')[0]!)) unknownOpt(st, a);
    i++;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === 'install' || sub === 'download' || sub === 'wheel') {
    const o = opts(st, rest, PIP_INSTALL_SPEC);
    const reqs = vals(o, '-r', '--requirement', '-c', '--constraint');
    read(st, [...reqs, ...vals(o, '-e', '--editable').filter(pathLike)]);
    write(st, vals(o, '-t', '--target', '--prefix', '--root', '-d', '--dest', '-w', '--wheel-dir', '--src', '--report', '--log'));
    if (has(o, '--user')) add(st, 'writes-outside-project', 'high', { path: '~' });
    if (has(o, '--break-system-packages')) add(st, 'writes-outside-project', 'high');
    if (sub === 'install') add(st, 'installs-packages', 'medium');
    if (!has(o, '--no-index')) add(st, 'uses-network', 'medium', { host: 'pypi.org' });
    const pkgs = o.operands;
    for (const p of pkgs) if (pathLike(p)) read(st, [p]);
    if (pkgs.length) P(st, 'pipInstall', { packages: fmtList(pkgs) });
    else if (reqs.length) P(st, 'pipInstallReq', { file: disp(st, reqs) });
    else P(st, 'pipInstall', { packages: '…' });
    return;
  }
  if (sub === 'uninstall') {
    const o = opts(st, rest, { f: ['-y', '--yes', '-q', '--quiet', '-v', '--break-system-packages', '--root-user-action'], v: ['-r', '--requirement'] });
    add(st, 'installs-packages', 'medium');
    P(st, 'pkgRemove', { packages: fmtList(o.operands) });
    return;
  }
  if (sub === undefined || ['list', 'show', 'freeze', 'check', 'help', 'inspect', 'debug'].includes(sub)) {
    const o = opts(st, rest, {
      f: ['--outdated', '-o', '--uptodate', '-u', '--editable', '-e', '--local', '-l', '--user', '--not-required', '--exclude-editable', '--include-editable', '--pre', '--all', '--verbose', '-v', '-f', '--files', '-q', '--quiet'],
      v: ['--format', '--path', '--exclude', '-r', '--requirement', '--log'],
    });
    read(st, [...vals(o, '--path', '-r', '--requirement')]);
    write(st, vals(o, '--log'));
    P(st, 'pipInfo'); return;
  }
  P(st, 'pkgOther', { tool: 'pip', sub });
  add(st, 'unknown-command', 'medium');
}

const PY_NOVAL = 'uBOIEsSqvbdxPRhVi';
def(['python', 'python3', 'pypy3'], (args, st) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-') { runsInput(st, 'python'); return; }
    if (a === '-X' || a.startsWith('-X')) {
      const v = a === '-X' ? args[++i] : a.slice(2);
      // `-X pycache_prefix=<dir>`: compiled modules are read from and written to that folder.
      if (v?.startsWith('pycache_prefix=')) codeFrom(st, v.slice(15));
      continue;
    }
    if (a === '-W' || a === '--check-hash-based-pycs') { i++; continue; }
    if (a === '--version' || a === '--help') { P(st, 'sysInfo'); return; }
    if (a.startsWith('--')) { unknownOpt(st, a); continue; }
    if (a.startsWith('-') && !a.includes('$')) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k]!;
        if (ch === 'c' || ch === 'm') {
          const v = a.slice(k + 1) !== '' ? a.slice(k + 1) : args[++i];
          if (v === undefined) { st.parsed = false; return; }
          if (ch === 'c') { inlineCode(st, v, 'python'); P(st, 'pythonInline'); return; }
          pythonModule(v, args.slice(i + 1), st);
          return;
        }
        if (ch === 'W' || ch === 'X') {
          // `-uX pycache_prefix=…` and `-uXpycache_prefix=…`: the same value checks as the separate forms.
          const v = a.slice(k + 1) !== '' ? a.slice(k + 1) : args[++i];
          if (ch === 'X' && v?.startsWith('pycache_prefix=')) codeFrom(st, v.slice(15));
          break;
        }
        if (!PY_NOVAL.includes(ch)) unknownOpt(st, `-${ch}`);
      }
      continue;
    }
    if (isStdinPath(a)) { runsInput(st, 'python'); return; }
    script(st, a);
    scriptArgs(st, args.slice(i + 1));
    P(st, 'pythonScript', { script: disp(st, [a]) });
    return;
  }
  runsInput(st, 'python');
});
function pythonModule(module: string, rest: string[], st: State): void {
  if (module === 'pip') { pip(rest, st); return; }
  if (module === 'venv' || module === 'virtualenv') {
    const o = opts(st, rest, { f: ['--clear', '--upgrade', '--without-pip', '--system-site-packages', '--symlinks', '--copies', '--upgrade-deps', '--without-scm-ignore-files'], v: ['--prompt'] });
    write(st, o.operands);
    P(st, 'venv', { path: disp(st, o.operands) });
    return;
  }
  if (module === 'json.tool') {
    const o = opts(st, rest, { f: ['--sort-keys', '--no-ensure-ascii', '--json-lines', '--tab', '--no-indent', '--compact'], v: ['--indent'] });
    read(st, o.operands.slice(0, 1));
    write(st, o.operands.slice(1, 2));
    P(st, 'jsonCheck', { path: o.operands.length ? disp(st, o.operands.slice(0, 1)) : '…' });
    return;
  }
  add(st, 'runs-code', 'medium');
  if (module === 'http.server' || module === 'SimpleHTTPServer' || module === 'smtpd') add(st, 'uses-network', 'medium');
  scriptArgs(st, rest);
  P(st, 'pythonModule', { module });
}
def(['pip', 'pip3'], (args, st) => pip(args, st));

// Node.
const NODE_VALUE = ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file', '--title', '--stack-size', '--max-old-space-size', '--inspect-port', '--test-reporter', '--test-name-pattern'];
const NODE_NOVAL = ['--no-warnings', '--enable-source-maps', '--trace-warnings', '--trace-uncaught', '--test', '--watch', '--check', '-c', '-v', '--version', '-h', '--help', '--no-deprecation', '--preserve-symlinks', '--abort-on-uncaught-exception', '--unhandled-rejections', '--throw-deprecation', '--pending-deprecation', '--expose-gc'];
/** Accepted by prefix: harmless families only. `--experimental-*` and `--trace-*` are listed one by one (some write or load files). */
const NODE_PREFIX = ['--max-old-space-size=', '--stack-size=', '--inspect', '--harmony', '--unhandled-rejections=', '--disable-warning='];
const NODE_SAFE_FLAGS = ['--experimental-vm-modules', '--experimental-strip-types', '--experimental-transform-types', '--experimental-specifier-resolution',
  '--experimental-json-modules', '--experimental-fetch', '--no-experimental-fetch', '--experimental-modules', '--experimental-detect-module',
  '--experimental-require-module', '--experimental-sqlite', '--experimental-websocket', '--experimental-global-webcrypto', '--experimental-wasm-modules',
  '--experimental-import-meta-resolve', '--experimental-test-coverage', '--no-experimental-strip-types', '--experimental-default-type',
  '--trace-warnings', '--trace-uncaught', '--trace-deprecation', '--trace-exit', '--trace-sigint', '--trace-gc', '--trace-sync-io', '--trace-tls'];
/** Options whose value is a file or folder node writes. */
const NODE_WRITE_FLAGS = ['--trace-event-file-pattern', '--diagnostic-dir', '--report-directory', '--report-filename', '--cpu-prof-dir', '--heap-prof-dir',
  '--redirect-warnings', '--cpu-prof-name', '--heap-prof-name', '--experimental-sea-config'];
/** Options that load a config or policy that can change what runs: not modeled. */
const NODE_OPAQUE_FLAGS = ['--experimental-config-file', '--experimental-policy', '--policy-integrity', '--openssl-config', '--icu-data-dir', '--snapshot-blob', '--build-snapshot'];
function node(args: string[], st: State): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-e' || a === '--eval' || a === '-p' || a === '--print' || a === '-pe') {
      const v = args[++i];
      if (v === undefined) { st.parsed = false; return; }
      inlineCode(st, v, 'js');
      P(st, 'nodeInline');
      return;
    }
    if (a.startsWith('--eval=') || a.startsWith('--print=')) { inlineCode(st, a.slice(a.indexOf('=') + 1), 'js'); P(st, 'nodeInline'); return; }
    if (a === '-') { runsInput(st, 'node'); return; }
    if (a === '-v' || a === '--version') { P(st, 'sysInfo'); return; }
    if (a === '--env-file' || a.startsWith('--env-file=') || a.startsWith('--env-file-if-exists')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
      if (v !== undefined) codeFrom(st, v); // it can set NODE_OPTIONS
      continue;
    }
    if (a.startsWith('--inspect')) {
      // `--inspect=0.0.0.0:9229` listens on the network; the default and 127.0.0.1 / localhost stay local.
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : '';
      const host = v.includes(':') ? v.slice(0, v.lastIndexOf(':')) : isDigitsStr(v) ? '' : v;
      if (host !== '' && host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') add(st, 'uses-network', 'medium', { host });
      continue;
    }
    if (NODE_VALUE.includes(a)) {
      const v = args[++i];
      if (v !== undefined && ['-r', '--require', '--import', '--loader', '--experimental-loader'].includes(a)) { if (v.includes(':')) inlineCode(st, v); else script(st, v); }
      continue;
    }
    if (a.startsWith('-') && !a.includes('$')) {
      const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      if (NODE_OPAQUE_FLAGS.includes(name)) { st.parsed = false; return; }
      if (NODE_WRITE_FLAGS.includes(name)) { write(st, [a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i] ?? '']); continue; }
      if (!NODE_NOVAL.includes(a) && !NODE_SAFE_FLAGS.includes(a) && !NODE_VALUE.includes(name) && !NODE_PREFIX.some((p) => a.startsWith(p))) unknownOpt(st, name);
      if ((name === '--require' || name === '--import' || name === '--loader' || name === '--experimental-loader') && a.includes('=')) {
        const v = a.slice(a.indexOf('=') + 1);
        // `data:` / `http:` modules are inline or remote code.
        if (v.includes(':')) inlineCode(st, v); else script(st, v);
      }
      continue;
    }
    if (isStdinPath(a)) { runsInput(st, 'node'); return; }
    script(st, a);
    scriptArgs(st, args.slice(i + 1));
    P(st, 'nodeScript', { script: disp(st, [a]) });
    return;
  }
  runsInput(st, 'node');
}
def(['node', 'nodejs'], (args, st) => node(args, st));
function installPkgs(st: State, pkgs: string[], global: boolean, offline: boolean): void {
  add(st, 'installs-packages', 'medium');
  if (!offline) add(st, 'uses-network', 'medium', { host: 'registry.npmjs.org' });
  if (global) add(st, 'writes-outside-project', 'high');
  for (const p of pkgs) if (pathLike(p) && !p.startsWith('@')) read(st, [p]);
  if (pkgs.length) P(st, 'npmInstall', { packages: fmtList(pkgs) }); else P(st, 'npmInstallAll');
}
function npx(args: string[], st: State): void {
  // npx's own options come before the tool name; everything after it belongs to the tool.
  const VALUE = ['-p', '--package', '--cache'];
  let at = 0;
  while (at < args.length && args[at]!.startsWith('-') && args[at] !== '--') at += VALUE.includes(args[at]!) ? 2 : 1;
  const own = args.slice(0, at);
  const toolArgs = args[at] === '--' ? args.slice(at + 1) : args.slice(at);
  if (own.some((a) => a === '-c' || a === '--call' || a.startsWith('--call=') || a === '--shell')) { st.parsed = false; return; }
  const o = opts(st, own, { f: ['-y', '--yes', '--no', '-q', '--quiet', '--no-install', '--prefer-offline', '--ignore-existing', '-s', '--silent'], v: VALUE });
  const tool = toolArgs[0] ?? vals(o, '-p', '--package')[0] ?? '…';
  if (tool === 'node') { node(toolArgs.slice(1), st); return; }
  add(st, 'runs-code', 'medium');
  add(st, 'uses-network', 'medium', { host: 'registry.npmjs.org' });
  scriptArgs(st, toolArgs.slice(1));
  P(st, 'npx', { tool });
}
def(['npx', 'pnpx', 'bunx'], (args, st) => npx(args, st));
const NPM_INSTALL = ['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'ci', 'clean-install', 'update', 'up', 'upgrade', 'udpate'];
const PKG_REMOVE = ['uninstall', 'remove', 'rm', 'r', 'un', 'unlink'];
const PKG_INFO = ['ls', 'list', 'll', 'la', 'view', 'info', 'show', 'v', 'outdated', 'explain', 'why', 'help', 'search'];
const PKG_RISKY = ['publish', 'unpublish', 'link', 'ln', 'config', 'set', 'get', 'login', 'logout', 'adduser', 'deploy', 'pack', 'patch',
  'patch-commit', 'store', 'env', 'setup', 'self-update', 'audit', 'import', 'rebuild', 'prune', 'fetch', 'server', 'root', 'bin', 'init',
  'version', 'owner', 'team', 'token', 'access', 'hook', 'profile', 'cache', 'dist-tag', 'deprecate', 'edit', 'sbom', 'shrinkwrap', 'global', 'plugin', 'policies', 'workspaces', 'catalog', 'approve-builds', 'workspace', 'dlx', 'exec', 'x', 'create', 'run', 'node', 'test', 'start'];
const NPM_SPEC: Spec = {
  f: ['-g', '--global', '-D', '--save-dev', '-S', '--save', '--no-save', '-E', '--save-exact', '-O', '--save-optional', '-P', '--save-prod',
    '--legacy-peer-deps', '--strict-peer-deps', '--force', '-f', '--silent', '-s', '--quiet', '-q', '--ignore-scripts', '--no-audit', '--no-fund',
    '--production', '--frozen-lockfile', '--prefer-offline', '--offline', '-y', '--yes', '--if-present', '-r', '--recursive', '--parallel',
    '--no-package-lock', '--dev', '-W', '--ignore-workspace-root-check', '--exact', '--dry-run', '--verbose', '-d', '--no-optional', '--no-progress',
    '--workspaces', '--include-workspace-root', '--immutable', '--check-files', '--pure-lockfile', '--no-lockfile', '--non-interactive',
    '--shamefully-hoist', '--prefer-frozen-lockfile', '--no-frozen-lockfile', '--save-peer', '--fix', '--json', '--long', '--all', '--depth',
    '--stream', '--aggregate-output', '--reporter-hide-prefix', '--color', '--no-color', '--version', '-v', '--help', '-h', '--foreground-scripts', '--no-update-notifier'],
  v: ['--omit', '--include', '--reporter', '--loglevel', '-w', '--workspace', '-C', '--dir', '--filter', '-F', '--prefix', '--location', '--cache',
    '--registry', '--cwd', '--tag', '--network-concurrency', '--child-concurrency', '--depth'],
};
/** Script names projects define for themselves: `pnpm build`, `yarn dev` run package.json scripts. */
const COMMON_SCRIPTS = ['build', 'dev', 'test', 'start', 'lint', 'render', 'preview', 'typecheck', 'format', 'serve', 'watch', 'check', 'compile',
  'bundle', 'export', 'generate', 'gen', 'storybook', 'e2e', 'ci', 'prettier', 'fmt'];
/** npm reads every `--option` before `--` as its own config, even after the script name: for running scripts only these are accepted. */
const NPM_RUN_SUBS = ['run', 'run-script', 'rum', 'urn', 'test', 't', 'tst', 'start', 'stop', 'restart'];
function npmRunOptionsSafe(st: State, args: readonly string[]): boolean {
  const end = args.indexOf('--');
  const own = end >= 0 ? args.slice(0, end) : args;
  for (let i = 0; i < own.length; i++) {
    const a = own[i]!;
    if (!a.startsWith('-')) continue;
    const opt = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (['--silent', '-s', '--if-present', '--workspaces', '--include-workspace-root', '-ws', '--quiet', '-q', '--verbose', '-d', '-dd', '--color', '--no-color', '--foreground-scripts', '--no-audit', '--no-fund', '--no-update-notifier'].includes(a)) continue;
    if (opt === '--loglevel' || opt === '--color') { if (!a.includes('=')) i++; continue; }
    if (opt === '-w' || opt === '--workspace' || opt === '--prefix') {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : own[++i];
      if (v !== undefined && locsOf(st, v).every((l) => l.cls === 'work' || l.cls === 'project')) continue;
      if (opt !== '--prefix' && v !== undefined && !pathLike(v)) continue; // a workspace name
    }
    return false;
  }
  return true;
}
def(['npm', 'pnpm', 'yarn'], (args, st, name) => {
  const subAt = args.findIndex((a, k) => !a.startsWith('-') && !NPM_SPEC.v!.includes(args[k - 1] ?? ''));
  const sub = subAt >= 0 ? args[subAt]! : undefined;
  if (name === 'npm' && sub !== undefined && NPM_RUN_SUBS.includes(sub) && !npmRunOptionsSafe(st, args)) { st.parsed = false; return; }
  // Arguments after `--` (and after the script or binary name) go to the program, not to the package manager.
  const dashdash = args.indexOf('--');
  const own = dashdash >= 0 ? args.slice(0, dashdash) : args;
  const passed = dashdash >= 0 ? args.slice(dashdash + 1) : [];
  const runLike = sub !== undefined && (sub === 'run' || sub === 'run-script' || sub === 'exec' || sub === 'x' || sub === 'dlx' || sub === 'node' || (name !== 'npm' && !NPM_INSTALL.includes(sub) && !PKG_REMOVE.includes(sub) && !PKG_INFO.includes(sub) && !PKG_RISKY.includes(sub)));
  const head = runLike && subAt >= 0 ? own.slice(0, subAt + (sub === 'run' || sub === 'run-script' ? 2 : 1)) : own;
  const tail = runLike && subAt >= 0 ? [...own.slice(subAt + (sub === 'run' || sub === 'run-script' ? 2 : 1)), ...passed] : passed;
  const o = opts(st, head, NPM_SPEC);
  const rest = o.operands.slice(1);
  const global = has(o, '-g', '--global') || vals(o, '--location').includes('global');
  const offline = has(o, '--offline');
  write(st, vals(o, '--prefix'));
  read(st, vals(o, '-C', '--dir', '--cwd'));
  if (sub === undefined) {
    if (has(o, '--version', '-v', '--help', '-h')) { P(st, 'pkgInfo', { tool: name }); return; }
    if (name === 'yarn') { installPkgs(st, [], global, offline); return; }
    P(st, 'pkgInfo', { tool: name }); return;
  }
  if (name === 'yarn' && sub === 'global') {
    if (rest[0] === 'add') { installPkgs(st, rest.slice(1), true, offline); return; }
    P(st, 'pkgOther', { tool: name, sub }); add(st, 'unknown-command', 'medium'); return;
  }
  if (NPM_INSTALL.includes(sub)) { installPkgs(st, rest, global, offline); return; }
  if (sub === 'run' || sub === 'run-script' || sub === 'rum' || sub === 'urn') {
    add(st, 'runs-code', 'low');
    scriptArgs(st, tail);
    P(st, 'npmRun', { script: rest[0] ?? '…' }); return;
  }
  if (['test', 't', 'tst', 'start', 'stop', 'restart'].includes(sub)) { add(st, 'runs-code', 'low'); scriptArgs(st, tail); P(st, 'npmRun', { script: sub }); return; }
  if (sub === 'node') { node(tail, st); return; }
  if (sub === 'exec' || sub === 'x' || sub === 'dlx' || sub === 'create') { npx(sub === 'create' ? [`create-${rest[0] ?? ''}`, ...rest.slice(1), ...tail] : tail, st); return; }
  if (PKG_REMOVE.includes(sub)) { add(st, 'installs-packages', 'medium'); if (global) add(st, 'writes-outside-project', 'high'); P(st, 'pkgRemove', { packages: fmtList(rest) }); return; }
  if (PKG_INFO.includes(sub)) { P(st, 'pkgInfo', { tool: name }); return; }
  // `npm audit` reads the dependency tree and reports; `npm audit fix` installs.
  if (sub === 'audit') { if (rest[0] === 'fix') installPkgs(st, [], global, offline); else P(st, 'pkgInfo', { tool: name }); return; }
  if (name !== 'npm' && runLike) {
    // pnpm and yarn run a package.json script or a package binary by name. The usual script names are the project's own
    // scripts (low, like `npm run`); any other name may be a package binary (medium). Arguments are path-checked either way.
    add(st, 'runs-code', COMMON_SCRIPTS.includes(sub) ? 'low' : 'medium');
    scriptArgs(st, tail);
    P(st, 'npmRun', { script: sub }); return;
  }
  P(st, 'pkgOther', { tool: name, sub });
  add(st, 'unknown-command', 'medium');
});
def(['bun'], (args, st) => {
  const a0 = args[0];
  if (a0 === '-e' || a0 === '--eval' || a0 === '-p' || a0 === '--print') {
    const v = args[1];
    if (v === undefined) { st.parsed = false; return; }
    inlineCode(st, v, 'js'); P(st, 'inlineCode', { lang: 'bun' }); return;
  }
  if (a0 === '-' || (a0 === 'run' && args[1] === '-')) { runsInput(st, 'node'); return; }
  if (a0 === 'install' || a0 === 'i' || a0 === 'add' || a0 === 'a') {
    const o = opts(st, args.slice(1), NPM_SPEC);
    installPkgs(st, o.operands, has(o, '-g', '--global'), false); return;
  }
  if (a0 === 'x') { npx(args.slice(1), st); return; }
  const target = a0 === 'run' ? args[1] : a0;
  if (target === undefined) { P(st, 'pkgInfo', { tool: 'bun' }); return; }
  const rest = args.slice(a0 === 'run' ? 2 : 1);
  if (isStdinPath(target)) { runsInput(st, 'node'); return; }
  if (fileLike(target)) { script(st, target); scriptArgs(st, rest); P(st, 'runScript', { script: disp(st, [target]) }); return; }
  add(st, 'runs-code', COMMON_SCRIPTS.includes(target) ? 'low' : 'medium');
  scriptArgs(st, rest);
  P(st, 'npmRun', { script: target });
});

// Network.
const CURL_SPEC: Spec = {
  f: ['-s', '-S', '-L', '-f', '-k', '-v', '-i', '-I', '-O', '-J', '-#', '-N', '-g', '-G', '-4', '-6', '-n', '-R', '-Z', '-q', '--silent', '--show-error',
    '--location', '--fail', '--fail-with-body', '--insecure', '--verbose', '--include', '--head', '--remote-name', '--remote-name-all',
    '--remote-header-name', '--progress-bar', '--no-buffer', '--globoff', '--get', '--compressed', '--create-dirs', '--http1.1', '--http2',
    '--http1.0', '--http2-prior-knowledge', '--tlsv1.2', '--tlsv1.3', '--retry-all-errors', '--no-progress-meter', '--location-trusted',
    '--parallel', '--fail-early', '--digest', '--basic', '--anyauth', '--negotiate', '--ntlm', '--remote-time', '--raw', '--tcp-nodelay',
    '--path-as-is', '--ssl-reqd', '--no-keepalive', '--disable'],
  v: ['-o', '--output', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '-F', '--form',
    '--form-string', '-H', '--header', '-X', '--request', '-u', '--user', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c',
    '--cookie-jar', '-T', '--upload-file', '-m', '--max-time', '--connect-timeout', '-w', '--write-out', '-x', '--proxy', '--retry',
    '--retry-delay', '--retry-max-time', '-r', '--range', '-C', '--continue-at', '--cacert', '--capath', '--cert', '--key', '-E', '-D',
    '--dump-header', '--trace', '--trace-ascii', '--stderr', '--output-dir', '-z', '--time-cond', '-Y', '--speed-limit', '-y', '--speed-time',
    '--limit-rate', '--resolve', '--connect-to', '--interface', '--max-filesize', '--url', '-U', '--proxy-user', '--tls-max', '--ciphers',
    '--max-redirs', '-K', '--config', '--libcurl', '--etag-save', '--etag-compare', '--hsts', '--alt-svc', '--netrc-file', '-Q', '--quote', '--variable',
    '--proto', '--proto-redir', '--parallel-max', '--expect100-timeout', '--happy-eyeballs-timeout-ms'],
};
def(['curl'], (args, st) => {
  const o = opts(st, args, CURL_SPEC);
  if (vals(o, '-K', '--config').length) { st.parsed = false; return; }
  const urls = [...o.operands, ...vals(o, '--url')];
  const fileUrls = urls.filter((u) => u.startsWith('file://'));
  read(st, fileUrls.map((u) => u.slice(7)));
  const outs = vals(o, '-o', '--output', '-c', '--cookie-jar', '-D', '--dump-header', '--trace', '--trace-ascii', '--stderr', '--libcurl', '--etag-save', '--hsts', '--alt-svc').filter((x) => x !== '-');
  const outDirs = vals(o, '--output-dir');
  if (has(o, '-O', '--remote-name', '--remote-name-all', '-J')) outDirs.push(outDirs[0] ?? '.');
  write(st, [...outs, ...outDirs]);
  read(st, vals(o, '--netrc-file', '--cacert', '--cert', '--key', '--etag-compare'));
  const data = vals(o, '-d', '--data', '--data-binary', '--data-urlencode', '--data-ascii', '--json');
  const forms = vals(o, '-F', '--form');
  const uploads = vals(o, '-T', '--upload-file');
  const uploadFiles = [
    ...data.filter((d) => d.startsWith('@')).map((d) => d.slice(1)),
    ...forms.flatMap((f) => { const k = f.search(/=[@<]/); return k >= 0 ? [f.slice(k + 2).split(';')[0]!] : []; }),
    ...uploads,
  ].filter((x) => x !== '-' && x !== '');
  read(st, uploadFiles);
  const method = (vals(o, '-X', '--request')[0] ?? '').toUpperCase();
  const sends = data.length > 0 || forms.length > 0 || uploads.length > 0 || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const host = urls.length ? hostOf(urls[0]!) : '…';
  if (urls.length !== fileUrls.length || urls.length === 0) add(st, 'uses-network', 'medium', { host });
  if (sends) P(st, 'upload', { host });
  else if (outs.length) P(st, 'downloadTo', { host, path: disp(st, outs.slice(0, 1)) });
  else P(st, 'download', { host });
});
def(['wget'], (args, st) => {
  const o = opts(st, args, {
    f: ['-q', '-c', '-nc', '-N', '-r', '-np', '-nd', '-nH', '-k', '-p', '-m', '-S', '-v', '-nv', '-4', '-6', '-x', '--quiet', '--continue', '--no-clobber',
      '--timestamping', '--recursive', '--no-parent', '--no-directories', '--no-host-directories', '--convert-links', '--page-requisites', '--mirror',
      '--server-response', '--no-verbose', '--show-progress', '--no-check-certificate', '--content-disposition', '--spider', '--force-directories',
      '--trust-server-names', '--progress', '--https-only', '--retry-connrefused', '--no-cache'],
    v: ['-O', '--output-document', '-P', '--directory-prefix', '-o', '--output-file', '-a', '--append-output', '-i', '--input-file',
      '--post-data', '--post-file', '--method', '--body-data', '--body-file', '-U', '--user-agent', '--header', '-t', '--tries', '-T', '--timeout',
      '-e', '--execute', '--user', '--password', '-l', '--level', '-A', '-R', '-D', '--load-cookies', '--save-cookies', '--config', '--wait', '-w', '--limit-rate'],
  });
  if (vals(o, '-e', '--execute', '--config').length) { st.parsed = false; return; }
  const doc = vals(o, '-O', '--output-document').filter((x) => x !== '-');
  const outs = [...doc, ...vals(o, '-o', '--output-file', '-a', '--append-output', '--save-cookies')];
  const dirs = vals(o, '-P', '--directory-prefix');
  write(st, [...outs, ...(doc.length || vals(o, '-O', '--output-document').includes('-') ? [] : dirs.length ? dirs : ['.'])]);
  const posts = vals(o, '--post-file', '--body-file');
  read(st, [...posts, ...vals(o, '-i', '--input-file', '--load-cookies')]);
  const host = o.operands.length ? hostOf(o.operands[0]!) : '…';
  add(st, 'uses-network', 'medium', { host });
  if (posts.length || vals(o, '--post-data', '--method', '--body-data').length) P(st, 'upload', { host });
  else if (doc.length) P(st, 'downloadTo', { host, path: disp(st, doc) });
  else P(st, 'download', { host });
});
def(['ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'socat', 'ping', 'dig', 'nslookup', 'host', 'whois', 'http', 'https', 'aria2c'], (args, st, name) => {
  unknown(args, st, name);
  add(st, 'uses-network', 'medium');
});

// git: per-subcommand allow-lists. `-c`, `--config`, `--exec`, `--upload-pack`, `--template`, `--ext-diff`, … → parsed false.
const GIT_DIFF_F = ['--stat', '--numstat', '--shortstat', '--dirstat', '--summary', '--name-only', '--name-status', '--cached', '--staged', '-p', '--patch',
  '-s', '--no-patch', '--raw', '--minimal', '--patience', '--histogram', '--word-diff', '--color-words', '--no-renames', '-M', '-C', '-B', '-D', '-R',
  '--text', '-a', '-w', '-b', '--ignore-space-change', '--ignore-all-space', '--ignore-blank-lines', '--exit-code', '--quiet', '--no-ext-diff',
  '--no-textconv', '--check', '--full-index', '--binary', '--abbrev', '--relative', '--no-index', '--compact-summary', '--merge-base', '--cc',
  '--no-prefix', '--ignore-submodules', '--submodule', '--color-moved', '--function-context', '-W', '--find-renames', '--find-copies',
  '--irreversible-delete', '--color', '--no-color', '--oneline', '--format', '--pretty', '--show-signature', '--diff-merges', '--remerge-diff', '-m', '-c', '-t', '-z', '--stat-width', '--ita-invisible-in-index'];
const GIT_DIFF_V = ['-U', '--unified', '--format', '--pretty', '--diff-filter', '--diff-algorithm', '-S', '-G', '--word-diff-regex', '--src-prefix', '--dst-prefix', '--inter-hunk-context', '--output', '-O', '-l'];
const GIT_LOG_F = [...GIT_DIFF_F, '--graph', '--decorate', '--all', '--branches', '--tags', '--remotes', '--follow', '--reverse', '--no-merges', '--merges',
  '--first-parent', '--abbrev-commit', '--date', '--relative-date', '--source', '--left-right', '--cherry-pick', '--boundary', '-i',
  '--regexp-ignore-case', '-E', '--extended-regexp', '-F', '--fixed-strings', '--all-match', '--invert-grep', '--walk-reflogs', '-g', '--no-walk',
  '--date-order', '--topo-order', '--full-history', '--simplify-by-decoration', '--notes', '--no-notes', '--mailmap', '-L', '--use-mailmap'];
const GIT_LOG_V = [...GIT_DIFF_V, '-n', '--max-count', '--skip', '--since', '--until', '--after', '--before', '--author', '--committer', '--grep', '--decorate-refs', '--date'];
const GIT_SUBS: Record<string, Spec & { phrase: string; changes?: boolean; net?: boolean }> = {
  status: { phrase: 'gitStatus', f: ['-s', '--short', '-b', '--branch', '--long', '--ignored', '-u', '-uno', '-unormal', '-uall', '--untracked-files', '--ahead-behind', '--no-ahead-behind', '--show-stash', '--no-renames', '--porcelain', '-z', '-v', '--verbose'] },
  diff: { phrase: 'gitDiff', f: GIT_DIFF_F, v: GIT_DIFF_V },
  show: { phrase: 'gitDiff', f: GIT_DIFF_F, v: GIT_DIFF_V },
  log: { phrase: 'gitLog', f: GIT_LOG_F, v: GIT_LOG_V, num: true },
  shortlog: { phrase: 'gitLog', f: ['-s', '-n', '-e', '--summary', '--numbered', '--email', '--all'], v: ['--since', '--until', '--group', '-c', '--format'] },
  blame: { phrase: 'gitLog', f: ['-l', '-s', '-e', '-w', '-M', '-C', '--porcelain', '--line-porcelain', '-p', '-t', '--show-email', '--show-name', '-f', '-n'], v: ['-L', '--since'] },
  reflog: { phrase: 'gitLog', f: ['show', '--all', '--date'], v: ['-n', '--date'], num: true },
  'rev-parse': { phrase: 'gitInfo', f: ['--show-toplevel', '--abbrev-ref', '--short', '--verify', '--git-dir', '--git-common-dir', '--is-inside-work-tree', '--is-bare-repository', '--symbolic-full-name', '--absolute-git-dir', '--show-prefix', '--show-cdup', '-q', '--quiet', '--all', '--branches', '--tags', '--symbolic', '--is-shallow-repository', '--show-superproject-working-tree'] },
  'ls-files': { phrase: 'gitInfo', f: ['-m', '--modified', '-o', '--others', '-d', '--deleted', '--exclude-standard', '-z', '-s', '--stage', '--cached', '-c', '-i', '--ignored', '--error-unmatch', '-t', '--full-name', '--abbrev', '--directory', '--no-empty-directory', '-u', '--unmerged', '-k', '--killed', '--eol'], v: ['-x', '--exclude', '-X', '--exclude-from', '--format'] },
  'ls-tree': { phrase: 'gitInfo', f: ['-r', '-d', '-t', '-l', '--long', '--name-only', '--name-status', '--full-name', '--full-tree', '--abbrev', '-z', '--object-only'], v: ['--format'] },
  describe: { phrase: 'gitInfo', f: ['--tags', '--all', '--always', '--long', '--abbrev', '--dirty', '--exact-match', '--contains', '--first-parent'], v: ['--match', '--exclude'] },
  'cat-file': { phrase: 'gitInfo', f: ['-t', '-s', '-p', '-e', '--batch', '--batch-check'] },
  'show-ref': { phrase: 'gitInfo', f: ['--heads', '--tags', '-s', '--hash', '--verify', '-d', '-q', '--quiet', '--head'] },
  grep: { phrase: 'gitInfo', f: ['-n', '-i', '-l', '-L', '-w', '-v', '-E', '-F', '-P', '-G', '--cached', '--untracked', '-c', '--count', '-h', '-H', '--heading', '--break', '-r', '--recursive', '--no-index', '-I', '-o', '--only-matching', '-q', '--quiet', '--line-number', '--ignore-case', '--files-with-matches', '--all-match', '--color', '--no-color', '--column', '-p', '-W'], v: ['-e', '-A', '-B', '-C', '-m', '--max-count', '--max-depth', '-f'], num: true },
  'rev-list': { phrase: 'gitInfo', f: ['--count', '--all', '--reverse', '--objects', '--first-parent', '--left-right', '--cherry-pick', '--merges', '--no-merges', '--topo-order', '--date-order'], v: ['--max-count', '-n', '--since', '--until', '--author'] },
  'merge-base': { phrase: 'gitInfo', f: ['--is-ancestor', '--all', '--octopus', '--independent', '--fork-point'] },
  add: { phrase: 'gitAdd', f: ['-A', '--all', '-u', '--update', '-N', '--intent-to-add', '-f', '--force', '-n', '--dry-run', '-v', '--verbose', '-p', '--patch', '--ignore-errors', '--renormalize', '--no-all', '--ignore-removal', '--sparse'], v: ['--chmod', '--pathspec-from-file'] },
  commit: { phrase: 'gitCommit', changes: true, f: ['-a', '--all', '--amend', '--no-edit', '-s', '--signoff', '--allow-empty', '--allow-empty-message', '-n', '--no-verify', '--no-gpg-sign', '-e', '--edit', '--only', '-o', '--include', '-i', '--dry-run', '--status', '--no-status', '-u', '--untracked-files', '-v', '--verbose', '--short', '--porcelain', '--reset-author', '-q', '--quiet', '-p', '--patch', '-S', '--gpg-sign'], v: ['-m', '--message', '-F', '--file', '--author', '--date', '--fixup', '--squash', '-C', '--reuse-message', '-c', '--reedit-message', '--cleanup', '-t', '--template', '--pathspec-from-file', '--trailer'] },
  push: { phrase: 'gitSync', changes: true, net: true, f: ['-u', '--set-upstream', '-f', '--force', '--force-with-lease', '--force-if-includes', '--tags', '--all', '--mirror', '--dry-run', '-n', '--delete', '-d', '--no-verify', '--follow-tags', '--atomic', '--prune', '--porcelain', '--progress', '-q', '--quiet', '-v', '--verbose', '--no-force-with-lease'], v: ['-o', '--push-option', '--repo', '--signed'] },
  pull: { phrase: 'gitSync', changes: true, net: true, f: ['--rebase', '--no-rebase', '--ff', '--ff-only', '--no-ff', '--all', '--tags', '--prune', '-p', '--unshallow', '--no-tags', '--autostash', '--no-autostash', '--squash', '--no-commit', '--commit', '--edit', '--no-edit', '--stat', '-n', '--no-stat', '-q', '--quiet', '-v', '--verbose', '-r'], v: ['--depth', '-s', '--strategy', '-X', '--strategy-option', '-j', '--jobs'] },
  fetch: { phrase: 'gitSync', net: true, f: ['--all', '--tags', '--prune', '-p', '-P', '--prune-tags', '--unshallow', '--no-tags', '--dry-run', '-f', '--force', '--multiple', '--recurse-submodules', '--no-recurse-submodules', '-q', '--quiet', '-v', '--verbose', '--progress', '-t', '--append', '-a', '--write-fetch-head', '--no-write-fetch-head', '--atomic'], v: ['--depth', '--deepen', '--shallow-since', '-j', '--jobs', '--refmap', '--negotiation-tip'] },
  clone: { phrase: 'gitClone', net: true, f: ['--single-branch', '--no-single-branch', '--recurse-submodules', '--recursive', '--shallow-submodules', '--bare', '--mirror', '--no-checkout', '-n', '--sparse', '--no-tags', '--dissociate', '--progress', '-q', '--quiet', '-v', '--verbose', '-l', '--local', '--no-local', '--no-hardlinks', '-s', '--shared', '--remote-submodules', '--also-filter-submodules', '--reject-shallow'], v: ['--depth', '--branch', '-b', '--filter', '--origin', '-o', '-j', '--jobs', '--reference', '--reference-if-able', '--shallow-since', '--shallow-exclude', '--bundle-uri', '--revision'] },
  checkout: { phrase: 'gitChange', changes: true, f: ['--detach', '-f', '--force', '--ours', '--theirs', '-p', '--patch', '-m', '--merge', '--track', '-t', '--no-track', '-q', '--quiet', '--recurse-submodules', '--no-recurse-submodules', '--overlay', '--no-overlay', '--progress', '--guess', '--no-guess', '--ignore-other-worktrees'], v: ['-b', '-B', '--orphan', '--conflict', '--pathspec-from-file'] },
  switch: { phrase: 'gitChange', changes: true, f: ['--detach', '-f', '--force', '--discard-changes', '-m', '--merge', '-t', '--track', '--no-track', '--guess', '--no-guess', '-q', '--quiet', '--recurse-submodules', '--progress', '--ignore-other-worktrees'], v: ['-c', '-C', '--create', '--force-create', '--orphan', '--conflict'] },
  restore: { phrase: 'gitChange', changes: true, f: ['--staged', '-S', '--worktree', '-W', '-p', '--patch', '--ours', '--theirs', '-m', '--merge', '--ignore-unmerged', '--overlay', '--no-overlay', '-q', '--quiet', '--progress', '--recurse-submodules'], v: ['-s', '--source', '--conflict', '--pathspec-from-file'] },
  reset: { phrase: 'gitChange', changes: true, f: ['--hard', '--soft', '--mixed', '--merge', '--keep', '-p', '--patch', '-N', '--intent-to-add', '-q', '--quiet', '--recurse-submodules', '--no-refresh'], v: ['--pathspec-from-file'] },
  stash: { phrase: 'gitChange', changes: true, f: ['push', 'pop', 'list', 'show', 'apply', 'drop', 'clear', 'save', 'branch', 'create', 'store', '-u', '--include-untracked', '-a', '--all', '-k', '--keep-index', '--no-keep-index', '-p', '--patch', '--staged', '-S', '--index', '-q', '--quiet', '--stat', '-p'], v: ['-m', '--message', '--pathspec-from-file'] },
  rebase: { phrase: 'gitChange', changes: true, f: ['--continue', '--abort', '--skip', '--quit', '-i', '--interactive', '--autosquash', '--no-autosquash', '--autostash', '--no-autostash', '--keep-base', '--root', '--rebase-merges', '-r', '--edit-todo', '--show-current-patch', '-q', '--quiet', '-v', '--verbose', '--stat', '-n', '--no-stat', '--no-verify', '--verify', '-f', '--force-rebase', '--fork-point', '--no-fork-point', '--signoff', '--committer-date-is-author-date', '--reset-author-date', '--update-refs'], v: ['--onto', '-s', '--strategy', '-X', '--strategy-option'] },
  merge: { phrase: 'gitChange', changes: true, f: ['--no-ff', '--ff', '--ff-only', '--squash', '--abort', '--continue', '--quit', '--no-edit', '--edit', '--no-commit', '--commit', '--allow-unrelated-histories', '--no-verify', '--stat', '-n', '--no-stat', '-q', '--quiet', '-v', '--verbose', '--autostash', '--no-autostash', '--signoff', '--progress'], v: ['-m', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--into-name'] },
  revert: { phrase: 'gitChange', changes: true, f: ['--no-edit', '--edit', '-e', '--continue', '--abort', '--skip', '--quit', '-n', '--no-commit', '-s', '--signoff'], v: ['-m', '--mainline', '--strategy', '-X'] },
  'cherry-pick': { phrase: 'gitChange', changes: true, f: ['--no-edit', '--edit', '-e', '--continue', '--abort', '--skip', '--quit', '-n', '--no-commit', '-s', '--signoff', '-x', '--ff', '--allow-empty', '--keep-redundant-commits'], v: ['-m', '--mainline', '--strategy', '-X'] },
  clean: { phrase: 'gitChange', changes: true, f: ['-f', '--force', '-d', '-x', '-X', '-n', '--dry-run', '-i', '--interactive', '-q', '--quiet', '-ff', '-fd', '-fdx', '-fdX', '-fx', '-dfx', '-xdf', '-fxd', '-dn', '-nd'], v: ['-e', '--exclude'] },
  rm: { phrase: 'gitChange', changes: true, f: ['--cached', '-r', '-f', '--force', '-n', '--dry-run', '--ignore-unmatch', '-q', '--quiet', '--sparse'], v: ['--pathspec-from-file'] },
  mv: { phrase: 'gitChange', changes: true, f: ['-f', '--force', '-k', '-n', '--dry-run', '-v', '--verbose'] },
  branch: { phrase: 'gitChange', changes: true, f: ['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '-l', '--list', '-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '--show-current', '--merged', '--no-merged', '--contains', '--no-contains', '--unset-upstream', '-t', '--track', '--no-track', '--points-at', '--column', '--no-column', '-q', '--quiet', '-i', '--ignore-case', '--color', '--no-color'], v: ['--sort', '--format', '-u', '--set-upstream-to'] },
  tag: { phrase: 'gitChange', changes: true, f: ['-a', '--annotate', '-l', '--list', '-d', '--delete', '-f', '--force', '-v', '--verify', '--contains', '--no-contains', '--merged', '--no-merged', '-s', '--sign', '-i', '--ignore-case', '--column', '--no-column'], v: ['-m', '--message', '-F', '--file', '--sort', '--points-at', '--format', '-n'], num: true },
  remote: { phrase: 'gitInfo', f: ['-v', '--verbose', 'add', 'remove', 'rm', 'rename', 'set-url', 'show', 'get-url', 'prune', 'update', 'set-head', '--push', '--all', '--add', '--delete', '-f'], v: ['-t', '-m'] },
  init: { phrase: 'gitChange', changes: true, f: ['-q', '--quiet', '--bare'], v: ['-b', '--initial-branch', '--shared', '--object-format'] },
  gc: { phrase: 'gitChange', changes: true, f: ['--aggressive', '--auto', '--prune', '--no-prune', '-q', '--quiet', '--force'] },
  apply: { phrase: 'gitChange', changes: true, f: ['--check', '--stat', '--numstat', '--summary', '--cached', '--index', '-3', '--3way', '-R', '--reverse', '-v', '--verbose', '--reject', '--allow-empty', '--recount', '--unidiff-zero', '-N', '--intent-to-add'], v: ['-p', '--whitespace', '--exclude', '--include', '--directory', '-C'] },
  'format-patch': { phrase: 'gitOther', num: true, f: ['--stdout', '-n', '--numbered', '-N', '--no-numbered', '-k', '--keep-subject', '--cover-letter', '--signoff', '-s', '--no-stat', '--root', '--thread', '-q', '--quiet', '--zero-commit', '--minimal', '-p', '--no-binary'], v: ['-o', '--output-directory', '--subject-prefix', '--start-number', '-v', '--reroll-count', '--base', '--suffix', '--to', '--cc', '--from'] },
  archive: { phrase: 'gitOther', f: ['--list', '-l', '-v', '--verbose', '--worktree-attributes', '-0', '-1', '-2', '-3', '-4', '-5', '-6', '-7', '-8', '-9'], v: ['-o', '--output', '--format', '--prefix', '--add-file', '--add-virtual-file', '--mtime'] },
  bundle: { phrase: 'gitOther', f: ['create', 'verify', 'list-heads', 'unbundle', '--all', '--branches', '--tags', '-q', '--quiet', '--progress'], v: ['--version'] },
  worktree: { phrase: 'gitChange', changes: true, f: ['add', 'list', 'remove', 'prune', 'lock', 'unlock', 'move', 'repair', '-f', '--force', '--detach', '--checkout', '--no-checkout', '--lock', '--orphan', '-q', '--quiet', '--porcelain', '-v', '--verbose', '--track', '--no-track', '--guess-remote'], v: ['-b', '-B', '--reason', '--expire'] },
  am: { phrase: 'gitChange', changes: true, f: ['--abort', '--continue', '--skip', '--quit', '-3', '--3way', '-s', '--signoff', '-k', '--keep', '-q', '--quiet', '--show-current-patch'], v: ['-p', '--whitespace', '--directory'] },
};
const GIT_OK: readonly string[] = [...new Set(Object.values(GIT_SUBS).flatMap((x) => [...(x.f ?? []), ...(x.v ?? [])]))];
const GIT_FALSE_LONG = ['--config', '--config-env', '--exec', '--upload-pack', '--receive-pack', '--template', '--ext-diff', '--open-files-in-pager',
  '--git-dir', '--work-tree', '--exec-path', '--namespace', '--super-prefix', '--separate-git-dir', '--textconv', '--strategy-option=theirs-exec'];
/** git subcommands that run other programs or commands given on the line (`submodule foreach`, `bisect run`, difftool…). */
const GIT_EXEC_SUBS = ['submodule', 'bisect', 'filter-branch', 'filter-repo', 'difftool', 'mergetool', 'hook', 'daemon', 'instaweb', 'credential',
  'credential-store', 'credential-cache', 'send-email', 'svn', 'p4', 'web--browse', 'upload-pack', 'receive-pack', 'shell', 'fsmonitor--daemon',
  'archimport', 'cvsimport', 'cvsserver', 'quiltimport', 'imap-send', 'remote-ext', 'run-command'];
const GIT_C_OK = new Set(['commit', 'switch', 'branch', 'show', 'log', 'diff', 'checkout', 'shortlog', 'grep', 'ls-files', 'apply']);
const GIT_U_EXEC = new Set(['clone', 'fetch', 'pull', 'ls-remote', 'archive']);
def(['git'], (args, st) => {
  let i = 0;
  let cwd = st.cwd;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-C') { const v = args[++i]; if (v === undefined) { st.parsed = false; return; } read(st, [v]); cwd = locsOf(st, v)[0]?.abs ?? null; continue; }
    if (['--no-pager', '-P', '--paginate', '-p', '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-advice'].includes(a)) continue;
    if (a === '--version' || a === '--help') { P(st, 'gitInfo'); return; }
    if (a.startsWith('-')) { st.parsed = false; return; } // -c, --git-dir, --work-tree, --exec-path, --config-env, …
    break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub !== undefined && GIT_EXEC_SUBS.includes(sub)) { st.parsed = false; return; }
  // Options that run a program or read a config anywhere on the line.
  for (const a of rest) {
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (GIT_FALSE_LONG.includes(name)) { st.parsed = false; return; }
    if ((a === '-c' || (a.startsWith('-c') && a.length > 2 && !a.startsWith('--'))) && !GIT_C_OK.has(sub ?? '')) { st.parsed = false; return; }
    if ((a === '-u' || (a.startsWith('-u') && a.length > 2 && !a.startsWith('--'))) && GIT_U_EXEC.has(sub ?? '')) { st.parsed = false; return; }
    if (sub === 'grep' && (a === '-O' || (a.startsWith('-O') && !a.startsWith('--')))) { st.parsed = false; return; }
    if (sub === 'rebase' && (a === '-x' || a.startsWith('-x') && !a.startsWith('--'))) { st.parsed = false; return; }
  }
  const saved = st.cwd;
  st.cwd = cwd;
  try {
    if (sub === undefined) { P(st, 'gitInfo'); return; }
    // `--output` writes a file for any subcommand.
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k]!;
      if (a === '--') break;
      const opt = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      const isOutput = opt === '--output' || (opt.length >= 4 && opt.startsWith('--ou') && '--output'.startsWith(opt));
      if (!isOutput) continue;
      write(st, [a.includes('=') ? a.slice(a.indexOf('=') + 1) : rest[k + 1] ?? '']);
    }
    if (sub === 'config') {
      const lower = rest.map((x) => x.toLowerCase());
      if (rest.some((x) => ['--get', '--get-all', '--list', '-l', '--get-regexp', '--show-origin', '--show-scope', 'get', 'list'].includes(x)) && rest.length <= 3) { P(st, 'gitInfo'); return; }
      if (lower.some((x) => ['core.', 'alias.', 'filter.', 'include', 'credential', 'command', 'textconv', 'hook', 'sshcommand', 'pager', 'editor', 'diff.', 'merge.', 'url.', 'http.', 'gpg.', 'protocol', 'remote.', 'submodule', 'sequence'].some((k) => x.includes(k)))) { st.parsed = false; return; }
      add(st, 'changes-git', 'medium');
      P(st, 'gitOther', { sub });
      add(st, 'unknown-command', 'medium');
      return;
    }
    const spec = GIT_SUBS[sub];
    if (!spec) {
      P(st, 'gitOther', { sub });
      add(st, 'unknown-command', 'medium');
      return;
    }
    const o = opts(st, rest, { ...spec, f: [...(spec.f ?? []), '-q', '--quiet', '-h', '--help'] });
    // Read-only listings: `git branch [-a|-r|-v] [--list <pattern>]`, `git tag [-l <pattern>]`, `git worktree list`.
    const listing = (sub === 'branch' || sub === 'tag')
      && !has(o, '-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream', '-t', '--track', '--no-track', '--edit-description')
      && !(sub === 'tag' && has(o, '-a', '-s', '--annotate', '--sign', '-m', '-F', '--message', '--file', '-v', '--verify'))
      && (o.operands.length === 0 || has(o, '-l', '--list'));
    if (listing || (sub === 'worktree' && o.operands[0] === 'list')) { P(st, 'gitInfo'); return; }
    if (spec.changes) add(st, 'changes-git', 'medium');
    if (spec.net) add(st, 'uses-network', 'medium');
    switch (sub) {
      case 'diff': if (has(o, '--no-index')) read(st, o.operands); P(st, 'gitDiff'); return;
      case 'format-patch': write(st, vals(o, '-o', '--output-directory')); if (!has(o, '-o', '--output-directory', '--stdout')) write(st, ['.']); P(st, 'gitOther', { sub }); return;
      case 'archive': write(st, vals(o, '-o')); read(st, vals(o, '--add-file')); P(st, 'gitOther', { sub }); return;
      case 'bundle': if (o.operands[0] === 'create') write(st, o.operands.slice(1, 2)); else read(st, o.operands.slice(1, 2)); P(st, 'gitOther', { sub }); return;
      case 'worktree': {
        const [op, path] = o.operands;
        if (op === 'add' || op === 'move') write(st, op === 'move' ? o.operands.slice(1, 3) : path !== undefined ? [path] : []);
        else if (op === 'remove') del(st, path !== undefined ? [path] : []);
        P(st, 'gitChange', { sub }); return;
      }
      case 'add': read(st, o.operands); P(st, 'gitAdd', { paths: disp(st, o.operands.length ? o.operands : ['.']) }); return;
      case 'commit': read(st, vals(o, '-F', '--file', '-t', '--template')); P(st, 'gitCommit'); return;
      case 'clone': {
        const url = o.operands[0] ?? '…';
        const base = (() => { let b = trimSlashes(url); b = b.slice(b.lastIndexOf('/') + 1); b = b.slice(b.lastIndexOf(':') + 1); return b.endsWith('.git') ? b.slice(0, -4) : b; })();
        write(st, [o.operands[1] ?? (base || '.')]);
        // A URL or `user@host:path` reaches the network; a plain path or file:// is a local clone.
        const colon = url.indexOf(':');
        const slash = url.indexOf('/');
        const scpLike = colon > 0 && (slash < 0 || colon < slash) && !url.startsWith('/') && !url.startsWith('.') && !url.startsWith('~');
        const local = url.startsWith('file://') || (!isUrl(url) && !scpLike);
        if (local) read(st, [url.startsWith('file://') ? url.slice(7) : url]);
        else add(st, 'uses-network', 'medium', { host: hostOf(url.includes('://') ? url : url.slice(url.indexOf('@') + 1).split(':')[0] ?? url) });
        P(st, 'gitClone', { url: repoOf(url) }); return;
      }
      case 'push': case 'pull': case 'fetch': P(st, 'gitSync', { sub }); return;
      case 'rm': if (!has(o, '--cached')) del(st, o.operands); P(st, 'gitChange', { sub }); return;
      case 'clean': if (!has(o, '-n', '--dry-run')) del(st, o.operands.length ? o.operands : ['.']); P(st, 'gitChange', { sub }); return;
      case 'branch': case 'tag': P(st, 'gitChange', { sub }); return;
      case 'remote': {
        const op = o.operands[0];
        if (op === undefined || op === 'show' || op === 'get-url') { P(st, 'gitInfo'); return; }
        add(st, 'changes-git', 'medium'); P(st, 'gitChange', { sub }); return;
      }
      case 'stash': P(st, 'gitChange', { sub }); return;
      default: P(st, spec.phrase, spec.phrase === 'gitChange' ? { sub } : {});
    }
  } finally {
    st.cwd = saved;
  }
});
def(['brew', 'apt', 'apt-get', 'port', 'yum', 'dnf', 'apk'], (args, st, name) => {
  const sub0 = args.find((a) => !a.startsWith('-'));
  const installing = ['install', 'reinstall', 'upgrade', 'tap', 'bundle', 'uninstall', 'remove', 'rm', 'purge', 'autoremove'].includes(sub0 ?? '');
  // Installs and removals are already rated high; for the read-only subcommands only listing options are accepted.
  const o = opts(st, args, installing ? { any: true, v: ['-o', '--option', '-t', '--target-release'] }
    : { f: ['--versions', '--json', '--formula', '--formulae', '--cask', '--casks', '-1', '-l', '--full-name', '--installed', '--upgradable', '-a', '--all', '--quiet', '-q', '-v', '--verbose', '--multiple', '--pinned', '--desc', '--eval-all'], v: [] });
  const [sub, ...rest] = o.operands;
  if (sub === 'install' || sub === 'reinstall' || sub === 'upgrade' || sub === 'tap' || (name === 'brew' && sub === 'bundle')) {
    add(st, 'installs-packages', 'medium');
    add(st, 'uses-network', 'medium');
    add(st, 'writes-outside-project', 'high');
    P(st, 'systemInstall', { packages: fmtList(rest) }); return;
  }
  if (sub === 'uninstall' || sub === 'remove' || sub === 'rm' || sub === 'purge' || sub === 'autoremove') {
    add(st, 'installs-packages', 'medium');
    add(st, 'writes-outside-project', 'high');
    P(st, 'pkgRemove', { packages: fmtList(rest) }); return;
  }
  if (sub === undefined || ['list', 'ls', 'info', 'search', '--prefix', '--version', 'config', 'outdated', 'deps', 'leaves', 'show', 'policy', 'desc', 'home', 'doctor'].includes(sub)) { P(st, 'pkgInfo', { tool: name }); return; }
  P(st, 'pkgOther', { tool: name, sub });
  add(st, 'unknown-command', 'medium');
});

// Processes.
const isSignalName = (s: string) => s.length > 0 && [...s].every((c) => (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'));
def(['kill'], (args, st) => {
  add(st, 'kills-processes', 'medium');
  let i = 0;
  if (args[0] === '-l' || args[0] === '-L') { P(st, 'sysInfo'); return; }
  if (args[0] === '-s' || args[0] === '-n') i = 2;
  else if (args[0] !== undefined && args[0] !== '--' && args[0].startsWith('-') && !args[0].startsWith('-$') && (isDigitsStr(args[0].slice(1)) || isSignalName(args[0].slice(1)))) i = 1;
  if (args[i] === '--') i++;
  const targets = args.slice(i);
  // A negative pid is a process group (`-1` is every process); `0` is our own group.
  for (const t of targets) {
    if (t === '0' || (t.startsWith('-') && (isDigitsStr(t.slice(1)) || t.startsWith('-$')))) add(st, 'kills-processes', 'high', { target: t });
    else if (!isDigitsStr(t) && !t.startsWith('%') && !t.startsWith('$')) unknownOpt(st, t);
  }
  P(st, 'kill', { targets: fmtList(targets), n: targets.length });
});
def(['pkill', 'killall'], (args, st, name) => {
  const signals = args.filter((a) => a.startsWith('-') && isSignalName(a.slice(1)) && !['-I', '-U', '-G', '-P', '-F', '-M', '-N'].includes(a));
  const o = opts(st, args.filter((a) => !signals.includes(a)), {
    num: true,
    f: name === 'pkill' ? ['-f', '-i', '-l', '-n', '-o', '-x', '-v', '-a', '-I', '-q', '--full', '--exact', '--newest', '--oldest'] : ['-v', '-s', '-e', '-I', '-q', '-m', '-z', '-d', '--exact', '--interactive', '--quiet', '--regexp', '-w', '--wait'],
    v: ['-u', '-U', '-g', '-G', '-t', '-s', '-P', '-F', '-c', '-j', '-M', '-N', '--signal', '-SIGNAL'],
  });
  read(st, vals(o, '-F'));
  const pats = o.operands;
  const broad = pats.some((p) => p === '' || p === '.' || p === '.*' || p === '^' || p === '*');
  add(st, 'kills-processes', broad ? 'high' : 'medium');
  P(st, 'kill', { targets: fmtList(pats), n: pats.length });
});
def(['sleep'], (args, st) => { opts(st, args, {}); P(st, 'sleep', { seconds: args[0] ?? '…' }); });
def(['echo'], (_args, st) => { if (st.stdout !== null) P(st, 'writeText', { path: st.stdout }); else P(st, 'print'); });
def(['printf'], (args, st) => {
  if (args[0] === '-v') {
    if ((args[1] ?? '').includes('[')) { st.parsed = false; return; }
    P(st, 'setVar', { name: args[1] ?? '…' }); return;
  }
  if (st.stdout !== null) P(st, 'writeText', { path: st.stdout }); else P(st, 'print');
});
// pure reader: these only print text computed from their arguments.
def(['basename', 'dirname', 'seq', 'expr', 'yes'], (args, st) => { opts(st, args, { any: true }); P(st, 'print'); });
def(['jq', 'gojq'], (args, st) => {
  const two = new Set(['--arg', '--argjson', '--slurpfile', '--rawfile']);
  const ONE = ['-f', '--from-file', '--indent', '-L'];
  const files: string[] = [];
  let filter: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--args' || a === '--jsonargs') break;
    if (two.has(a)) { const v = args[i + 2]; if ((a === '--slurpfile' || a === '--rawfile') && v !== undefined) read(st, [v]); i += 2; continue; }
    if (ONE.includes(a)) { const v = args[++i]; if ((a === '-f' || a === '--from-file') && v !== undefined) { read(st, [v]); filter = v; } continue; }
    if (a.startsWith('-') && a !== '-' && !a.includes('$')) continue; // jq's options only shape the output
    if (filter === null) filter = a; else files.push(a);
  }
  read(st, files);
  if (files.length) P(st, 'json', { paths: disp(st, files) }); else P(st, 'jsonPipe');
});
def(['yq'], (args, st) => {
  // `-s`/`--split-exp` writes one file per document, named by an expression: not modeled.
  if (args.some((a) => a === '-s' || a.startsWith('--split-exp') || a.startsWith('--split'))) { st.parsed = false; return; }
  const o = opts(st, args, { f: ['-i', '--inplace', '-e', '--exit-status', '-P', '--prettyPrint', '-C', '--colors', '-M', '--no-colors', '-n', '--null-input', '-N', '--no-doc', '-r', '--unwrapScalar', '-j', '--tojson', '-0', '--nul-output', '-v', '--verbose', '--front-matter'], v: ['-o', '--output-format', '-p', '--input-format', '--indent', '-I', '--from-file', '--expression'] });
  const files = o.operands.slice(vals(o, '--from-file').length ? 0 : 1);
  read(st, [...files, ...vals(o, '--from-file')]);
  if (has(o, '-i', '--inplace')) { write(st, files); P(st, 'editText', { paths: disp(st, files) }); return; }
  if (files.length) P(st, 'json', { paths: disp(st, files) }); else P(st, 'jsonPipe');
});

/** sed scripts we accept: `s/a/b/[gIip0-9]`, `y/abc/xyz/`, and an optional address with `p`, `d`, `q`, `Q`, `=`. Linear. */
export function sedScriptSafe(sc: string): boolean {
  explainWork.add(sc.length);
  const n = sc.length;
  let i = 0;
  const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
  const skipWs = () => { while (i < n && (sc[i] === ' ' || sc[i] === '\t')) i++; };
  const address = (): boolean => {
    if (sc[i] === '$') { i++; return true; }
    if (isDigit(sc[i])) { while (isDigit(sc[i])) i++; if (sc[i] === '~') { i++; while (isDigit(sc[i])) i++; } return true; }
    if (sc[i] === '/') {
      i++;
      while (i < n && sc[i] !== '/') { if (sc[i] === '\\') i++; if (sc[i] === '\n') return false; i++; }
      if (i >= n) return false;
      i++;
      if (sc[i] === 'I') i++;
    }
    return true;
  };
  while (i < n) {
    skipWs();
    while (sc[i] === ';' || sc[i] === '\n') { i++; skipWs(); }
    if (i >= n) break;
    if (!address()) return false;
    if (sc[i] === ',') { i++; if (!address()) return false; }
    skipWs();
    if (sc[i] === '!') { i++; skipWs(); }
    const cmd = sc[i++];
    if (cmd === 's' || cmd === 'y') {
      const d = sc[i++];
      if (d === undefined || d === '\\' || d === '\n' || d === ' ' || d === ';') return false;
      for (let part = 0; part < 2; part++) {
        while (i < n && sc[i] !== d) { if (sc[i] === '\\') i++; i++; }
        if (i >= n) return false;
        i++;
      }
      if (cmd === 's') while (i < n && 'gIip0123456789'.includes(sc[i]!)) i++;
    } else if (cmd === 'p' || cmd === 'd' || cmd === '=') {
      // nothing
    } else if (cmd === 'q' || cmd === 'Q') {
      skipWs();
      while (isDigit(sc[i])) i++;
    } else return false;
    skipWs();
    if (i < n && sc[i] !== ';' && sc[i] !== '\n') return false;
  }
  return true;
}
def(['sed', 'gsed'], (args, st) => {
  const scripts: string[] = [];
  const operands: string[] = [];
  const backups: string[] = [];
  let inPlace = false;
  const LONG_OK = ['--quiet', '--silent', '--regexp-extended', '--posix', '--null-data', '--separate', '--unbuffered', '--debug', '--sandbox', '--zero-terminated'];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') { operands.push(...args.slice(i + 1)); break; }
    if (a === '--expression') { scripts.push(args[++i] ?? ''); continue; }
    if (a.startsWith('--expression=')) { scripts.push(a.slice(13)); continue; }
    if (a.startsWith('--in-place')) { inPlace = true; const suf = a.slice(a.indexOf('=') + 1); if (a.includes('=') && suf.includes('/')) backups.push(suf.split('*').join('x')); continue; }
    if (a === '--line-length') { i++; continue; }
    if (a.startsWith('--')) { if (LONG_OK.includes(a)) continue; st.parsed = false; return; }
    if (a.startsWith('-') && a !== '-' && !a.includes('$')) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k]!;
        if ('nErusz'.includes(ch)) continue;
        if (ch === 'i' || ch === 'I') {
          inPlace = true;
          // GNU `-i.bak` (attached suffix); BSD `-i ''` / `-i .bak` (next word). A suffix with `/` is a backup path (`*` = file name).
          let suffix = a.slice(k + 1);
          if (k === a.length - 1) { const next = args[i + 1]; if (next !== undefined && (next === '' || (next.startsWith('.') && !next.includes('/')))) { suffix = next; i++; } }
          if (suffix.includes('/')) backups.push(suffix.split('*').join('x'));
          break;
        }
        if (ch === 'e') { const rest = a.slice(k + 1); scripts.push(rest !== '' ? rest : args[++i] ?? ''); break; }
        if (ch === 'l') { if (a.slice(k + 1) === '') i++; break; }
        st.parsed = false; return; // -f (script file) and anything unknown
      }
      continue;
    }
    operands.push(a);
  }
  if (scripts.length === 0 && operands.length) scripts.push(operands.shift()!);
  if (scripts.length === 0 || !scripts.every(sedScriptSafe)) { st.parsed = false; return; }
  if (inPlace) { write(st, [...operands, ...backups]); P(st, 'editText', { paths: disp(st, operands) }); return; }
  read(st, operands);
  if (operands.length) P(st, 'filter', { paths: disp(st, operands) }); else P(st, 'filterPipe');
});
def(['awk', 'gawk', 'mawk', 'nawk'], (args, st) => {
  const o = opts(st, args, { v: ['-F', '-v', '--assign', '--field-separator'], f: ['--posix', '--traditional', '-P', '--re-interval'] });
  if (args.some((a) => a === '-f' || a.startsWith('--file') || a === '-E' || a === '-i' || a === '--include' || a === '-l' || a === '--load')) { st.parsed = false; return; }
  const [program, ...rest] = o.operands;
  if (program === undefined) { st.parsed = false; return; }
  if (['system', 'getline', '|', '>', 'close(', 'fflush(', '@', 'ENVIRON'].some((x) => program.includes(x))) { st.parsed = false; return; }
  const files = rest.filter((f) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(f));
  read(st, files);
  if (files.length) P(st, 'filter', { paths: disp(st, files) }); else P(st, 'filterPipe');
});
const RG_SPEC: Spec = {
  f: ['-n', '-N', '-i', '-I', '-l', '-w', '-v', '-F', '-x', '-s', '-S', '-c', '-o', '-q', '-u', '-uu', '-uuu', '-U', '-P', '-L', '-H', '--line-number', '--no-line-number',
    '--ignore-case', '--smart-case', '--case-sensitive', '--files-with-matches', '--files-without-match', '--word-regexp', '--invert-match', '--fixed-strings',
    '--line-regexp', '--count', '--count-matches', '--only-matching', '--quiet', '--hidden', '--no-ignore', '--no-ignore-vcs', '--follow', '--files', '--json',
    '--no-heading', '--heading', '--vimgrep', '--stats', '--multiline', '--pcre2', '--null', '-0', '--no-filename', '--with-filename', '--type-list', '--trim',
    '--sort-files', '--column', '--no-messages', '--byte-offset', '-b', '--passthru', '--text', '-a', '--crlf', '--no-config'],
  v: ['-e', '--regexp', '-f', '--file', '-A', '-B', '-C', '-m', '--max-count', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '--color', '--colors',
    '-M', '--max-columns', '-j', '--threads', '--max-depth', '-d', '--sort', '--sortr', '-r', '--replace', '--max-filesize', '--context', '--after-context', '--before-context', '--type-add', '--ignore-file'],
};
const AG_SPEC: Spec = {
  f: ['-i', '-s', '-S', '-l', '-L', '-w', '-v', '-Q', '-c', '-o', '-u', '-U', '-a', '-t', '--hidden', '--nocolor', '--noheading', '--nogroup', '--column', '--literal', '--files-with-matches', '--count', '--vimgrep', '--follow', '--ignore-case', '--case-sensitive', '--silent', '--stats', '--numbers', '--nonumbers'],
  v: ['-G', '--file-search-regex', '-g', '-A', '-B', '-C', '-m', '--max-count', '--depth', '--ignore', '--ignore-dir', '--color-match'],
};
def(['grep', 'egrep', 'fgrep', 'ggrep', 'rg', 'ag'], (args, st, name) => {
  // pure reader: GNU/BSD grep has no option that writes or runs anything. rg and ag can (`--pre`, `--pager`): allow-lists.
  const o = opts(st, args, name === 'rg' ? RG_SPEC : name === 'ag' ? AG_SPEC : { any: true, v: ['-e', '--regexp', '-f', '--file', '-A', '-B', '-C', '-m', '--max-count', '--include', '--exclude', '--exclude-dir', '-d', '-D',
    '--context', '--after-context', '--before-context', '--label', '--binary-files', '-g', '--glob', '-t', '--type', '-T', '--type-not', '--colors', '-M', '--max-columns', '-j', '--threads', '--ignore-file', '--max-depth', '--sort', '--sortr', '-r', '--replace'].filter((x) => !(name !== 'rg' && x === '-r')) });
  const patterns = vals(o, '-e', '--regexp', '-f', '--file');
  read(st, [...vals(o, '-f', '--file', '--ignore-file')]);
  const files = patterns.length ? o.operands : o.operands.slice(1);
  const recursive = name === 'rg' || name === 'ag' || has(o, '-r', '-R', '--recursive');
  const targets = files.length ? files : recursive ? ['.'] : [];
  read(st, targets);
  if (targets.length) P(st, 'search', { paths: disp(st, targets) }); else P(st, 'searchPipe');
});
def(['sort'], (args, st) => {
  if (args.some((a) => a.startsWith('--compress-program'))) { st.parsed = false; return; }
  const o = opts(st, args, {
    f: ['-r', '-n', '-u', '-f', '-b', '-d', '-g', '-h', '-i', '-M', '-R', '-s', '-V', '-c', '-C', '-m', '-z', '--reverse', '--numeric-sort', '--unique',
      '--ignore-case', '--human-numeric-sort', '--version-sort', '--stable', '--check', '--merge', '--zero-terminated', '--ignore-leading-blanks',
      '--dictionary-order', '--general-numeric-sort', '--month-sort', '--random-sort', '--ignore-nonprinting', '--debug'],
    v: ['-o', '--output', '-k', '--key', '-t', '--field-separator', '-T', '--temporary-directory', '-S', '--buffer-size', '--parallel', '--files0-from', '--random-source', '--sort', '--batch-size'],
  });
  write(st, vals(o, '-o', '--output', '-T', '--temporary-directory'));
  read(st, [...o.operands, ...vals(o, '--files0-from', '--random-source')]);
  if (o.operands.length) P(st, 'filter', { paths: disp(st, o.operands) }); else P(st, 'filterPipe');
});
/** Text filters: none of their options write or run anything; only the value-taking ones differ per tool. */
const FILTER_VALUES: Record<string, string[]> = {
  uniq: ['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars'], cut: ['-d', '--delimiter', '-f', '--fields', '-c', '--characters', '-b', '--bytes', '--output-delimiter'],
  tr: [], nl: ['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w'], column: ['-s', '-c', '-o', '-N', '-W', '-t'], rev: [], paste: ['-d', '--delimiters'],
  fold: ['-w', '--width'], fmt: ['-w', '--width', '-p'], expand: ['-t', '--tabs'], unexpand: ['-t', '--tabs'], tac: ['-s', '--separator'], comm: [],
  join: ['-1', '-2', '-t', '-o', '-j', '-e', '-a', '-v'], iconv: ['-f', '-t', '-o', '--from-code', '--to-code', '--output'], col: ['-l'], colrm: [],
};
def(Object.keys(FILTER_VALUES), (args, st, name) => {
  // pure reader: text filters only transform stdin or their files; uniq's and iconv's output files are checked below.
  const o = opts(st, args, { any: true, v: FILTER_VALUES[name] });
  let files = name === 'tr' ? [] : o.operands;
  if (name === 'uniq' && files.length >= 2) { write(st, files.slice(1, 2)); files = files.slice(0, 1); }
  if (name === 'iconv') write(st, vals(o, '-o', '--output'));
  read(st, files);
  if (files.length) P(st, 'filter', { paths: disp(st, files) }); else P(st, 'filterPipe');
});
// pure reader: hashing, inspecting and comparing tools; none of their options writes or runs anything.
def(['stat', 'diff', 'cmp', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'readlink', 'realpath', 'od', 'hexdump',
  'strings', 'mdls', 'pdfinfo', 'otool'], (args, st) => {
  const o = opts(st, args, { any: true, v: ['-f', '--format', '-c', '-n', '-s', '-l', '-L', '-a', '-I', '-P', '--from-file', '--to-file', '-t', '-j', '-N', '-e'] });
  read(st, [...o.operands, ...vals(o, '--from-file', '--to-file')]);
  if (o.operands.length) P(st, 'readFiles', { paths: disp(st, o.operands) }); else P(st, 'filterPipe');
});
/** Readers that can also write (an output file) or are pagers: allow-lists. */
const READER_SPEC: Record<string, Spec & { out?: string[]; inp?: string[] }> = {
  xxd: { long1: true, out: [], f: ['-a', '-autoskip', '-b', '-bits', '-C', '-capitalize', '-E', '-EBCDIC', '-e', '-i', '-include', '-p', '-ps', '-postscript', '-plain', '-r', '-revert', '-u', '-uppercase', '-d', '-h', '-help', '-v', '-version'], v: ['-c', '-cols', '-g', '-groupsize', '-l', '-len', '-o', '-offset', '-s', '-seek', '-n', '-name', '-R'] },
  base64: { out: ['-o', '--output'], inp: ['-i', '--input'], f: ['-d', '-D', '--decode', '-h', '--help', '--ignore-garbage'], v: ['-b', '--break', '-i', '--input', '-o', '--output', '-w', '--wrap'] },
  tree: { out: ['-o'], f: ['-a', '-d', '-l', '-f', '-x', '-i', '-q', '-N', '-Q', '-p', '-u', '-g', '-s', '-h', '--du', '-D', '-F', '-v', '-t', '-c', '-U', '-r', '-C', '-n', '-A', '-S', '--dirsfirst', '--noreport', '--prune', '-J', '-X', '--gitignore', '--si'], v: ['-L', '-P', '-I', '-o', '--charset', '--filelimit', '--timefmt'] },
  less: { f: ['-N', '-S', '-R', '-r', '-F', '-X', '-i', '-I', '-n', '-M', '-m', '-e', '-E', '-K', '-c', '-s', '-f', '-q', '-Q', '-+F'], v: ['-x', '-z', '-p', '-j', '-b', '-h', '-y'] },
  more: { f: ['-N', '-S', '-R', '-r', '-F', '-X', '-i', '-I', '-n', '-M', '-m', '-e', '-E', '-c', '-s', '-f', '-d', '-l', '-u'], v: ['-x', '-z', '-p', '-n'] },
  mediainfo: { inp: [], f: ['--Full', '-f', '--Help', '--Version'], v: ['--Output', '--Language', '--Inform'] },
};
def(Object.keys(READER_SPEC), (args, st, name) => {
  const spec = READER_SPEC[name]!;
  const o = opts(st, args, spec);
  if (name === 'xxd') write(st, o.operands.slice(1, 2));
  write(st, vals(o, ...(spec.out ?? [])));
  for (const v of vals(o, '--Output', '--Inform')) if (v.startsWith('file://')) codeFrom(st, v.slice(7));
  const files = name === 'xxd' ? o.operands.slice(0, 1) : [...o.operands, ...vals(o, ...(spec.inp ?? []))];
  const targets = files.length ? files : name === 'tree' ? ['.'] : [];
  read(st, targets);
  if (targets.length) P(st, 'readFiles', { paths: disp(st, targets) }); else P(st, 'filterPipe');
});
def(['tee'], (args, st) => {
  const o = opts(st, args, { f: ['-a', '-i', '-p', '--append', '--ignore-interrupts', '--output-error'] });
  write(st, o.operands);
  P(st, 'writeFile', { paths: disp(st, o.operands) });
});
const XARGS_INTERPRETERS = ['python', 'node', 'perl', 'ruby', 'php', 'bun', 'deno', 'osascript', 'lua', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pypy', 'tclsh', 'Rscript'];
def(['xargs'], (args, st) => {
  const VALUE = ['-n', '-L', '-P', '-s', '-d', '-E', '-e', '-I', '-J', '-R', '-S', '-a', '--arg-file', '--max-args', '--max-procs', '--delimiter', '--replace', '--max-chars', '--eof', '--max-lines'];
  const NOVAL = ['-0', '-r', '-t', '-p', '-x', '-o', '--null', '--no-run-if-empty', '--verbose', '--interactive', '--exit', '--open-tty'];
  let replace: string | null = null;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') { i++; break; }
    if (!a.startsWith('-')) break;
    if (VALUE.includes(a)) { const v = args[++i]; if (a === '-I' || a === '-J' || a === '--replace') replace = v ?? '{}'; if (a === '-a' || a === '--arg-file') read(st, [v ?? '']); continue; }
    if (a.startsWith('-I') && a.length > 2) { replace = a.slice(2); continue; }
    if (a === '-i') { replace = '{}'; continue; }
    if (a.startsWith('-n') || a.startsWith('-P') || a.startsWith('-L')) continue;
    if (!NOVAL.includes(a)) unknownOpt(st, a);
  }
  const inner = args.slice(i);
  if (inner.length === 0) { P(st, 'xargs', { cmd: 'echo' }); return; }
  if (isOpaqueCommand(inner)) { st.parsed = false; return; }
  const token = replace !== null && replace !== '' && inner.some((w) => w.includes(replace!)) ? replace : PLACEHOLDER_INPUT;
  subExplain(token === PLACEHOLDER_INPUT ? [...inner, PLACEHOLDER_INPUT] : inner, st, { token, locs: [UNKNOWN_LOC('…')] });
  // `curl … | xargs -0 python3 -c`: downloaded text handed to an interpreter as its code or arguments.
  const prog = (commandFromArgv(inner)?.argv[0] ?? inner[0]!).replace(/^.*\//, '');
  if (st.pipedIn && st.pipeNet && XARGS_INTERPRETERS.some((x) => prog === x || prog.startsWith(`${x}3`) || prog.startsWith(`${x}.`) || prog.startsWith(`${x}-`))) add(st, 'runs-code', 'high');
  P(st, 'xargs', { cmd: inner[0]! });
});
/** File types `open` hands to a viewer; anything else may be an app, a script or an installer. */
const OPEN_SAFE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'mov', 'm4v', 'webm', 'mp3', 'wav', 'aac', 'm4a', 'pdf', 'txt', 'md', 'json', 'csv', 'heic', 'tif', 'tiff', 'avif', 'bmp', 'ogg', 'flac', 'mkv', 'gif', 'ico', 'psd', 'ai', 'eps', 'log'];
def(['open'], (args, st) => {
  const argsAt = args.indexOf('--args');
  const own = argsAt >= 0 ? args.slice(0, argsAt) : args;
  const o = opts(st, own, { f: ['-e', '-t', '-f', '-F', '-W', '-R', '-n', '-g', '-j', '-h', '--fresh', '--new', '--wait-apps', '--background', '--hide', '--reveal', '--header'], v: ['-a', '-b', '-s', '-u', '--env', '--stdin', '--stdout', '--stderr'] });
  const urls = [...o.operands.filter(isUrl), ...vals(o, '-u')];
  const files = o.operands.filter((x) => !isUrl(x));
  if (urls.length) add(st, 'uses-network', 'medium', { host: hostOf(urls[0]!) });
  read(st, files);
  const safeFile = (f: string) => {
    if (f.endsWith('/') || f === '.' || f === '..') return true;
    const ext = f.slice(f.lastIndexOf('.') + 1).toLowerCase();
    return f.lastIndexOf('.') > f.lastIndexOf('/') && OPEN_SAFE_EXT.includes(ext);
  };
  const fresh = files.some((f) => locsOf(st, f).some((l) => l.abs !== null && wasWritten(st, l.abs)));
  if (vals(o, '-a', '-b').length || files.some((f) => !safeFile(f)) || fresh) add(st, 'runs-code', 'medium');
  if (files.length) P(st, 'open', { paths: disp(st, files) });
  else if (urls.length) P(st, 'openUrl', { host: hostOf(urls[0]!) });
  else P(st, 'open', { paths: fmtList(vals(o, '-a', '-b')) });
});
def(['which', 'whereis', 'type', 'command'], (args, st) => P(st, 'which', { cmd: fmtList(args.filter((a) => !a.startsWith('-'))) }));
def(['pwd'], (args, st) => { opts(st, args, { f: ['-L', '-P'] }); P(st, 'pwd'); });
def(['whoami', 'uname', 'id', 'sw_vers', 'nproc', 'uptime', 'df', 'locale', 'system_profiler', 'ps', 'top', 'lsof', 'groups', 'tty', 'cal', 'vm_stat', 'xcrun', 'jobs'], (_args, st) => P(st, 'sysInfo'));
// pure reader: `arch` without a command only prints the architecture (with one, the tokenizer unwraps it).
def(['arch'], (args, st) => { opts(st, args, { any: true }); P(st, 'sysInfo'); });
def(['caffeinate'], (args, st) => { opts(st, args, { f: ['-d', '-i', '-m', '-s', '-u'], v: ['-t', '-w'] }); P(st, 'noop'); });
/** Commands that read system state, or change it with a flag or an operand: a change is a write outside the project. */
def(['date'], (args, st) => {
  const o = opts(st, args, { f: ['-u', '-j', '-n', '-R', '--utc', '--universal', '--rfc-email', '-I', '--iso-8601', '--rfc-3339', '--debug'], v: ['-r', '-v', '-f', '-d', '--date', '--reference', '-s', '--set', '-z'] });
  read(st, vals(o, '--reference'));
  const sets = vals(o, '-s', '--set').length > 0 || (!has(o, '-j') && o.operands.some((x) => !x.startsWith('+')));
  if (sets) add(st, 'writes-outside-project', 'high');
  P(st, sets ? 'changesSystem' : 'sysInfo');
});
def(['hostname'], (args, st) => {
  const o = opts(st, args, { f: ['-s', '-f', '-d', '-i', '-I', '-a', '-A', '--short', '--fqdn', '--domain', '--ip-address', '--all-ip-addresses'], v: ['-F', '--file'] });
  const sets = o.operands.length > 0 || vals(o, '-F', '--file').length > 0;
  if (sets) add(st, 'writes-outside-project', 'high');
  P(st, sets ? 'changesSystem' : 'sysInfo');
});
def(['sysctl'], (args, st) => {
  const o = opts(st, args, { f: ['-a', '-n', '-b', '-e', '-h', '-N', '-o', '-x', '-q', '-d', '-w'], v: ['-f'] });
  const sets = has(o, '-w') || o.operands.some((x) => x.includes('='));
  if (sets) add(st, 'writes-outside-project', 'high');
  P(st, sets ? 'changesSystem' : 'sysInfo');
});
/** Persistence and system configuration: scheduled jobs, preferences, launch agents. */
def(['crontab'], (args, st) => {
  if (args.length === 1 && args[0] === '-l') { P(st, 'sysInfo'); return; }
  add(st, 'writes-outside-project', 'high');
  P(st, 'changesSystem');
});
def(['defaults'], (args, st) => {
  const sub = args.find((a) => !a.startsWith('-'));
  if (sub === 'read' || sub === 'read-type' || sub === 'domains' || sub === 'find' || sub === 'help') { P(st, 'sysInfo'); return; }
  add(st, 'writes-outside-project', 'high');
  P(st, 'changesSystem');
});
def(['launchctl'], (args, st) => {
  const sub = args[0];
  if (sub === 'list' || sub === 'print' || sub === 'version' || sub === 'help' || sub === 'getenv' || sub === 'blame' || sub === 'print-cache' || sub === 'managerpid' || sub === 'manageruid') { P(st, 'sysInfo'); return; }
  add(st, 'writes-outside-project', 'high');
  add(st, 'runs-code', 'high');
  P(st, 'changesSystem');
});
def(['hash'], (args, st) => {
  // `hash -p /path name` makes later commands named `name` run another program.
  if (args.some((a) => a.startsWith('-') && a.includes('p'))) { add(st, 'runs-code', 'high'); P(st, 'shellOption'); return; }
  P(st, 'noop');
});
def(['enable'], (args, st) => {
  // `enable -f lib.so name` loads a builtin from a shared library; `enable -n` unmasks programs named like builtins.
  if (args.some((a) => a.startsWith('-') && a.includes('f'))) { add(st, 'runs-code', 'high'); P(st, 'shellOption'); return; }
  add(st, 'unknown-command', 'medium');
  P(st, 'shellOption');
});
def(['printenv'], (_args, st) => P(st, 'printEnv'));
def(['true', 'false', ':', 'exit', 'wait', 'return', 'shift', 'break', 'continue'], (_args, st) => P(st, 'noop'));
def(['set'], (_args, st) => P(st, 'shellOption'));
def(['shopt'], (_args, st) => { st.parsed = false; });
def(['test', '['], (args, st) => {
  // `test -v 'a[$(cmd)]'` evaluates the subscript.
  if (args.some((a) => a.includes('['))) { st.parsed = false; return; }
  // The operands of `-eq`…`-ge` are numbers, not paths (`[ $# -eq 0 ]`).
  const NUM_OPS = ['-eq', '-ne', '-lt', '-le', '-gt', '-ge'];
  read(st, args.filter((a, k) => pathLike(a) && a !== ']' && !NUM_OPS.includes(args[k - 1] ?? '') && !NUM_OPS.includes(args[k + 1] ?? '')));
  P(st, 'check');
});
def(['export', 'unset', 'readonly', 'declare', 'typeset', 'local', 'read'], (args, st, name) => {
  const names: string[] = [];
  for (const a of args) {
    // `declare 'a[$(cmd)]=1'` evaluates the subscript, even from single quotes.
    if (a.includes('[') || a.includes('`') || a.includes('$(')) { st.parsed = false; return; }
    if (a.startsWith('-')) {
      if (name === 'read') continue;
      if (a.includes('f') || a.includes('n')) { st.parsed = false; return; }
      continue;
    }
    const eq = a.indexOf('=');
    const n = eq >= 0 ? a.slice(0, eq) : a;
    if (envRisky(st, n, eq >= 0 ? a.slice(eq + 1) : '')) { st.parsed = false; return; }
    names.push(n);
  }
  P(st, 'setVar', { name: fmtList(names) });
});
/** Interpreters whose options mostly cluster: an option letter that takes inline code makes it inline code. */
const INTERP: Record<string, { code: string; value: string; rest: string; digits: string; noval: string }> = {
  // code: letters taking the code (attached or next); value: letters taking the next word (or attached);
  // rest: letters consuming the rest of the cluster; digits: letters followed by optional digits only (`-l`, `-0777`).
  perl: { code: 'eE', value: 'I', rest: 'Mmixd', digits: 'l0C', noval: 'nNpaswWXSTtUcvhD' },
  ruby: { code: 'e', value: 'IrCFE', rest: 'iWxK', digits: '0', noval: 'npalwvdscyhUT' },
  php: { code: 'rBRE', value: 'fdctzS', rest: '', digits: '', noval: 'nlsiamvhHqeaw' },
};
def(['perl', 'ruby', 'php'], (args, st, name) => {
  const spec = INTERP[name]!;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') { const s = args[i + 1]; if (s === undefined) { runsInput(st, 'shell'); return; } script(st, s); scriptArgs(st, args.slice(i + 2)); P(st, 'runScript', { script: disp(st, [s]) }); return; }
    if (a === '-') { runsInput(st, 'shell'); return; }
    if (a.startsWith('--')) { unknownOpt(st, a); continue; }
    if (a.startsWith('-') && !a.includes('$')) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k]!;
        const attached = a.slice(k + 1);
        if (spec.code.includes(ch)) {
          const code = attached !== '' ? attached : args[++i];
          if (code === undefined) { st.parsed = false; return; }
          inlineCode(st, code);
          // perl/ruby -n/-p with -i rewrite the files given after the code.
          if (a.includes('i') || args.some((x) => x.startsWith('-') && !x.startsWith('--') && x.includes('i') && (name !== 'php'))) write(st, args.slice(i + 1).filter((x) => !x.startsWith('-')));
          P(st, 'inlineCode', { lang: name });
          return;
        }
        if (spec.value.includes(ch)) {
          const v = attached !== '' ? attached : args[++i];
          if (name === 'php' && ch === 'f' && v !== undefined) { script(st, v); scriptArgs(st, args.slice(i + 1)); P(st, 'runScript', { script: disp(st, [v]) }); return; }
          if (name === 'php' && ch === 'S') { add(st, 'uses-network', 'medium'); add(st, 'runs-code', 'medium'); }
          if (v !== undefined) {
            // Folders and files code or settings are loaded from: outside the project, that's code we can't see.
            if (ch === 'I' || (ch === 'r' && name === 'ruby' && pathLike(v)) || (name === 'php' && (ch === 'z' || ch === 'c'))) codeFrom(st, v);
            if (name === 'ruby' && ch === 'C') read(st, [v]);
            if (name === 'php' && ch === 'd') {
              const key = v.slice(0, Math.max(0, v.indexOf('='))).trim().toLowerCase();
              const val = v.slice(v.indexOf('=') + 1);
              if (['auto_prepend_file', 'auto_append_file', 'extension', 'zend_extension', 'include_path', 'extension_dir', 'open_basedir', 'error_log', 'sendmail_path'].includes(key)) {
                add(st, 'runs-code', 'medium', { option: `-d ${key}` });
                if (val && key !== 'sendmail_path') codeFrom(st, val);
              }
            }
          }
          break;
        }
        if (spec.rest.includes(ch)) {
          // `-Mlib=/a,/b` (perl) adds module folders, like -I.
          if (name === 'perl' && (ch === 'M' || ch === 'm') && attached.startsWith('lib=')) for (const d of attached.slice(4).split(',')) if (d) codeFrom(st, d);
          break;
        }
        if (spec.digits.includes(ch)) { while (k + 1 < a.length && a[k + 1]! >= '0' && a[k + 1]! <= '9') k++; continue; }
        if (!spec.noval.includes(ch)) unknownOpt(st, `-${ch}`);
      }
      continue;
    }
    if (isStdinPath(a)) { runsInput(st, 'shell'); return; }
    script(st, a);
    scriptArgs(st, args.slice(i + 1));
    P(st, 'runScript', { script: disp(st, [a]) });
    return;
  }
  runsInput(st, 'shell');
});
def(['osascript'], (args, st) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-e') { const code = args[++i]; if (code === undefined) { st.parsed = false; return; } inlineCode(st, code); P(st, 'inlineCode', { lang: 'AppleScript' }); return; }
    if (a === '-l' || a === '-s') { i++; continue; }
    if (a === '-i') continue;
    if (a === '-') { runsInput(st, 'shell'); return; }
    if (a.startsWith('-') && !a.includes('$')) { if (a.includes('e')) { st.parsed = false; return; } unknownOpt(st, a); continue; }
    if (isStdinPath(a)) { runsInput(st, 'shell'); return; }
    script(st, a);
    scriptArgs(st, args.slice(i + 1));
    P(st, 'runScript', { script: disp(st, [a]) });
    return;
  }
  runsInput(st, 'shell');
});
def(['lua', 'Rscript', 'tclsh', 'deno'], (args, st, name) => {
  const INLINE = ['-e', '-E', '--eval'];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (INLINE.includes(a) || (name === 'deno' && a === 'eval')) {
      const v = args[++i];
      if (v === undefined) { st.parsed = false; return; }
      inlineCode(st, v);
      P(st, 'inlineCode', { lang: name });
      return;
    }
    if (a === '-') { runsInput(st, 'shell'); return; }
    if (name === 'deno' && a === 'run') continue;
    if (a.startsWith('-') && !a.includes('$')) { unknownOpt(st, a); continue; }
    if (isUrl(a)) {
      add(st, 'uses-network', 'medium', { host: hostOf(a) });
      add(st, 'runs-code', 'medium');
      scriptArgs(st, args.slice(i + 1));
      P(st, 'runScript', { script: hostOf(a) });
      return;
    }
    if (isStdinPath(a)) { runsInput(st, 'shell'); return; }
    script(st, a);
    scriptArgs(st, args.slice(i + 1));
    P(st, 'runScript', { script: disp(st, [a]) });
    return;
  }
  runsInput(st, 'shell');
});
def(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'], (args, st) => {
  // `-c` is rejected by the tokenizer; here: a script file, or commands from stdin.
  // The shell's options come before the script; the rest belongs to the script.
  let at = 0;
  while (at < args.length && (args[at]!.startsWith('-') || args[at]!.startsWith('+')) && args[at] !== '-' && args[at] !== '--') at += ['-o', '+o', '-O', '+O'].includes(args[at]!) ? 2 : 1;
  const o = opts(st, args.slice(0, at), { f: ['-e', '-u', '-x', '-v', '-n', '-l', '--login', '-i', '-s', '--norc', '--noprofile', '--posix', '-r', '--restricted', '-eu', '-ex', '-eux', '-euo', '--verbose'], v: ['-o', '+o', '-O', '+O'] });
  o.operands.push(...args.slice(args[at] === '--' ? at + 1 : at));
  const first = o.operands[0];
  const firstPath = first === undefined ? '' : normalizeCommandPath(first);
  if (has(o, '-s') || first === undefined || first === '-' || isStdinPath(firstPath)) { runsInput(st, 'shell'); return; }
  const rest = o.operands.slice(1);
  script(st, first);
  scriptArgs(st, rest);
  P(st, 'runScript', { script: disp(st, [first]) });
});

/**
 * Options that run a program, load a config or write somewhere we can't see → parsed false. Long options are also matched
 * by unambiguous prefix (git parse-options, GNU getopt_long and npm's nopt accept `--upload-p`, `--to-comm`, `--script-sh`):
 * a word of 3+ characters that is a strict prefix of one of them counts, unless it is itself an option the tool's allow-list
 * names exactly (`git diff --text` is not `--textconv`). Checking stops at `--`.
 */
const NPM_DANGER = ['--script-shell', '--node-options', '--userconfig', '--globalconfig', '--init-module', '--shell', '--editor', '--browser', '--git',
  '--onload-script', '--npmrc', '--call', '--sign-git-commit', '--sign-git-tag', '--viewer', '--node-gyp', '--prefix-dir'];
const DANGER_OPTS: Record<string, { opts: string[]; ok?: () => readonly string[] }> = {
  git: { opts: ['--config', '--config-env', '--exec', '--upload-pack', '--receive-pack', '--template', '--ext-diff', '--open-files-in-pager', '--git-dir',
    '--work-tree', '--exec-path', '--namespace', '--super-prefix', '--separate-git-dir', '--textconv', '--extcmd', '--tool', '--gui'], ok: () => GIT_OK },
  tar: { opts: TAR_DANGER, ok: () => TAR_LONG_OK }, bsdtar: { opts: TAR_DANGER, ok: () => TAR_LONG_OK }, gtar: { opts: TAR_DANGER, ok: () => TAR_LONG_OK },
  sort: { opts: ['--compress-program'] },
  rsync: { opts: ['-e', '--rsh', '--rsync-path', '--config', '--daemon'] },
  ssh: { opts: ['-o', '-F', '-S', '-J', '-L', '-R', '-D', '-w'] }, scp: { opts: ['-o', '-F', '-S', '-J'] }, sftp: { opts: ['-o', '-F', '-S', '-J', '-b'] },
  npm: { opts: NPM_DANGER, ok: () => NPM_SPEC.f!.concat(NPM_SPEC.v!) }, pnpm: { opts: NPM_DANGER, ok: () => NPM_SPEC.f!.concat(NPM_SPEC.v!) },
  yarn: { opts: NPM_DANGER, ok: () => NPM_SPEC.f!.concat(NPM_SPEC.v!) }, npx: { opts: NPM_DANGER }, pnpx: { opts: NPM_DANGER }, bunx: { opts: NPM_DANGER },
  curl: { opts: ['--config', '-K'] }, wget: { opts: ['--execute', '--config', '-e'] },
  rg: { opts: ['--pre', '--pre-glob', '--hostname-bin', '--search-zip', '-z'] }, ag: { opts: ['--pager', '--search-zip', '-z'] },
  zip: { opts: ['--unzip-command', '-TT'] }, less: { opts: ['-o', '-O', '--log-file', '--LOG-FILE', '--lesskey-file'] },
  mediainfo: { opts: ['--LogFile', '--logfile'] },
};
function hasDangerOption(name: string, args: readonly string[]): boolean {
  const d = DANGER_OPTS[name];
  if (!d) return false;
  const ok = d.ok ? new Set(d.ok()) : null;
  for (const a of args) {
    if (a === '--') return false;
    if (!a.startsWith('-')) continue;
    const opt = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (d.opts.includes(opt)) return true;
    // npm/pnpm/yarn: `--config.<key>=…` and `--npm_config_<key>` set any config key, including the script shell.
    if (d.opts === NPM_DANGER && (opt.startsWith('--config.') || opt.toLowerCase().startsWith('--npm_config'))) return true;
    if (opt.startsWith('--') && opt.length >= 3 && !(ok?.has(opt)) && d.opts.some((x) => x.startsWith('--') && x !== opt && x.startsWith(opt))) return true;
  }
  return false;
}

/** Commands outside the dictionary: "Runs <cmd>", medium, and any outside path among the arguments may be written. */
function unknown(args: readonly string[], st: State, name: string): void {
  add(st, 'unknown-command', 'medium');
  scriptArgs(st, args);
  P(st, 'runs', { cmd: name });
}

const PY_OR_PIP = (b: string) => /^(python|pip)(\d+(\.\d+)?)?$/.test(b);

/** Explains one simple command's argv (wrappers and env already stripped by the tokenizer). */
export function explainArgv(argv: readonly string[], st: State): void {
  const raw = argv[0];
  if (raw === undefined) return;
  // A command name from a variable, a glob or a brace list (`$X`, `r?`, `{rm,-rf,~}`) can be anything.
  if (raw.includes('$') || raw.includes('*') || raw.includes('?') || (raw.includes('[') && raw !== '[') || (raw.includes('{') && raw.includes(','))) { st.parsed = false; return; }
  let name = raw;
  const args = argv.slice(1);
  if (raw.includes('/')) {
    const sys = systemCommandName(raw);
    const slash = raw.lastIndexOf('/');
    const base = raw.slice(slash + 1);
    const loc = locsOf(st, raw)[0];
    const inProject = loc !== undefined && (loc.cls === 'work' || loc.cls === 'project');
    const fresh = loc !== undefined && loc.abs !== null && wasWritten(st, loc.abs);
    if (sys !== null) name = sys;
    else if (inProject && PY_OR_PIP(base) && raw.slice(0, slash).endsWith('/bin')) {
      name = base;
      if (fresh) add(st, 'runs-code', 'medium', { path: displayLoc(loc, st.ctx) });
    } else {
      // Running a file directly: anything could be in it.
      add(st, 'runs-code', 'medium');
      read(st, [raw]);
      scriptArgs(st, args);
      P(st, 'runScript', { script: disp(st, [raw]) });
      return;
    }
  }
  if (/^python\d+(\.\d+)?$/.test(name)) name = 'python3';
  else if (/^pip\d+(\.\d+)?$/.test(name)) name = 'pip';
  if (hasDangerOption(name, args) || hasDangerOption(name.toLowerCase(), args)) { st.parsed = false; return; }
  const h = H.get(name);
  if (h) { h(args, st, name); return; }
  // A case variant of a known command (`RM` on a case-insensitive disk runs rm): its indicators, an unknown-command phrase.
  const lower = name.toLowerCase();
  const hl = lower !== name ? H.get(lower) : undefined;
  if (hl) {
    const phrases = st.phrases;
    st.phrases = [];
    hl(args, st, lower);
    st.phrases = phrases;
    add(st, 'unknown-command', 'medium');
    P(st, 'runs', { cmd: name });
    return;
  }
  unknown(args, st, name);
}

/** Explains a command run by another one (`find -exec`, `xargs`): only its indicators count. */
function subExplain(argv: readonly string[], st: State, found: State['found']): void {
  const phrases = st.phrases;
  const cwd = st.cwd;
  const prevFound = st.found;
  const prevCd = st.cdTarget;
  st.phrases = [];
  st.found = found;
  // The same assignments and wrappers as at the top level (`find … -exec sudo rm {} +`, `xargs env X=1 nice rm`).
  const c = commandFromArgv(argv);
  if (c === null) st.parsed = false;
  else {
    for (const [k, v] of Object.entries(c.env)) if (envRisky(st, k, v)) st.parsed = false;
    if (c.wrappers.includes('sudo') || c.wrappers.includes('doas')) add(st, 'elevated', 'high');
    if (st.parsed) explainArgv(c.argv, st);
  }
  st.phrases = phrases;
  st.cwd = cwd;
  st.found = prevFound;
  st.cdTarget = prevCd;
}

/** Explains a whole simple command: wrappers, env, redirects and the command itself. Exactly one phrase is added. */
export function explainSimple(c: SimpleCommand, st: State): void {
  for (const [k, v] of Object.entries(c.env)) {
    if (envRisky(st, k, v)) { st.parsed = false; return; }
    if (CODE_PATH_ENV.includes(k)) {
      for (const part of v.split(':')) {
        if (part === '') continue;
        if (locsOf(st, part).some((l) => l.cls !== 'work' && l.cls !== 'project')) add(st, 'runs-code', 'medium', { path: part });
      }
    }
  }
  if (c.wrappers.includes('sudo') || c.wrappers.includes('doas')) add(st, 'elevated', 'high');
  st.stdout = null;
  st.stdinFile = null;
  for (const r of c.redirects) {
    if (r.op === '<') { read(st, [r.target]); st.stdinFile ??= disp(st, [r.target]); continue; }
    write(st, [r.target]);
    if (r.op !== '2>' && st.stdout === null && !isHarmlessDevice(locsOf(st, r.target)[0]?.abs ?? null)) st.stdout = disp(st, [r.target]);
  }
  const before = st.phrases.length;
  if (c.argv.length === 0) {
    const names = Object.keys(c.env);
    if (c.wrappers.includes('env')) P(st, 'printEnv');
    else if (names.length) P(st, 'setVar', { name: fmtList(names) });
    else if (c.wrappers.includes('time') || c.wrappers.includes('nohup')) P(st, 'noop');
    else P(st, 'writeFile', { paths: st.stdout ?? '…' });
  } else explainArgv(c.argv, st);
  if (!st.parsed) return;
  // Every simple command contributes exactly one phrase.
  if (st.phrases.length === before) P(st, 'runs', { cmd: c.argv[0] ?? '…' });
  else if (st.phrases.length > before + 1) st.phrases.splice(before + 1);
}

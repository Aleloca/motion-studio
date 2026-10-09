// Per-command explanations. Each handler adds exactly one phrase and the indicators the command deserves.
// When a handler meets something it can't model it sets `st.parsed = false`: the caller then shows the generic phrase.
//
// RULE: default-deny argument shapes.
// - Every entry lists the option shapes it understands (an allow-list, `Spec`). An option that is not listed adds
//   `unknown-command` (medium) with `{ option }`, so an unmodelled flag can never leave a command at "low".
// - An unmodelled subcommand is `unknown-command` (medium) too.
// - Options known to run code or write somewhere we can't see (`git -c`, `--upload-pack`, `sed …/e`, `tar --to-command`,
//   `curl -K`, `rg --pre`, …) give `parsed: false` (the generic "complex" phrase) or a high indicator.
// - `any: true` is used only for read-only tools whose whole option set has no write or exec effect (ls, cat, wc, grep…).
// - The common, everyday shapes (ffmpeg encodes, pip/npm installs, sips, cwebp, mkdir/cp/mv) are modelled in full,
//   and the "common commands" group of the table test pins their exact result.
import type { IndicatorId, Phrase, Risk } from './types.ts';
import type { Indicators } from './indicators.ts';
import { isOpaqueCommand, systemCommandName, type SimpleCommand } from './tokenize.ts';
import { dirnameAbs, displayLoc, isHarmlessDevice, resolveLocs, type ExplainContext, type Loc } from './paths.ts';
import { explainWork } from './work.ts';

export interface State {
  ctx: ExplainContext;
  cwd: string | null;
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
  /** Set by `cd`/`pushd`: where the next command runs if the `cd` succeeded (null: unknown). */
  cdTarget?: string | null;
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
function locsOf(st: State, word: string, cwd: string | null = st.cwd): Loc[] {
  if (st.found && st.found.token !== '' && word.includes(st.found.token)) return st.found.locs;
  return resolveLocs(word, cwd, st.ctx);
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
/** Arguments given to a script: a path outside the project may be written by it. */
function scriptArgs(st: State, args: readonly string[]): void {
  for (const a of args) {
    // `--out=/x` and `of=/dev/disk2` carry a path after `=`.
    const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : a;
    if (pathLike(v)) write(st, [v]); else if (pathLike(a) && !a.startsWith('-')) write(st, [a]);
  }
}
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
const SPAWN_TOKENS = ['do shell script', 'doShellScript', 'system(', 'system ', 'exec ', 'os.system', 'subprocess', 'os.popen', 'os.exec', 'os.spawn', 'pty.spawn', 'child_process', 'execSync', 'spawn(', 'exec(', 'eval(', '__import__', 'execFile', 'process.binding', 'shell_exec', 'passthru', 'popen', 'proc_open', 'Bun.spawn', 'Deno.run', 'Deno.Command', '`'];
const NET_TOKENS = ['urllib', 'requests', 'http.client', 'httpx', 'socket', 'fetch(', 'http.get', 'https.get', 'http.request', 'https.request', 'net.connect', 'ftplib', 'smtplib', 'Net::', 'LWP', 'curl_', 'file_get_contents(\'http', 'open-uri'];
/** Inline code (`python3 -c`, `node -e`, `perl -e`…) can do anything: medium at least, more when it visibly deletes, spawns or connects. */
function inlineCode(st: State, code: string): void {
  explainWork.add(code.length * 4);
  add(st, 'runs-code', SPAWN_TOKENS.some((t) => code.includes(t)) ? 'high' : 'medium');
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
  if (target === undefined) { st.cdTarget = st.ctx.home; P(st, 'cd', { path: '~' }); return; }
  if (target === '-') { st.cdTarget = null; P(st, 'cd', { path: '-' }); return; }
  const ls = locsOf(st, target);
  P(st, 'cd', { path: disp(st, [target]) });
  st.cdTarget = ls.length === 1 && ls[0]!.abs !== null && !ls[0]!.abs.includes('*') && !ls[0]!.abs.includes('?') ? ls[0]!.abs : null;
});
def(['popd'], (_args, st) => { st.cdTarget = null; P(st, 'cd', { path: '…' }); });
def(['ls'], (args, st) => {
  const o = opts(st, args, { any: true, v: ['-I', '--ignore', '-w', '--width', '-T', '--tabsize', '--format', '--sort', '--time-style', '-D', '--hide', '--block-size'] });
  const targets = o.operands.length ? o.operands : ['.'];
  read(st, targets);
  P(st, 'list', { paths: disp(st, targets) });
});
def(['cat'], (args, st) => {
  const o = opts(st, args, { any: true });
  const files = o.operands.filter((x) => x !== '-');
  read(st, files);
  if (files.length) P(st, 'show', { paths: disp(st, files) }); else P(st, 'filterPipe');
});
def(['head', 'tail'], (args, st, name) => {
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
  srm: { any: true },
  trash: { any: true },
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
  const o = opts(st, args, { any: true, v: ['--reference', '-w', '-d', '-p'] });
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
  const LONG_OK = ['--create', '--append', '--update', '--extract', '--get', '--list', '--absolute-names', '--file', '--directory', '--gzip', '--gunzip',
    '--bzip2', '--xz', '--zstd', '--lzma', '--auto-compress', '--verbose', '--exclude', '--strip-components', '--keep-old-files', '--no-same-owner',
    '--no-same-permissions', '--to-stdout', '--totals', '--wildcards', '--exclude-vcs', '--remove-files', '--overwrite', '--skip-old-files',
    '--preserve-permissions', '--same-owner', '--numeric-owner', '--owner', '--group', '--mode', '--mtime', '--sort', '--format', '--transform',
    '--exclude-from', '--files-from', '--null', '--no-recursion', '--one-file-system', '--dereference', '--hard-dereference', '--quiet', '--warning'];
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
  '-tag', '-max_muxing_queue_size', '-sample_fmt', '-channel_layout', '-ch_layout', '-minrate', '-maxrate', '-bufsize', '-pattern_type',
  '-itsoffset', '-sseof', '-fs', '-color_primaries', '-color_trc', '-colorspace', '-color_range', '-disposition', '-safe', '-probesize',
  '-analyzeduration', '-video_size', '-pixel_format', '-cq', '-qp', '-rc', '-deadline', '-cpu-used', '-row-mt', '-tile-columns',
  '-lag-in-frames', '-auto-alt-ref', '-quality', '-speed', '-compression_level', '-pred', '-lossless', '-sws_flags', '-vtag', '-atag',
  '-b_strategy', '-refs', '-keyint_min', '-sc_threshold', '-apad', '-async', '-frame_size', '-id3v2_version', '-write_id3v1', '-brand',
  '-timecode', '-max_interleave_delta', '-avoid_negative_ts', '-fflags', '-flags', '-strict', '-thread_queue_size', '-filter_threads',
  '-filter_complex_threads', '-hwaccel', '-hwaccel_output_format', '-hwaccel_device', '-init_hw_device', '-stats_period', '-x', '-y_pos',
  '-alpha_quality', '-pass', '-plays', '-final_delay', '-gifflags', '-dpi', '-update', '-frame_pts', '-strftime', '-qmin', '-qmax',
  '-allowed_extensions', '-vbr', '-application', '-cutoff', '-loop_output', '-intra_refresh', '-bsf', '-vbsf', '-absf', '-af_threads', '-bits_per_raw_sample',
]);
const FFMPEG_READ_VALUE = new Set(['-filter_complex_script', '-filter_script', '-attach', '-i_qfactor']);
const FFMPEG_WRITE_VALUE = new Set(['-vstats_file', '-passlogfile', '-dump_attachment', '-progress', '-sdp_file']);
const FFPROBE_VALUE = new Set(['-v', '-loglevel', '-print_format', '-of', '-output_format', '-select_streams', '-show_entries', '-read_intervals', '-i', '-o', '-f', '-analyzeduration', '-probesize', '-show_optional_fields', '-threads', '-sections']);
/** Filters that read or load something from a path (`movie=`, `fontfile=`) or talk to the outside (`zmq`). */
function ffmpegFilters(st: State, graph: string): void {
  for (const key of ['movie=', 'amovie=', 'fontfile=', 'textfile=', 'filename=', 'stats_file=', 'lut3d=file=', 'file=']) {
    let from = 0;
    for (;;) {
      const at = graph.indexOf(key, from);
      if (at < 0) break;
      let end = at + key.length;
      while (end < graph.length && !':,;[]\'"'.includes(graph[end]!)) end++;
      const path = graph.slice(at + key.length, end);
      if (path) read(st, [path]);
      from = end;
    }
  }
  for (const f of ['sendcmd', 'zmq', 'azmq', 'frei0r', 'ladspa', 'lv2', 'lensfun', 'vidstabdetect']) if (graph.includes(f)) unknownOpt(st, f);
}
function media(st: State, args: string[], kind: 'ffmpeg' | 'ffprobe'): { inputs: string[]; outputs: string[] } {
  const inputs: string[] = [];
  const outputs: string[] = [];
  const valueReads: string[] = [];
  const consumed = new Set<number>();
  const isFfprobeNoval = (a: string) => (a.startsWith('-show_') && a !== '-show_entries' && a !== '-show_optional_fields') || a.startsWith('-count_')
    || ['-hide_banner', '-pretty', '-unit', '-prefix', '-byte_binary_prefix', '-sexagesimal', '-bitexact', '-version', '-h', '-help'].includes(a);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-') && a.length > 1 && !a.includes('$')) {
      if (kind === 'ffmpeg' ? FFMPEG_NOVAL.has(a) : isFfprobeNoval(a)) continue;
      const name = kind === 'ffmpeg' && a.includes(':') ? a.slice(0, a.indexOf(':')) : a;
      const known = kind === 'ffmpeg' ? FFMPEG_VALUE.has(name) || FFMPEG_READ_VALUE.has(name) || FFMPEG_WRITE_VALUE.has(name) : FFPROBE_VALUE.has(name);
      if (!known) unknownOpt(st, name);
      const v = args[++i];
      consumed.add(i);
      if (v === undefined) continue;
      if (name === '-i') { inputs.push(v); continue; }
      if (kind === 'ffprobe' && name === '-o') { if (v !== '-') outputs.push(v); continue; }
      if (FFMPEG_READ_VALUE.has(name)) { read(st, [v]); continue; }
      if (FFMPEG_WRITE_VALUE.has(name)) { if (isUrl(v)) add(st, 'uses-network', 'medium', { host: hostOf(v) }); else write(st, [v]); continue; }
      if (['-vf', '-af', '-filter', '-filter_complex', '-lavfi'].includes(name)) ffmpegFilters(st, v);
      if (name === '-safe' && v === '0') add(st, 'reads-outside-project', 'medium');
      if (v.startsWith('/') || v.startsWith('~') || v.startsWith('$') || v.startsWith('../')) valueReads.push(v);
      continue;
    }
    (kind === 'ffmpeg' ? outputs : inputs).push(a);
  }
  // ffmpeg's last word is always an output: catch it even after an option we don't know.
  const lastIdx = args.length - 1;
  const last = args[lastIdx];
  if (kind === 'ffmpeg' && last !== undefined && consumed.has(lastIdx) && args[lastIdx - 1] !== '-i' && !last.startsWith('-')) outputs.push(last);
  const net = [...inputs, ...outputs].filter(isUrl);
  if (net.length) add(st, 'uses-network', 'medium', { host: hostOf(net[0]!) });
  const files = (xs: string[]) => xs.filter((x) => !isUrl(x) && x !== '-' && !x.startsWith('pipe:'));
  read(st, [...files(inputs), ...valueReads]);
  write(st, kind === 'ffmpeg' ? files(outputs) : outputs);
  return { inputs: files(inputs), outputs: files(outputs) };
}
def(['ffmpeg'], (args, st) => {
  const { inputs, outputs } = media(st, args, 'ffmpeg');
  if (outputs.length) P(st, 'mediaConvert', { inputs: disp(st, inputs), outputs: disp(st, outputs) });
  else P(st, 'mediaProcess', { inputs: disp(st, inputs) });
});
def(['ffprobe'], (args, st) => {
  const { inputs } = media(st, args, 'ffprobe');
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
/** ImageMagick options we model (the value, if any, is treated as a possible path like every other word). */
const MAGICK_OPTS = new Set(['resize', 'crop', 'gravity', 'extent', 'background', 'flatten', 'colors', 'format', 'quality', 'strip', 'thumbnail',
  'fill', 'font', 'pointsize', 'annotate', 'geometry', 'alpha', 'colorspace', 'depth', 'density', 'rotate', 'flip', 'flop', 'trim', 'repage',
  'define', 'sharpen', 'blur', 'unsharp', 'modulate', 'level', 'negate', 'type', 'units', 'interlace', 'sampling-factor', 'append', 'layers',
  'coalesce', 'delay', 'loop', 'dispose', 'deconstruct', 'scale', 'sample', 'adaptive-resize', 'auto-orient', 'bordercolor', 'border', 'frame',
  'shadow', 'channel', 'separate', 'combine', 'compose', 'composite', 'page', 'size', 'unique-colors', 'print', 'verbose', 'quiet', 'limit',
  'transparent', 'fuzz', 'opaque', 'threshold', 'dither', 'remap', 'posterize', 'monochrome', 'grayscale', 'normalize', 'contrast-stretch',
  'brightness-contrast', 'gamma', 'sigmoidal-contrast', 'transpose', 'transverse', 'shave', 'chop', 'splice', 'distort', 'virtual-pixel',
  'interpolate', 'filter', 'vignette', 'morphology', 'kernel', 'compress', 'comment', 'region', 'colorize', 'tint', 'sepia-tone', 'evaluate',
  'clut', 'stroke', 'strokewidth', 'kerning', 'interline-spacing', 'interword-spacing', 'family', 'weight', 'style', 'stretch', 'antialias',
  'resample', 'extract', 'orient', 'delete', 'swap', 'clone', 'duplicate', 'reverse', 'ping', 'precision', 'matte', 'liquid-rescale', 'edge',
  'charcoal', 'paint', 'sketch', 'emboss', 'polaroid', 'roll', 'shear', 'motion-blur', 'radial-blur', 'despeckle', 'enhance', 'equalize',
  'auto-level', 'auto-gamma', 'white-balance', 'linear-stretch', 'label', 'caption', 'mosaic', 'bordercolor', 'mattecolor', 'fx', 'write', 'draw', 'identify', 'set']);
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
      if (opt === 'write') { const v = rest[++i]; if (v !== undefined) writes.push(stripCoder(v)); continue; }
      if (opt === 'draw') { const v = rest[i + 1] ?? ''; if (v.includes('@') || v.includes('url(') || v.includes('image')) { st.parsed = false; return; } }
      if (opt === 'script' || opt === 'process' || opt === 'monitor' || opt === 'authenticate') { st.parsed = false; return; }
      if (!MAGICK_OPTS.has(opt)) unknownOpt(st, a);
      continue;
    }
    const w = stripCoder(a);
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
export const isDangerousEnv = (name: string) => DANGEROUS_ENV.has(name) || name.startsWith('DYLD_') || name.startsWith('GIT_') || name.startsWith('BASH_FUNC_')
  || ((name.startsWith('npm_config_') || name.startsWith('NPM_CONFIG_')) && !SAFE_NPM_ENV.has(name));
/** Variables that make an interpreter load code from a folder: outside the project, that's code we can't see. */
const CODE_PATH_ENV = ['PYTHONPATH', 'NODE_PATH', 'RUBYLIB', 'GEM_PATH', 'GEM_HOME', 'PYTHONUSERBASE', 'CLASSPATH'];

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
    if (GLOBAL_VALUE.includes(a)) i++;
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
    opts(st, rest, { any: true });
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
    if (a === '-W' || a === '-X' || a === '--check-hash-based-pycs') { i++; continue; }
    if (a === '--version' || a === '--help') { P(st, 'sysInfo'); return; }
    if (a.startsWith('--')) { unknownOpt(st, a); continue; }
    if (a.startsWith('-') && !a.includes('$')) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k]!;
        if (ch === 'c' || ch === 'm') {
          const v = a.slice(k + 1) !== '' ? a.slice(k + 1) : args[++i];
          if (v === undefined) { st.parsed = false; return; }
          if (ch === 'c') { inlineCode(st, v); P(st, 'pythonInline'); return; }
          pythonModule(v, args.slice(i + 1), st);
          return;
        }
        if (ch === 'W' || ch === 'X') { if (a.slice(k + 1) === '') i++; break; }
        if (!PY_NOVAL.includes(ch)) unknownOpt(st, `-${ch}`);
      }
      continue;
    }
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
const NODE_PREFIX = ['--experimental-', '--no-experimental-', '--max-old-space-size=', '--stack-size=', '--inspect', '--trace-', '--harmony', '--unhandled-rejections=', '--disable-warning='];
function node(args: string[], st: State): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-e' || a === '--eval' || a === '-p' || a === '--print' || a === '-pe') {
      const v = args[++i];
      if (v === undefined) { st.parsed = false; return; }
      inlineCode(st, v);
      P(st, 'nodeInline');
      return;
    }
    if (a.startsWith('--eval=') || a.startsWith('--print=')) { inlineCode(st, a.slice(a.indexOf('=') + 1)); P(st, 'nodeInline'); return; }
    if (a === '-') { runsInput(st, 'node'); return; }
    if (a === '-v' || a === '--version') { P(st, 'sysInfo'); return; }
    if (NODE_VALUE.includes(a)) {
      const v = args[++i];
      if (v !== undefined && ['-r', '--require', '--import', '--loader', '--experimental-loader'].includes(a)) { if (v.includes(':')) inlineCode(st, v); else script(st, v); }
      continue;
    }
    if (a.startsWith('-') && !a.includes('$')) {
      const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      if (!NODE_NOVAL.includes(a) && !NODE_VALUE.includes(name) && !NODE_PREFIX.some((p) => a.startsWith(p))) unknownOpt(st, name);
      if ((name === '--require' || name === '--import' || name === '--loader' || name === '--experimental-loader') && a.includes('=')) {
        const v = a.slice(a.indexOf('=') + 1);
        // `data:` / `http:` modules are inline or remote code.
        if (v.includes(':')) inlineCode(st, v); else script(st, v);
      }
      continue;
    }
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
    '--stream', '--aggregate-output', '--reporter-hide-prefix', '--color', '--no-color'],
  v: ['--omit', '--include', '--reporter', '--loglevel', '-w', '--workspace', '-C', '--dir', '--filter', '-F', '--prefix', '--location', '--cache',
    '--registry', '--cwd', '--tag', '--network-concurrency', '--child-concurrency', '--depth'],
};
def(['npm', 'pnpm', 'yarn'], (args, st, name) => {
  const subAt = args.findIndex((a, k) => !a.startsWith('-') && !NPM_SPEC.v!.includes(args[k - 1] ?? ''));
  const sub = subAt >= 0 ? args[subAt]! : undefined;
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
  if (name !== 'npm' && runLike) {
    // pnpm and yarn run a package.json script or a package binary by name: whatever it is, it runs code.
    add(st, 'runs-code', 'medium');
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
    inlineCode(st, v); P(st, 'inlineCode', { lang: 'bun' }); return;
  }
  if (a0 === 'install' || a0 === 'i' || a0 === 'add' || a0 === 'a') {
    const o = opts(st, args.slice(1), NPM_SPEC);
    installPkgs(st, o.operands, has(o, '-g', '--global'), false); return;
  }
  if (a0 === 'x') { npx(args.slice(1), st); return; }
  const target = a0 === 'run' ? args[1] : a0;
  if (target === undefined) { P(st, 'pkgInfo', { tool: 'bun' }); return; }
  const rest = args.slice(a0 === 'run' ? 2 : 1);
  if (fileLike(target)) { script(st, target); scriptArgs(st, rest); P(st, 'runScript', { script: disp(st, [target]) }); return; }
  add(st, 'runs-code', 'medium');
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
  am: { phrase: 'gitChange', changes: true, f: ['--abort', '--continue', '--skip', '--quit', '-3', '--3way', '-s', '--signoff', '-k', '--keep', '-q', '--quiet', '--show-current-patch'], v: ['-p', '--whitespace', '--directory'] },
};
const GIT_FALSE_LONG = ['--config', '--config-env', '--exec', '--upload-pack', '--receive-pack', '--template', '--ext-diff', '--open-files-in-pager',
  '--git-dir', '--work-tree', '--exec-path', '--namespace', '--super-prefix', '--separate-git-dir', '--textconv', '--strategy-option=theirs-exec'];
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
      if (a.startsWith('--output=')) write(st, [a.slice(9)]);
      else if (a === '--output') write(st, [rest[k + 1] ?? '']);
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
    if (spec.changes) add(st, 'changes-git', 'medium');
    if (spec.net) add(st, 'uses-network', 'medium');
    switch (sub) {
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
      case 'branch': case 'tag': {
        const listing = o.operands.length === 0 && !has(o, '-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy', '-f', '--force', '-a', '-s', '-u', '--set-upstream-to');
        if (listing) { P(st, 'gitInfo'); return; }
        P(st, 'gitChange', { sub }); return;
      }
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
  const o = opts(st, args, { any: true, v: ['-o', '--option', '-t', '--target-release'] });
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
  else if (args[0] !== undefined && args[0] !== '--' && args[0].startsWith('-') && (isDigitsStr(args[0].slice(1)) || isSignalName(args[0].slice(1)))) i = 1;
  if (args[i] === '--') i++;
  const targets = args.slice(i);
  // A negative pid is a process group (`-1` is every process); `0` is our own group.
  for (const t of targets) {
    if (t === '0' || (t.startsWith('-') && isDigitsStr(t.slice(1)))) add(st, 'kills-processes', 'high', { target: t });
    else if (!isDigitsStr(t) && !t.startsWith('%')) unknownOpt(st, t);
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
  const o = opts(st, args, { any: true, v: ['-o', '--output-format', '-p', '--input-format', '--indent', '-I', '--from-file'] });
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
  let inPlace = false;
  const LONG_OK = ['--quiet', '--silent', '--regexp-extended', '--posix', '--null-data', '--separate', '--unbuffered', '--debug', '--sandbox', '--zero-terminated'];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') { operands.push(...args.slice(i + 1)); break; }
    if (a === '--expression') { scripts.push(args[++i] ?? ''); continue; }
    if (a.startsWith('--expression=')) { scripts.push(a.slice(13)); continue; }
    if (a.startsWith('--in-place')) { inPlace = true; continue; }
    if (a === '--line-length') { i++; continue; }
    if (a.startsWith('--')) { if (LONG_OK.includes(a)) continue; st.parsed = false; return; }
    if (a.startsWith('-') && a !== '-' && !a.includes('$')) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k]!;
        if ('nErusz'.includes(ch)) continue;
        if (ch === 'i' || ch === 'I') {
          inPlace = true;
          // GNU `-i.bak` (attached suffix); BSD `-i ''` / `-i .bak` (next word).
          if (k === a.length - 1) { const next = args[i + 1]; if (next !== undefined && (next === '' || (next.startsWith('.') && !next.includes('/')))) i++; }
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
  if (inPlace) { write(st, operands); P(st, 'editText', { paths: disp(st, operands) }); return; }
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
def(['grep', 'egrep', 'fgrep', 'ggrep', 'rg', 'ag'], (args, st, name) => {
  // GNU/BSD grep has no option that writes or runs anything. rg and ag do: those few are refused.
  if (args.some((a) => a === '--pre' || a.startsWith('--pre=') || a.startsWith('--pre-glob') || a.startsWith('--hostname-bin') || a.startsWith('--pager') || a === '--search-zip' || a === '-z' && name === 'rg')) { st.parsed = false; return; }
  const o = opts(st, args, { any: true, v: ['-e', '--regexp', '-f', '--file', '-A', '-B', '-C', '-m', '--max-count', '--include', '--exclude', '--exclude-dir', '-d', '-D',
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
  const o = opts(st, args, { any: true, v: FILTER_VALUES[name] });
  let files = name === 'tr' ? [] : o.operands;
  if (name === 'uniq' && files.length >= 2) { write(st, files.slice(1, 2)); files = files.slice(0, 1); }
  if (name === 'iconv') write(st, vals(o, '-o', '--output'));
  read(st, files);
  if (files.length) P(st, 'filter', { paths: disp(st, files) }); else P(st, 'filterPipe');
});
def(['stat', 'diff', 'cmp', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'readlink', 'realpath', 'xxd', 'od', 'hexdump',
  'strings', 'less', 'more', 'mediainfo', 'exiv2', 'pdfinfo', 'otool', 'lipo', 'mdls', 'tree', 'base64'], (args, st, name) => {
  const o = opts(st, args, { any: true, v: ['-f', '--format', '-c', '-n', '-s', '-l', '-L', '-o', '-i', '--input', '--output', '-a', '-I', '-P'] });
  if (name === 'base64' || name === 'xxd' || name === 'tree' || name === 'lipo') write(st, [...vals(o, '-o', '--output'), ...(name === 'xxd' ? o.operands.slice(1, 2) : [])]);
  if (name === 'lipo' || name === 'exiv2') unknownOpt(st, name);
  const files = name === 'xxd' ? o.operands.slice(0, 1) : [...o.operands, ...vals(o, '-i', '--input')];
  const targets = files.length ? files : name === 'tree' ? ['.'] : [];
  read(st, targets);
  if (targets.length) P(st, 'readFiles', { paths: disp(st, targets) }); else P(st, 'filterPipe');
});
def(['tee'], (args, st) => {
  const o = opts(st, args, { f: ['-a', '-i', '-p', '--append', '--ignore-interrupts', '--output-error'] });
  write(st, o.operands);
  P(st, 'writeFile', { paths: disp(st, o.operands) });
});
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
def(['whoami', 'uname', 'id', 'sw_vers', 'nproc', 'uptime', 'df', 'locale', 'system_profiler', 'ps', 'top', 'lsof', 'groups', 'tty', 'cal', 'vm_stat', 'xcrun'], (_args, st) => P(st, 'sysInfo'));
def(['arch'], (args, st) => { opts(st, args, { any: true }); P(st, 'sysInfo'); });
def(['caffeinate'], (args, st) => { opts(st, args, { f: ['-d', '-i', '-m', '-s', '-u'], v: ['-t', '-w'] }); P(st, 'noop'); });
/** Commands that read system state, or change it with a flag or an operand: a change is a write outside the project. */
def(['date'], (args, st) => {
  const o = opts(st, args, { f: ['-u', '-j', '-n', '-R', '--utc', '--universal', '--rfc-email', '-I', '--iso-8601', '--rfc-3339', '--debug'], v: ['-r', '-v', '-f', '-d', '--date', '--reference', '-s', '--set', '-z'] });
  read(st, vals(o, '--reference'));
  const sets = vals(o, '-s', '--set').length > 0 || (!has(o, '-j') && o.operands.some((x) => !x.startsWith('+')));
  if (sets) add(st, 'writes-outside-project', 'high');
  P(st, 'sysInfo');
});
def(['hostname'], (args, st) => {
  const o = opts(st, args, { f: ['-s', '-f', '-d', '-i', '-I', '-a', '-A', '--short', '--fqdn', '--domain', '--ip-address', '--all-ip-addresses'], v: ['-F', '--file'] });
  if (o.operands.length || vals(o, '-F', '--file').length) add(st, 'writes-outside-project', 'high');
  P(st, 'sysInfo');
});
def(['sysctl'], (args, st) => {
  const o = opts(st, args, { f: ['-a', '-n', '-b', '-e', '-h', '-N', '-o', '-x', '-q', '-d', '-w'], v: ['-f'] });
  if (has(o, '-w') || o.operands.some((x) => x.includes('='))) add(st, 'writes-outside-project', 'high');
  P(st, 'sysInfo');
});
def(['printenv'], (_args, st) => P(st, 'printEnv'));
def(['true', 'false', ':', 'exit', 'wait'], (_args, st) => P(st, 'noop'));
def(['set'], (_args, st) => P(st, 'shellOption'));
def(['shopt'], (_args, st) => { st.parsed = false; });
def(['test', '['], (args, st) => {
  // `test -v 'a[$(cmd)]'` evaluates the subscript.
  if (args.some((a) => a.includes('['))) { st.parsed = false; return; }
  read(st, args.filter((a) => pathLike(a) && a !== ']'));
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
    if (isDangerousEnv(n)) { st.parsed = false; return; }
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
          if ((ch === 'I' || ch === 'r' || ch === 'C' || ch === 'c') && v !== undefined && pathLike(v)) read(st, [v]);
          break;
        }
        if (spec.rest.includes(ch)) break;
        if (spec.digits.includes(ch)) { while (k + 1 < a.length && a[k + 1]! >= '0' && a[k + 1]! <= '9') k++; continue; }
        if (!spec.noval.includes(ch)) unknownOpt(st, `-${ch}`);
      }
      continue;
    }
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
  if (has(o, '-s') || first === undefined || first === '-' || first === '/dev/stdin' || first === '/dev/fd/0') { runsInput(st, 'shell'); return; }
  const rest = o.operands.slice(1);
  script(st, first);
  scriptArgs(st, rest);
  P(st, 'runScript', { script: disp(st, [first]) });
});

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
  explainArgv(argv, st);
  st.phrases = phrases;
  st.cwd = cwd;
  st.found = prevFound;
  st.cdTarget = prevCd;
}

/** Explains a whole simple command: wrappers, env, redirects and the command itself. Exactly one phrase is added. */
export function explainSimple(c: SimpleCommand, st: State): void {
  for (const [k, v] of Object.entries(c.env)) {
    if (isDangerousEnv(k)) { st.parsed = false; return; }
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

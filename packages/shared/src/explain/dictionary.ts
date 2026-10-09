// Per-command explanations. Each handler adds exactly one phrase and the indicators the command deserves.
// When a handler meets something it can't model it sets `st.parsed = false`: the caller then shows the generic phrase.
import type { IndicatorId, Phrase, Risk } from './types.ts';
import type { Indicators } from './indicators.ts';
import { isOpaqueCommand, type SimpleCommand } from './tokenize.ts';
import { dirnameAbs, displayLoc, isHarmlessDevice, resolveLocs, type ExplainContext, type Loc } from './paths.ts';

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

const PLACEHOLDER_INPUT = '$MOTION_STUDIO_INPUT';

// ——— paths ———

const locsOf = (st: State, word: string, cwd: string | null = st.cwd): Loc[] => resolveLocs(word, cwd, st.ctx);

export function fmtList(items: readonly string[]): string {
  const uniq = [...new Set(items.filter((x) => x !== ''))];
  if (uniq.length === 0) return '…';
  return uniq.length > 3 ? `${uniq.slice(0, 3).join(', ')} +${uniq.length - 3}` : uniq.join(', ');
}

const disp = (st: State, words: readonly string[], cwd: string | null = st.cwd): string =>
  fmtList(words.flatMap((w) => locsOf(st, w, cwd).slice(0, 1).map((l) => displayLoc(l, st.ctx))));

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
/** Runs a script file: low inside the project, medium elsewhere. */
function script(st: State, word: string): void {
  const ls = locsOf(st, word);
  const inProject = ls.every((l) => l.cls === 'work' || l.cls === 'project');
  add(st, 'runs-code', inProject && !st.chainNet ? 'low' : 'medium');
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
const SPAWN_TOKENS = ['do shell script', 'system(', 'os.system', 'subprocess', 'os.popen', 'os.exec', 'os.spawn', 'pty.spawn', 'child_process', 'execSync', 'spawn(', 'exec(', 'eval(', '__import__', 'execFile', 'process.binding'];
const NET_TOKENS = ['urllib', 'requests', 'http.client', 'httpx', 'socket', 'fetch(', 'http.get', 'https.get', 'http.request', 'https.request', 'net.connect', 'ftplib', 'smtplib'];
/** Inline code (`python3 -c`, `node -e`) can do anything: medium at least, more when it visibly deletes, spawns or connects. */
function inlineCode(st: State, code: string): void {
  add(st, 'runs-code', SPAWN_TOKENS.some((t) => code.includes(t)) ? 'high' : 'medium');
  if (DELETE_TOKENS.some((t) => code.includes(t))) add(st, 'deletes-files', 'high');
  if (NET_TOKENS.some((t) => code.includes(t))) add(st, 'uses-network', 'medium');
}

// ——— option parsing ———

interface Opts { flags: string[]; values: Map<string, string[]>; operands: string[] }
/** Splits flags from operands. `valueFlags` lists flags taking one value (`-n`, `--target`); `--x=v` always carries one. */
function opts(args: readonly string[], valueFlags: readonly string[] = []): Opts {
  const vf = new Set(valueFlags);
  const flags: string[] = [];
  const values = new Map<string, string[]>();
  const operands: string[] = [];
  const put = (f: string, v: string | undefined) => { if (v !== undefined) values.set(f, [...(values.get(f) ?? []), v]); };
  let end = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (end || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
    if (a === '--') { end = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      flags.push(name);
      if (eq > 0) put(name, a.slice(eq + 1));
      else if (vf.has(name)) put(name, args[++i]);
      continue;
    }
    if (vf.has(a)) { flags.push(a); put(a, args[++i]); continue; }
    for (let k = 1; k < a.length; k++) {
      const f = `-${a[k]}`;
      flags.push(f);
      if (vf.has(f)) { const rest = a.slice(k + 1); put(f, rest !== '' ? rest : args[++i]); break; }
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
/** `https://user:pw@host:8443/x?y` → `host:8443`; a bare `host/path` → `host`. */
export function hostOf(url: string): string {
  let s = url;
  const i = s.indexOf('://');
  if (i >= 0) s = s.slice(i + 3);
  let end = s.length;
  for (const c of ['/', '?', '#']) { const k = s.indexOf(c); if (k >= 0 && k < end) end = k; }
  s = s.slice(0, end);
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  return s === '' ? '…' : s;
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
  const target = args.find((a) => a !== '-P' && a !== '-L' && a !== '-e' && a !== '--');
  if (target === undefined) { st.cwd = st.ctx.home; P(st, 'cd', { path: '~' }); return; }
  if (target === '-') { st.cwd = null; P(st, 'cd', { path: '-' }); return; }
  const ls = locsOf(st, target);
  P(st, 'cd', { path: disp(st, [target]) });
  st.cwd = ls.length === 1 && ls[0]!.abs !== null && !ls[0]!.abs.includes('*') && !ls[0]!.abs.includes('?') ? ls[0]!.abs : null;
});
def(['ls'], (args, st) => {
  const o = opts(args, ['-I', '--ignore', '-w', '--width', '--color', '-T', '--format', '--sort', '--time-style', '-D']);
  const targets = o.operands.length ? o.operands : ['.'];
  read(st, targets);
  P(st, 'list', { paths: disp(st, targets) });
});
def(['cat'], (args, st) => {
  const o = opts(args);
  const files = o.operands.filter((x) => x !== '-');
  read(st, files);
  if (files.length) P(st, 'show', { paths: disp(st, files) }); else P(st, 'filterPipe');
});
def(['head', 'tail'], (args, st, name) => {
  const o = opts(args, ['-n', '-c', '-b', '--lines', '--bytes', '-s', '--sleep-interval', '--pid']);
  const files = o.operands.filter((x) => x !== '-');
  read(st, files);
  const base = name === 'head' ? 'head' : 'tail';
  if (files.length) P(st, `${base}File`, { paths: disp(st, files) }); else P(st, `${base}Pipe`);
});
def(['file'], (args, st) => {
  const o = opts(args, ['-m', '-M', '-F', '-P', '-e', '-f']);
  read(st, [...o.operands, ...vals(o, '-f', '-m', '-M')]);
  P(st, 'fileType', { paths: disp(st, o.operands) });
});
def(['wc'], (args, st) => {
  const o = opts(args, ['--files0-from']);
  read(st, o.operands);
  if (o.operands.length) P(st, 'count', { paths: disp(st, o.operands) }); else P(st, 'countPipe');
});
def(['mkdir'], (args, st) => {
  const o = opts(args, ['-m', '--mode']);
  write(st, o.operands);
  P(st, 'mkdir', { paths: disp(st, o.operands) });
});
def(['cp', 'mv'], (args, st, name) => {
  const o = opts(args, ['-t', '--target-directory', '-S', '--suffix', '--backup']);
  const t = vals(o, '-t', '--target-directory');
  const dest = t.length ? t : o.operands.slice(-1);
  const sources = t.length ? o.operands : o.operands.slice(0, -1);
  if (name === 'mv') write(st, sources); else read(st, sources);
  write(st, dest);
  P(st, name === 'mv' ? 'move' : 'copy', { sources: disp(st, sources), dest: disp(st, dest) });
});
def(['rm', 'rmdir', 'unlink', 'srm', 'shred', 'trash'], (args, st) => {
  const o = opts(args);
  del(st, o.operands);
  P(st, 'delete', { paths: disp(st, o.operands) });
});
def(['touch'], (args, st) => {
  const o = opts(args, ['-t', '-d', '-r', '-A', '--date', '--reference']);
  write(st, o.operands);
  read(st, vals(o, '-r', '--reference'));
  P(st, 'touch', { paths: disp(st, o.operands) });
});
def(['chmod', 'chown', 'chgrp', 'chflags', 'xattr'], (args, st, name) => {
  const o = opts(args, ['--reference', '-w', '-d', '-p']);
  const files = has(o, '--reference') || name === 'xattr' ? o.operands : o.operands.slice(1);
  write(st, files);
  if (name === 'chmod') P(st, 'chmod', { paths: disp(st, files) }); else { P(st, 'runs', { cmd: name }); add(st, 'unknown-command', 'medium'); }
});
def(['ln'], (args, st) => {
  const o = opts(args, ['-t', '--target-directory', '-S', '--suffix']);
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
  const o = opts(args, ['-d', '-B', '--max-depth', '--block-size', '-t', '--threshold', '--exclude', '-I']);
  const targets = o.operands.length ? o.operands : ['.'];
  read(st, targets);
  P(st, 'size', { paths: disp(st, targets) });
});
def(['find'], (args, st) => {
  let i = 0;
  while (i < args.length && ['-H', '-L', '-P', '-E', '-X', '-s', '-x', '-d', '-O0', '-O1', '-O2', '-O3'].includes(args[i]!)) i++;
  const starts: string[] = [];
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-f') { const v = args[++i]; if (v !== undefined) starts.push(v); continue; }
    if (a.startsWith('-') || a === '(' || a === '!' || a === ')') break;
    starts.push(a);
  }
  if (starts.length === 0) starts.push('.');
  read(st, starts);
  const FILTERS = ['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-empty', '-newer', '-mtime', '-mmin', '-ctime', '-cmin', '-atime', '-amin', '-size', '-perm', '-user', '-group', '-links', '-inum', '-samefile'];
  const filtered = args.slice(i).some((a) => FILTERS.includes(a));
  const child = (s: string) => (s.endsWith('/') ? `${s}{}` : `${s}/{}`);
  let deletes = false;
  let execName: string | null = null;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-delete') deletes = true;
    else if (a === '-fprint' || a === '-fprint0' || a === '-fls' || a === '-fprintf') write(st, [args[++i] ?? '']);
    else if (a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir') {
      const inner: string[] = [];
      for (i++; i < args.length && args[i] !== ';' && args[i] !== '+'; i++) inner.push(args[i]!);
      if (inner.length === 0 || isOpaqueCommand(inner)) { st.parsed = false; return; }
      execName ??= inner[0]!;
      for (const s of starts.slice(0, 5)) subExplain(inner.map((w) => (w === '{}' ? child(s) : w.split('{}').join(child(s)))), st);
    }
  }
  if (deletes) del(st, filtered ? starts.map(child) : starts);
  if (execName !== null) P(st, 'findExec', { cmd: execName, paths: disp(st, starts) });
  else if (deletes) P(st, 'findDelete', { paths: disp(st, starts) });
  else P(st, 'find', { paths: disp(st, starts) });
});
def(['tar', 'bsdtar', 'gtar'], (args, st) => {
  let mode: 'c' | 'x' | 't' | null = null;
  let archive: string | null = null;
  let dir: string | null = null;
  let absolute = false;
  const operands: string[] = [];
  const valueLetters = 'fCbTXK';
  const setValue = (letter: string, v: string | undefined) => {
    if (v === undefined) return;
    if (letter === 'f') archive = v; else if (letter === 'C') dir = v;
  };
  const letters = (cluster: string, i: number, attached: boolean): number => {
    for (let k = 0; k < cluster.length; k++) {
      const ch = cluster[k]!;
      if (ch === 'c' || ch === 'r' || ch === 'u') mode = 'c';
      else if (ch === 'x') mode = 'x';
      else if (ch === 't') mode = 't';
      else if (ch === 'P') absolute = true;
      else if (ch === 'I' || ch === 'F') { st.parsed = false; return i; }
      else if (valueLetters.includes(ch)) {
        const rest = cluster.slice(k + 1);
        if (attached && rest !== '') { setValue(ch, rest); return i; }
        setValue(ch, args[++i]);
      }
    }
    return i;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (i === 0 && !a.startsWith('-')) { i = letters(a, i, false); continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      const v = eq > 0 ? a.slice(eq + 1) : undefined;
      if (['--to-command', '--use-compress-program', '--checkpoint-action', '--info-script', '--new-volume-script', '--rsh-command'].includes(name)) { st.parsed = false; return; }
      if (name === '--create' || name === '--append' || name === '--update') mode = 'c';
      else if (name === '--extract' || name === '--get') mode = 'x';
      else if (name === '--list') mode = 't';
      else if (name === '--absolute-names') absolute = true;
      else if (name === '--file') archive = v ?? args[++i] ?? null;
      else if (name === '--directory') dir = v ?? args[++i] ?? null;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) { i = letters(a.slice(1), i, true); if (!st.parsed) return; continue; }
    operands.push(a);
  }
  if (!st.parsed) return;
  const arch = archive as string | null;
  const d = dir as string | null;
  const real = arch !== null && arch !== '-' ? [arch] : [];
  if (mode === 'c') {
    write(st, real);
    read(st, operands, d !== null ? (locsOf(st, d)[0]?.abs ?? null) : st.cwd);
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
  const o = opts(args, ['-d', '-P']);
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
  const o = opts(args, ['-b', '-n', '-t', '-tt', '-O', '--output-file', '-P', '--password', '-Z', '-s', '-sp']);
  // `-x` / `-i` take a list of patterns up to the next option; those are patterns, not files.
  const operands: string[] = [];
  let inList = false;
  for (const a of args) {
    if (a === '-x' || a === '-i' || a === '--exclude' || a === '--include') { inList = true; continue; }
    if (a.startsWith('-')) { inList = false; continue; }
    if (!inList && o.operands.includes(a)) operands.push(a);
  }
  const archive = operands[0];
  const real = archive !== undefined ? [archive] : [];
  write(st, [...real, ...vals(o, '-O', '--output-file')]);
  read(st, operands.slice(1));
  P(st, 'archiveCreate', { archive: disp(st, real) });
});

// Media.
const FFMPEG_NOVAL = new Set([
  '-y', '-n', '-hide_banner', '-nostdin', '-stdin', '-stats', '-nostats', '-shortest', '-an', '-vn', '-sn', '-dn', '-re', '-benchmark',
  '-benchmark_all', '-copyts', '-start_at_zero', '-accurate_seek', '-noaccurate_seek', '-report', '-dump', '-hex', '-ignore_unknown',
  '-copy_unknown', '-debug_ts', '-xerror', '-autorotate', '-noautorotate', '-version', '-buildconf', '-formats', '-codecs', '-encoders',
  '-decoders', '-filters', '-pix_fmts', '-sample_fmts', '-layouts', '-L', '-protocols', '-muxers', '-demuxers', '-devices', '-bsfs',
  '-hwaccels', '-colors', '-sources', '-sinks', '-dts_delta_threshold', '-noautoscale',
]);
function media(st: State, args: string[], kind: 'ffmpeg' | 'ffprobe'): { inputs: string[]; outputs: string[] } {
  const inputs: string[] = [];
  const outputs: string[] = [];
  const valueReads: string[] = [];
  const consumed = new Set<number>();
  const isFfprobeNoval = (a: string) => (a.startsWith('-show_') && a !== '-show_entries') || a.startsWith('-count_')
    || ['-hide_banner', '-pretty', '-unit', '-prefix', '-byte_binary_prefix', '-sexagesimal', '-bitexact', '-version'].includes(a);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-i') { const v = args[++i]; consumed.add(i); if (v !== undefined) inputs.push(v); continue; }
    if (a.startsWith('-') && a.length > 1) {
      if (kind === 'ffmpeg' ? FFMPEG_NOVAL.has(a) : isFfprobeNoval(a)) continue;
      const v = args[++i];
      consumed.add(i);
      if (v === undefined) continue;
      if (kind === 'ffprobe' && a === '-o') { if (v !== '-') outputs.push(v); continue; }
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
  const READ_ONLY = new Set(['-g', '--getProperty', '-1', '--oneLine', '-h', '--help', '-H', '--helpProperties', '--debug', '--formats']);
  const inputs: string[] = [];
  const out: string[] = [];
  let modifies = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) { inputs.push(a); continue; }
    if (!READ_ONLY.has(a)) modifies = true;
    if (TWO.has(a)) { i += 2; continue; }
    if (ONE.has(a)) {
      const v = args[++i];
      if (v === undefined) continue;
      if (a === '-o' || a === '--out' || a === '-x' || a === '--extractProfile') out.push(v);
      else if (a === '-j' || a === '--js') { add(st, 'runs-code', 'medium'); read(st, [v]); }
      else if (a === '-e' || a === '-E' || a === '-m' || a === '-M' || a.startsWith('--embed') || a.startsWith('--match')) read(st, [v]);
    }
  }
  if (out.length) { read(st, inputs); write(st, out); P(st, 'imageConvert', { inputs: disp(st, inputs), outputs: disp(st, out) }); }
  else if (modifies) { write(st, inputs); P(st, 'imageEdit', { paths: disp(st, inputs) }); }
  else { read(st, inputs); P(st, 'imageInfo', { paths: disp(st, inputs) }); }
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
def(['magick', 'convert', 'mogrify', 'identify', 'montage', 'composite'], (args, st, name) => {
  let mode = name;
  let rest = args;
  if (name === 'magick' && ['convert', 'mogrify', 'identify', 'montage', 'composite', 'compare', 'stream', 'import', 'display', 'animate', 'conjure'].includes(args[0] ?? '')) {
    mode = args[0]!; rest = args.slice(1);
  }
  if (mode === 'conjure' || mode === 'import' || mode === 'display' || mode === 'animate' || mode === 'stream') { unknown(args, st, name); return; }
  if (rest.some((a) => a.startsWith('msl:') || a.startsWith('mvg:') || a.startsWith('@'))) { st.parsed = false; return; }
  const words = rest.filter((a) => !a.startsWith('-') && !a.startsWith('+')).map(stripCoder);
  const net = words.filter(isUrl);
  if (net.length) add(st, 'uses-network', 'medium', { host: hostOf(net[0]!) });
  const files = words.filter((w) => !isUrl(w) && w !== '-' && w !== '');
  if (mode === 'mogrify') {
    write(st, files);
    for (let i = 0; i < rest.length; i++) if (rest[i] === '-path') write(st, [rest[i + 1] ?? '']);
    P(st, 'imageEdit', { paths: disp(st, files.filter(fileLike)) });
    return;
  }
  if (mode === 'identify') { read(st, files); P(st, 'imageInfo', { paths: disp(st, files.filter(fileLike)) }); return; }
  const lastWord = words[words.length - 1];
  const output = lastWord !== undefined && lastWord !== '-' && !isUrl(lastWord) && lastWord !== '' ? lastWord : null;
  const inputs = files.slice(0, output !== null && words.length > 1 ? -1 : files.length);
  read(st, inputs);
  if (output !== null && words.length > 1) {
    write(st, [output]);
    P(st, 'imageConvert', { inputs: disp(st, inputs.filter(fileLike)), outputs: disp(st, [output]) });
  } else P(st, 'imageInfo', { paths: disp(st, inputs.filter(fileLike)) });
});
def(['cwebp', 'dwebp', 'gif2webp', 'img2webp', 'rsvg-convert', 'avifenc', 'avifdec', 'heif-convert', 'vwebp', 'webpmux'], (args, st) => {
  const outFlags = ['-o', '--output', '-out'];
  const outs: string[] = [];
  const inputs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (outFlags.includes(a)) { const v = args[++i]; if (v !== undefined && v !== '-') outs.push(v); continue; }
    if (a.startsWith('--output=')) { outs.push(a.slice(9)); continue; }
    if (!a.startsWith('-')) inputs.push(a);
  }
  read(st, inputs);
  write(st, outs);
  const shownOut = outs.length ? disp(st, outs) : st.stdout;
  if (shownOut !== null) P(st, 'imageConvert', { inputs: disp(st, inputs.filter(fileLike)), outputs: shownOut });
  else P(st, 'imageInfo', { paths: disp(st, inputs.filter(fileLike)) });
});
def(['optipng', 'pngquant', 'gifsicle', 'jpegoptim', 'oxipng', 'pngcrush', 'svgo'], (args, st, name) => {
  const outFlags = name === 'optipng' ? ['-out', '-dir'] : name === 'jpegoptim' ? ['-d', '--dest'] : ['-o', '--output', '--out'];
  const outs: string[] = [];
  const inputs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (outFlags.includes(a)) { const v = args[++i]; if (v !== undefined && v !== '-') outs.push(v); continue; }
    const eq = a.indexOf('=');
    if (eq > 0 && outFlags.includes(a.slice(0, eq))) { outs.push(a.slice(eq + 1)); continue; }
    if (!a.startsWith('-')) inputs.push(a);
  }
  // Optimizers rewrite their inputs (or write next to them) unless told otherwise.
  write(st, [...inputs, ...outs]);
  P(st, 'imageOptimize', { paths: disp(st, (outs.length ? [...inputs, ...outs] : inputs).filter(fileLike)) });
});

// Python.
const DANGEROUS_ENV = new Set(['PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'BASH_ENV', 'ENV', 'IFS', 'PROMPT_COMMAND', 'SHELLOPTS',
  'BASHOPTS', 'PS4', 'NODE_OPTIONS', 'PYTHONSTARTUP', 'PYTHONINSPECT', 'PYTHONHOME', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'HOME', 'TMPDIR', 'PWD', 'OLDPWD',
  'CDPATH', 'GLOBIGNORE', 'ZDOTDIR', 'EDITOR', 'VISUAL', 'PAGER', 'GIT_DIR', 'GIT_WORK_TREE', 'npm_config_prefix', 'NPM_CONFIG_PREFIX', 'PIP_TARGET', 'PIP_PREFIX']);
export const isDangerousEnv = (name: string) => DANGEROUS_ENV.has(name) || name.startsWith('DYLD_') || name.startsWith('GIT_') || name.startsWith('BASH_FUNC_');

function pip(args: string[], st: State): void {
  let i = 0;
  const GLOBAL_VALUE = ['--python', '--log', '--proxy', '--cache-dir', '--retries', '--timeout', '--exists-action', '--trusted-host', '--cert', '--client-cert', '--keyring-provider', '--use-feature', '--use-deprecated'];
  while (i < args.length && args[i]!.startsWith('-')) { if (GLOBAL_VALUE.includes(args[i]!)) i++; i++; }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === 'install' || sub === 'download' || sub === 'wheel') {
    const o = opts(rest, ['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-t', '--target', '--prefix', '--root', '-i',
      '--index-url', '--extra-index-url', '-f', '--find-links', '--cache-dir', '--src', '--upgrade-strategy', '--platform', '--python-version',
      '--implementation', '--abi', '--only-binary', '--no-binary', '--progress-bar', '--log', '--timeout', '--retries', '--proxy',
      '--trusted-host', '--cert', '--client-cert', '-C', '--config-settings', '--global-option', '-d', '--dest', '-w', '--wheel-dir', '--report']);
    const reqs = vals(o, '-r', '--requirement', '-c', '--constraint');
    read(st, [...reqs, ...vals(o, '-e', '--editable').filter(pathLike)]);
    write(st, vals(o, '-t', '--target', '--prefix', '--root', '-d', '--dest', '-w', '--wheel-dir', '--src', '--report', '--log'));
    if (has(o, '--user')) add(st, 'writes-outside-project', 'high', { path: '~' });
    if (has(o, '--break-system-packages')) add(st, 'writes-outside-project', 'high');
    if (sub === 'install') add(st, 'installs-packages', 'medium');
    if (!has(o, '--no-index')) add(st, 'uses-network', 'medium', { host: 'pypi.org' });
    const pkgs = o.operands;
    if (pkgs.length) P(st, 'pipInstall', { packages: fmtList(pkgs) });
    else if (reqs.length) P(st, 'pipInstallReq', { file: disp(st, reqs) });
    else P(st, 'pipInstall', { packages: '…' });
    return;
  }
  if (sub === 'uninstall') {
    const o = opts(rest, ['-r', '--requirement']);
    add(st, 'installs-packages', 'medium');
    P(st, 'pkgRemove', { packages: fmtList(o.operands) });
    return;
  }
  if (sub === undefined || ['list', 'show', 'freeze', 'check', 'help', 'inspect', '--version', '-V', 'debug'].includes(sub)) { P(st, 'pipInfo'); return; }
  P(st, 'pkgOther', { tool: 'pip', sub });
  add(st, 'unknown-command', 'medium');
}

def(['python', 'python3', 'pypy3'], (args, st) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-') { runsInput(st, 'python'); return; }
    if (a === '-W' || a === '-X' || a === '--check-hash-based-pycs') { i++; continue; }
    if (a.startsWith('--')) continue;
    if (a.startsWith('-')) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === 'c' || ch === 'm') {
          const v = a.slice(k + 1) !== '' ? a.slice(k + 1) : args[++i];
          if (v === undefined) { st.parsed = false; return; }
          if (ch === 'c') { inlineCode(st, v); P(st, 'pythonInline'); return; }
          pythonModule(v, args.slice(i + 1), st);
          return;
        }
        if (ch === 'W' || ch === 'X') { if (a.slice(k + 1) === '') i++; break; }
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
    const o = opts(rest, ['--prompt']);
    write(st, o.operands);
    P(st, 'venv', { path: disp(st, o.operands) });
    return;
  }
  if (module === 'json.tool') {
    const o = opts(rest, ['--indent']);
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
def(['node', 'nodejs'], (args, st) => {
  const VALUE = ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file', '--title', '--stack-size', '--max-old-space-size', '--inspect-port'];
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
    if (VALUE.includes(a)) { const v = args[++i]; if (v !== undefined && pathLike(v)) script(st, v); continue; }
    if (a.startsWith('-')) continue;
    script(st, a);
    scriptArgs(st, args.slice(i + 1));
    P(st, 'nodeScript', { script: disp(st, [a]) });
    return;
  }
  runsInput(st, 'node');
});
function installPkgs(st: State, pkgs: string[], global: boolean, offline: boolean): void {
  add(st, 'installs-packages', 'medium');
  if (!offline) add(st, 'uses-network', 'medium', { host: 'registry.npmjs.org' });
  if (global) add(st, 'writes-outside-project', 'high');
  if (pkgs.length) P(st, 'npmInstall', { packages: fmtList(pkgs) }); else P(st, 'npmInstallAll');
}
function npx(args: string[], st: State): void {
  const o = opts(args, ['-p', '--package', '-c', '--call', '--cache']);
  if (has(o, '-c', '--call')) { st.parsed = false; return; }
  const tool = o.operands[0] ?? vals(o, '-p', '--package')[0] ?? '…';
  add(st, 'runs-code', 'medium');
  add(st, 'uses-network', 'medium', { host: 'registry.npmjs.org' });
  scriptArgs(st, o.operands.slice(1));
  P(st, 'npx', { tool });
}
def(['npx', 'pnpx', 'bunx'], (args, st) => npx(args, st));
const NPM_INSTALL = ['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'ci', 'clean-install', 'update', 'up', 'upgrade', 'udpate'];
const PKG_REMOVE = ['uninstall', 'remove', 'rm', 'r', 'un', 'unlink'];
const PKG_INFO = ['ls', 'list', 'll', 'la', 'view', 'info', 'show', 'v', 'outdated', 'explain', 'why', 'help', '-v', '--version', 'search'];
const PKG_RISKY = ['publish', 'unpublish', 'link', 'ln', 'config', 'set', 'get', 'login', 'logout', 'adduser', 'deploy', 'pack', 'patch',
  'patch-commit', 'store', 'env', 'setup', 'self-update', 'audit', 'import', 'rebuild', 'prune', 'fetch', 'server', 'root', 'bin', 'init',
  'version', 'owner', 'team', 'token', 'access', 'hook', 'profile', 'cache', 'dist-tag', 'deprecate', 'edit', 'sbom', 'shrinkwrap', 'global', 'plugin', 'policies', 'workspaces', 'catalog', 'approve-builds'];
def(['npm', 'pnpm', 'yarn', 'bun'], (args, st, name) => {
  const o = opts(args, ['-C', '--dir', '--prefix', '--filter', '-F', '--workspace', '-w', '--cwd', '--location', '--cache']);
  const [sub, ...rest] = o.operands;
  const global = has(o, '-g', '--global') || vals(o, '--location').includes('global');
  const offline = has(o, '--offline');
  write(st, vals(o, '--prefix'));
  if (sub === undefined) {
    if (name === 'yarn' || name === 'bun') { installPkgs(st, [], global, offline); return; }
    P(st, 'pkgInfo', { tool: name }); return;
  }
  if (name === 'yarn' && sub === 'global' && rest[0] === 'add') { installPkgs(st, rest.slice(1), true, offline); return; }
  if (NPM_INSTALL.includes(sub)) { installPkgs(st, rest, global, offline); return; }
  if (sub === 'run' || sub === 'run-script' || sub === 'rum' || sub === 'urn') {
    add(st, 'runs-code', 'low');
    P(st, 'npmRun', { script: rest[0] ?? '…' }); return;
  }
  if (['test', 't', 'tst', 'start', 'stop', 'restart'].includes(sub)) { add(st, 'runs-code', 'low'); P(st, 'npmRun', { script: sub }); return; }
  if (sub === 'exec' || sub === 'x' || sub === 'dlx' || sub === 'create') { npx(sub === 'create' ? [`create-${rest[0] ?? ''}`, ...rest.slice(1)] : rest, st); return; }
  if (PKG_REMOVE.includes(sub)) { add(st, 'installs-packages', 'medium'); if (global) add(st, 'writes-outside-project', 'high'); P(st, 'pkgRemove', { packages: fmtList(rest) }); return; }
  if (PKG_INFO.includes(sub)) { P(st, 'pkgInfo', { tool: name }); return; }
  if (name !== 'npm' && !PKG_RISKY.includes(sub) && !sub.startsWith('-')) {
    // pnpm, yarn and bun run a package.json script by name.
    add(st, 'runs-code', 'low');
    P(st, 'npmRun', { script: sub }); return;
  }
  P(st, 'pkgOther', { tool: name, sub });
  add(st, 'unknown-command', 'medium');
});

// Network.
def(['curl'], (args, st) => {
  const VALUE = ['-o', '--output', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '-F', '--form',
    '--form-string', '-H', '--header', '-X', '--request', '-u', '--user', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c',
    '--cookie-jar', '-T', '--upload-file', '-m', '--max-time', '--connect-timeout', '-w', '--write-out', '-x', '--proxy', '--retry',
    '--retry-delay', '--retry-max-time', '-r', '--range', '-C', '--continue-at', '--cacert', '--capath', '--cert', '--key', '-E', '-D',
    '--dump-header', '--trace', '--trace-ascii', '--stderr', '--output-dir', '-z', '--time-cond', '-Y', '--speed-limit', '-y', '--speed-time',
    '--limit-rate', '--resolve', '--connect-to', '--interface', '--max-filesize', '--url', '-U', '--proxy-user', '--tls-max', '--ciphers',
    '--max-redirs', '-K', '--config', '--libcurl', '--etag-save', '--etag-compare', '--hsts', '--alt-svc', '--netrc-file', '-Q', '--quote', '--variable'];
  const o = opts(args, VALUE);
  if (vals(o, '-K', '--config').length) { st.parsed = false; return; }
  const urls = [...o.operands, ...vals(o, '--url')];
  const fileUrls = urls.filter((u) => u.startsWith('file://'));
  read(st, fileUrls.map((u) => u.slice(7)));
  const outs = vals(o, '-o', '--output', '-c', '--cookie-jar', '-D', '--dump-header', '--trace', '--trace-ascii', '--stderr', '--libcurl', '--etag-save').filter((x) => x !== '-');
  const outDirs = vals(o, '--output-dir');
  if (has(o, '-O', '--remote-name', '--remote-name-all', '-J')) outDirs.push(outDirs[0] ?? '.');
  write(st, [...outs, ...outDirs]);
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
  const o = opts(args, ['-O', '--output-document', '-P', '--directory-prefix', '-o', '--output-file', '-a', '--append-output', '-i', '--input-file',
    '--post-data', '--post-file', '--method', '--body-data', '--body-file', '-U', '--user-agent', '--header', '-t', '--tries', '-T', '--timeout',
    '-e', '--execute', '--user', '--password', '-l', '--level', '-A', '-R', '-D', '--load-cookies', '--save-cookies', '--config']);
  if (vals(o, '-e', '--execute', '--config').length) { st.parsed = false; return; }
  const doc = vals(o, '-O', '--output-document').filter((x) => x !== '-');
  const outs = [...doc, ...vals(o, '-o', '--output-file', '-a', '--append-output', '--save-cookies')];
  const dirs = vals(o, '-P', '--directory-prefix');
  write(st, [...outs, ...(doc.length || vals(o, '-O').includes('-') ? [] : dirs.length ? dirs : ['.'])]);
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
def(['git'], (args, st) => {
  let i = 0;
  let cwd = st.cwd;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-C') { const v = args[++i]; if (v === undefined) { st.parsed = false; return; } read(st, [v]); cwd = locsOf(st, v)[0]?.abs ?? null; continue; }
    if (a === '--no-pager' || a === '-P' || a === '--paginate' || a === '-p' || a === '--no-optional-locks' || a === '--no-replace-objects' || a === '--literal-pathspecs') continue;
    if (a.startsWith('-')) { st.parsed = false; return; } // -c, --git-dir, --work-tree, --exec-path, --config-env, …
    break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const saved = st.cwd;
  st.cwd = cwd;
  try {
    if (sub === undefined) { P(st, 'gitInfo'); return; }
    const o = opts(rest, ['-m', '--message', '-F', '--file', '-C', '-c', '-b', '-B', '-o', '--output', '--depth', '--branch', '--format', '--pretty', '-n', '--author', '--since', '--until', '--grep', '-u', '--upstream']);
    switch (sub) {
      case 'status': P(st, 'gitStatus'); return;
      case 'diff': case 'show': write(st, vals(o, '-o', '--output')); P(st, 'gitDiff'); return;
      case 'log': case 'shortlog': case 'blame': case 'reflog': P(st, 'gitLog'); return;
      case 'rev-parse': case 'ls-files': case 'ls-tree': case 'describe': case 'cat-file': case 'show-ref': case 'grep': case 'rev-list': P(st, 'gitInfo'); return;
      case 'add': case 'stage': read(st, o.operands); P(st, 'gitAdd', { paths: disp(st, o.operands.length ? o.operands : ['.']) }); return;
      case 'commit':
        read(st, vals(o, '-F', '--file'));
        add(st, 'changes-git', 'medium'); P(st, 'gitCommit'); return;
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
      case 'push': case 'pull': case 'fetch':
        add(st, 'uses-network', 'medium');
        if (sub !== 'fetch') add(st, 'changes-git', 'medium');
        P(st, 'gitSync', { sub }); return;
      case 'branch': case 'tag': case 'remote': case 'stash': {
        const listing = (sub === 'branch' || sub === 'tag') ? o.operands.length === 0 && !has(o, '-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy', '-f', '--force', '-a', '-s', '-u')
          : sub === 'remote' ? (o.operands.length === 0 || o.operands[0] === 'show' || o.operands[0] === 'get-url') : o.operands[0] === 'list' || o.operands[0] === 'show';
        if (listing) { P(st, 'gitInfo'); return; }
        add(st, 'changes-git', 'medium'); P(st, 'gitChange', { sub }); return;
      }
      case 'reset': case 'checkout': case 'restore': case 'switch': case 'rebase': case 'merge': case 'revert': case 'cherry-pick': case 'am': case 'apply': case 'init': case 'gc': case 'mv':
        add(st, 'changes-git', 'medium'); P(st, 'gitChange', { sub }); return;
      case 'rm': case 'clean':
        add(st, 'changes-git', 'medium');
        if (sub === 'rm' && !has(o, '--cached')) del(st, o.operands);
        if (sub === 'clean') del(st, [has(o, '-x', '-X') ? '.' : `./{}`]);
        P(st, 'gitChange', { sub }); return;
      default:
        P(st, 'gitOther', { sub });
        add(st, 'unknown-command', 'medium');
    }
  } finally {
    st.cwd = saved;
  }
});
function systemPkgs(args: string[], st: State, name: string): void {
  const o = opts(args, ['-o', '--option', '-t', '--target-release']);
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
}
def(['brew', 'apt', 'apt-get', 'port', 'yum', 'dnf', 'apk'], (args, st, name) => systemPkgs(args, st, name));

// Processes.
def(['kill', 'pkill', 'killall'], (args, st, name) => {
  const o = opts(args, name === 'kill' ? ['-s', '-n'] : ['-u', '-U', '-g', '-G', '-t', '-s', '-P', '-F', '-c', '-j', '-M', '-N']);
  read(st, vals(o, '-F'));
  add(st, 'kills-processes', 'medium');
  if (o.operands.length === 0 && has(o, '-l', '-L')) { P(st, 'sysInfo'); return; }
  P(st, 'kill', { targets: fmtList(o.operands) });
});
def(['sleep'], (args, st) => P(st, 'sleep', { seconds: args[0] ?? '…' }));
def(['echo', 'printf'], (args, st) => {
  void args;
  if (st.stdout !== null) P(st, 'writeText', { path: st.stdout }); else P(st, 'print');
});
def(['basename', 'dirname', 'seq', 'expr', 'yes'], (_args, st) => P(st, 'print'));
def(['jq', 'gojq', 'yq'], (args, st) => {
  const two = new Set(['--arg', '--argjson', '--slurpfile', '--rawfile']);
  const ONE = ['-f', '--from-file', '--indent', '-L'];
  const files: string[] = [];
  let filter: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--args' || a === '--jsonargs') break;
    if (two.has(a)) { const v = args[i + 2]; if ((a === '--slurpfile' || a === '--rawfile') && v !== undefined) read(st, [v]); i += 2; continue; }
    if (ONE.includes(a)) { const v = args[++i]; if ((a === '-f' || a === '--from-file') && v !== undefined) { read(st, [v]); filter = v; } continue; }
    if (a.startsWith('-') && a !== '-') continue;
    if (filter === null) filter = a; else files.push(a);
  }
  read(st, files);
  if (files.length) P(st, 'json', { paths: disp(st, files) }); else P(st, 'jsonPipe');
});
def(['sed', 'gsed'], (args, st) => {
  const scripts: string[] = [];
  const operands: string[] = [];
  let inPlace = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-e' || a === '--expression') { scripts.push(args[++i] ?? ''); continue; }
    if (a.startsWith('--expression=')) { scripts.push(a.slice(13)); continue; }
    if (a === '-f' || a === '--file' || a.startsWith('--file=')) { st.parsed = false; return; }
    if (a === '-i' || a === '-I') {
      inPlace = true;
      const next = args[i + 1];
      if (next !== undefined && (next === '' || (next.startsWith('.') && !next.includes('/')))) i++; // BSD suffix: `-i ''`, `-i .bak`
      continue;
    }
    if (a.startsWith('--in-place')) { inPlace = true; continue; }
    if (a === '-l' || a === '--line-length') { i++; continue; }
    if (a.startsWith('-') && a !== '-') { if (a.slice(1).includes('i')) inPlace = true; continue; }
    operands.push(a);
  }
  if (scripts.length === 0 && operands.length) scripts.push(operands.shift()!);
  // `w file` writes, `e` runs a command, `r file` reads: not modeled.
  for (const sc of scripts) {
    const t = sc.trim();
    if (t.startsWith('e') || t.startsWith('w') || t.startsWith('W') || t.startsWith('r') || t.startsWith('R')
      || ['w ', 'W ', '/e', ';e', '\ne', '}e', ';w', ';r', ' r ', '/w', '/r ', '/R '].some((x) => sc.includes(x))) { st.parsed = false; return; }
  }
  if (inPlace) { write(st, operands); P(st, 'editText', { paths: disp(st, operands) }); return; }
  read(st, operands);
  if (operands.length) P(st, 'filter', { paths: disp(st, operands) }); else P(st, 'filterPipe');
});
def(['awk', 'gawk', 'mawk', 'nawk'], (args, st) => {
  const o = opts(args, ['-F', '-v', '--assign', '--field-separator']);
  if (args.some((a) => a === '-f' || a.startsWith('--file') || a === '-E' || a === '-i' || a === '--include' || a === '-l' || a === '--load')) { st.parsed = false; return; }
  const [program, ...rest] = o.operands;
  if (program === undefined) { st.parsed = false; return; }
  if (['system', 'getline', '|', '>', 'close(', 'fflush(', '@'].some((x) => program.includes(x))) { st.parsed = false; return; }
  const files = rest.filter((f) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(f));
  read(st, files);
  if (files.length) P(st, 'filter', { paths: disp(st, files) }); else P(st, 'filterPipe');
});
def(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ggrep'], (args, st, name) => {
  if (args.some((a) => a === '--pre' || a.startsWith('--pre='))) { st.parsed = false; return; }
  const o = opts(args, ['-e', '--regexp', '-f', '--file', '-A', '-B', '-C', '-m', '--max-count', '--include', '--exclude', '--exclude-dir', '-d', '-D',
    '--context', '--after-context', '--before-context', '--label', '--binary-files', '-g', '--glob', '-t', '--type', '-T', '--type-not', '--color', '--colors', '-M', '--max-columns', '-j', '--threads']);
  const patterns = vals(o, '-e', '--regexp', '-f', '--file');
  read(st, vals(o, '-f', '--file'));
  const files = patterns.length ? o.operands : o.operands.slice(1);
  const recursive = name === 'rg' || name === 'ag' || has(o, '-r', '-R', '--recursive');
  const targets = files.length ? files : recursive ? ['.'] : [];
  read(st, targets);
  if (targets.length) P(st, 'search', { paths: disp(st, targets) }); else P(st, 'searchPipe');
});
def(['sort'], (args, st) => {
  const o = opts(args, ['-o', '--output', '-k', '--key', '-t', '--field-separator', '-T', '--temporary-directory', '-S', '--buffer-size', '--parallel', '--files0-from', '--random-source']);
  write(st, vals(o, '-o', '--output'));
  read(st, o.operands);
  if (o.operands.length) P(st, 'filter', { paths: disp(st, o.operands) }); else P(st, 'filterPipe');
});
def(['uniq', 'cut', 'tr', 'nl', 'column', 'rev', 'paste', 'fold', 'fmt', 'expand', 'unexpand', 'tac', 'comm', 'join', 'iconv', 'col', 'colrm'], (args, st, name) => {
  const o = opts(args, ['-d', '--delimiter', '-f', '--fields', '-c', '--characters', '-b', '--bytes', '-s', '-w', '-t', '-o', '-j', '-1', '-2', '-v', '-n', '-i', '-l', '--from-code', '--to-code']);
  let files = name === 'tr' ? [] : o.operands;
  if (name === 'uniq' && files.length >= 2) { write(st, files.slice(1, 2)); files = files.slice(0, 1); }
  if (name === 'iconv') write(st, vals(o, '-o'));
  read(st, files);
  if (files.length) P(st, 'filter', { paths: disp(st, files) }); else P(st, 'filterPipe');
});
def(['stat', 'diff', 'cmp', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'readlink', 'realpath', 'xxd', 'od', 'hexdump',
  'strings', 'less', 'more', 'mediainfo', 'exiv2', 'pdfinfo', 'otool', 'lipo', 'mdls', 'tree', 'base64'], (args, st, name) => {
  const o = opts(args, ['-f', '--format', '-c', '-n', '-s', '-l', '-L', '-o', '-i', '--input', '--output', '-a', '-I']);
  if (name === 'base64' || name === 'xxd') write(st, [...vals(o, '-o', '--output'), ...(name === 'xxd' ? o.operands.slice(1, 2) : [])]);
  const files = name === 'xxd' ? o.operands.slice(0, 1) : [...o.operands, ...vals(o, '-i', '--input')];
  const targets = files.length ? files : name === 'tree' ? ['.'] : [];
  read(st, targets);
  if (targets.length) P(st, 'readFiles', { paths: disp(st, targets) }); else P(st, 'filterPipe');
});
def(['tee'], (args, st) => {
  const o = opts(args);
  write(st, o.operands);
  P(st, 'writeFile', { paths: disp(st, o.operands) });
});
def(['xargs'], (args, st) => {
  const VALUE = ['-n', '-L', '-P', '-s', '-d', '-E', '-e', '-I', '-J', '-R', '-S', '-a', '--arg-file', '--max-args', '--max-procs', '--delimiter', '--replace', '--max-chars', '--eof'];
  let replace: string | null = null;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') { i++; break; }
    if (!a.startsWith('-')) break;
    if (VALUE.includes(a)) { const v = args[++i]; if (a === '-I' || a === '-J' || a === '--replace') replace = v ?? '{}'; if (a === '-a' || a === '--arg-file') read(st, [v ?? '']); continue; }
    if (a.startsWith('-I') && a.length > 2) { replace = a.slice(2); continue; }
    if (a === '-i') { replace = '{}'; continue; }
  }
  const inner = args.slice(i);
  if (inner.length === 0) { P(st, 'xargs', { cmd: 'echo' }); return; }
  if (isOpaqueCommand(inner)) { st.parsed = false; return; }
  const withInput = replace !== null && inner.some((w) => w.includes(replace!))
    ? inner.map((w) => w.split(replace!).join(PLACEHOLDER_INPUT))
    : [...inner, PLACEHOLDER_INPUT];
  subExplain(withInput, st);
  P(st, 'xargs', { cmd: inner[0]! });
});
def(['open'], (args, st) => {
  const o = opts(args, ['-a', '-b', '-s', '-u', '--env', '--stdin', '--stdout', '--stderr']);
  const argsAt = args.indexOf('--args');
  const operands = argsAt >= 0 ? o.operands.filter((x) => args.indexOf(x) < argsAt) : o.operands;
  const urls = [...operands.filter(isUrl), ...vals(o, '-u')];
  const files = operands.filter((x) => !isUrl(x));
  if (urls.length) add(st, 'uses-network', 'medium', { host: hostOf(urls[0]!) });
  read(st, files);
  const EXEC = ['.app', '.command', '.sh', '.tool', '.pkg', '.mpkg', '.workflow', '.terminal', '.scpt', '.jar', '.dmg', '.action', '.prefPane'];
  if (vals(o, '-a', '-b').length || files.some((f) => EXEC.some((e) => trimSlashes(f).endsWith(e)))) add(st, 'runs-code', 'medium');
  if (files.length) P(st, 'open', { paths: disp(st, files) });
  else if (urls.length) P(st, 'openUrl', { host: hostOf(urls[0]!) });
  else P(st, 'open', { paths: fmtList(vals(o, '-a', '-b')) });
});
def(['which', 'whereis', 'type'], (args, st) => P(st, 'which', { cmd: fmtList(args.filter((a) => !a.startsWith('-'))) }));
def(['command'], (args, st) => P(st, 'which', { cmd: fmtList(args.filter((a) => !a.startsWith('-'))) }));
def(['pwd'], (_args, st) => P(st, 'pwd'));
def(['date', 'whoami', 'uname', 'hostname', 'id', 'sw_vers', 'nproc', 'uptime', 'df', 'locale', 'arch', 'sysctl', 'system_profiler', 'ps', 'top', 'lsof', 'groups', 'tty', 'cal', 'vm_stat'], (_args, st) => P(st, 'sysInfo'));
def(['printenv'], (_args, st) => P(st, 'printEnv'));
def(['true', 'false', ':', 'exit', 'wait'], (_args, st) => P(st, 'noop'));
def(['set'], (_args, st) => P(st, 'shellOption'));
def(['shopt'], (_args, st) => { st.parsed = false; });
def(['test', '['], (args, st) => { read(st, args.filter((a) => pathLike(a) && a !== ']')); P(st, 'check'); });
def(['export', 'unset', 'readonly', 'declare', 'typeset', 'local'], (args, st) => {
  const names: string[] = [];
  for (const a of args) {
    if (a.startsWith('-')) { if (a.includes('f') || a.includes('n')) { st.parsed = false; return; } continue; }
    const eq = a.indexOf('=');
    const n = eq >= 0 ? a.slice(0, eq) : a;
    if (isDangerousEnv(n)) { st.parsed = false; return; }
    names.push(n);
  }
  P(st, 'setVar', { name: fmtList(names) });
});
def(['perl', 'ruby', 'php', 'lua', 'osascript', 'Rscript', 'tclsh', 'jxa'], (args, st, name) => {
  const INLINE = ['-e', '-E', '-r', '--eval'];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (INLINE.includes(a)) {
      const v = args[++i];
      if (v === undefined) { st.parsed = false; return; }
      inlineCode(st, v);
      P(st, 'inlineCode', { lang: name });
      return;
    }
    if (a === '-') { runsInput(st, 'shell'); return; }
    if (a.startsWith('-')) { if (a.startsWith('-e') || a.startsWith('-E')) { st.parsed = false; return; } continue; }
    script(st, a);
    scriptArgs(st, args.slice(i + 1));
    P(st, 'runScript', { script: disp(st, [a]) });
    return;
  }
  runsInput(st, 'shell');
});
def(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'], (args, st) => {
  // `-c` is rejected by the tokenizer; here: a script file, or commands from stdin.
  const o = opts(args, ['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
  if (has(o, '-s') || o.operands.length === 0 || o.operands[0] === '-') { runsInput(st, 'shell'); return; }
  const [file, ...rest] = o.operands;
  script(st, file!);
  scriptArgs(st, rest);
  P(st, 'runScript', { script: disp(st, [file!]) });
});

/** Commands outside the dictionary: "Runs <cmd>", medium, and any outside path among the arguments may be written. */
function unknown(args: readonly string[], st: State, name: string): void {
  add(st, 'unknown-command', 'medium');
  scriptArgs(st, args);
  P(st, 'runs', { cmd: name });
}

const SYSTEM_BINS = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/sbin', '/usr/sbin', '/opt/local/bin', '/usr/local/sbin'];
const PY_OR_PIP = (b: string) => /^(python|pip)(\d+(\.\d+)?)?$/.test(b);

/** Explains one simple command's argv (wrappers and env already stripped by the tokenizer). */
export function explainArgv(argv: readonly string[], st: State): void {
  const raw = argv[0];
  if (raw === undefined) return;
  // A command name from a variable, a glob or a brace list (`$X`, `r?`, `{rm,-rf,~}`) can be anything.
  if (raw.includes('$') || raw.includes('*') || raw.includes('?') || raw.includes('[') || (raw.includes('{') && raw.includes(','))) { st.parsed = false; return; }
  let name = raw;
  const args = argv.slice(1);
  if (raw.includes('/')) {
    const slash = raw.lastIndexOf('/');
    const dir = raw.slice(0, slash);
    const base = raw.slice(slash + 1);
    const loc = locsOf(st, raw)[0];
    const inProject = loc !== undefined && (loc.cls === 'work' || loc.cls === 'project');
    if (SYSTEM_BINS.includes(dir) || (inProject && PY_OR_PIP(base) && dir.endsWith('/bin'))) name = base;
    else {
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
  if (name === 'popd') { st.cwd = null; P(st, 'cd', { path: '…' }); return; }
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
function subExplain(argv: readonly string[], st: State): void {
  const phrases = st.phrases;
  const cwd = st.cwd;
  st.phrases = [];
  explainArgv(argv, st);
  st.phrases = phrases;
  st.cwd = cwd;
}

/** Explains a whole simple command: wrappers, env, redirects and the command itself. Exactly one phrase is added. */
export function explainSimple(c: SimpleCommand, st: State): void {
  for (const k of Object.keys(c.env)) if (isDangerousEnv(k)) { st.parsed = false; return; }
  if (c.wrappers.includes('sudo')) add(st, 'elevated', 'high');
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

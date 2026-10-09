// Path resolution and classification for the explainer. Pure string work (no node:path: the web uses it too).
import { explainWork } from './work.ts';

export interface ExplainContext {
  projectDir: string;
  /** The creative's `work/` folder, when the job has one. */
  workDir?: string;
  home: string;
  /** Where relative paths start: the cwd of the `claude` process, which is the project directory (the default). */
  cwd?: string;
  /** The user's `$TMPDIR`, when known. */
  tmpDir?: string;
  /**
   * A placeholder folder that stands for unknown locations (the web uses it for a project or home it can't know).
   * Paths in it are never shown: the word as the agent wrote it is shown instead.
   */
  opaqueRoot?: string;
}

export type PathClass = 'work' | 'project' | 'tmp' | 'outside' | 'unknown';

export interface Loc {
  cls: PathClass;
  /** Normalized absolute path; null when it can't be known (`$VAR`, `~user`, unknown cwd). */
  abs: string | null;
  /** The word as written, for display when `abs` is null. */
  raw: string;
  /** Deleting or rewriting it would be catastrophic: `/`, home, the project or one of its ancestors, a temp root, or a glob directly in one of them. */
  critical: boolean;
}

const WORST: Record<PathClass, number> = { work: 0, project: 1, tmp: 2, outside: 3, unknown: 4 };
export const worstClass = (a: PathClass, b: PathClass): PathClass => (WORST[a] >= WORST[b] ? a : b);

const MAX_BRACE_GROUPS = 4;
const MAX_ALTERNATIVES = 32;
const MAX_DOTDOT_GLOBS = 3;
/** Longer than any real path (macOS PATH_MAX is 1024): such a path is unknown. Also bounds the work of long `cd a/b/…` chains. */
export const MAX_PATH = 4096;

/** `/private/tmp/x` → `/tmp/x` (macOS symlinks), so both spellings compare equal. */
function canonical(p: string): string {
  if (p === '/private/tmp' || p.startsWith('/private/tmp/') || p === '/private/var' || p.startsWith('/private/var/') || p === '/private/etc' || p.startsWith('/private/etc/')) return p.slice(8);
  return p;
}

/** Normalizes an absolute path: collapses `//`, `.` and `..`. */
export function normalizeAbs(p: string): string {
  explainWork.add(p.length);
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= p.length; i++) {
    if (i === p.length || p[i] === '/') {
      const seg = p.slice(start, i);
      start = i + 1;
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { out.pop(); continue; }
      out.push(seg);
    }
  }
  return canonical(`/${out.join('/')}`);
}

const isInside = (p: string, dir: string) => dir === '/' || p === dir || p.startsWith(`${dir}/`);
const isGlobSeg = (seg: string) => seg.includes('*') || seg.includes('?') || seg.includes('[');
/** A segment like `.*` or `.?` that a shell may expand to `..`. */
const canMatchDotDot = (seg: string) => seg.length >= 2 && seg[0] === '.' && (seg[1] === '*' || seg[1] === '?' || seg[1] === '[');

interface Dirs { project: string; work: string | null; home: string; tmpRoots: string[]; tmpDir: string | null }
const dirsCache = new WeakMap<ExplainContext, Dirs>();
function dirs(ctx: ExplainContext): Dirs {
  const hit = dirsCache.get(ctx);
  if (hit) return hit;
  const d = computeDirs(ctx);
  dirsCache.set(ctx, d);
  return d;
}
function computeDirs(ctx: ExplainContext): Dirs {
  const tmpDir = ctx.tmpDir ? normalizeAbs(ctx.tmpDir) : null;
  return {
    project: normalizeAbs(ctx.projectDir),
    work: ctx.workDir ? normalizeAbs(ctx.workDir) : null,
    home: normalizeAbs(ctx.home),
    tmpRoots: ['/tmp', ...(tmpDir ? [tmpDir] : [])],
    tmpDir,
  };
}

function classifyAbs(abs: string, d: Dirs): PathClass {
  if (d.work && isInside(abs, d.work)) return 'work';
  if (isInside(abs, d.project)) return 'project';
  if (d.tmpRoots.some((t) => isInside(abs, t))) return 'tmp';
  return 'outside';
}

function isCriticalDir(dir: string, d: Dirs): boolean {
  return dir === '/' || dir === d.home || isInside(d.project, dir) || d.tmpRoots.includes(dir);
}

/** Expands `{a,b}` groups (not nested, at most 4 groups, 32 results); null when it can't be modeled. */
function expandBraces(word: string): string[] | null {
  let results = [word];
  for (let groups = 0; ; groups++) {
    const next: string[] = [];
    let expanded = false;
    for (const w of results) {
      let from = 0;
      let done = false;
      while (!done) {
        const open = w.indexOf('{', from);
        if (open < 0) { next.push(w); break; }
        let close = -1;
        let comma = false;
        for (let j = open + 1; j < w.length; j++) {
          const c = w[j];
          if (c === '{') return null; // nested
          if (c === ',') comma = true;
          if (c === '}') { close = j; break; }
        }
        if (close < 0) { next.push(w); break; } // a lone `{` is literal
        if (!comma) { from = close + 1; continue; } // `{}`, `{1..3}`: literal for our purposes
        const head = w.slice(0, open);
        const tail = w.slice(close + 1);
        for (const alt of w.slice(open + 1, close).split(',')) next.push(head + alt + tail);
        expanded = true;
        done = true;
      }
      if (next.length > MAX_ALTERNATIVES) return null;
    }
    results = next;
    for (const w of next) explainWork.add(w.length);
    if (!expanded) return results;
    if (groups + 1 >= MAX_BRACE_GROUPS) {
      // More groups left: give up rather than guess.
      return results.some((w) => w.includes('{') && w.includes(',')) ? null : results;
    }
  }
}

const startsVar = (p: string, name: string): string | null => {
  for (const form of [`$${name}`, `\${${name}}`]) {
    if (p === form) return '';
    if (p.startsWith(`${form}/`)) return p.slice(form.length);
  }
  return null;
};

function resolveOne(p: string, cwd: string | null, d: Dirs, depth: number): Loc[] {
  explainWork.add(p.length + (cwd?.length ?? 0));
  const unknown: Loc[] = [{ cls: 'unknown', abs: null, raw: p, critical: true }];
  if (p === '') return unknown;
  let path = p;
  if (path === '~' || path.startsWith('~/')) path = d.home + path.slice(1);
  else if (path.startsWith('~')) return unknown;
  else {
    const home = startsVar(path, 'HOME');
    const tmp = startsVar(path, 'TMPDIR');
    const pwd = startsVar(path, 'PWD');
    if (home !== null) path = d.home + home;
    else if (pwd !== null) { if (cwd === null) return unknown; path = cwd + pwd; }
    else if (tmp !== null) {
      if (d.tmpDir) path = d.tmpDir + tmp;
      else {
        // $TMPDIR without its value: still the temp folder unless the rest climbs out of it.
        if (tmp.includes('$') || tmp.split('/').includes('..')) return unknown;
        return [{ cls: 'tmp', abs: null, raw: p, critical: tmp === '' || tmp === '/' || isGlobSeg(tmp.split('/')[1] ?? '') }];
      }
    }
  }
  if (path.includes('$')) return unknown;
  if (!path.startsWith('/')) {
    if (cwd === null) return unknown;
    path = `${cwd}/${path}`;
  }
  if (path.length > MAX_PATH) return unknown;
  // Split, keeping glob segments as text; a `.*`-like segment may also mean `..`.
  const segs = path.split('/');
  const extra: Loc[] = [];
  for (let k = 0; k < segs.length; k++) {
    if (canMatchDotDot(segs[k]!)) {
      if (depth >= MAX_DOTDOT_GLOBS) return unknown;
      const alt = [...segs.slice(0, k), '..', ...segs.slice(k + 1)].join('/');
      for (const l of resolveOne(alt, cwd, d, depth + 1)) extra.push({ ...l, raw: p, critical: true });
      break;
    }
  }
  const abs = normalizeAbs(path);
  const parts = abs.split('/').slice(1);
  const g = parts.findIndex(isGlobSeg);
  const critical = g >= 0 ? isCriticalDir(`/${parts.slice(0, g).join('/')}`, d) : isCriticalDir(abs, d);
  return [{ cls: classifyAbs(abs, d), abs, raw: p, critical }, ...extra];
}

/** Every location a shell word may refer to (brace expansion and `.*` can give several). */
export function resolveLocs(word: string, cwd: string | null, ctx: ExplainContext): Loc[] {
  const d = dirs(ctx);
  const alts = expandBraces(word);
  if (!alts) return [{ cls: 'unknown', abs: null, raw: word, critical: true }];
  const base = cwd === null ? null : normalizeAbs(cwd);
  return alts.flatMap((a) => resolveOne(a, base, d, 0));
}

/** Classifies a path written in a command, resolved from `ctx.cwd` (default: the project). Several meanings → the worst. */
export function classifyPath(p: string, ctx: ExplainContext): PathClass {
  return resolveLocs(p, ctx.cwd ?? ctx.projectDir, ctx).reduce<PathClass>((w, l) => worstClass(w, l.cls), 'work');
}

/** How a location is shown: relative to the project inside it, `$TMPDIR/…`, `~/…`, otherwise abbreviated. Never the home path. */
export function displayLoc(l: Loc, ctx: ExplainContext): string {
  if (l.abs === null) return l.raw;
  const d = dirs(ctx);
  const abs = l.abs;
  const opaque = ctx.opaqueRoot ? normalizeAbs(ctx.opaqueRoot) : null;
  if (isInside(abs, d.project)) {
    if (abs === d.project) return opaque && isInside(abs, opaque) ? l.raw : `${d.project.slice(d.project.lastIndexOf('/') + 1)}/`;
    return abs.slice(d.project.length + 1);
  }
  if (d.tmpDir && isInside(abs, d.tmpDir)) return abs === d.tmpDir ? '$TMPDIR' : `$TMPDIR/${abs.slice(d.tmpDir.length + 1)}`;
  if (d.home !== '/' && isInside(abs, d.home)) return abs === d.home ? '~' : `~/${abs.slice(d.home.length + 1)}`;
  if (opaque && isInside(abs, opaque)) return l.raw;
  const parts = abs.split('/').slice(1);
  if (parts.length <= 3) return abs;
  return `/${parts[0]}/…/${parts[parts.length - 1]}`;
}

/** Device files that read or write nothing on disk. */
export function isHarmlessDevice(abs: string | null): boolean {
  return abs === '/dev/null' || abs === '/dev/stdout' || abs === '/dev/stderr' || abs === '/dev/stdin' || abs === '/dev/tty'
    || abs === '/dev/zero' || abs === '/dev/random' || abs === '/dev/urandom' || (abs !== null && abs.startsWith('/dev/fd/'));
}

/** Directory part of an absolute path. */
export const dirnameAbs = (abs: string): string => (abs.lastIndexOf('/') <= 0 ? '/' : abs.slice(0, abs.lastIndexOf('/')));

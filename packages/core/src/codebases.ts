import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, parse, relative } from 'node:path';
import { isSecretPath, SECRET_PATTERNS, type LinkedCodebase } from '@motion-studio/shared';
import { messages, type Locale } from '@motion-studio/shared';
import { codebaseOverlaps, expandHome, normalizeCodebasePath, pathHasGlobChars } from './workspace-store.ts';
import { currentLocale } from './i18n.ts';
import { sensitiveHomeEntries } from './agent/sandbox.ts';

// Defined next to WorkspaceStore (which needs it) to avoid an import cycle.
export { assertCodebasesLiteral, assertCodebasesOutside, codebaseGlobCharsMessage, codebaseHasGlobChars, codebaseOverlapMessage, codebaseOverlaps, GLOB_PATH_CHARS, normalizeCodebasePath, normalizeCodebaseList, pathHasGlobChars } from './workspace-store.ts';

export interface CodebaseCheck { path: string; note?: string; exists: boolean }

export async function checkCodebases(list: LinkedCodebase[]): Promise<CodebaseCheck[]> {
  const seen = new Set<string>();
  const out: CodebaseCheck[] = [];
  for (const c of list) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    const exists = Boolean((await stat(c.path).catch(() => null))?.isDirectory());
    out.push({ path: c.path, ...(c.note ? { note: c.note } : {}), exists });
  }
  return out;
}

/** Claude Code permission rule syntax: an absolute path is written with a leading '//'. */
/** Glob metacharacters in the path are escaped so a folder like `cb [x]` or `app {a,b}` is matched literally. */
export const escapeGlob = (p: string) => p.replace(/[\\[\]*?{}()!+@]/g, '\\$&');
export const dirDenyRules = (tools: string[], dirs: string[]) => dirs.flatMap((d) => tools.map((t) => `${t}(/${escapeGlob(d)}/**)`));
export const readOnlyRules = (paths: string[]) => dirDenyRules(['Edit'], paths);
/** Deny rules for each tool on each exact absolute file path (same escaping as readOnlyRules). */
export const fileDenyRules = (tools: string[], files: string[]) => files.flatMap((f) => tools.map((t) => `${t}(/${escapeGlob(f)})`));

/** Deny rules for each tool on a glob over absolute paths; the caller escapes the literal parts (`escapeGlob`) and leaves the wildcards. */
export const globDenyRules = (tools: string[], globs: string[]) => globs.flatMap((g) => tools.map((t) => `${t}(/${g})`));

export type Snapshot = { value: string } | { unavailable: 'not-git' | 'failed' };
export interface HashedRun { code: number; hash: string; stderr: string; timedOut: boolean }
export type HashedExec = (args: string[]) => Promise<HashedRun>;

/**
 * Hooks and an fsmonitor command configured in a linked repository must never run from Motion Studio; nor an external diff, a textconv or a clean filter (`--no-ext-diff --no-textconv`, `--no-filters`, decisions log 141).
 * `--no-optional-locks` (and `GIT_OPTIONAL_LOCKS=0` in GIT_ENV): a status never refreshes the user's `.git/index` nor takes its lock (decision 782).
 */
export const GIT_SAFE = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
// Stable, untranslated git output whatever the user's locale; no optional locks in the user's repository.
export const GIT_ENV = () => ({ ...process.env, GIT_EXTERNAL_DIFF: undefined, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' });

/** Runs git without a shell, streaming stdout into a sha256 (no size limit); killed after the timeout. */
export const gitHashed = (path: string, timeoutMs = 30_000): HashedExec => (args) => new Promise((resolve) => {
  const hash = createHash('sha256');
  let stderr = '';
  let timedOut = false;
  let settled = false;
  const child = spawn('git', [...GIT_SAFE, '-C', path, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV() });
  const done = (code: number) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, hash: hash.digest('hex'), stderr, timedOut }); } };
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  child.stdout.on('data', (d: Buffer) => hash.update(d));
  child.stderr.on('data', (d: Buffer) => { if (stderr.length < 2000) stderr += d.toString(); });
  child.on('error', () => done(-1));
  child.on('close', (code) => done(code ?? -1));
});

/**
 * Hash of the contents of the untracked (not ignored) files under the folder: `git ls-files -o` streamed into
 * `git hash-object --stdin-paths`, so nothing is buffered whatever the number of files.
 */
export const untrackedContentHash = (path: string, timeoutMs = 30_000) => (): Promise<HashedRun> => new Promise((resolve) => {
  const hash = createHash('sha256');
  let stderr = '';
  let timedOut = false;
  let settled = false;
  const codes: Array<number | null> = [];
  const list = spawn('git', [...GIT_SAFE, '-C', path, 'ls-files', '-o', '--exclude-standard', '-z', '--', '.'], { stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV() });
  const hasher = spawn('git', [...GIT_SAFE, '-C', path, 'hash-object', '--no-filters', '--stdin-paths'], { stdio: ['pipe', 'pipe', 'pipe'], env: GIT_ENV() });
  const finish = (code: number) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, hash: hash.digest('hex'), stderr, timedOut }); } };
  const timer = setTimeout(() => { timedOut = true; list.kill('SIGKILL'); hasher.kill('SIGKILL'); }, timeoutMs);
  const onClose = (code: number | null) => { codes.push(code); if (codes.length === 2) finish(codes.every((c) => c === 0) ? 0 : 1); };
  let pending = Buffer.alloc(0);
  list.stdout.on('data', (d: Buffer) => {
    pending = Buffer.concat([pending, d]); // split on NUL bytes first: a chunk may end inside a multi-byte character
    const parts: string[] = [];
    for (let i = pending.indexOf(0); i >= 0; i = pending.indexOf(0)) { parts.push(pending.subarray(0, i).toString('utf8')); pending = pending.subarray(i + 1); }
    // Nested repositories are listed as `dir/` (not hashable); hash-object reads one path per line.
    const paths = parts.filter((p) => p && !p.endsWith('/') && !p.includes('\n'));
    if (paths.length && !hasher.stdin.write(`${paths.join('\n')}\n`)) { list.stdout.pause(); hasher.stdin.once('drain', () => list.stdout.resume()); }
  });
  list.on('close', (code) => { hasher.stdin.end(); onClose(code); });
  hasher.stdin.on('error', () => { /* hasher died: its exit code reports it */ });
  hasher.stdout.on('data', (d: Buffer) => hash.update(d));
  for (const c of [list, hasher]) {
    c.stderr.on('data', (d: Buffer) => { if (stderr.length < 2000) stderr += d.toString(); });
    c.on('error', () => finish(-1));
  }
  hasher.on('close', onClose);
});

/**
 * Fingerprint of a git working tree, scoped to the linked folder (`-- .`): hash of the status (untracked files listed,
 * ignored directories collapsed), of the content diff against HEAD (editing an already-modified file changes it) and of
 * the untracked files' contents.
 */
export async function codebaseSnapshot(path: string, run: HashedExec = gitHashed(path), untracked: () => Promise<HashedRun> = untrackedContentHash(path), meta: () => Promise<string | null> = () => gitMetaHash(path)): Promise<Snapshot> {
  const status = await run(['status', '--porcelain=v1', '-uall', '--ignored=traditional', '--', '.']);
  if (status.timedOut) return { unavailable: 'failed' };
  if (status.code !== 0) return { unavailable: /not a git repository/i.test(status.stderr) ? 'not-git' : 'failed' };
  // Plumbing (decision 782): the porcelain `git diff` refreshes and rewrites the user's `.git/index` even without optional
  // locks; `diff-index -p` / `diff-files -p` give the same patch and never write it.
  let diff = await run(['diff-index', '-p', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--', '.']);
  if (!diff.timedOut && diff.code !== 0) diff = await run(['diff-files', '-p', '--no-ext-diff', '--no-textconv', '--binary', '--', '.']); // repository without commits
  if (diff.timedOut || diff.code !== 0) return { unavailable: 'failed' };
  const extra = await untracked();
  if (extra.timedOut || extra.code !== 0) return { unavailable: 'failed' };
  // Phase 14 fix round 1: the repository's own config, HEAD and hooks (git never lists them in a status).
  const repo = await meta();
  if (repo === null) return { unavailable: 'failed' };
  return { value: `${status.hash}:${diff.hash}:${extra.hash}:${repo}` };
}

// ---------------------------------------------------------------------------------------------------------------------
// Phase 14 (spec §2.2): a brand analysis reads a whole codebase, never its secret files.
// ---------------------------------------------------------------------------------------------------------------------

/** C0 and C1 control characters and DEL: a rule or a sandbox entry cannot carry them safely, so such a folder is refused. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
export const hasUnsafePathChars = (p: string): boolean => CONTROL_CHARS.test(p);

/**
 * Every letter as a two-letter class (`e` → `[eE]`): the glob matches whatever the case. Applied to an already escaped
 * glob, letters are never part of an escape sequence (escapeGlob only escapes punctuation).
 */
export const caseFoldGlob = (glob: string): string => glob.replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

/**
 * Glob suffixes (after `<root>/**` + `/`) for every SECRET_PATTERNS entry: the pattern as written and `<pattern>/**`, since
 * any of them can name a folder (`isSecretPath` checks every segment: a folder `keys.key/` or `secrets/` is secret).
 * `exact` keeps the case, `folded` matches any case (decision 742).
 */
function secretSuffixes(fold: boolean): string[] {
  const out: string[] = [];
  for (const raw of SECRET_PATTERNS) {
    const base = raw.replace(/\/\*\*$/, '');
    const name = fold ? caseFoldGlob(base) : base;
    out.push(name, `${name}/**`);
  }
  return out;
}
const EXACT_SUFFIXES = secretSuffixes(false);
const FOLDED_SUFFIXES = secretSuffixes(true);

/**
 * `Read` deny rules for the secret files of one codebase (absolute path, already normalised): `Read(//<path>/**` + `/<pattern>)`
 * for each SECRET_PATTERNS entry, in the exact case and again with every letter (of the folder and of the pattern) as a
 * case class, so a case-sensitive matcher still denies `.ENV` or `/USERS/me/app/.env` on a case-insensitive disk. Glob
 * characters of the folder are escaped (escapeGlob); a folder with control characters gets no rules: callers refuse it.
 * No Grep/Glob forms: Grep is denied outright to these jobs, and Glob only lists names (fix round 1, decisions log).
 */
export function secretReadRules(path: string): string[] {
  if (hasUnsafePathChars(path)) return [];
  const root = escapeGlob(path);
  const folded = caseFoldGlob(root);
  return [
    ...EXACT_SUFFIXES.map((s) => `Read(/${root}/**/${s})`),
    ...FOLDED_SUFFIXES.map((s) => `Read(/${folded}/**/${s})`),
  ];
}

/**
 * Sandbox `denyRead` globs for one codebase: the same patterns, with the folder made literal by `sandboxPath` (a function
 * argument, to avoid an import cycle with policy.ts). macOS expands globs in the sandbox; Linux/WSL skip glob entries,
 * which is why the concrete secret files found by `findCodebaseSecrets` are listed too.
 */
export function secretSandboxGlobs(path: string, literal: (p: string) => string): string[] {
  if (hasUnsafePathChars(path)) return [];
  const root = literal(path);
  return [...EXACT_SUFFIXES, ...FOLDED_SUFFIXES].map((s) => `${root}/**/${s}`);
}

export interface CodebaseSecrets {
  /** Absolute paths (as reached under `root`) of secret files, and of links whose target is a secret or leaves the codebase. */
  files: string[];
  /** Absolute paths of secret folders (e.g. `.git`, `config/secrets`): denied with everything inside. */
  dirs: string[];
  /** The walk stopped at its cap: secrets past it are covered by the glob rules only. */
  truncated: boolean;
}

const SECRET_WALK_ENTRIES = 50_000;
const SECRET_WALK_DEPTH = 24;
const SECRET_LIST_MAX = 400;
/** Not descended: `node_modules` is huge and third-party (the glob rules still cover it). Secret folders are denied whole. */
const WALK_SKIP = new Set(['node_modules']);

/**
 * The secret files and folders that exist now under a codebase (case-insensitive, `isSecretPath`), found by a bounded walk
 * that never follows links. Turned into exact deny rules and sandbox entries: they hold whatever the case of the name and
 * on every platform, unlike the globs. A link is listed when its target is a secret or lies outside the codebase.
 */
export async function findCodebaseSecrets(root: string): Promise<CodebaseSecrets> {
  const out: CodebaseSecrets = { files: [], dirs: [], truncated: false };
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot) return out;
  let seen = 0;
  const full = () => out.files.length + out.dirs.length >= SECRET_LIST_MAX;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > SECRET_WALK_DEPTH) { out.truncated = true; return; }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (++seen > SECRET_WALK_ENTRIES || full()) { out.truncated = true; return; }
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (isSecretPath(childRel)) {
        (e.isDirectory() ? out.dirs : out.files).push(abs);
        continue;
      }
      if (e.isSymbolicLink()) {
        const target = await realpath(abs).catch(() => null);
        if (target === null) continue;
        const inside = relative(realRoot, target);
        if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || isSecretPath(inside) || isSecretPath(basename(target))) out.files.push(abs);
        continue;
      }
      if (e.isDirectory() && !WALK_SKIP.has(e.name)) await walk(abs, childRel, depth + 1);
      if (out.truncated) return;
    }
  };
  await walk(root, '', 0);
  return out;
}

export type BrandCodebaseProblem = 'unsafe-path' | 'glob-chars' | 'not-absolute' | 'disk-root' | 'home' | 'missing' | 'overlap' | 'nested' | 'config' | 'sensitive';
/** Why a codebase folder is refused, in `locale` (the route's error, the analysis's note). */
export function codebaseProblemText(problem: BrandCodebaseProblem, path: string, locale: Locale = currentLocale()): string {
  const e = messages(locale).errors;
  switch (problem) {
    case 'unsafe-path': return e.codebaseUnsafePath;
    case 'glob-chars': return e.codebaseGlobChars({ path });
    case 'not-absolute': return e.codebaseNotAbsolute({ path });
    case 'disk-root': return e.codebaseDiskRoot;
    case 'home': return e.codebaseHome;
    case 'missing': return e.codebaseSourceMissing({ path });
    case 'overlap': return e.codebaseOverlapBrand;
    case 'nested': return e.codebaseNestedBrand;
    case 'config': return e.codebaseConfigBrand;
    case 'sensitive': return e.codebaseSensitiveBrand;
  }
}
/** A brand codebase source ready for use: the normalised spelling and its real path (equal when no link is involved). */
export interface BrandCodebase { path: string; real: string }

/**
 * Validates one brand codebase folder before any use (route and analysis): no control characters, normalised (absolute or
 * `~`, never the disk root or the home, also after resolving links), an existing folder, outside `protectedDirs` (the
 * project and the workspace) under both spellings.
 */
/** Home folders a brand codebase may neither be, sit in, nor contain (fix round 1): credentials, keychains, app data. */
export const sensitiveCodebaseDirs = (home: string): string[] => [...sensitiveHomeEntries(home).dirs, ...sensitiveHomeEntries(home).files, join(home, 'Library'), join(home, '.config')];

export interface BrandCodebaseChecks {
  /** Motion Studio's config folder (tokens): never inside or around a codebase. */
  configDir?: string;
  /** The analysis's other codebases (already accepted): a codebase inside or around one of them is refused (`nested`). */
  others?: string[];
}

export async function resolveBrandCodebase(raw: string, protectedDirs: string[], checks: BrandCodebaseChecks = {}): Promise<BrandCodebase | { problem: BrandCodebaseProblem }> {
  if (hasUnsafePathChars(raw)) return { problem: 'unsafe-path' };
  const home = homedir().replace(/\/+$/, '');
  const expanded = normalize(expandHome(raw.trim()));
  if (!isAbsolute(expanded)) return { problem: 'not-absolute' };
  if (expanded.replace(/\/+$/, '') === '') return { problem: 'disk-root' };
  if (expanded.replace(/\/+$/, '') === home) return { problem: 'home' };
  const path = normalizeCodebasePath(raw);
  // Decision 781: the agent's rules cannot match a path with glob characters (decision 780), under either spelling.
  if (pathHasGlobChars(path)) return { problem: 'glob-chars' };
  const st = await stat(path).catch(() => null);
  if (!st?.isDirectory()) return { problem: 'missing' };
  const real = await realpath(path).catch(() => null);
  if (real === null) return { problem: 'missing' };
  // A link to the disk root or to the home folder is the disk root or the home folder.
  if (hasUnsafePathChars(real)) return { problem: 'unsafe-path' };
  if (pathHasGlobChars(real)) return { problem: 'glob-chars' };
  if (real === parse(real).root) return { problem: 'disk-root' };
  if (real === home || real === await realpath(home).catch(() => home)) return { problem: 'home' };
  if (await codebaseOverlaps(path, protectedDirs)) return { problem: 'overlap' };
  if (checks.configDir && await codebaseOverlaps(path, [checks.configDir])) return { problem: 'config' };
  if (await codebaseOverlaps(path, sensitiveCodebaseDirs(home))) return { problem: 'sensitive' };
  if (checks.others?.length && await codebaseOverlaps(path, checks.others)) return { problem: 'nested' };
  return { path, real };
}

/** Both spellings of a resolved codebase, for rules: the user's and the real one (deduplicated). */
export const codebaseSpellings = (c: BrandCodebase): string[] => (c.path === c.real ? [c.path] : [c.path, c.real]);

/**
 * The working-tree entries git reports as changed under the folder (status line and content hash of each), for listing what
 * an agent changed. Capped; null when git cannot tell (not a repository, failure).
 */
export async function codebaseFileStates(path: string, timeoutMs = 30_000, cap = 5000): Promise<Map<string, string> | null> {
  const status = await gitText(path, ['status', '--porcelain=v1', '-z', '-uall', '--ignored=traditional', '--', '.'], timeoutMs);
  if (status === null) return null;
  const states = new Map<string, string>();
  const records = status.split('\0');
  for (let i = 0; i < records.length && states.size < cap; i++) {
    const r = records[i]!;
    if (r.length < 4) continue;
    const code = r.slice(0, 2);
    const file = r.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // the next record is the source of a rename/copy
    states.set(file, code);
  }
  const files = [...states.keys()].filter((f) => !f.endsWith('/') && !f.includes('\n'));
  if (files.length) {
    const hashes = await gitText(path, ['hash-object', '--no-filters', '--stdin-paths'], timeoutMs, `${files.join('\n')}\n`);
    if (hashes !== null) {
      const lines = hashes.trim().split('\n');
      if (lines.length === files.length) files.forEach((f, k) => states.set(f, `${states.get(f)} ${lines[k]}`));
    }
  }
  return states;
}

/** Files whose state differs between two `codebaseFileStates` captures (appeared, gone or changed), sorted. */
export function changedCodebaseFiles(before: Map<string, string> | null, after: Map<string, string> | null): string[] {
  if (!before || !after) return [];
  const out = new Set<string>();
  for (const [f, s] of after) if (before.get(f) !== s) out.add(f);
  for (const f of before.keys()) if (!after.has(f)) out.add(f);
  return [...out].sort();
}

/**
 * Hash of the repository's `config`, `HEAD` and `hooks/` (each entry: kind, link target or content), found with
 * `git rev-parse --absolute-git-dir`: files git runs or obeys that a status never shows. Null when git cannot tell.
 */
export async function gitMetaHash(path: string, timeoutMs = 30_000): Promise<string | null> {
  const out = await gitText(path, ['rev-parse', '--absolute-git-dir'], timeoutMs);
  const gitDir = out?.trim();
  if (!gitDir) return null;
  const hash = createHash('sha256');
  const entry = async (abs: string, name: string) => {
    const st = await lstat(abs).catch(() => null);
    hash.update(`\0${name}\0`);
    if (!st) { hash.update('absent'); return; }
    if (st.isSymbolicLink()) { hash.update(`link:${await readlink(abs).catch(() => '?')}`); return; }
    if (st.isFile()) { hash.update(`file:${st.mode}:`); hash.update(st.size <= 4 * 1024 * 1024 ? await readFile(abs).catch(() => Buffer.from('?')) : `big:${st.size}:${st.mtimeMs}`); return; }
    hash.update(`${st.isDirectory() ? 'dir' : 'other'}:${st.mode}`);
  };
  await entry(join(gitDir, 'config'), 'config');
  await entry(join(gitDir, 'HEAD'), 'HEAD');
  await entry(join(gitDir, 'hooks'), 'hooks');
  const hooks = (await readdir(join(gitDir, 'hooks')).catch(() => [] as string[])).sort();
  for (const h of hooks.slice(0, 500)) await entry(join(gitDir, 'hooks', h), `hooks/${h}`);
  return hash.digest('hex');
}

/** git's stdout as text (capped at 4 MB), or null on a non-zero exit, a timeout or a spawn error. Same safe options as gitHashed. */
function gitText(path: string, args: string[], timeoutMs: number, input?: string): Promise<string | null> {
  return new Promise((resolveText) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const child = spawn('git', [...GIT_SAFE, '-C', path, ...args], { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], env: GIT_ENV() });
    const done = (v: string | null) => { if (!settled) { settled = true; clearTimeout(timer); resolveText(v); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, timeoutMs);
    child.stdout!.on('data', (d: Buffer) => { if (size < 4 * 1024 * 1024) { chunks.push(d); size += d.length; } });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? Buffer.concat(chunks).toString('utf8') : null));
    if (input !== undefined) { child.stdin!.on('error', () => {}); child.stdin!.end(input); }
  });
}

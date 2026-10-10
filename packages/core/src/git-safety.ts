import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execCommand, type CommandExec } from './exec.ts';
import { t } from './i18n.ts';
import { readRegularFile } from './safe-read.ts';

/** Largest attributes file read (git's own attribute files stay far below it); a bigger one is refused, never read. */
export const MAX_ATTRIBUTES_BYTES = 1024 * 1024;

/**
 * Git hardening against a tampered repository (decisions log 141). The agent can write inside the project, and under a
 * workspace path with `[ ] * ?` (or by moving the whole project folder out of the sandbox and back, or with the sandbox
 * off) it can reach `.git` and the attributes files. A `filter.<x>.clean`, a `diff.<x>.textconv`, a `core.sshCommand`, an
 * `include.path`, a `commondir` pointing at another config and the like all run a command or load a file OUTSIDE the
 * sandbox on the core's next `git add`/`commit`. Before every core git call the repository layout, the config (as git
 * itself reports it, with its origin) and every attributes file are checked; anything else blocks the repo.
 */

/** `-c` flags on every core git call: hooks and the fsmonitor never run. */
export const HARDENED_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/**
 * The environment of every core git call: nothing inherited from `GIT_*` (a `GIT_DIR`, `GIT_CONFIG_PARAMETERS`,
 * `GIT_INDEX_FILE`, `GIT_EXTERNAL_DIFF`… set when the app started would redirect git or add config), no system or global
 * config, no system attributes. With `dir`, the repository is pinned: `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR`
 * (the last one wins over a `.git/commondir` file). `init` passes no `dir` (it creates the repository in its cwd).
 */
export function hardenedGitEnv(dir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' });
  if (dir !== undefined) {
    const root = resolve(dir);
    Object.assign(env, { GIT_DIR: join(root, '.git'), GIT_WORK_TREE: root, GIT_COMMON_DIR: join(root, '.git') });
  }
  return env;
}

/** Exactly the keys a fresh `git init -b main` writes (verified on git 2.x), lowercased `section.key`. `user.*` is allowed on top (the core passes its identity with `-c`, but a stored one is harmless). */
const ALLOWED_CONFIG_KEYS = new Set([
  'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates',
  'core.ignorecase', 'core.precomposeunicode', 'core.symlinks', 'core.hidedotfiles',
]);
/**
 * Second tier (compatibility, decisions log 141): keys an existing repo may legitimately carry after the user added a
 * remote. The core never fetches, pushes or pulls, so they are inert for it; still, a value with `!`, `ext::` or a
 * `--upload-pack`/`--receive-pack` option is refused (those are the forms that make git run a command).
 */
const REMOTE_KEYS = new Set(['url', 'pushurl', 'fetch']);
const BRANCH_KEYS = new Set(['remote', 'merge', 'rebase']);
const isDangerousValue = (v: string) => { const l = v.toLowerCase(); return l.includes('!') || l.includes('ext::') || l.includes('--upload-pack') || l.includes('--receive-pack'); };

export class GitUnsafeError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = 'GitUnsafeError';
  }
}

export interface ConfigEntry { origin: string; key: string; value: string | null }

/** Parses `git config --list --show-origin --null`: `origin NUL key [LF value] NUL`, repeated. */
export function parseGitConfigList(out: string): ConfigEntry[] {
  const parts = out.split('\0');
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const origin = parts[i]!;
    const kv = parts[i + 1]!;
    const nl = kv.indexOf('\n');
    entries.push({ origin, key: nl < 0 ? kv : kv.slice(0, nl), value: nl < 0 ? null : kv.slice(nl + 1) });
  }
  return entries;
}

/** Splits a git-reported key (`section[.subsection].name`, section and name already lowercased by git). */
function splitKey(key: string): { section: string; subsection: string | undefined; name: string } {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first < 0) return { section: key, subsection: undefined, name: '' };
  return { section: key.slice(0, first), subsection: first === last ? undefined : key.slice(first + 1, last), name: key.slice(last + 1) };
}

/** 'ok', 'key' (the key itself is not allowed) or 'value' (an allowed second-tier key with a dangerous value). */
export function configVerdict(key: string, value: string | null): 'ok' | 'key' | 'value' {
  const { section, subsection, name } = splitKey(key);
  if (subsection === undefined) {
    if (section === 'user') return 'ok';
    return ALLOWED_CONFIG_KEYS.has(`${section}.${name}`) ? 'ok' : 'key';
  }
  if ((section === 'remote' && REMOTE_KEYS.has(name)) || (section === 'branch' && BRANCH_KEYS.has(name))) {
    return value !== null && isDangerousValue(value) ? 'value' : 'ok';
  }
  return 'key';
}

/** Diff drivers built into git (userdiff.c): word regexes and hunk headers only, no command. */
const BUILTIN_DIFF = new Set([
  'ada', 'bash', 'bibtex', 'cpp', 'csharp', 'css', 'dts', 'elixir', 'fortran', 'fountain', 'golang', 'html', 'java',
  'kotlin', 'markdown', 'matlab', 'objc', 'pascal', 'perl', 'php', 'python', 'ruby', 'rust', 'scheme', 'tex',
]);

/**
 * Attribute tokens that make git run a command or load a driver. `merge=union|binary|text` are built-ins; `diff=<name>`
 * is fine for a built-in name as long as the config defines no `diff.<name>.*` (which the allowlist refuses anyway).
 */
function dangerousAttr(token: string, configKeys: ReadonlySet<string>): boolean {
  const eq = token.indexOf('=');
  if (eq <= 0) return false;
  const name = token.slice(0, eq);
  const value = token.slice(eq + 1);
  if (name === 'filter') return true;
  if (name === 'diff') return !BUILTIN_DIFF.has(value) || [...configKeys].some((k) => k.startsWith(`diff.${value}.`));
  if (name === 'merge') return value !== 'union' && value !== 'binary' && value !== 'text';
  return false;
}

/**
 * Lines of an attributes file that set a dangerous attribute. Only a line whose first non-blank character is `#` is a
 * comment (git does not strip a `#` in the middle of a line: `*#* filter=x` applies `filter=x` to `a#b`). Every token is
 * checked, the pattern too (fail closed for a quoted pattern with spaces).
 */
export function dangerousAttributeLines(text: string, configKeys: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.split(/\s+/).some((tok) => dangerousAttr(tok, configKeys))) out.push(line);
  }
  return out;
}

type Lstat = Awaited<ReturnType<typeof lstat>>;
/** lstat that returns null only for a missing entry; any other error (EACCES, ENOTDIR, ELOOP…) throws. */
async function lstatMissing(p: string): Promise<Lstat | null> {
  try { return await lstat(p); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
/**
 * Checks a project's repository. Returns null when safe, or a localized message naming the first problem and how to fix
 * it. A project with no `.git` yet (before `git init`) is safe. Fails closed: an unexpected read error is a problem.
 */
export async function inspectGitSafety(projectDir: string, exec: CommandExec = execCommand): Promise<string | null> {
  const e = t().errors;
  const unsafe = (detail: string) => e.gitRepoUnsafe({ detail });
  const gitDir = join(projectDir, '.git');
  try {
    const st = await lstatMissing(gitDir);
    if (st === null) return null;
    // A `gitdir:` file (or a link) would point git at a config and objects anywhere on disk.
    if (!st.isDirectory()) return e.gitDirNotFolder;
    for (const name of ['commondir', 'config.worktree']) {
      if ((await lstatMissing(join(gitDir, name))) !== null) return e.gitLayoutFile({ file: `.git/${name}` });
    }
    const cfg = await lstatMissing(join(gitDir, 'config'));
    if (cfg !== null && !cfg.isFile()) return unsafe('.git/config is not a regular file');
  } catch (err) {
    return unsafe(`.git could not be inspected (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }

  // Ask git itself which config it would load, with the origin of each key: includes, a `config.worktree` or any parser
  // drift show up as an origin other than the project's own `.git/config`.
  const env = hardenedGitEnv(projectDir);
  const list = await exec('git', [...HARDENED_FLAGS, 'config', '--list', '--show-origin', '--null'], { cwd: projectDir, env });
  if (list.notFound) return null; // the git call itself reports "git not found"
  if (list.code !== 0) return unsafe(`git config could not be read: ${list.stderr.trim().slice(0, 200)}`);
  const own = new Set([join(resolve(projectDir), '.git', 'config')]);
  own.add(join(await realpath(projectDir).catch(() => resolve(projectDir)), '.git', 'config'));
  const entries = parseGitConfigList(list.stdout);
  for (const entry of entries) {
    if (entry.origin === 'command line:') continue; // only the core's own `-c` (GIT_CONFIG_PARAMETERS is stripped)
    const file = entry.origin.startsWith('file:') ? resolve(projectDir, entry.origin.slice(5)) : null;
    if (file === null || !own.has(file)) return e.gitConfigOrigin({ key: entry.key, origin: entry.origin });
    const verdict = configVerdict(entry.key, entry.value);
    if (verdict === 'key') return e.gitConfigKeyBlocked({ key: entry.key });
    if (verdict === 'value') return e.gitConfigValueBlocked({ key: entry.key });
  }
  const keys = new Set(entries.map((x) => x.key));

  // Every attributes file git could honour: tracked, untracked and ignored ones (an ignored folder may hold tracked files),
  // plus `.git/info/attributes`. `ls-files` runs no filter.
  const files = await exec('git', [...HARDENED_FLAGS, 'ls-files', '-z', '--cached', '--others', '--', ':(glob)**/.gitattributes'], { cwd: projectDir, env });
  if (files.code !== 0) return unsafe(`git ls-files failed: ${files.stderr.trim().slice(0, 200)}`);
  const rels = [...new Set(files.stdout.split('\0').filter((p) => p !== '' && !p.endsWith('/'))), '.git/info/attributes'];
  // Git also opens `.gitattributes` in every folder it walks for `add`, even one it does not list (an untracked FIFO is
  // left out of `ls-files`, and git's own open would block on it). Every folder of a file `git add -A` would see gets an
  // lstat of its `.gitattributes`: anything but a regular file or a link (which git does not follow) is refused.
  const walked = await exec('git', [...HARDENED_FLAGS, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: projectDir, env });
  if (walked.code !== 0) return unsafe(`git ls-files failed: ${walked.stderr.trim().slice(0, 200)}`);
  const dirs = new Set<string>(['']);
  for (const path of walked.stdout.split('\0')) {
    for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
      const dir = path.slice(0, i);
      if (dirs.has(dir)) break;
      dirs.add(dir);
    }
  }
  for (const dir of dirs) {
    const rel = dir === '' ? '.gitattributes' : `${dir}/.gitattributes`;
    let st;
    try { st = await lstat(join(projectDir, rel)); } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return unsafe(`${rel} could not be inspected (${code ?? 'error'})`);
    }
    if (!st.isFile() && !st.isSymbolicLink()) return unsafe(`${rel} is not a regular file`);
  }

  for (const rel of rels) {
    // Never a plain readFile: a FIFO (or a link to one) would block forever and `/dev/zero` would grow without bound.
    let file;
    try { file = await readRegularFile(join(projectDir, rel), MAX_ATTRIBUTES_BYTES); } catch (err) {
      return unsafe(`${rel} could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    if (file.kind === 'missing') continue;
    // Git does not follow a symlinked `.gitattributes` in the work tree: skipped. `.git/info/attributes` is read through
    // a link by git, so there a link is refused like any other non-regular file.
    if (file.kind === 'link' && rel !== '.git/info/attributes') continue;
    if (file.kind === 'link' || file.kind === 'special') return unsafe(`${rel} is not a regular file`);
    if (file.kind === 'too-large') return unsafe(`${rel} is larger than ${MAX_ATTRIBUTES_BYTES} bytes`);
    const bad = dangerousAttributeLines(file.data.toString('utf8'), keys);
    if (bad.length > 0) return e.gitAttributesBlocked({ file: rel, line: bad[0]!.slice(0, 120) });
  }
  return null;
}

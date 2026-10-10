import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execCommand, type CommandExec } from './exec.ts';
import { inspectGitSafety, isQuarantined, GitUnsafeError } from './git-safety.ts';
import { KeyedMutex } from './keyed-mutex.ts';
import { t } from './i18n.ts';

const IDENTITY = ['-c', 'user.name=Motion Studio', '-c', 'user.email=motion-studio@localhost'];
/**
 * The agent can write inside the project: hooks, an fsmonitor command or a config/attributes driver planted in the repo
 * must never run. `-c` overrides the repo config for this call; the env drops the system and global config and any external
 * diff. The repo's own config and attributes are still checked by `assertSafe` before every call (a `-c` cannot neutralise
 * a `filter`/`diff` driver, which runs from `.gitattributes`). Identity travels in `-c user.*`, so commits work without a
 * global config.
 */
const HARDENED = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const HARDENED_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
  GIT_EXTERNAL_DIFF: undefined, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0',
};

/**
 * Never versioned, whatever the project's .gitignore says: the sandbox caches, the agent's scratch folders and the
 * core's caches (`.studio/cache/`, e.g. output hashes). They go
 * into `.git/info/exclude` (the agent cannot write `.git/`) rather than an exclude pathspec: git 2.50 makes
 * `git add -A -- . ':(exclude).cache'` exit 1 when `.cache/` is also gitignored and present.
 */
export const LOCAL_EXCLUDES = ['/.cache/', '/creatives/*/work/tmp/', '/.studio/cache/'] as const;

/**
 * Appends the missing LOCAL_EXCLUDES to `<dir>/.git/info/exclude`, keeping its other lines. Skipped when `<dir>/.git`
 * is not a real folder (projects are always created with `git init`). A symlink in place of the file is replaced,
 * never followed.
 */
async function ensureLocalExcludes(dir: string): Promise<void> {
  const gitDir = join(dir, '.git');
  const info = await lstat(gitDir).catch(() => null);
  if (!info?.isDirectory()) return;
  await mkdir(join(gitDir, 'info'), { recursive: true });
  const path = join(gitDir, 'info', 'exclude');
  const current = await lstat(path).catch(() => null);
  let text = '';
  if (current?.isFile()) text = await readFile(path, 'utf8');
  else if (current) await rm(path, { recursive: true, force: true });
  const present = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = LOCAL_EXCLUDES.filter((l) => !present.has(l));
  if (missing.length === 0 && current?.isFile()) return;
  await writeFile(path, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${missing.join('\n')}${missing.length ? '\n' : ''}`);
}

/** The git subcommand, skipping `-c key=value` pairs; the rest (e.g. commit messages) is never echoed. */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') { i++; continue; }
    return args[i]!;
  }
  return '';
}

export class Git {
  private readonly lock = new KeyedMutex();
  constructor(private readonly exec: CommandExec = execCommand) {}

  /**
   * Refuses to run git on a repo that is quarantined (the integrity tripwire found a protected file changed) or whose
   * config/attributes carry anything the core did not set. Called before every operation on an existing repo (not `init`,
   * which creates the config). The job that triggered it fails with a clear message; no git touches the repo until the
   * user restores it (or restarts the app). The core keeps no trusted copy of `.git`, so it never rewrites the repo itself.
   */
  private async assertSafe(dir: string): Promise<void> {
    if (isQuarantined(dir)) throw new GitUnsafeError(t().errors.gitRepoQuarantined, 'quarantined');
    const detail = await inspectGitSafety(dir);
    if (detail !== null) throw new GitUnsafeError(t().errors.gitRepoUnsafe({ detail }), detail);
  }

  async init(dir: string): Promise<void> {
    await this.must(dir, ['init', '-q', '-b', 'main']);
    await ensureLocalExcludes(dir);
  }

  commitAll(dir: string, message: string): Promise<string | null> {
    return this.lock.run(resolve(dir), async () => {
      await this.assertSafe(dir);
      await ensureLocalExcludes(dir);
      await this.must(dir, ['add', '-A']);
      const status = await this.must(dir, ['status', '--porcelain']);
      if (status.trim() === '') return null;
      await this.must(dir, [...IDENTITY, 'commit', '-q', '-m', message]);
      return (await this.must(dir, ['rev-parse', 'HEAD'])).trim();
    });
  }

  /**
   * Commits only `relPaths` (relative to `dir`, literal pathspecs), whatever else is changed or staged in the tree: used
   * for the creative's own metadata while an agent may be writing elsewhere (its half-written sources are never
   * committed). Returns the sha, or null when those paths have no change.
   */
  commitPaths(dir: string, relPaths: string[], message: string): Promise<string | null> {
    return this.lock.run(resolve(dir), async () => {
      if (relPaths.length === 0) return null;
      await this.assertSafe(dir);
      await ensureLocalExcludes(dir);
      const specs = relPaths.map((p) => `:(literal)${p}`);
      await this.must(dir, ['add', '--', ...specs]);
      const status = await this.must(dir, ['status', '--porcelain', '--', ...specs]);
      if (status.trim() === '') return null;
      await this.must(dir, [...IDENTITY, 'commit', '-q', '--only', '-m', message, '--', ...specs]);
      return (await this.must(dir, ['rev-parse', 'HEAD'])).trim();
    });
  }

  /**
   * Brings relPath back to `commit` and deletes the untracked, non-ignored files below it (ignored ones such as
   * node_modules/ or .venv/ survive). Returns how many entries were deleted (an untracked folder counts as one).
   */
  restorePath(dir: string, commit: string, relPath: string): Promise<number> {
    return this.lock.run(resolve(dir), async () => {
      if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(t().errors.commitNotFound({ commit }));
      await this.assertSafe(dir);
      const check = await this.exec('git', [...HARDENED, 'cat-file', '-e', `${commit}^{commit}`], { cwd: dir, env: HARDENED_ENV });
      if (check.notFound) throw new Error(t().errors.gitNotFound);
      if (check.code !== 0) throw new Error(t().errors.commitNotFound({ commit }));
      const spec = `:(literal)${relPath}`;
      await this.must(dir, ['restore', `--source=${commit}`, '--staged', '--worktree', '--', spec]);
      const pending = (await this.must(dir, ['clean', '-n', '-d', '--', spec])).split('\n').filter((l) => l.trim() !== '').length;
      if (pending > 0) await this.must(dir, ['clean', '-f', '-d', '--', spec]);
      return pending;
    });
  }

  private async must(cwd: string, args: string[]): Promise<string> {
    const r = await this.exec('git', [...HARDENED, ...args], { cwd, env: HARDENED_ENV });
    if (r.notFound) throw new Error(t().errors.gitNotFound);
    if (r.code !== 0) throw new Error(t().errors.gitFailed({ command: subcommand(args), detail: r.stderr.trim() }));
    return r.stdout;
  }
}

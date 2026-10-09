import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execCommand, type CommandExec } from './exec.ts';
import { KeyedMutex } from './keyed-mutex.ts';
import { t } from './i18n.ts';

const IDENTITY = ['-c', 'user.name=Motion Studio', '-c', 'user.email=motion-studio@localhost'];
/** The agent can write inside the project: hooks and an fsmonitor command planted in the repo must never run. */
const HARDENED = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/**
 * Never versioned, whatever the project's .gitignore says: the sandbox caches and the agent's scratch folders. They go
 * into `.git/info/exclude` (the agent cannot write `.git/`) rather than an exclude pathspec: git 2.50 makes
 * `git add -A -- . ':(exclude).cache'` exit 1 when `.cache/` is also gitignored and present.
 */
export const LOCAL_EXCLUDES = ['/.cache/', '/creatives/*/work/tmp/'] as const;

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

  async init(dir: string): Promise<void> {
    await this.must(dir, ['init', '-q', '-b', 'main']);
    await ensureLocalExcludes(dir);
  }

  commitAll(dir: string, message: string): Promise<string | null> {
    return this.lock.run(resolve(dir), async () => {
      await ensureLocalExcludes(dir);
      await this.must(dir, ['add', '-A']);
      const status = await this.must(dir, ['status', '--porcelain']);
      if (status.trim() === '') return null;
      await this.must(dir, [...IDENTITY, 'commit', '-q', '-m', message]);
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
      const check = await this.exec('git', [...HARDENED, 'cat-file', '-e', `${commit}^{commit}`], { cwd: dir });
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
    const r = await this.exec('git', [...HARDENED, ...args], { cwd });
    if (r.notFound) throw new Error(t().errors.gitNotFound);
    if (r.code !== 0) throw new Error(t().errors.gitFailed({ command: subcommand(args), detail: r.stderr.trim() }));
    return r.stdout;
  }
}

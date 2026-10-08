import { resolve } from 'node:path';
import { execCommand, type CommandExec } from './exec.ts';
import { KeyedMutex } from './keyed-mutex.ts';
import { t } from './i18n.ts';

const IDENTITY = ['-c', 'user.name=Motion Studio', '-c', 'user.email=motion-studio@localhost'];
/** The agent can write inside the project: hooks and an fsmonitor command planted in the repo must never run. */
const HARDENED = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

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
  }

  commitAll(dir: string, message: string): Promise<string | null> {
    return this.lock.run(resolve(dir), async () => {
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

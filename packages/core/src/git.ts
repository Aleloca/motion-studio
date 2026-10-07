import { resolve } from 'node:path';
import { execCommand, type CommandExec } from './exec.ts';
import { KeyedMutex } from './keyed-mutex.ts';

const IDENTITY = ['-c', 'user.name=Motion Studio', '-c', 'user.email=motion-studio@localhost'];

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

  restorePath(dir: string, commit: string, relPath: string): Promise<void> {
    return this.lock.run(resolve(dir), async () => {
      const exists = /^[0-9a-f]{7,40}$/.test(commit)
        && (await this.exec('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: dir })).code === 0;
      if (!exists) throw new Error(`Versione non trovata nel repository: ${commit}`);
      await this.must(dir, ['restore', `--source=${commit}`, '--staged', '--worktree', '--', relPath]);
    });
  }

  private async must(cwd: string, args: string[]): Promise<string> {
    const r = await this.exec('git', args, { cwd });
    if (r.notFound) throw new Error('git non trovato: installalo per usare Motion Studio');
    if (r.code !== 0) throw new Error(`git ${subcommand(args)} fallito: ${r.stderr.trim()}`);
    return r.stdout;
  }
}

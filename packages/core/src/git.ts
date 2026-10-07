import { execCommand, type CommandExec } from './exec.ts';
import { KeyedMutex } from './keyed-mutex.ts';

const IDENTITY = ['-c', 'user.name=Motion Studio', '-c', 'user.email=motion-studio@localhost'];

export class Git {
  private readonly lock = new KeyedMutex();
  constructor(private readonly exec: CommandExec = execCommand) {}

  async init(dir: string): Promise<void> {
    await this.must(dir, ['init', '-q', '-b', 'main']);
  }

  commitAll(dir: string, message: string): Promise<string | null> {
    return this.lock.run(dir, async () => {
      await this.must(dir, ['add', '-A']);
      const status = await this.must(dir, ['status', '--porcelain']);
      if (status.trim() === '') return null;
      await this.must(dir, [...IDENTITY, 'commit', '-q', '-m', message]);
      return (await this.must(dir, ['rev-parse', 'HEAD'])).trim();
    });
  }

  private async must(cwd: string, args: string[]): Promise<string> {
    const r = await this.exec('git', args, { cwd });
    if (r.notFound) throw new Error('git non trovato: installalo per usare Motion Studio');
    if (r.code !== 0) throw new Error(`git ${args.filter((a) => !a.startsWith('user.')).join(' ')} fallito: ${r.stderr.trim()}`);
    return r.stdout;
  }
}

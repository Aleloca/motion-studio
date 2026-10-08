import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandExec } from '../src/exec.ts';
import { resolveLoginShellPath, spawnBounded } from '../src/shell-path.ts';

const out = (stdout: string, code = 0): CommandExec => async () => ({ code, stdout, stderr: '', notFound: false });

describe('resolveLoginShellPath', () => {
  it('extracts PATH between markers and merges it before the current one', async () => {
    const r = await resolveLoginShellPath({ platform: 'darwin', current: '/usr/bin:/bin', exec: out('Welcome!\n__MS_PATH__/opt/homebrew/bin:/usr/bin:/Users/me/.npm-global/bin__MS_END__') });
    expect(r).toEqual({ path: '/opt/homebrew/bin:/usr/bin:/Users/me/.npm-global/bin:/bin', source: 'login-shell' });
  });
  it('falls back when the shell fails, adding the usual install folders after the current PATH (deduped)', async () => {
    const r = await resolveLoginShellPath({ platform: 'darwin', current: '/usr/bin:/usr/local/bin', home: '/Users/me', exec: out('', 1) });
    expect(r.source).toBe('fallback');
    expect(r.path).toBe('/usr/bin:/usr/local/bin:/Users/me/.local/bin:/Users/me/.claude/local:/Users/me/.npm-global/bin:/Users/me/.volta/bin:/opt/homebrew/bin');
  });
  it('probes PATH through /bin/sh so a non-POSIX login shell (fish) still prints it colon-joined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-sp-'));
    try {
      // Like fish: its own "$PATH" is a list joined by spaces; only a POSIX child sees the exported, colon-joined PATH.
      const fish = join(dir, 'fake-fish');
      await writeFile(fish, `#!/bin/sh\n[ "$1" = -ilc ] || exit 9\ncase "$2" in\n  "/bin/sh -c "*) exec /bin/sh -c "$2" ;;\n  *) printf '__MS_PATH__%s__MS_END__' "$(printf %s "$PATH" | tr : ' ')" ;;\nesac\n`, { mode: 0o755 });
      const r = await resolveLoginShellPath({ platform: 'darwin', current: '/nowhere', shell: fish, timeoutMs: 5000, exec: spawnBounded });
      expect(r.source).toBe('login-shell');
      expect(r.path).toBe([...new Set([...process.env.PATH!.split(':'), '/nowhere'].filter(Boolean))].join(':'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('does nothing on Windows', async () => {
    expect(await resolveLoginShellPath({ platform: 'win32', current: 'C:\\x', exec: out('x') })).toEqual({ path: 'C:\\x', source: 'fallback' });
  });
  it('passes the timeout to the exec and never hangs on a stuck shell', async () => {
    let seen: number | undefined;
    await resolveLoginShellPath({ platform: 'darwin', current: '/usr/bin', timeoutMs: 1234, exec: async (_c, _a, o) => { seen = o?.timeoutMs; return { code: 0, stdout: '', stderr: '', notFound: false }; } });
    expect(seen).toBe(1234);
  });
  it('does not hang on a shell whose background child holds the pipes, and kills the whole group', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-sp-'));
    try {
      const shell = join(dir, 'fake-shell.sh');
      await writeFile(shell, `#!/bin/sh\nsleep 30 &\necho $! > "${dir}/bg.pid"\nwait\n`, { mode: 0o755 });
      const t0 = Date.now();
      const r = await resolveLoginShellPath({ platform: 'darwin', current: '/usr/bin', shell: '/bin/sh', timeoutMs: 300, exec: (c, _a, o) => spawnBounded(c, [shell], o) });
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(r.source).toBe('fallback');
      expect(r.error).toBe('timeout dopo 0.3 s');
      const pid = Number((await readFile(join(dir, 'bg.pid'), 'utf8')).trim());
      await new Promise((res) => setTimeout(res, 100));
      expect(() => process.kill(pid, 0)).toThrow(); // the background child is gone with its group
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('reports a missing marker and a non-zero exit in Italian', async () => {
    expect((await resolveLoginShellPath({ platform: 'darwin', current: '/a', exec: out('niente') })).error).toBe('marcatore non trovato');
    expect((await resolveLoginShellPath({ platform: 'darwin', current: '/a', exec: out('', 3) })).error).toBe('codice 3');
  });
  it('reads PATH from a real shell', async () => {
    const r = await resolveLoginShellPath({ platform: 'darwin', current: '/usr/bin', shell: '/bin/sh', timeoutMs: 5000, exec: (c, _a, o) => spawnBounded(c, ['-c', 'printf "__MS_PATH__%s__MS_END__" "/x/bin"'], o) });
    expect(r).toEqual({ path: '/x/bin:/usr/bin', source: 'login-shell' });
  });
});

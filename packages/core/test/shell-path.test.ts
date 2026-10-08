import { describe, expect, it } from 'vitest';
import { execCommand, type CommandExec } from '../src/exec.ts';
import { resolveLoginShellPath } from '../src/shell-path.ts';

const out = (stdout: string, code = 0): CommandExec => async () => ({ code, stdout, stderr: '', notFound: false });

describe('resolveLoginShellPath', () => {
  it('extracts PATH between markers and merges it before the current one', async () => {
    const r = await resolveLoginShellPath({ platform: 'darwin', current: '/usr/bin:/bin', exec: out('Welcome!\n__MS_PATH__/opt/homebrew/bin:/usr/bin:/Users/me/.npm-global/bin__MS_END__') });
    expect(r).toEqual({ path: '/opt/homebrew/bin:/usr/bin:/Users/me/.npm-global/bin:/bin', source: 'login-shell' });
  });
  it('falls back when the shell fails', async () => {
    const r = await resolveLoginShellPath({ platform: 'darwin', current: '/usr/bin', exec: out('', 1) });
    expect(r.source).toBe('fallback');
    expect(r.path).toBe('/usr/bin:/opt/homebrew/bin:/usr/local/bin');
  });
  it('does nothing on Windows', async () => {
    expect(await resolveLoginShellPath({ platform: 'win32', current: 'C:\\x', exec: out('x') })).toEqual({ path: 'C:\\x', source: 'fallback' });
  });
  it('passes the timeout to the exec and never hangs on a stuck shell', async () => {
    let seen: number | undefined;
    await resolveLoginShellPath({ platform: 'darwin', current: '/usr/bin', timeoutMs: 1234, exec: async (_c, _a, o) => { seen = o?.timeoutMs; return { code: 0, stdout: '', stderr: '', notFound: false }; } });
    expect(seen).toBe(1234);
    const t0 = Date.now();
    const r = await resolveLoginShellPath({ platform: 'darwin', current: '/usr/bin', shell: '/bin/sh', timeoutMs: 300, exec: (c, _a, o) => execCommand(c, ['-c', 'sleep 5'], o) });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.source).toBe('fallback');
  });
});

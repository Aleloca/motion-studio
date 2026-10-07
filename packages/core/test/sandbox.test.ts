import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_DOMAINS, detectSandbox, sensitiveHomePaths } from '../src/agent/sandbox.ts';
import type { CommandExec } from '../src/exec.ts';

const ok: CommandExec = async () => ({ code: 0, stdout: '', stderr: '', notFound: false });
const missing: CommandExec = async () => ({ code: -1, stdout: '', stderr: '', notFound: true });

describe('detectSandbox', () => {
  it('macOS depends on sandbox-exec', async () => {
    expect(await detectSandbox({ platform: 'darwin', exists: async () => true })).toMatchObject({ available: true });
    expect((await detectSandbox({ platform: 'darwin', exists: async () => false })).available).toBe(false);
  });
  it('linux needs bwrap and socat', async () => {
    expect((await detectSandbox({ platform: 'linux', exec: ok })).available).toBe(true);
    const r = await detectSandbox({ platform: 'linux', exec: missing });
    expect(r.available).toBe(false);
    expect(r.reason).toContain('bubblewrap');
  });
  it('windows is unsupported', async () => {
    expect(await detectSandbox({ platform: 'win32' })).toMatchObject({ available: false, reason: 'La sandbox di Claude Code non è disponibile su Windows' });
  });
});

describe('constants', () => {
  it('lists package registries and sensitive folders', () => {
    expect(DEFAULT_ALLOWED_DOMAINS).toContain('registry.npmjs.org');
    expect(sensitiveHomePaths('/Users/me')).toContain('/Users/me/.ssh');
  });
});

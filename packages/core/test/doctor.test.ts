import { describe, expect, it } from 'vitest';
import { hasBlockingFailure, runDoctor } from '../src/doctor.ts';
import type { CommandExec, CommandResult } from '../src/exec.ts';

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '', notFound: false });
const missing: CommandResult = { code: -1, stdout: '', stderr: 'ENOENT', notFound: true };

function fakeExec(table: Record<string, CommandResult>): CommandExec {
  return async (cmd, args) => table[[cmd, ...args].join(' ')] ?? missing;
}

const allGood = {
  'git --version': ok('git version 2.50.1'),
  'ffmpeg -version': ok('ffmpeg version 8.0.1 Copyright'),
  'claude --version': ok('2.1.292 (Claude Code)'),
  'claude auth status --json': ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })),
};

describe('runDoctor', () => {
  it('reports everything ok with versions', async () => {
    const checks = await runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' });
    expect(checks.map((c) => [c.id, c.ok, c.version])).toEqual([
      ['node', true, '24.9.0'],
      ['git', true, '2.50.1'],
      ['ffmpeg', true, '8.0.1'],
      ['claude', true, '2.1.292'],
      ['claude-auth', true, undefined],
    ]);
    expect(hasBlockingFailure(checks)).toBe(false);
  });
  it('flags missing claude with an install fix and skips the auth probe', async () => {
    const { ['claude --version']: _, ['claude auth status --json']: __, ...rest } = allGood;
    const checks = await runDoctor({ exec: fakeExec(rest), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' });
    const claude = checks.find((c) => c.id === 'claude')!;
    expect(claude.ok).toBe(false);
    expect(claude.fix).toContain('npm install -g @anthropic-ai/claude-code');
    expect(checks.find((c) => c.id === 'claude-auth')).toMatchObject({ ok: false, message: 'Installa prima Claude Code' });
    expect(hasBlockingFailure(checks)).toBe(true);
  });
  it('flags a logged-out claude with the login command', async () => {
    const checks = await runDoctor({
      exec: fakeExec({ ...allGood, 'claude auth status --json': { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: '', notFound: false } }),
      claudeCommand: ['claude'], nodeVersion: 'v24.9.0',
    });
    expect(checks.find((c) => c.id === 'claude-auth')).toMatchObject({ ok: false, fix: 'claude auth login' });
  });
  it('treats missing ffmpeg as non-blocking', async () => {
    const { ['ffmpeg -version']: _, ...rest } = allGood;
    const checks = await runDoctor({ exec: fakeExec(rest), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' });
    expect(checks.find((c) => c.id === 'ffmpeg')).toMatchObject({ ok: false, required: false });
    expect(hasBlockingFailure(checks)).toBe(false);
  });
  it('rejects node older than 22', async () => {
    const checks = await runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v20.11.0' });
    expect(checks[0]).toMatchObject({ id: 'node', ok: false, required: true });
  });
  it('uses a custom claude command prefix', async () => {
    const exec = fakeExec({
      ...allGood,
      'node /fake.mjs --version': ok('9.9.9 (Claude Code)'),
      'node /fake.mjs auth status --json': ok(JSON.stringify({ loggedIn: true })),
    });
    const checks = await runDoctor({ exec, claudeCommand: ['node', '/fake.mjs'], nodeVersion: 'v24.9.0' });
    expect(checks.find((c) => c.id === 'claude')).toMatchObject({ ok: true, version: '9.9.9' });
  });
  it('treats a non-JSON auth status as logged out', async () => {
    const checks = await runDoctor({
      exec: fakeExec({ ...allGood, 'claude auth status --json': ok('Logged in as someone') }),
      claudeCommand: ['claude'], nodeVersion: 'v24.9.0',
    });
    expect(checks.find((c) => c.id === 'claude-auth')).toMatchObject({ ok: false, fix: 'claude auth login' });
  });
  it('distinguishes an installed tool that fails from a missing one', async () => {
    const broken = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr, notFound: false });
    const checks = await runDoctor({
      exec: fakeExec({ ...allGood, 'git --version': broken('xcrun: error: invalid developer path\nmore'), 'ffmpeg -version': broken('dyld: missing lib'), 'claude --version': broken('SyntaxError: bad\n') }),
      claudeCommand: ['claude'], nodeVersion: 'v24.9.0',
    });
    expect(checks.find((c) => c.id === 'git')).toEqual({ id: 'git', label: 'Git', required: true, ok: false, message: 'Installato ma non risponde correttamente: xcrun: error: invalid developer path' });
    expect(checks.find((c) => c.id === 'ffmpeg')).toMatchObject({ ok: false, message: 'Installato ma non risponde correttamente: dyld: missing lib' });
    expect(checks.find((c) => c.id === 'ffmpeg')?.fix).toBeUndefined();
    expect(checks.find((c) => c.id === 'claude')).toMatchObject({ ok: false, message: 'Installato ma non risponde correttamente: SyntaxError: bad' });
    expect(checks.find((c) => c.id === 'claude')?.fix).toBeUndefined();
    expect(checks.find((c) => c.id === 'claude-auth')).toMatchObject({ ok: false });
  });
  it('keeps the install fix when a tool is not found', async () => {
    const { ['git --version']: _, ...rest } = allGood;
    const checks = await runDoctor({ exec: fakeExec(rest), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' });
    expect(checks.find((c) => c.id === 'git')).toMatchObject({ ok: false, message: 'Git non trovato', fix: 'Installa Git da https://git-scm.com' });
  });
  it('reports the sandbox as an optional check', async () => {
    const checks = await runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', sandbox: async () => ({ available: false, reason: 'manca bubblewrap' }) });
    expect(checks.at(-1)).toMatchObject({ id: 'sandbox', ok: false, required: false, message: 'manca bubblewrap' });
  });
  it('reports where PATH came from only when told (desktop)', async () => {
    const base = { exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' };
    expect((await runDoctor(base)).some((c) => c.id === 'shell-path')).toBe(false);
    expect((await runDoctor({ ...base, shellPath: { source: 'login-shell' } })).find((c) => c.id === 'shell-path')).toEqual({
      id: 'shell-path', label: 'PATH della shell di login', required: false, ok: true, message: 'PATH caricato dalla shell di login',
    });
    const fallback = await runDoctor({ ...base, shellPath: { source: 'fallback', error: 'timeout dopo 15 s' } });
    expect(fallback.find((c) => c.id === 'shell-path')).toEqual({
      id: 'shell-path', label: 'PATH della shell di login', required: false, ok: false, message: 'PATH di riserva: timeout dopo 15 s',
      fix: 'Se mancano programmi, avvia Motion Studio dal terminale o controlla i file di avvio della shell',
    });
    expect(hasBlockingFailure(fallback)).toBe(false);
  });
  it('flags a workspace path with glob characters as an optional failed check (decisions log 141)', async () => {
    const base = { exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' };
    for (const p of [null, '/Users/me/Motion Studio', '/Users/me/a (1)']) expect((await runDoctor({ ...base, workspacePath: p })).some((c) => c.id === 'workspace-path')).toBe(false);
    for (const p of ['/Users/me/ws [x]', '/Users/me/a*b', '/Users/me/what?']) {
      const checks = await runDoctor({ ...base, workspacePath: p });
      expect(checks.find((c) => c.id === 'workspace-path')).toMatchObject({ required: false, ok: false, label: 'Percorso della cartella di lavoro' });
      expect(hasBlockingFailure(checks)).toBe(false);
    }
  });
});

describe('billing', () => {
  it('reads the billing method from the auth status field names only', async () => {
    const { billingFromAuthStatus, readBilling } = await import('../src/doctor.ts');
    expect(billingFromAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'x@y.z', orgName: 'Org' }))).toBe('subscription');
    expect(billingFromAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'api_key' }))).toBe('api');
    expect(billingFromAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'apiKey' }))).toBe('api');
    expect(billingFromAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }))).toBe('unknown');
    expect(billingFromAuthStatus(JSON.stringify({ loggedIn: false, authMethod: 'claude.ai' }))).toBe('unknown');
    expect(billingFromAuthStatus('Logged in')).toBe('unknown');
    expect(billingFromAuthStatus('null')).toBe('unknown');
    expect(await readBilling({ exec: fakeExec(allGood), claudeCommand: ['claude'] })).toBe('subscription');
    expect(await readBilling({ exec: async () => { throw new Error('spawn'); }, claudeCommand: ['claude'] })).toBe('unknown');
  });
});

describe('runDoctor: ffmpeg architecture (Task 8, carry 13)', () => {
  const ffmpegOf = async (info: { arch: 'arm64' | 'x86_64' | 'universal' | 'unknown'; hostArch: string; translated: boolean } | null) =>
    (await runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', ffmpegInfo: async () => info })).find((c) => c.id === 'ffmpeg')!;

  it('adds the build architecture to the version', async () => {
    expect((await ffmpegOf({ arch: 'arm64', hostArch: 'arm64', translated: false })).version).toBe('8.0.1 · arm64');
    expect((await ffmpegOf({ arch: 'universal', hostArch: 'arm64', translated: false })).version).toBe('8.0.1 · universale');
    expect((await ffmpegOf({ arch: 'x86_64', hostArch: 'x86_64', translated: false })).version).toBe('8.0.1 · x86_64');
  });
  it('says when an Intel build runs under Rosetta on Apple Silicon (slower renders), still ok', async () => {
    const c = await ffmpegOf({ arch: 'x86_64', hostArch: 'arm64', translated: true });
    expect(c.ok).toBe(true);
    expect(c.version).toBe('8.0.1 · x86_64 con Rosetta: render più lenti');
    expect(c.message).toContain('Rosetta');
  });
  it('keeps the plain version when the architecture is unknown or cannot be read', async () => {
    expect((await ffmpegOf({ arch: 'unknown', hostArch: 'arm64', translated: false })).version).toBe('8.0.1');
    expect((await ffmpegOf(null)).version).toBe('8.0.1');
    const failing = await runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', ffmpegInfo: async () => { throw new Error('boom'); } });
    expect(failing.find((c) => c.id === 'ffmpeg')!.version).toBe('8.0.1');
  });
});

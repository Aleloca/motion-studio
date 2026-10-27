import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasBlockingFailure, runDoctor } from '../src/doctor.ts';
import { t } from '../src/i18n.ts';
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

describe('runDoctor · automatic updates (decision 802)', () => {
  const run = (updatesOff?: boolean) => runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', ...(updatesOff === undefined ? {} : { updatesOff }) });
  it('adds one informational row (ok, not a recommendation) when the updater is off, and it never blocks', async () => {
    const checks = await run(true);
    expect(checks.find((c) => c.id === 'updates')).toEqual({ id: 'updates', label: t().doctor.updatesLabel, required: false, ok: true, info: true, message: t().doctor.updatesOff, technical: true });
    expect(hasBlockingFailure(checks)).toBe(false);
  });
  it('has no such row when the updater is on or there is none', async () => {
    expect((await run(false)).some((c) => c.id === 'updates')).toBe(false);
    expect((await run()).some((c) => c.id === 'updates')).toBe(false);
  });
});

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
    const checks = await runDoctor({ exec: fakeExec(rest), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', platform: 'darwin' });
    const claude = checks.find((c) => c.id === 'claude')!;
    expect(claude.ok).toBe(false);
    // User report 91: the official native installer (never npm), with the one-click install offered.
    expect(claude.fix).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(claude.action).toBe('install-claude');
    // The sign-in row waits: no remedy, no button (no empty box in the UI).
    const auth = checks.find((c) => c.id === 'claude-auth')!;
    expect(auth).toMatchObject({ ok: false, message: 'Prima installa Claude Code', waitsFor: 'claude' });
    expect(auth.fix).toBeUndefined();
    expect(auth.action).toBeUndefined();
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
    const checks = await runDoctor({ exec: fakeExec(rest), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', platform: 'win32' });
    // User report 91: plain words and the Git for Windows download page.
    expect(checks.find((c) => c.id === 'git')).toMatchObject({ ok: false, message: 'Git non trovato', fix: t().doctor.gitFix.windows });
    expect(checks.find((c) => c.id === 'git')!.fix).toContain('https://git-scm.com/downloads/win');
  });
  it('reports the sandbox as an optional check', async () => {
    const checks = await runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', sandbox: async () => ({ available: false, reason: 'manca bubblewrap' }) });
    expect(checks.at(-1)).toMatchObject({ id: 'sandbox', ok: false, required: false, message: 'manca bubblewrap' });
  });
  it('reports where PATH came from only when told (desktop)', async () => {
    const base = { exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', platform: 'darwin' as const };
    expect((await runDoctor(base)).some((c) => c.id === 'shell-path')).toBe(false);
    expect((await runDoctor({ ...base, shellPath: { source: 'login-shell' } })).find((c) => c.id === 'shell-path')).toEqual({
      id: 'shell-path', label: 'PATH della shell di login', required: false, ok: true, message: 'PATH caricato dalla shell di login', technical: true,
    });
    const fallback = await runDoctor({ ...base, shellPath: { source: 'fallback', error: 'timeout dopo 15 s' } });
    expect(fallback.find((c) => c.id === 'shell-path')).toEqual({
      id: 'shell-path', label: 'PATH della shell di login', required: false, ok: false, message: 'PATH di riserva: timeout dopo 15 s',
      fix: 'Se mancano programmi, avvia Motion Studio dal terminale o controlla i file di avvio della shell', technical: true,
    });
    expect(hasBlockingFailure(fallback)).toBe(false);
    // User report 91: never "unknown reason".
    const noReason = (await runDoctor({ ...base, shellPath: { source: 'fallback' } })).find((c) => c.id === 'shell-path')!;
    expect(noReason.message).toBe(t().doctor.shellPathFallbackPlain);
    expect(noReason.message).not.toMatch(/sconosciuto|unknown/i);
  });
  it('flags a workspace path with glob characters as an optional failed check that names it (decisions 141, 790)', async () => {
    const base = { exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' };
    for (const p of [null, '/Users/me/Motion Studio']) expect((await runDoctor({ ...base, workspacePath: p })).some((c) => c.id === 'workspace-path')).toBe(false);
    for (const p of ['/Users/me/ws [x]', '/Users/me/a*b', '/Users/me/what?', '/Users/me/a (1)', '/Users/me/p (x) [y]', '/Users/me/{z}', '/Users/me/a\\b']) {
      const checks = await runDoctor({ ...base, workspacePath: p });
      expect(checks.find((c) => c.id === 'workspace-path'), p).toEqual({
        id: 'workspace-path', label: 'Percorso della cartella di lavoro', required: false, ok: false,
        message: t().doctor.folderGlobChars({ path: p }), fix: t().doctor.folderGlobFix,
      });
      expect(checks.find((c) => c.id === 'workspace-path')!.message).toContain(p);
      expect(hasBlockingFailure(checks)).toBe(false);
    }
  });
  it('decision 790: names the real path of a clean-named workspace link, or of a project folder that is a link to such a folder', async () => {
    const base = { exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' };
    const holder = mkdtempSync(join(tmpdir(), 'ms-doctor-glob-'));
    try {
      const bad = join(holder, 'p (x) [y]');
      mkdirSync(join(bad, 'acme'), { recursive: true });
      symlinkSync(bad, join(holder, 'clean-ws'));
      const realBad = await realpath(bad);
      const viaLink = (await runDoctor({ ...base, workspacePath: join(holder, 'clean-ws') })).find((c) => c.id === 'workspace-path');
      expect(viaLink?.message).toBe(t().doctor.folderGlobChars({ path: realBad }));
      // A clean workspace with a project folder linked into the glob-named one: the project's real path is named.
      const ws = join(holder, 'ws');
      mkdirSync(join(ws, 'plain'), { recursive: true });
      expect((await runDoctor({ ...base, workspacePath: ws })).some((c) => c.id === 'workspace-path')).toBe(false);
      symlinkSync(join(bad, 'acme'), join(ws, 'acme'));
      const viaProject = (await runDoctor({ ...base, workspacePath: ws })).find((c) => c.id === 'workspace-path');
      expect(viaProject?.message).toBe(t().doctor.folderGlobChars({ path: join(realBad, 'acme') }));
    } finally {
      rmSync(holder, { recursive: true, force: true });
    }
  });
  it('decision 791: a home or config folder with glob characters is a warning naming the path, never a refusal', async () => {
    const base = { exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' };
    const holder = mkdtempSync(join(tmpdir(), 'ms-doctor-deny-'));
    try {
      const clean = join(holder, 'home');
      mkdirSync(clean);
      expect((await runDoctor({ ...base, home: clean, configDir: join(clean, 'cfg') })).some((c) => c.id === 'agent-deny-paths')).toBe(false);
      const badHome = join(holder, 'h (x) [y]');
      const badConfig = join(holder, 'cfg {z}');
      const row = (await runDoctor({ ...base, home: badHome, configDir: badConfig })).find((c) => c.id === 'agent-deny-paths');
      expect(row).toEqual({ id: 'agent-deny-paths', label: t().doctor.denyPathsLabel, required: false, ok: false, message: t().doctor.denyPathsGlob({ paths: `${badHome}, ${badConfig}`, count: 2 }), technical: true });
      expect(row!.message).toContain(badHome);
      expect(row!.message.startsWith(`The paths `) || row!.message.startsWith(`I percorsi `)).toBe(true);
      // A clean-named link to such a folder: its real path is named.
      mkdirSync(badConfig);
      symlinkSync(badConfig, join(holder, 'cfg-link'));
      const viaLink = (await runDoctor({ ...base, home: clean, configDir: join(holder, 'cfg-link') })).find((c) => c.id === 'agent-deny-paths');
      expect(viaLink?.message).toBe(t().doctor.denyPathsGlob({ paths: await realpath(badConfig), count: 1 }));
      expect(hasBlockingFailure(await runDoctor({ ...base, home: badHome, configDir: badConfig }))).toBe(false);
    } finally {
      rmSync(holder, { recursive: true, force: true });
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

describe('runDoctor Phase 13 agent capabilities (decision 804)', () => {
  const agentChecks = (checks: Awaited<ReturnType<typeof runDoctor>>) => checks.filter((c) => c.id === 'live-messages' || c.id === 'interrupt');

  it('adds no capability rows unless asked (older callers keep their report)', async () => {
    const checks = await runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' });
    expect(agentChecks(checks)).toEqual([]);
  });

  it('reports the fallback for an unverified version: queued only, stop and resume (optional, not a problem)', async () => {
    const checks = await runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', agentOptIn: {} });
    expect(agentChecks(checks)).toEqual([
      { id: 'live-messages', label: 'Messaggi durante il lavoro', required: false, ok: true, message: 'solo in coda (non verificati per questa versione di Claude Code)', technical: true },
      { id: 'interrupt', label: 'Interruzione', required: false, ok: true, message: 'ferma e riprendi', technical: true },
    ]);
    expect(hasBlockingFailure(checks)).toBe(false);
  });

  it('decision 804: a verified version (2.1.301) with the settings on is live; the settings can switch it off; an older version stays on the fallback', async () => {
    const at = (v: string) => fakeExec({ ...allGood, 'claude --version': ok(`${v} (Claude Code)`) });
    const run = async (v: string, agentOptIn: { liveInput?: boolean; interrupt?: boolean }) =>
      agentChecks(await runDoctor({ exec: at(v), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', agentOptIn })).map((c) => c.message);
    expect(await run('2.1.301', { liveInput: true, interrupt: true })).toEqual([
      'attivi (verificati per questa versione di Claude Code)',
      'attiva (verificata per questa versione di Claude Code)',
    ]);
    expect(await run('2.1.301', { liveInput: true, interrupt: false })).toEqual([
      'attivi (verificati per questa versione di Claude Code)',
      'ferma e riprendi (disattivata nelle impostazioni dell’area di lavoro)',
    ]);
    expect(await run('2.1.301', { liveInput: false, interrupt: true })).toEqual([
      'solo in coda (disattivati nelle impostazioni dell’area di lavoro)',
      'ferma e riprendi (disattivata nelle impostazioni dell’area di lavoro)',
    ]);
    expect(await run('2.1.300', { liveInput: true, interrupt: true })).toEqual(['solo in coda (non verificati per questa versione di Claude Code)', 'ferma e riprendi']);
  });

  it('user report 91: without Claude Code the live-messages and interrupt rows are not shown (they would say nothing useful)', async () => {
    const { ['claude --version']: _, ['claude auth status --json']: __, ...rest } = allGood;
    const checks = await runDoctor({ exec: fakeExec(rest), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', agentOptIn: { liveInput: true, interrupt: true } });
    expect(agentChecks(checks)).toEqual([]);
  });

  it('the English texts are the orchestrator\'s wording (decisions log 610)', async () => {
    const en = (await import('@motion-studio/shared')).messages('en');
    expect(`${en.doctor.liveMessagesLabel}: ${en.doctor.liveMessagesQueued}`).toBe('Live messages: queued only (not verified for this Claude Code version)');
    expect(`${en.doctor.interruptLabel}: ${en.doctor.interruptStopResume}`).toBe('Interrupt: stop and resume');
  });
});

describe('runDoctor Phase 13: version parsing shared with the route', () => {
  it('an x.y version (not x.y.z) is unknown for the capability rows, as for /api/agent/capabilities', async () => {
    const checks = await runDoctor({ exec: fakeExec({ ...allGood, 'claude --version': ok('2.1 (Claude Code)') }), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', agentOptIn: { liveInput: true } });
    expect(checks.find((c) => c.id === 'live-messages')?.message).toBe('solo in coda (non verificati per questa versione di Claude Code)');
  });
});

describe('runDoctor · first-run setup for non-technical users (user report 91)', () => {
  const sandbox = async () => ({ available: false, reason: t().doctor.sandboxWindows });
  it('Windows: no sandbox row and no login-shell PATH row (they do not apply there)', async () => {
    const checks = await runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', platform: 'win32', sandbox, shellPath: { source: 'fallback' } });
    expect(checks.some((c) => c.id === 'sandbox')).toBe(false);
    expect(checks.some((c) => c.id === 'shell-path')).toBe(false);
  });
  it('Windows: the Claude Code fix is the official PowerShell installer', async () => {
    const { ['claude --version']: _, ['claude auth status --json']: __, ...rest } = allGood;
    const checks = await runDoctor({ exec: fakeExec(rest), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', platform: 'win32' });
    expect(checks.find((c) => c.id === 'claude')).toMatchObject({ fix: 'irm https://claude.ai/install.ps1 | iex', action: 'install-claude' });
  });
  it('macOS and Linux keep the sandbox row, as a technical one', async () => {
    const checks = await runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', platform: 'linux', sandbox: async () => ({ available: true, reason: '' }) });
    expect(checks.find((c) => c.id === 'sandbox')).toMatchObject({ ok: true, technical: true });
  });
  it('a signed-out Claude Code offers the sign-in', async () => {
    const checks = await runDoctor({ exec: fakeExec({ ...allGood, 'claude auth status --json': ok(JSON.stringify({ loggedIn: false })) }), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' });
    expect(checks.find((c) => c.id === 'claude-auth')).toMatchObject({ ok: false, action: 'sign-in', fix: 'claude auth login' });
  });
  it('the free plan is named plainly (only subscriptionType is read besides loggedIn)', async () => {
    const free = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'free', email: 'x@y.z', orgName: 'Org' });
    const checks = await runDoctor({ exec: fakeExec({ ...allGood, 'claude auth status --json': ok(free) }), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' });
    const row = checks.find((c) => c.id === 'claude-auth')!;
    expect(row).toMatchObject({ ok: false, message: t().doctor.freePlan, action: 'sign-in' });
    expect(row.message).not.toContain('x@y.z');
    expect(row.message).not.toContain('Org');
    expect(hasBlockingFailure(checks)).toBe(true);
    const pro = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' });
    expect((await runDoctor({ exec: fakeExec({ ...allGood, 'claude auth status --json': ok(pro) }), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' })).find((c) => c.id === 'claude-auth')!.ok).toBe(true);
  });
  it('a missing FFmpeg says what it is for and offers the install, never blocking', async () => {
    const { ['ffmpeg -version']: _, ...rest } = allGood;
    const checks = await runDoctor({ exec: fakeExec(rest), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', platform: 'win32' });
    expect(checks.find((c) => c.id === 'ffmpeg')).toMatchObject({ ok: false, required: false, message: t().doctor.ffmpegRecommended, fix: t().doctor.ffmpegFix.windows, action: 'install-ffmpeg' });
    expect(hasBlockingFailure(checks)).toBe(false);
  });
  it('the main rows are not technical; the node row is technical when it passes', async () => {
    const checks = await runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' });
    for (const id of ['git', 'ffmpeg', 'claude', 'claude-auth']) expect(checks.find((c) => c.id === id)!.technical, id).toBeUndefined();
    expect(checks.find((c) => c.id === 'node')!.technical).toBe(true);
  });
});

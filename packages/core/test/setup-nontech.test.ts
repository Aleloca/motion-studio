// @vitest-environment node
/**
 * User report 91: the first-run setup for non-technical users. Everything here uses fakes: the installer is a node one-liner
 * (MOTION_STUDIO_CLAUDE_INSTALLER_COMMAND's seam), `claude` is a node script, the registry is a fake `reg`, and FFmpeg's
 * download goes through a fetch that never leaves the process. Nothing is downloaded or installed for real.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SetupStatus } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { execCommand, type CommandExec, type CommandResult } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';
import { isLoopbackHost } from '../src/server/main.ts';
import { ffmpegBuildFor, FFMPEG_BUILDS, installFfmpeg, type FfmpegBuild } from '../src/setup/ffmpeg-download.ts';
import {
  claudeInstallerCommand, claudeManualCommand, installerCommandFromEnv, loginUrlIn, SetupRefused, SetupService, type SetupServiceOptions,
} from '../src/setup/setup-service.ts';
import { claudeLocalBin, expandWindowsVars, ffmpegBinDir, mergePath, parseRegPath, readWindowsRegistryPath, refreshToolPath } from '../src/setup/tool-path.ts';

const node = process.execPath;
const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '', notFound: false });
let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'ms-test-setup-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

const until = async (pred: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timed out');
};

describe('tool PATH (Claude Code in ~/.local/bin, FFmpeg in the data folder, the Windows registry)', () => {
  it('appends the folders, never twice, never in front', () => {
    expect(mergePath('/usr/bin:/bin', ['/home/u/.local/bin', '/usr/bin/'], 'linux')).toBe('/usr/bin:/bin:/home/u/.local/bin');
    expect(mergePath('C:\\Windows;C:\\Tools', ['c:\\tools\\', 'C:\\Users\\u\\.local\\bin'], 'win32')).toBe('C:\\Windows;C:\\Tools;C:\\Users\\u\\.local\\bin');
    expect(mergePath('', ['/a'], 'darwin')).toBe('/a');
  });
  it('expands %VARS% case-insensitively and leaves unknown ones', () => {
    expect(expandWindowsVars('%USERPROFILE%\\bin;%SystemRoot%\\x;%NOPE%', { UserProfile: 'C:\\Users\\u', SYSTEMROOT: 'C:\\Windows' }))
      .toBe('C:\\Users\\u\\bin;C:\\Windows\\x;%NOPE%');
  });
  it('reads the user and machine PATH from `reg query` (a fake reg)', async () => {
    expect(parseRegPath('\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Git\\cmd\r\n')).toBe('%USERPROFILE%\\.local\\bin;C:\\Git\\cmd');
    const calls: string[] = [];
    const exec: CommandExec = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (args[1]!.startsWith('HKLM')) return ok('    Path    REG_SZ    C:\\Windows\\system32;C:\\Program Files\\Git\\cmd\r\n');
      return ok('    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Microsoft\\WinGet\\Links\r\n');
    };
    expect(await readWindowsRegistryPath(exec, { USERPROFILE: 'C:\\Users\\u' })).toEqual([
      'C:\\Windows\\system32', 'C:\\Program Files\\Git\\cmd', 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links',
    ]);
    expect(calls).toEqual([
      'reg query HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment /v Path', 'reg query HKCU\\Environment /v Path',
    ]);
    // A failing reg gives nothing (never throws).
    expect(await readWindowsRegistryPath(async () => ({ code: 1, stdout: '', stderr: 'x', notFound: false }), {})).toEqual([]);
  });
  it('Windows: a tool installed while the app runs (Git for Windows) is found at the next check, merged after the process PATH', async () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\system32', USERPROFILE: 'C:\\Users\\u' };
    let machine = 'C:\\Windows\\system32';
    const exec: CommandExec = async (_cmd, args) => ok(`    Path    REG_SZ    ${args[1]!.startsWith('HKLM') ? machine : ''}\r\n`);
    await refreshToolPath({ env, platform: 'win32', home: 'C:\\Users\\u', configDir: 'C:\\cfg', exec });
    expect(env.PATH!.split(';')).not.toContain('C:\\Program Files\\Git\\cmd');
    machine = 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd';
    await refreshToolPath({ env, platform: 'win32', home: 'C:\\Users\\u', configDir: 'C:\\cfg', exec });
    const parts = env.PATH!.split(';');
    expect(parts[0]).toBe('C:\\Windows\\system32');
    expect(parts).toContain('C:\\Program Files\\Git\\cmd');
  });
  it('elsewhere the registry is never read', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    await refreshToolPath({ env, platform: 'darwin', home: '/h', configDir: '/c', exec: async () => { throw new Error('reg must not run'); } });
    expect(env.PATH).toBe(['/usr/bin', claudeLocalBin('/h'), ffmpegBinDir('/c')].join(':'));
  });
  it.skipIf(process.platform === 'win32')('a claude installed in ~/.local/bin after start is found without a restart', async () => {
    const home = join(base, 'home');
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    const run = () => execCommand('claude', ['--version'], { env });
    await refreshToolPath({ env, home, configDir: join(base, 'cfg'), exec: execCommand });
    expect((await run()).notFound).toBe(true);
    // The native installer drops the launcher there.
    mkdirSync(claudeLocalBin(home), { recursive: true });
    const bin = join(claudeLocalBin(home), 'claude');
    writeFileSync(bin, `#!/bin/sh\necho "2.1.301 (Claude Code)"\n`);
    chmodSync(bin, 0o755);
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('2.1.301');
    expect(env.PATH!.split(delimiter)).toContain(claudeLocalBin(home));
  });
});

describe('the Claude Code installer and sign-in (fakes only)', () => {
  const service = (over: Partial<SetupServiceOptions> = {}) => new SetupService({
    claudeCommand: () => ['claude'], exec: async () => ok('{"loggedIn":false}'), configDir: base, ffmpegBuild: null, allowed: true,
    installerCommand: [node, '-e', 'process.exit(0)'], ...over,
  });

  it('runs the official native installer, never npm: PowerShell on Windows (no profile, bypass for this process only), curl | bash elsewhere', () => {
    expect(claudeInstallerCommand('win32')).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex']);
    expect(claudeInstallerCommand('darwin')).toEqual(['bash', '-c', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash']);
    expect(claudeManualCommand('win32')).toBe('irm https://claude.ai/install.ps1 | iex');
    expect(claudeManualCommand('linux')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    for (const p of ['win32', 'darwin', 'linux'] as const) expect(claudeInstallerCommand(p).join(' ')).not.toContain('npm');
  });
  it('the installer can be replaced by a fake through MOTION_STUDIO_CLAUDE_INSTALLER_COMMAND (a JSON array)', () => {
    expect(installerCommandFromEnv({})).toBeNull();
    expect(installerCommandFromEnv({ MOTION_STUDIO_CLAUDE_INSTALLER_COMMAND: '["node","-e","1"]' })).toEqual(['node', '-e', '1']);
    expect(() => installerCommandFromEnv({ MOTION_STUDIO_CLAUDE_INSTALLER_COMMAND: '"x"' })).toThrow();
    expect(() => installerCommandFromEnv({ MOTION_STUDIO_CLAUDE_INSTALLER_COMMAND: '{' })).toThrow();
  });
  it('install: success, then the PATH/caches hook and the listeners', async () => {
    let changed = 0; let told = 0;
    const s = service({ onChanged: () => { changed += 1; } });
    s.onEnded(() => { told += 1; });
    expect(s.installClaude().state).toBe('running');
    await until(() => s.status().tasks.claudeInstall.state !== 'running');
    expect(s.status().tasks.claudeInstall).toEqual({ state: 'done' });
    expect([changed, told]).toEqual([1, 1]);
  });
  it('install: a failing installer is a failure (exit), one at a time', async () => {
    const s = service({ installerCommand: [node, '-e', 'setTimeout(() => process.exit(3), 200)'] });
    s.installClaude();
    expect(() => s.installClaude()).toThrow(SetupRefused);
    await until(() => s.status().tasks.claudeInstall.state !== 'running');
    expect(s.status().tasks.claudeInstall).toEqual({ state: 'failed', error: 'exit' });
  });
  it('install: a time limit stops it (its own process only)', async () => {
    const s = service({ installerCommand: [node, '-e', 'setInterval(() => {}, 1000)'], installTimeoutMs: 300 });
    s.installClaude();
    await until(() => s.status().tasks.claudeInstall.state !== 'running');
    expect(s.status().tasks.claudeInstall).toEqual({ state: 'failed', error: 'timeout' });
  });
  it('install: Cancel stops it', async () => {
    const s = service({ installerCommand: [node, '-e', 'setInterval(() => {}, 1000)'] });
    s.installClaude();
    await new Promise((r) => setTimeout(r, 150));
    s.cancel('claudeInstall');
    await until(() => s.status().tasks.claudeInstall.state !== 'running');
    expect(s.status().tasks.claudeInstall).toEqual({ state: 'cancelled' });
  });
  it('install: a missing installer is a start failure', async () => {
    const s = service({ installerCommand: [join(base, 'no-such-installer')] });
    s.installClaude();
    await until(() => s.status().tasks.claudeInstall.state !== 'running');
    expect(s.status().tasks.claudeInstall.state).toBe('failed');
  });
  it('refuses everything when the server is reachable from the network', () => {
    const s = service({ allowed: false });
    expect(() => s.installClaude()).toThrow(SetupRefused);
    expect(() => s.signIn()).toThrow(SetupRefused);
    expect(() => s.installFfmpeg()).toThrow(SetupRefused);
    expect(s.status().tasks.claudeInstall.state).toBe('idle');
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
  });

  /** A fake `claude auth login`: prints the sign-in address and waits (as the real one waits for the browser). */
  const fakeLogin = [node, '-e', 'console.log("Opening https://claude.ai/oauth/authorize?code=true&x=1 in your browser"); setInterval(() => {}, 1000)'];
  it('sign-in: polls `claude auth status --json` until signed in, shows the sign-in address, stops the login', async () => {
    let polls = 0;
    const calls: string[] = [];
    const s = service({
      claudeCommand: () => fakeLogin, loginPollMs: 50,
      exec: async (cmd, args) => { calls.push(args.slice(-3).join(' ')); polls += 1; return ok(JSON.stringify({ loggedIn: polls >= 3, email: 'x@y.z' })); },
    });
    // The fake "claude" is node -e <script>: `auth login` lands as extra argv the script ignores.
    expect(s.signIn().state).toBe('running');
    await until(() => Boolean(s.status().tasks.claudeLogin.loginUrl) || s.status().tasks.claudeLogin.state !== 'running');
    expect(s.status().tasks.claudeLogin.loginUrl).toBe('https://claude.ai/oauth/authorize?code=true&x=1');
    await until(() => s.status().tasks.claudeLogin.state !== 'running');
    expect(s.status().tasks.claudeLogin).toEqual({ state: 'done' });
    expect(calls.every((c) => c === 'auth status --json')).toBe(true);
  });
  it('sign-in: a time limit, and Cancel', async () => {
    const s = service({ claudeCommand: () => fakeLogin, loginPollMs: 30, loginTimeoutMs: 200 });
    s.signIn();
    await until(() => s.status().tasks.claudeLogin.state !== 'running');
    expect(s.status().tasks.claudeLogin).toEqual({ state: 'failed', error: 'timeout' });
    const c = service({ claudeCommand: () => fakeLogin, loginPollMs: 30 });
    c.signIn();
    await new Promise((r) => setTimeout(r, 100));
    c.cancel('claudeLogin');
    await until(() => c.status().tasks.claudeLogin.state !== 'running');
    expect(c.status().tasks.claudeLogin).toEqual({ state: 'cancelled' });
  });
  it('sign-in: a login that ends without signing in is a failure', async () => {
    const s = service({ claudeCommand: () => [node, '-e', 'process.exit(1)'], loginPollMs: 30 });
    s.signIn();
    await until(() => s.status().tasks.claudeLogin.state !== 'running');
    expect(s.status().tasks.claudeLogin).toEqual({ state: 'failed', error: 'exit' });
  });
  it('only an https address on an Anthropic host is offered as the sign-in page', () => {
    expect(loginUrlIn('go to https://claude.ai/oauth/authorize?x=1 now')).toBe('https://claude.ai/oauth/authorize?x=1');
    expect(loginUrlIn('https://console.anthropic.com/login')).toBe('https://console.anthropic.com/login');
    expect(loginUrlIn('https://evil.example/claude.ai http://claude.ai/x https://claude.ai.evil.example/')).toBeNull();
  });
});

/** A minimal stored zip (enough for the extractor). */
function zipOf(files: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name); const raw = Buffer.from(f.data); const body = deflateRawSync(raw); const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((0o100755 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('FFmpeg: the pinned builds and the install into the data folder (no real download)', () => {
  it('pins a build per computer: version, publisher, SHA-256 and exact size; Windows on Arm gets the x64 one', () => {
    for (const [key, b] of Object.entries(FFMPEG_BUILDS)) {
      expect(b.version, key).toBe('9.0.2');
      for (const a of b.archives) {
        expect(a.url, key).toMatch(/^https:\/\/(?:github\.com\/GyanD\/codexffmpeg\/releases\/download\/9\.0\.2\/|ffmpeg\.martin-riedl\.de\/download\/)/);
        expect(a.sha256, key).toMatch(/^[0-9a-f]{64}$/);
        expect(a.sizeBytes, key).toBeGreaterThan(10_000_000);
      }
    }
    expect(ffmpegBuildFor('win32', 'x86_64')!.source).toBe('gyan.dev');
    expect(ffmpegBuildFor('win32', 'arm64')!.source).toBe('gyan.dev');
    expect(ffmpegBuildFor('darwin', 'arm64')!.archives[0]!.url).toContain('/macos/arm64/');
    expect(ffmpegBuildFor('darwin', 'x86_64')!.archives[0]!.url).toContain('/macos/amd64/');
    expect(ffmpegBuildFor('linux', 'x64')!.archives[0]!.url).toContain('/linux/amd64/');
    expect(ffmpegBuildFor('linux', 'arm64')!.archives[0]!.url).toContain('/linux/arm64/');
    expect(ffmpegBuildFor('freebsd', 'x86_64')).toBeNull();
  });

  const ffZip = zipOf([{ name: 'ffmpeg', data: '#!/bin/sh\necho "ffmpeg version 9.0.2"\n' }]);
  const probeZip = zipOf([{ name: 'ffprobe', data: '#!/bin/sh\necho "ffprobe version 9.0.2"\n' }]);
  const build = (o: { badSha?: boolean } = {}): FfmpegBuild => ({
    version: '9.0.2', source: 'test', license: 'GPL',
    archives: [
      { url: 'https://ff.invalid/ffmpeg.zip', sha256: o.badSha ? '0'.repeat(64) : sha(ffZip), sizeBytes: ffZip.length },
      { url: 'https://ff.invalid/ffprobe.zip', sha256: sha(probeZip), sizeBytes: probeZip.length },
    ],
  });
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = url.endsWith('/ffmpeg.zip') ? ffZip : url.endsWith('/ffprobe.zip') ? probeZip : null;
    if (!body) throw new Error(`test tried to reach ${url}`);
    return new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } });
  };

  it('downloads, checks the SHA-256, extracts, and puts ffmpeg and ffprobe in <configDir>/tools/ffmpeg/bin', async () => {
    const progress: number[] = [];
    const bin = await installFfmpeg({ configDir: base, build: build(), platform: 'linux', fetchImpl: fakeFetch, onProgress: (p) => progress.push(p.bytes) });
    expect(bin).toBe(ffmpegBinDir(base));
    for (const n of ['ffmpeg', 'ffprobe']) {
      expect(readFileSync(join(bin, n), 'utf8')).toContain(`${n} version 9.0.2`);
      expect(statSync(join(bin, n)).mode & 0o111).not.toBe(0);
    }
    expect(progress.at(-1)).toBe(ffZip.length + probeZip.length);
  });
  it('a wrong SHA-256 installs nothing', async () => {
    await expect(installFfmpeg({ configDir: base, build: build({ badSha: true }), platform: 'linux', fetchImpl: fakeFetch })).rejects.toThrow(/sha256/);
    expect(existsSync(ffmpegBinDir(base))).toBe(false);
  });
  it('the service reports progress and the outcome; a failure says download, Cancel stops it', async () => {
    let release: (() => void) | null = null;
    const s = new SetupService({
      claudeCommand: () => ['claude'], exec: async () => ok(''), configDir: base, allowed: true, ffmpegBuild: build(),
      installFfmpegImpl: async (o) => {
        o.onProgress?.({ bytes: 100, total: 200 });
        await new Promise<void>((r, j) => { release = r; o.signal?.addEventListener('abort', () => j(new Error('aborted'))); });
        return ffmpegBinDir(base);
      },
    });
    expect(s.status().ffmpeg).toEqual({ version: '9.0.2', source: 'test', sizeBytes: ffZip.length + probeZip.length, license: 'GPL' });
    s.installFfmpeg();
    await until(() => s.status().tasks.ffmpegInstall.bytes === 100);
    release!();
    await until(() => s.status().tasks.ffmpegInstall.state !== 'running');
    expect(s.status().tasks.ffmpegInstall).toEqual({ state: 'done' });
    s.installFfmpeg();
    await until(() => release !== null && s.status().tasks.ffmpegInstall.bytes === 100);
    s.cancel('ffmpegInstall');
    await until(() => s.status().tasks.ffmpegInstall.state !== 'running');
    expect(s.status().tasks.ffmpegInstall).toEqual({ state: 'cancelled' });
    const f = new SetupService({
      claudeCommand: () => ['claude'], exec: async () => ok(''), configDir: base, allowed: true, ffmpegBuild: build({ badSha: true }),
      installFfmpegImpl: (o) => installFfmpeg({ ...o, fetchImpl: fakeFetch }),
    });
    f.installFfmpeg();
    await until(() => f.status().tasks.ffmpegInstall.state !== 'running');
    expect(f.status().tasks.ffmpegInstall).toEqual({ state: 'failed', error: 'download' });
  });
  it('no build for this computer: no button, and the install is refused', () => {
    const s = new SetupService({ claudeCommand: () => ['claude'], exec: async () => ok(''), configDir: base, allowed: true, ffmpegBuild: null });
    expect(s.status().ffmpeg).toBeNull();
    expect(() => s.installFfmpeg()).toThrow(SetupRefused);
  });
});

describe('the setup routes', () => {
  const TOKEN = 'cd'.repeat(32);
  const H = { 'x-motion-studio-ui': TOKEN };
  let app: FastifyInstance | null = null;
  afterEach(async () => { await app?.close(); app = null; });
  const build = async (allowed: boolean) => {
    const setup = new SetupService({ claudeCommand: () => ['claude'], exec: async () => ok(''), configDir: base, allowed, ffmpegBuild: null, installerCommand: [node, '-e', 'process.exit(0)'], platform: 'win32' });
    app = await buildServer({
      uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
      runner: new ClaudeCodeRunner([node, '-e', ''], { killGraceMs: 200 }), doctor: async () => [], setup,
    });
    return setup;
  };
  it('need the UI token, and the consent before anything runs', async () => {
    await build(true);
    expect((await app!.inject({ url: '/api/setup' })).statusCode).toBe(401);
    const s = (await app!.inject({ url: '/api/setup', headers: H })).json() as SetupStatus;
    expect(s).toMatchObject({ platform: 'windows', allowed: true, claudeManual: 'irm https://claude.ai/install.ps1 | iex', ffmpeg: null });
    const refused = await app!.inject({ method: 'POST', url: '/api/setup/claude/install', headers: H, payload: {} });
    expect(refused.statusCode).toBe(400);
    expect(((await app!.inject({ url: '/api/setup', headers: H })).json() as SetupStatus).tasks.claudeInstall.state).toBe('idle');
    const started = await app!.inject({ method: 'POST', url: '/api/setup/claude/install', headers: H, payload: { consent: true } });
    expect(started.statusCode).toBe(202);
    await until(async () => ((await app!.inject({ url: '/api/setup', headers: H })).json() as SetupStatus).tasks.claudeInstall.state === 'done');
    expect((await app!.inject({ method: 'POST', url: '/api/setup/nope/cancel', headers: H })).statusCode).toBe(404);
  });
  it('a server open to the network refuses the installs (403)', async () => {
    await build(false);
    for (const url of ['/api/setup/claude/install', '/api/setup/claude/login', '/api/setup/ffmpeg/install']) {
      expect((await app!.inject({ method: 'POST', url, headers: H, payload: { consent: true } })).statusCode, url).toBe(403);
    }
  });
});

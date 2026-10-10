import { existsSync, linkSync, readFileSync } from 'node:fs';
import { appendFile, chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceSettingsSchema, type AgentEvent } from '@motion-studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AgentLauncher, sweepRunDir, type LauncherDeps } from '../src/agent/launcher.ts';
import { ProjectQuarantinedError } from '../src/project-integrity.ts';
import { Git } from '../src/git.ts';
import type { AgentRunner } from '../src/agent/runner.ts';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { PermissionsStore } from '../src/approvals/permissions-store.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { escapeGlob } from '../src/codebases.ts';
import { PROVIDER_ENV } from '../src/secrets/vault.ts';
import { testLauncher } from './helpers/launcher.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  delete process.env.FAKE_CLAUDE_ARGS_FILE;
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

async function newProject() {
  const projectDir = await mkdtemp(join(tmpdir(), 'ms-launch è '));
  cleanup.push(projectDir);
  return projectDir;
}

async function launch(over: Parameters<typeof testLauncher>[1], kind: 'creative' | 'brand-analysis' | 'describe' | 'console' = 'creative', projectDir?: string, protectedDirs?: string[]) {
  const dir = projectDir ?? await newProject();
  if (!projectDir) {
    await new PermissionsStore(dir).add('Bash(ls:*)', 'x');
    await new PermissionsStore(dir).add('provider:openai-images', 'x');
  }
  const argsFile = join(dir, 'args.json');
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  const launcher = testLauncher(new ClaudeCodeRunner([process.execPath, FAKE]), over);
  const run = await launcher.start({ kind, jobId: 'j1', projectSlug: 'acme', projectDir: dir, codebases: [], request: { prompt: 'ciao' }, onEvent: () => {}, ...(protectedDirs ? { protectedDirs } : {}) });
  await run.done;
  const { args, env, mcpTimeout, mcpConfigFile, tokenFile, envKeys, cacheEnv } = JSON.parse(await readFile(argsFile, 'utf8'));
  return { cacheEnv: cacheEnv as Record<string, string | null>, args: args as string[], env, mcpTimeout, envKeys: envKeys as string[], tokenFile: tokenFile as { path: string; mode: number; content: string } | null, mcpConfigFile: mcpConfigFile as { path: string; mode: number | null; content: string | null } | null, launcher, projectDir: dir };
}

const protectedDirRules = (dir: string, name: string) => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].map((t) => `${t}(/${escapeGlob(join(dir, name))}/**)`);
const studioRules = (dir: string) => protectedDirRules(dir, '.studio');

describe('AgentLauncher sandbox caches', () => {
  it('points the caches at <project>/.cache only when sandboxed', { timeout: 20_000 }, async () => {
    vi.stubEnv('HOME', '/fake-home-for-test');
    // Restored even when the launch throws: a stubbed HOME must never leak into later tests.
    let on: Awaited<ReturnType<typeof launch>>;
    try { on = await launch({ sandbox: async () => ({ available: true, reason: 'ok' }) }); } finally { vi.unstubAllEnvs(); }
    // No cache variable may point into the (fake) real HOME: every one is inside the project.
    for (const k of ['npm_config_cache', 'PIP_CACHE_DIR', 'XDG_CACHE_HOME'] as const) {
      expect(on.cacheEnv[k], k).not.toContain('/fake-home-for-test');
      expect(on.cacheEnv[k], k).toContain(on.projectDir);
    }
    expect(on.cacheEnv.npm_config_cache).toBe(join(on.projectDir, '.cache', 'npm'));
    expect(on.cacheEnv.PIP_CACHE_DIR).toBe(join(on.projectDir, '.cache', 'pip'));
    expect(on.cacheEnv.XDG_CACHE_HOME).toBe(join(on.projectDir, '.cache', 'xdg'));
    expect(on.cacheEnv.PUPPETEER_SKIP_DOWNLOAD).toBe('1');
    expect(on.cacheEnv.HOME).toBe('/fake-home-for-test');
    const off = await launch({});
    expect(off.cacheEnv.npm_config_cache).toBe(process.env.npm_config_cache ?? null);
    expect(off.cacheEnv.PUPPETEER_SKIP_DOWNLOAD).toBe(null);
    const sandboxOff = await launch({ sandbox: async () => ({ available: true, reason: 'ok' }), settings: { sandboxMode: 'off' } });
    expect(sandboxOff.cacheEnv.PIP_CACHE_DIR).toBe(null);
  });
});

describe('AgentLauncher sandbox decision', () => {
  it('a sandbox turned off between the prompt and start wins: the override can only downgrade, never claim a sandbox', { timeout: 20_000 }, async () => {
    const dir = await newProject();
    const argsFile = join(dir, 'args.json');
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    let mode: 'auto' | 'off' = 'auto';
    const base = testLauncher(new ClaudeCodeRunner([process.execPath, FAKE]), { sandbox: async () => ({ available: true, reason: 'ok' }) });
    const launcher = new AgentLauncher({ ...(base as unknown as { deps: LauncherDeps }).deps, settings: async () => workspaceSettingsSchema.parse({ schemaVersion: 1, sandboxMode: mode }) });
    const decided = await launcher.sandboxed(); // what the prompt claims
    mode = 'off'; // toggled after the prompt was built
    const run = await launcher.start({ kind: 'creative', jobId: 'j1', projectSlug: 'acme', projectDir: dir, codebases: [], request: { prompt: 'ciao' }, onEvent: () => {}, sandboxed: decided });
    await run.done;
    const { cacheEnv, args } = JSON.parse(await readFile(argsFile, 'utf8'));
    expect(decided).toBe(true);
    // The safe direction: the job runs unsandboxed (asking as usual) even though the prompt said sandboxed.
    expect(cacheEnv.npm_config_cache).not.toBe(join(dir, '.cache', 'npm')); // whatever the parent env had, not the project cache
    expect(args).not.toContain('--settings');
  });
  it('the override keeps the prompt and the policy in agreement when nothing changes', { timeout: 20_000 }, async () => {
    const dir = await newProject();
    const argsFile = join(dir, 'args.json');
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    const launcher = testLauncher(new ClaudeCodeRunner([process.execPath, FAKE]), { sandbox: async () => ({ available: true, reason: 'ok' }) });
    const decided = await launcher.sandboxed();
    await (await launcher.start({ kind: 'creative', jobId: 'j1', projectSlug: 'acme', projectDir: dir, codebases: [], request: { prompt: 'ciao' }, onEvent: () => {}, sandboxed: decided })).done;
    const { cacheEnv, args } = JSON.parse(await readFile(argsFile, 'utf8'));
    expect(decided).toBe(true);
    expect(cacheEnv.npm_config_cache).toBe(join(dir, '.cache', 'npm'));
    expect(args).toContain('--settings');
  });
});

describe('AgentLauncher', () => {
  it('without sandbox and MCP keeps the phase 3 behaviour plus project rules (never provider rules)', { timeout: 20_000 }, async () => {
    const { args } = await launch({});
    expect(args).toContain('--permission-prompts');
    expect(args).not.toContain('--settings');
    expect(args).toContain('Bash(ls:*)');
    expect(args).not.toContain('provider:openai-images');
    expect(args).not.toContain('--mcp-config');
  });
  it('with sandbox passes the sandbox settings', { timeout: 20_000 }, async () => {
    const { args } = await launch({ sandbox: async () => ({ available: true, reason: 'ok' }) });
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    expect(settings.sandbox.enabled).toBe(true);
  });
  it('honours sandboxMode off', { timeout: 20_000 }, async () => {
    const { args } = await launch({ sandbox: async () => ({ available: true, reason: 'ok' }), settings: { sandboxMode: 'off' } });
    expect(args).not.toContain('--settings');
  });
  it('with a bridge origin wires the MCP server through a private file, the prompt tool, the env and frees the token at the end', { timeout: 20_000 }, async () => {
    const bridge = new AgentBridge();
    bridge.setOrigin('http://127.0.0.1:4317');
    const configDir = await newProject();
    const { args, env, mcpTimeout, mcpConfigFile, tokenFile } = await launch({ bridge, mcpCommand: ['node', '/x/server.mjs'], configDir });
    expect(args).toContain('--strict-mcp-config');
    const path = args[args.indexOf('--mcp-config') + 1]!;
    expect(path.startsWith(join(configDir, 'run') + '/')).toBe(true);
    expect(path).toMatch(/\.mcp\.json$/);
    expect(mcpConfigFile).toMatchObject({ path, mode: 0o600 });
    const cfg = JSON.parse(mcpConfigFile!.content!);
    expect(cfg.mcpServers.studio).toMatchObject({ type: 'stdio', command: 'node', args: ['/x/server.mjs'] });
    expect(cfg.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_URL).toBe('http://127.0.0.1:4317');
    expect(cfg.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN).toBeUndefined(); // the raw token is not in the config
    const tokenPath = cfg.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE as string;
    expect(tokenPath).toBe(path.replace(/\.mcp\.json$/, '.token'));
    expect(tokenFile).toMatchObject({ path: tokenPath, mode: 0o600 });
    const token = tokenFile!.content;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(args.some((a) => a.includes(token))).toBe(false); // never visible in the process list
    expect(cfg.mcpServers.studio.env.MOTION_STUDIO_TOOLS).toContain('validate_output');
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__studio__approve');
    expect(args).not.toContain('--permission-prompts');
    expect(args).toContain('mcp__studio__report_progress');
    expect(env).toBe(null); // MS_TEST_ENV unset
    expect(mcpTimeout).toBe('900000');
    expect(bridge.resolve(token)).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(tokenPath)).toBe(false);
    expect((await stat(join(configDir, 'run'))).mode & 0o777).toBe(0o700);
  });
  it('passes mcpEnv to the MCP server env without letting it override the Motion Studio variables', { timeout: 20_000 }, async () => {
    const bridge = new AgentBridge();
    bridge.setOrigin('http://127.0.0.1:4317');
    const { mcpConfigFile, args } = await launch({
      bridge, mcpCommand: ['node', '/x/server.mjs'],
      mcpEnv: { ELECTRON_RUN_AS_NODE: '1', MOTION_STUDIO_BRIDGE_TOKEN_FILE: '/evil', MOTION_STUDIO_BRIDGE_URL: 'http://evil', MOTION_STUDIO_TOOLS: 'x' },
    });
    const env = JSON.parse(mcpConfigFile!.content!).mcpServers.studio.env;
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    const path = args[args.indexOf('--mcp-config') + 1]!;
    expect(env.MOTION_STUDIO_BRIDGE_TOKEN_FILE).toBe(path.replace(/\.mcp\.json$/, '.token'));
    expect(env.MOTION_STUDIO_BRIDGE_URL).toBe('http://127.0.0.1:4317');
    expect(env.MOTION_STUDIO_TOOLS).toContain('validate_output');
  });
  it('only exposes the MCP tools of the job kind', { timeout: 20_000 }, async () => {
    const bridge = new AgentBridge();
    bridge.setOrigin('http://127.0.0.1:4317');
    const { mcpConfigFile, args } = await launch({ bridge, mcpCommand: ['node', '/x/server.mjs'] }, 'describe');
    const cfg = JSON.parse(mcpConfigFile!.content!);
    expect(cfg.mcpServers.studio.env.MOTION_STUDIO_TOOLS).toBe('report_progress');
    expect(args).not.toContain('mcp__studio__read_brand_kit');
    const brand = await launch({ bridge, mcpCommand: ['node', '/x/server.mjs'] }, 'brand-analysis');
    expect(JSON.parse(brand.mcpConfigFile!.content!).mcpServers.studio.env.MOTION_STUDIO_TOOLS).toBe('report_progress,read_brand_kit,fonts_fetch,download_file');
    expect(brand.args).toContain('mcp__studio__download_file');
    const creative = await launch({ bridge, mcpCommand: ['node', '/x/server.mjs'] }, 'creative');
    expect(creative.args).not.toContain('mcp__studio__download_file');
  });
  it('protects .studio (and its real path) from edits for every job kind, sandbox or not', { timeout: 20_000 }, async () => {
    const real = await newProject();
    const linkParent = await newProject();
    const linked = join(linkParent, 'link');
    await symlink(real, linked);
    for (const kind of ['creative', 'console', 'brand-analysis', 'describe'] as const) {
      for (const available of [false, true]) {
        const { args } = await launch({ sandbox: async () => ({ available, reason: 'x' }) }, kind, linked);
        const realDir = await realpath(linked);
        expect(args).toEqual(expect.arrayContaining([...studioRules(linked), ...studioRules(realDir)]));
        if (available) {
          const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
          expect(settings.sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining([join(linked, '.studio'), join(realDir, '.studio')]));
        }
      }
    }
  });
  it('protects every creative\'s conversation/versions/creative files and every proposal log, plain and realpath, sandbox or not', { timeout: 30_000 }, async () => {
    const real = await newProject();
    const linkParent = await newProject();
    const linked = join(linkParent, 'link');
    await symlink(real, linked);
    const realDir = await realpath(linked);
    await mkdir(join(real, 'creatives', 'other-1'), { recursive: true });
    await mkdir(join(real, 'brand', 'proposals', 'p-1'), { recursive: true });
    const tools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
    for (const kind of ['creative', 'brand-analysis'] as const) {
      for (const available of [false, true]) {
        const { args } = await launch({ sandbox: async () => ({ available, reason: 'x' }) }, kind, linked);
        const globs = (d: string) => [...['conversation.jsonl', 'versions.json', 'creative.json'].map((n) => `${escapeGlob(join(d, 'creatives'))}/*/${n}`), `${escapeGlob(join(d, 'brand', 'proposals'))}/*/log.jsonl`];
        for (const d of [linked, realDir]) for (const g of globs(d)) expect(args).toEqual(expect.arrayContaining(tools.map((t) => `${t}(/${g})`)));
        // The agent's own folders stay writable.
        const globToRe = (g: string) => new RegExp(`^${g.replace(/\\(.)/g, '\u0000$1').split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*').replace(/\u0000(.)/g, (_m, c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}$`);
        const rules = args.filter((a) => /^(Edit|Write|MultiEdit|NotebookEdit)\(/.test(a));
        const sbDeny: string[] = available ? JSON.parse(args[args.indexOf('--settings') + 1]!).sandbox.filesystem.denyWrite : [];
        for (const f of [join(linked, 'creatives', 'x', 'outputs', 'v1', 'a.png'), join(linked, 'creatives', 'x', 'work', 'a')]) {
          for (const r of rules) { const g = /^\w+\(\/(.*)\)$/.exec(r)![1]!; expect(globToRe(g.replace(/\/\*\*$/, '/**')).test(f) && !g.endsWith('/**') ? r : null, r).toBeNull(); expect(g.endsWith('/**') && f.startsWith(g.slice(0, -2).replace(/\\(.)/g, '$1')) ? r : null, r).toBeNull(); }
          for (const d of sbDeny) { expect(globToRe(d).test(f) ? d : null).toBeNull(); expect(f.startsWith(`${d}/`) ? d : null).toBeNull(); }
        }
        if (available) {
          const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
          const deny: string[] = settings.sandbox.filesystem.denyWrite;
          expect(deny).toEqual(expect.arrayContaining([join(linked, 'creatives', '*', 'conversation.jsonl'), join(realDir, 'brand', 'proposals', '*', 'log.jsonl')]));
          for (const d of [linked, realDir]) {
            expect(deny).toEqual(expect.arrayContaining([join(d, 'creatives', 'other-1', 'conversation.jsonl'), join(d, 'creatives', 'other-1', 'versions.json'), join(d, 'creatives', 'other-1', 'creative.json'), join(d, 'brand', 'proposals', 'p-1', 'log.jsonl')]));
          }
        }
      }
    }
  });
  it('protects the caller\'s extra folders (earlier outputs/v*), plain and realpath, sandbox or not; the new one stays writable', { timeout: 30_000 }, async () => {
    const real = await newProject();
    const linkParent = await newProject();
    const linked = join(linkParent, 'link');
    await symlink(real, linked);
    const realDir = await realpath(linked);
    const v1 = (d: string) => join(d, 'creatives', 'c', 'outputs', 'v1');
    for (const available of [false, true]) {
      const { args } = await launch({ sandbox: async () => ({ available, reason: 'x' }) }, 'creative', linked, [v1(linked)]);
      for (const d of [linked, realDir]) {
        expect(args).toEqual(expect.arrayContaining(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].map((t) => `${t}(/${escapeGlob(v1(d))}/**)`)));
        if (available) expect(JSON.parse(args[args.indexOf('--settings') + 1]!).sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining([v1(d)]));
      }
      expect(args.some((a) => a.includes(join('outputs', 'v2')))).toBe(false);
    }
  });
  it('never passes the provider keys or the bridge token from the environment to the agent', { timeout: 20_000 }, async () => {
    const keys = [...Object.values(PROVIDER_ENV), 'MOTION_STUDIO_BRIDGE_TOKEN'];
    for (const k of keys) process.env[k] = `secret-${k}`;
    try {
      const bridge = new AgentBridge();
      bridge.setOrigin('http://127.0.0.1:4317');
      const { envKeys, mcpTimeout } = await launch({ bridge, mcpCommand: ['node', '/x/server.mjs'] });
      for (const k of keys) expect(envKeys).not.toContain(k);
      expect(mcpTimeout).toBe('900000');
    } finally {
      for (const k of keys) delete process.env[k];
    }
  });
  it('protects .git, .claude, CLAUDE.md, CLAUDE.local.md and .mcp.json (and their real paths) for every job kind, sandbox or not', { timeout: 30_000 }, async () => {
    const real = await newProject();
    const linkParent = await newProject();
    const linked = join(linkParent, 'link');
    await symlink(real, linked);
    const realDir = await realpath(linked);
    const tools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
    for (const kind of ['creative', 'console', 'brand-analysis', 'describe'] as const) {
      for (const available of [false, true]) {
        const { args } = await launch({ sandbox: async () => ({ available, reason: 'x' }) }, kind, linked);
        for (const d of [linked, realDir]) {
          expect(args).toEqual(expect.arrayContaining([...protectedDirRules(d, '.git'), ...protectedDirRules(d, '.claude')]));
          for (const f of ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', '.gitattributes']) {
            expect(args).toEqual(expect.arrayContaining(tools.map((t) => `${t}(/${escapeGlob(join(d, f))})`)));
          }
          if (available) {
            const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
            expect(settings.sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining(
              ['.git', '.claude', '.studio', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', '.gitattributes'].map((n) => join(d, n)),
            ));
          }
        }
      }
    }
  });
  it('ignores stored rules that are not valid "always" rules, and a corrupt permissions file', { timeout: 20_000 }, async () => {
    const dir = await newProject();
    await mkdir(join(dir, '.studio'), { recursive: true });
    const at = new Date().toISOString();
    await writeFile(join(dir, '.studio', 'permissions.json'), JSON.stringify({ schemaVersion: 1, allow: [
      { rule: 'Bash(*)', label: 'x', addedAt: at }, { rule: 'Bash(node:*)', label: 'x', addedAt: at }, { rule: 'Bash(ls:*)', label: 'x', addedAt: at },
    ] }));
    const { args } = await launch({}, 'console', dir);
    expect(args).not.toContain('Bash(*)');
    expect(args).not.toContain('Bash(node:*)');
    expect(args).toContain('Bash(ls:*)');
    await writeFile(join(dir, '.studio', 'permissions.json'), '{oops');
    const again = await launch({}, 'console', dir);
    expect(again.args).not.toContain('Bash(ls:*)');
  });
  it('cancel denies the job approvals and cancels the run; done frees the approvals too', async () => {
    const approvals = new ApprovalBroker({ broadcast: () => {} });
    let cancelled = false;
    let finish: (v: { status: 'succeeded' }) => void = () => {};
    const runner: AgentRunner = { start: () => ({ done: new Promise((r) => { finish = r; }), cancel: () => { cancelled = true; } }) };
    const projectDir = await newProject();
    const launcher = testLauncher(runner, { approvals });
    const run = await launcher.start({ kind: 'creative', jobId: 'j9', projectSlug: 'acme', projectDir, request: { prompt: 'x' }, onEvent: () => {} });
    const pending = approvals.request({ jobId: 'j9', projectSlug: 'acme', projectDir, creativeSlug: null, kind: 'tool', toolName: 'Bash', input: { command: 'x' } });
    run.cancel();
    expect(cancelled).toBe(true);
    await expect(pending).resolves.toEqual({ decision: 'cancelled' });
    const late = approvals.request({ jobId: 'j9', projectSlug: 'acme', projectDir, creativeSlug: null, kind: 'tool', toolName: 'Bash', input: { command: 'x' } });
    finish({ status: 'succeeded' });
    await run.done;
    await expect(late).resolves.toEqual({ decision: 'cancelled' });
  });
  it('revokes the token and removes the MCP config file as soon as the run is cancelled', async () => {
    const bridge = new AgentBridge();
    bridge.setOrigin('http://127.0.0.1:4317');
    let configPath = '';
    let tokenPath = '';
    let runnerCancelled = false;
    let tokenAtRunnerCancel: unknown = 'unset';
    let token = '';
    const runner: AgentRunner = { start: (req) => {
      configPath = req.mcpConfigPath!;
      tokenPath = configPath.replace(/\.mcp\.json$/, '.token'); token = readFileSync(tokenPath, 'utf8');
      return { done: new Promise(() => {}), cancel: () => { runnerCancelled = true; tokenAtRunnerCancel = bridge.resolve(token); } };
    } };
    const projectDir = await newProject();
    const launcher = testLauncher(runner, { bridge, mcpCommand: ['node', '/x/server.mjs'] });
    const run = await launcher.start({ kind: 'creative', jobId: 'j7', projectSlug: 'acme', projectDir, request: { prompt: 'x' }, onEvent: () => {} });
    expect(bridge.resolve(token)).not.toBeNull();
    run.cancel();
    expect(bridge.resolve(token)).toBeNull();
    expect(runnerCancelled).toBe(true);
    expect(tokenAtRunnerCancel).toBeNull(); // revoked before the runner is told
    await vi.waitFor(() => expect(existsSync(configPath)).toBe(false));
    expect(existsSync(tokenPath)).toBe(false);
  });
  it('frees the token and the MCP config file when the runner fails to start', async () => {
    const bridge = new AgentBridge();
    bridge.setOrigin('http://127.0.0.1:4317');
    let configPath = '';
    let tokenPath = '';
    let token = '';
    const runner: AgentRunner = { start: (req) => {
      configPath = req.mcpConfigPath!;
      tokenPath = configPath.replace(/\.mcp\.json$/, '.token'); token = readFileSync(tokenPath, 'utf8');
      throw new Error('claudeCommand vuoto');
    } };
    const projectDir = await newProject();
    const launcher = testLauncher(runner, { bridge, mcpCommand: ['node', '/x/server.mjs'] });
    await expect(launcher.start({ kind: 'creative', jobId: 'j8', projectSlug: 'acme', projectDir, request: { prompt: 'x' }, onEvent: () => {} })).rejects.toThrow('claudeCommand vuoto');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(bridge.resolve(token)).toBeNull();
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(tokenPath)).toBe(false);
  });
  it('sweeps leftover run files, replacing a run folder that is a link or a file without following it', async () => {
    const configDir = await newProject();
    const run = join(configDir, 'run');
    await mkdir(run, { mode: 0o700 });
    for (const f of ['a.mcp.json', 'a.token', 'keep.txt', 'server.json']) await writeFile(join(run, f), 'x');
    await sweepRunDir(configDir);
    expect(existsSync(join(run, 'server.json'))).toBe(true);
    expect(existsSync(join(run, 'a.mcp.json'))).toBe(false);
    expect(existsSync(join(run, 'a.token'))).toBe(false);
    expect(existsSync(join(run, 'keep.txt'))).toBe(true);
    const outside = await newProject();
    await writeFile(join(outside, 'b.token'), 'x');
    await rm(run, { recursive: true });
    await symlink(outside, run);
    await sweepRunDir(configDir);
    expect(existsSync(run)).toBe(false); // the link is gone
    expect(existsSync(join(outside, 'b.token'))).toBe(true); // its target was never touched
    await writeFile(run, 'file');
    await sweepRunDir(configDir);
    expect(existsSync(run)).toBe(false);
    await sweepRunDir(join(configDir, 'missing')); // no folder: nothing to do
  });
  it('replaces a run folder that is a link instead of writing or chmod-ing through it', { timeout: 20_000 }, async () => {
    const bridge = new AgentBridge();
    bridge.setOrigin('http://127.0.0.1:4317');
    const configDir = await newProject();
    const outside = await newProject();
    await chmod(outside, 0o755);
    await symlink(outside, join(configDir, 'run'));
    const { mcpConfigFile } = await launch({ bridge, mcpCommand: ['node', '/x/server.mjs'], configDir });
    expect(mcpConfigFile!.path.startsWith(join(configDir, 'run') + '/')).toBe(true);
    const st = await lstat(join(configDir, 'run'));
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    expect((await stat(outside)).mode & 0o777).toBe(0o755);
    expect(await readdir(outside)).toEqual([]);
  });
  it('reads the settings once per start', { timeout: 20_000 }, async () => {
    let reads = 0;
    const projectDir = await newProject();
    process.env.FAKE_CLAUDE_ARGS_FILE = join(projectDir, 'args.json');
    const launcher = new AgentLauncher({
      runner: new ClaudeCodeRunner([process.execPath, FAKE]), bridge: new AgentBridge(), approvals: new ApprovalBroker({ broadcast: () => {} }),
      sandbox: async () => ({ available: true, reason: '' }), configDir: projectDir, mcpCommand: null,
      settings: async () => { reads++; return workspaceSettingsSchema.parse({ schemaVersion: 1 }); },
    });
    await (await launcher.start({ kind: 'describe', jobId: 'j6', projectSlug: 'acme', projectDir, request: { prompt: 'x' }, onEvent: () => {} })).done;
    expect(reads).toBe(1);
  });

  it("stamps the run's session event with the job's sandbox decision (count work)", { timeout: 20_000 }, async () => {
    const projectDir = await newProject();
    const runner: AgentRunner = {
      start: (_req, onEvent) => {
        onEvent({ kind: 'session', sessionId: 's1', model: 'haiku' });
        onEvent({ kind: 'text', text: 'hi' });
        return { done: Promise.resolve({ status: 'succeeded' as never }), cancel: () => {} };
      },
    };
    for (const [available, mode, expected] of [[true, 'auto', true], [false, 'auto', false], [true, 'off', false]] as const) {
      const got: unknown[] = [];
      const launcher = new AgentLauncher({
        runner, bridge: new AgentBridge(), approvals: new ApprovalBroker({ broadcast: () => {} }),
        sandbox: async () => ({ available, reason: '' }), configDir: projectDir, mcpCommand: null,
        settings: async () => workspaceSettingsSchema.parse({ schemaVersion: 1, sandboxMode: mode }),
      });
      await (await launcher.start({ kind: 'creative', jobId: 'j7', projectSlug: 'acme', projectDir, request: { prompt: 'x' }, onEvent: (e) => got.push(e) })).done.catch(() => {});
      expect(got.slice(0, 2)).toEqual([{ kind: 'session', sessionId: 's1', model: 'haiku', sandboxed: expected }, { kind: 'text', text: 'hi' }]);
    }
  });
});

describe('AgentLauncher protected files under a root with glob characters (decisions log 141)', () => {
  it('sends the sandbox the escaped roots: concrete entries and the log globs both match the real paths', { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-launch [x] *? '));
    cleanup.push(dir);
    await mkdir(join(dir, 'creatives', 'c1'), { recursive: true });
    const { args } = await launch({ sandbox: async () => ({ available: true, reason: 'x' }) }, 'console', dir);
    const deny: string[] = JSON.parse(args[args.indexOf('--settings') + 1]!).sandbox.filesystem.denyWrite;
    // Claude Code's glob → regex (see policy.test.ts): `[` must not survive as an open class.
    const toRe = (g: string) => new RegExp(`^${g.replace(/[.^$+{}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}(/.*)?$`);
    const covered = (f: string) => deny.some((d) => (/[*?[\]]/.test(d) ? toRe(d).test(f) : f === d || f.startsWith(`${d}/`)));
    const realDir = await realpath(dir);
    for (const root of [dir, realDir]) {
      for (const f of [join(root, '.studio', 'usage.jsonl'), join(root, 'creatives', 'c1', 'conversation.jsonl'), join(root, 'creatives', 'made-later', 'versions.json'), join(root, 'brand', 'proposals', 'p', 'log.jsonl')]) {
        expect(covered(f), f).toBe(true);
      }
      expect(covered(join(root, 'creatives', 'c1', 'work', 'a.txt'))).toBe(false);
    }
    expect(deny.some((d) => d.includes('[x]'))).toBe(false);
  });
});

describe('AgentLauncher hard links to protected files', () => {
  /** A runner that runs `during` while the "agent" works, then succeeds. */
  const stubRunner = (during: () => Promise<void>): AgentRunner => ({
    start: () => ({ done: during().then(() => ({ status: 'succeeded' as const })), cancel: () => {} }),
  });
  it('detaches a linked log before the run and one linked during the run, with a warning each time', { timeout: 20_000 }, async () => {
    const dir = await newProject();
    const c = join(dir, 'creatives', 'c1');
    await mkdir(join(c, 'work'), { recursive: true });
    await writeFile(join(c, 'conversation.jsonl'), 'core\n');
    await mkdir(join(dir, '.studio'), { recursive: true });
    await writeFile(join(dir, '.studio', 'usage.jsonl'), '');
    await link(join(c, 'conversation.jsonl'), join(c, 'work', 'x'));
    let nlinkAtStart = 0;
    const launcher = testLauncher(stubRunner(async () => {
      nlinkAtStart = (await stat(join(c, 'conversation.jsonl'))).nlink;
      await link(join(dir, '.studio', 'usage.jsonl'), join(c, 'work', 'u'));
    }));
    const warnings: string[] = [];
    const run = await launcher.start({ kind: 'console', jobId: 'j1', projectSlug: 'acme', projectDir: dir, request: { prompt: 'x' }, onEvent: () => {}, onWarning: (w) => { warnings.push(w); } });
    await run.done;
    expect(nlinkAtStart).toBe(1);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(join('creatives', 'c1', 'conversation.jsonl'));
    expect(warnings[1]).toContain(join('.studio', 'usage.jsonl'));
    expect((await stat(join(dir, '.studio', 'usage.jsonl'))).nlink).toBe(1);
    await appendFile(join(c, 'work', 'x'), 'forged\n');
    expect(await readFile(join(c, 'conversation.jsonl'), 'utf8')).toBe('core\n');
  });
  it('without onWarning the warning is a progress event of the run', { timeout: 20_000 }, async () => {
    const dir = await newProject();
    await mkdir(join(dir, 'brand', 'proposals', 'p1'), { recursive: true });
    await writeFile(join(dir, 'brand', 'proposals', 'p1', 'log.jsonl'), '');
    await link(join(dir, 'brand', 'proposals', 'p1', 'log.jsonl'), join(dir, 'l'));
    const events: AgentEvent[] = [];
    const run = await testLauncher(stubRunner(async () => {})).start({ kind: 'brand-analysis', jobId: 'j1', projectSlug: 'acme', projectDir: dir, request: { prompt: 'x' }, onEvent: (e) => events.push(e) });
    await run.done;
    expect(events.filter((e) => e.kind === 'progress').map((e) => (e as { text: string }).text)).toEqual([expect.stringContaining('log.jsonl')]);
  });
});

describe('AgentLauncher after-run checks (review of decisions log 141)', () => {
  it('kills leftover processes before the after-run detach: a link made by a leftover until the kill is still caught', { timeout: 20_000 }, async () => {
    const dir = await newProject();
    await mkdir(join(dir, '.studio'), { recursive: true });
    await writeFile(join(dir, '.studio', 'usage.jsonl'), '');
    const order: string[] = [];
    const runner: AgentRunner = {
      start: () => ({
        done: Promise.resolve({ status: 'succeeded' as const }),
        cancel: () => {},
        // The leftover's last act happens right before it is killed.
        killGroup: () => { order.push('kill'); linkSync(join(dir, '.studio', 'usage.jsonl'), join(dir, 'leftover-link')); },
      }),
    };
    const run = await testLauncher(runner).start({ kind: 'brand-analysis', jobId: 'j1', projectSlug: 'acme', projectDir: dir, request: { prompt: 'x' }, onEvent: () => {}, onWarning: (w) => { order.push(w.includes('usage.jsonl') ? 'detached' : 'other'); } });
    await run.done;
    expect(order).toEqual(['kill', 'detached']);
    expect((await stat(join(dir, '.studio', 'usage.jsonl'))).nlink).toBe(1);
  });
  it('under a path with glob characters: one warning per job, and a creative moved out and back during the run is reported', { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-launch [x] '));
    cleanup.push(dir);
    const c = join(dir, 'creatives', 'c1');
    await mkdir(c, { recursive: true });
    await writeFile(join(c, 'conversation.jsonl'), '{"a":1}\n');
    let move = true;
    const runner: AgentRunner = {
      start: () => ({
        done: (async () => {
          await new Promise((r) => setTimeout(r, 15));
          if (move) {
            await rename(c, join(dir, 'out'));
            await writeFile(join(dir, 'out', 'conversation.jsonl'), '{"forged":1}\n');
            await rename(join(dir, 'out'), c);
          }
          return { status: 'succeeded' as const };
        })(),
        cancel: () => {},
      }),
    };
    const launcher = testLauncher(runner);
    const warnings: string[] = [];
    const start = (jobId: string) => launcher.start({ kind: 'creative', jobId, projectSlug: 'acme', projectDir: dir, creativeSlug: 'c1', request: { prompt: 'x' }, onEvent: () => {}, onWarning: (w) => { warnings.push(w); } });
    await (await start('j1')).done;
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('[ ] * o ?');
    expect(warnings[1]).toContain(join('creatives', 'c1'));
    expect(warnings[2]).toContain(join('creatives', 'c1', 'conversation.jsonl'));
    move = false;
    warnings.length = 0;
    await (await start('j1')).done; // second attempt of the same job: no repeat, nothing moved
    expect(warnings).toEqual([]);
    await (await start('j2')).done;
    expect(warnings).toHaveLength(1);
  });
});

describe('AgentLauncher integrity tripwire fails the job (decisions log 141)', () => {
  it('a protected config file changed during the run fails the job, warns, and quarantines the repo', { timeout: 20_000 }, async () => {
    const dir = await newProject();
    await mkdir(join(dir, '.git', 'info'), { recursive: true });
    await writeFile(join(dir, '.git', 'config'), '[core]\n\tfilemode = true\n');
    await writeFile(join(dir, 'CLAUDE.md'), '# ok');
    const runner: AgentRunner = {
      start: () => ({
        done: (async () => { await writeFile(join(dir, '.git', 'config'), '[filter "lfs"]\n\tclean = evil\n'); return { status: 'succeeded' as const }; })(),
        cancel: () => {},
      }),
    };
    const warnings: string[] = [];
    const launcher = testLauncher(runner);
    const run = await launcher.start({ kind: 'creative', jobId: 'j1', projectSlug: 'acme', projectDir: dir, creativeSlug: 'c1', request: { prompt: 'x' }, onEvent: () => {}, onWarning: (w) => { warnings.push(w); } });
    await expect(run.done).rejects.toThrow();
    expect(warnings.some((w) => w.includes('.git/config'))).toBe(true);
    expect(await launcher.integrity.isQuarantined(dir)).toBe(true);
  });
  it('does not kill the process group at the end of a console turn, but still runs the detach', { timeout: 20_000 }, async () => {
    const dir = await newProject();
    await mkdir(join(dir, '.studio'), { recursive: true });
    await writeFile(join(dir, '.studio', 'usage.jsonl'), '');
    let killed = false;
    const runner: AgentRunner = { start: () => ({ done: Promise.resolve({ status: 'succeeded' as const }), cancel: () => {}, killGroup: () => { killed = true; } }) };
    const run = await testLauncher(runner).start({ kind: 'console', jobId: 'j1', projectSlug: 'acme', projectDir: dir, request: { prompt: 'x' }, onEvent: () => {} });
    await run.done;
    expect(killed).toBe(false);
  });
});

describe('Integrity with the sandbox off (decisions log 141, round 4)', () => {
  /** A runner whose "agent" runs `act` in the project, as an unsandboxed agent could. */
  const acting = (act: () => Promise<void>): AgentRunner => ({
    start: () => ({ done: (async () => { await act(); return { status: 'succeeded' as const }; })(), cancel: () => {} }),
  });
  const off = { settings: { sandboxMode: 'off' as const } };
  async function gitProject() {
    const dir = await newProject();
    await new Git().init(dir);
    await writeFile(join(dir, 'CLAUDE.md'), '# ok');
    await writeFile(join(dir, 'a.txt'), 'x');
    return dir;
  }
  const start = (launcher: AgentLauncher, dir: string, jobId = 'j1') => launcher.start({ kind: 'creative', jobId, projectSlug: 'acme', projectDir: dir, creativeSlug: 'c1', request: { prompt: 'x' }, onEvent: () => {}, onWarning: () => {} });

  it('an agent creating .claude/settings.json fails the job and quarantines the project; launches and git are refused until it is removed, across a restart', { timeout: 30_000 }, async () => {
    const dir = await gitProject();
    let act = async () => { await mkdir(join(dir, '.claude'), { recursive: true }); await writeFile(join(dir, '.claude', 'settings.json'), '{"hooks":{"Stop":[]}}'); };
    const configDir = await mkdtemp(join(tmpdir(), 'ms-cfg-q-'));
    cleanup.push(configDir);
    const launcher = testLauncher(acting(() => act()), { ...off, configDir });
    await expect((await start(launcher, dir)).done).rejects.toThrow('.claude/settings.json');
    expect(await launcher.integrity.isQuarantined(dir)).toBe(true);
    act = async () => {};
    await expect(start(launcher, dir, 'j2')).rejects.toBeInstanceOf(ProjectQuarantinedError);
    await expect(new Git().commitAll(dir, 'c')).rejects.toThrow('.claude/settings.json');
    // A restart (a new launcher on the same config folder) still refuses.
    const restarted = testLauncher(acting(() => act()), { ...off, configDir });
    await expect(start(restarted, dir, 'j3')).rejects.toThrow('.claude/settings.json');
    // Restored: the quarantine clears by itself.
    await rm(join(dir, '.claude'), { recursive: true });
    await (await start(restarted, dir, 'j4')).done;
    expect(await restarted.integrity.isQuarantined(dir)).toBe(false);
    await expect(new Git().commitAll(dir, 'c')).resolves.toMatch(/^[0-9a-f]{40}$/);
  });
  it('an agent creating .git/commondir fails the job, and git refuses the repo', { timeout: 30_000 }, async () => {
    const dir = await gitProject();
    const launcher = testLauncher(acting(async () => { await writeFile(join(dir, '.git', 'commondir'), '/tmp/evil\n'); }), off);
    await expect((await start(launcher, dir)).done).rejects.toThrow('.git/commondir');
    expect(await launcher.integrity.isQuarantined(dir)).toBe(true);
    await expect(new Git().commitAll(dir, 'c')).rejects.toThrow();
  });
  it('a check() that throws fails the job and quarantines the project (fail closed)', { timeout: 30_000 }, async () => {
    const dir = await gitProject();
    const locked = join(dir, '.claude', 'locked');
    const launcher = testLauncher(acting(async () => { await mkdir(locked, { recursive: true }); await chmod(locked, 0o000); }), off);
    try {
      await expect((await start(launcher, dir)).done).rejects.toThrow();
      expect(await launcher.integrity.isQuarantined(dir)).toBe(true);
    } finally { await chmod(locked, 0o700).catch(() => {}); }
  });
  it('a change between runs (e.g. a leftover process) is caught at the next arm against the last good state', { timeout: 30_000 }, async () => {
    const dir = await gitProject();
    const launcher = testLauncher(acting(async () => {}), off);
    await (await start(launcher, dir)).done;
    await writeFile(join(dir, '.mcp.json'), '{"mcpServers":{"x":{"command":"evil"}}}');
    await expect(start(launcher, dir, 'j2')).rejects.toThrow('.mcp.json');
    expect(await launcher.integrity.isQuarantined(dir)).toBe(true);
    await rm(join(dir, '.mcp.json'));
    await (await start(launcher, dir, 'j3')).done;
  });
  it('permissions.json: a core write during the run stays quiet, a foreign write trips', { timeout: 30_000 }, async () => {
    const dir = await gitProject();
    const quiet = testLauncher(acting(async () => { await new PermissionsStore(dir).add('Bash(ls:*)', 'x'); }), off);
    await (await start(quiet, dir)).done;
    // Between runs the core writes again: still quiet at the next arm.
    await new PermissionsStore(dir).remove('Bash(ls:*)');
    await (await start(quiet, dir, 'j2')).done;
    const forged = JSON.stringify({ schemaVersion: 1, allow: [{ rule: 'WebFetch(domain:evil.example)', label: 'x', addedAt: new Date().toISOString() }] });
    const loud = testLauncher(acting(async () => { await writeFile(join(dir, '.studio', 'permissions.json'), forged); }), off);
    await expect((await start(loud, dir)).done).rejects.toThrow('.studio/permissions.json');
  });
});

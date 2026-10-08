import { existsSync, readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceSettingsSchema } from '@motion-studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AgentLauncher, sweepRunDir } from '../src/agent/launcher.ts';
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
  delete process.env.FAKE_CLAUDE_ARGS_FILE;
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

async function newProject() {
  const projectDir = await mkdtemp(join(tmpdir(), 'ms-launch è '));
  cleanup.push(projectDir);
  return projectDir;
}

async function launch(over: Parameters<typeof testLauncher>[1], kind: 'creative' | 'brand-analysis' | 'describe' | 'console' = 'creative', projectDir?: string) {
  const dir = projectDir ?? await newProject();
  if (!projectDir) {
    await new PermissionsStore(dir).add('Bash(ls:*)', 'x');
    await new PermissionsStore(dir).add('provider:openai-images', 'x');
  }
  const argsFile = join(dir, 'args.json');
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  const launcher = testLauncher(new ClaudeCodeRunner([process.execPath, FAKE]), over);
  const run = await launcher.start({ kind, jobId: 'j1', projectSlug: 'acme', projectDir: dir, codebases: [], request: { prompt: 'ciao' }, onEvent: () => {} });
  await run.done;
  const { args, env, mcpTimeout, mcpConfigFile, tokenFile, envKeys } = JSON.parse(await readFile(argsFile, 'utf8'));
  return { args: args as string[], env, mcpTimeout, envKeys: envKeys as string[], tokenFile: tokenFile as { path: string; mode: number; content: string } | null, mcpConfigFile: mcpConfigFile as { path: string; mode: number | null; content: string | null } | null, launcher, projectDir: dir };
}

const protectedDirRules = (dir: string, name: string) => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].map((t) => `${t}(/${escapeGlob(join(dir, name))}/**)`);
const studioRules = (dir: string) => protectedDirRules(dir, '.studio');

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
          for (const f of ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json']) {
            expect(args).toEqual(expect.arrayContaining(tools.map((t) => `${t}(/${escapeGlob(join(d, f))})`)));
          }
          if (available) {
            const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
            expect(settings.sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining(
              ['.git', '.claude', '.studio', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json'].map((n) => join(d, n)),
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
});

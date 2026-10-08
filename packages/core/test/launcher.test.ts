import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import type { AgentRunner } from '../src/agent/runner.ts';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { PermissionsStore } from '../src/approvals/permissions-store.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { escapeGlob } from '../src/codebases.ts';
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
    await new PermissionsStore(dir).add('Bash(brew install:*)', 'x');
    await new PermissionsStore(dir).add('provider:openai-images', 'x');
  }
  const argsFile = join(dir, 'args.json');
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  const launcher = testLauncher(new ClaudeCodeRunner([process.execPath, FAKE]), over);
  const run = await launcher.start({ kind, jobId: 'j1', projectSlug: 'acme', projectDir: dir, codebases: [], request: { prompt: 'ciao' }, onEvent: () => {} });
  await run.done;
  const { args, env, mcpTimeout } = JSON.parse(await readFile(argsFile, 'utf8'));
  return { args: args as string[], env, mcpTimeout, launcher, projectDir: dir };
}

const studioRules = (dir: string) => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].map((t) => `${t}(/${escapeGlob(join(dir, '.studio'))}/**)`);

describe('AgentLauncher', () => {
  it('without sandbox and MCP keeps the phase 3 behaviour plus project rules (never provider rules)', { timeout: 20_000 }, async () => {
    const { args } = await launch({});
    expect(args).toContain('--permission-prompts');
    expect(args).not.toContain('--settings');
    expect(args).toContain('Bash(brew install:*)');
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
  it('with a bridge origin wires the MCP server, the prompt tool, the env and frees the token at the end', { timeout: 20_000 }, async () => {
    const bridge = new AgentBridge();
    bridge.setOrigin('http://127.0.0.1:4317');
    const { args, env, mcpTimeout } = await launch({ bridge, mcpCommand: ['node', '/x/server.mjs'] });
    const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
    expect(cfg.mcpServers.studio).toMatchObject({ type: 'stdio', command: 'node', args: ['/x/server.mjs'] });
    expect(cfg.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_URL).toBe('http://127.0.0.1:4317');
    const token = cfg.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(cfg.mcpServers.studio.env.MOTION_STUDIO_TOOLS).toContain('validate_output');
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__studio__approve');
    expect(args).not.toContain('--permission-prompts');
    expect(args).toContain('mcp__studio__report_progress');
    expect(env).toBe(null); // MS_TEST_ENV unset
    expect(mcpTimeout).toBe('900000');
    expect(bridge.resolve(token)).toBeNull();
  });
  it('only exposes the MCP tools of the job kind', { timeout: 20_000 }, async () => {
    const bridge = new AgentBridge();
    bridge.setOrigin('http://127.0.0.1:4317');
    const { args } = await launch({ bridge, mcpCommand: ['node', '/x/server.mjs'] }, 'describe');
    const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
    expect(cfg.mcpServers.studio.env.MOTION_STUDIO_TOOLS).toBe('report_progress');
    expect(args).not.toContain('mcp__studio__read_brand_kit');
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
  it('sandboxActive follows the settings and the system support', async () => {
    const runner: AgentRunner = { start: () => { throw new Error('unused'); } };
    expect(await testLauncher(runner, { sandbox: async () => ({ available: true, reason: '' }) }).sandboxActive()).toBe(true);
    expect(await testLauncher(runner, { sandbox: async () => ({ available: true, reason: '' }), settings: { sandboxMode: 'off' } }).sandboxActive()).toBe(false);
    expect(await testLauncher(runner).sandboxActive()).toBe(false);
  });
});

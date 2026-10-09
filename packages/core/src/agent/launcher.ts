import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentEvent, WorkspaceSettings } from '@motion-studio/shared';
import { PROVIDER_ENV } from '../secrets/vault.ts';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { isAllowedRule, PermissionsStore } from '../approvals/permissions-store.ts';
import type { AgentBridge, BridgeContext } from '../bridge/bridge.ts';
import { buildAgentPolicy, type AgentJobKind } from './policy.ts';
import type { AgentRun, AgentRunner, AgentTurnRequest } from './runner.ts';
import type { SandboxSupport } from './sandbox.ts';
import { UsageLedger } from '../usage/usage-ledger.ts';
import { UsageTracker } from '../usage/usage-tracker.ts';

const RUN_DIR = 'run';
export const MCP_SERVER = 'studio';
export const MCP_TOOLS: Record<AgentJobKind, string[]> = {
  creative: ['report_progress', 'validate_output', 'read_brand_kit', 'generate_image', 'tts', 'stock_search', 'stock_download', 'fonts_fetch'],
  console: ['report_progress', 'read_brand_kit', 'generate_image', 'tts', 'stock_search', 'stock_download', 'fonts_fetch'],
  'brand-analysis': ['report_progress', 'read_brand_kit', 'fonts_fetch', 'download_file'],
  describe: ['report_progress'],
};

/** Project entries the agent may never write, whatever the job or sandbox mode. */
const PROTECTED_PROJECT_DIRS = ['.git', '.claude', '.studio'];
const PROTECTED_PROJECT_FILES = ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json'];
/** Secrets the core reads from its own environment: never inherited by the agent (nor by the MCP server it starts). */
const AGENT_UNSET_ENV = [...Object.values(PROVIDER_ENV), 'MOTION_STUDIO_BRIDGE_TOKEN'];

export interface LauncherDeps {
  runner: AgentRunner; bridge: AgentBridge; approvals: ApprovalBroker;
  /** Cached by the caller. */
  sandbox: () => Promise<SandboxSupport>;
  settings: () => Promise<WorkspaceSettings>;
  configDir: string;
  /** Defaults to os.homedir(). */
  home?: string;
  /** e.g. [process.execPath, '/…/server.mjs']; null disables MCP and approvals. */
  mcpCommand: string[] | null;
  /** Extra env of the MCP server process (e.g. ELECTRON_RUN_AS_NODE=1 when the command is Electron's binary). Never overrides the Motion Studio variables. */
  mcpEnv?: Record<string, string>;
  /** Where every run's token and cost usage is recorded (`<project>/.studio/usage.jsonl`); defaults to a private one. */
  usageLedger?: UsageLedger;
}
export interface LaunchInput {
  kind: AgentJobKind; jobId: string; projectSlug: string; projectDir: string; creativeSlug?: string | null;
  codebases?: string[]; protectedFiles?: string[];
  request: Pick<AgentTurnRequest, 'prompt' | 'resumeSessionId' | 'forkSession' | 'model'>;
  onEvent(e: AgentEvent): void;
  validate?: BridgeContext['validate'];
  /** What the run's ledger line is about (a creative's version and fix-loop attempt); null for other jobs. */
  usage?: { version: number | null; attempt: number | null };
}

/** The only place that starts the agent: applies the job's policy, the project's rules, the MCP server and the UI prompts. */
export class AgentLauncher {
  private readonly usageLedger: UsageLedger;
  constructor(private readonly deps: LauncherDeps) { this.usageLedger = deps.usageLedger ?? new UsageLedger(); }

  /** True when agents get the `studio` MCP server (bridge listening and a command to start it). */
  mcpActive(): boolean { return Boolean(this.deps.bridge.origin && this.deps.mcpCommand?.length); }

  async start(i: LaunchInput): Promise<AgentRun> {
    const settings = await this.deps.settings();
    const sandbox = settings.sandboxMode === 'auto' && (await this.deps.sandbox()).available;
    const home = this.deps.home ?? homedir();
    const { configDir, bridge, mcpCommand, approvals } = this.deps;
    // The file is agent-reachable in the fallback mode: only rules that "Sempre" could have produced are honoured;
    // provider rules are checked by the core before paid calls, they are not agent permissions.
    const stored = await new PermissionsStore(i.projectDir).list().catch(() => []);
    const rules = stored.map((r) => r.rule).filter((r) => !r.startsWith('provider:') && isAllowedRule(r, { home, configDir, workspaceRoot: dirname(i.projectDir) }));
    // Files the core or a later turn executes or loads outside the sandbox: .studio holds the project's permissions
    // (the agent must never grant itself more), .git hooks/config run on every commit, .claude / CLAUDE*.md / .mcp.json
    // configure the next agent turn.
    const realDir = await realpath(i.projectDir).catch(() => i.projectDir);
    const roots = [...new Set([i.projectDir, realDir])];
    const protectedDirs = roots.flatMap((d) => PROTECTED_PROJECT_DIRS.map((n) => join(d, n)));
    const protectedFiles = [...(i.protectedFiles ?? []), ...roots.flatMap((d) => PROTECTED_PROJECT_FILES.map((n) => join(d, n)))];
    const mcpOn = this.mcpActive();
    // Aborted on cancel and when the run settles: provider calls started by the agent's tools stop with the job.
    const abort = new AbortController();
    const policy = buildAgentPolicy({
      kind: i.kind, sandbox, projectDir: i.projectDir, home, configDir,
      codebases: i.codebases ?? [], protectedFiles, protectedDirs,
      extraDomains: settings.extraAllowedDomains, projectAllowRules: rules,
      mcpTools: mcpOn ? MCP_TOOLS[i.kind].map((t) => `mcp__${MCP_SERVER}__${t}`) : [],
      autoApproveSandboxed: settings.autoApproveSandboxed,
    });

    let token: string | null = null;
    let configFile: string | null = null;
    let tokenFile: string | null = null;
    let released = false;
    // Token first (synchronously), then the job's pending approvals (on every call), then the config file.
    const release = async () => {
      const first = !released;
      released = true;
      abort.abort();
      if (first && token) bridge.unregister(token);
      approvals.cancelJob(i.jobId);
      if (first) await Promise.all([configFile, tokenFile].map((f) => (f ? rm(f, { force: true }).catch(() => {}) : undefined)));
    };
    let mcp: Pick<AgentTurnRequest, 'mcpConfigPath' | 'permissionPromptTool'> = {};
    try {
      if (mcpOn && mcpCommand) {
        token = bridge.register({
          jobId: i.jobId, kind: i.kind, projectSlug: i.projectSlug, projectDir: i.projectDir, creativeSlug: i.creativeSlug ?? null,
          // The same value the policy was built with: `approve` auto-allows only for jobs that really run in the sandbox.
          sandboxed: sandbox,
          emit: i.onEvent, signal: abort.signal, ...(i.validate ? { validate: i.validate } : {}),
        });
        // The paths are recorded before writing, so release() also removes a half-written pair.
        const files = await prepareRunFiles(configDir, i.jobId);
        configFile = files.config;
        tokenFile = files.token;
        const config = {
          mcpServers: {
            [MCP_SERVER]: {
              type: 'stdio', command: mcpCommand[0], args: mcpCommand.slice(1),
              env: { ...this.deps.mcpEnv, MOTION_STUDIO_BRIDGE_URL: bridge.origin!, MOTION_STUDIO_BRIDGE_TOKEN_FILE: files.token, MOTION_STUDIO_TOOLS: MCP_TOOLS[i.kind].join(',') },
            },
          },
        };
        // The token travels in a private file (the config folder is denied to the agent), never in argv or env where `ps` shows it.
        await writeFile(files.token, token, { mode: 0o600, flag: 'wx' });
        await writeFile(files.config, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
        mcp = { mcpConfigPath: files.config, permissionPromptTool: `mcp__${MCP_SERVER}__approve` };
      }
      // Every run is metered here, whatever the job: the final usage is held back and re-emitted with per-run values.
      const tracker = new UsageTracker({
        projectDir: i.projectDir, jobId: i.jobId, kind: i.kind, creativeSlug: i.creativeSlug ?? null,
        version: i.usage?.version ?? null, attempt: i.usage?.attempt ?? null,
        ...(i.request.resumeSessionId ? { resumeSessionId: i.request.resumeSessionId } : {}),
      }, this.usageLedger);
      const forward = (e: AgentEvent) => { const out = tracker.observe(e); if (out) i.onEvent(out); };
      const run = this.deps.runner.start({
        cwd: i.projectDir, ...i.request,
        addDirs: policy.addDirs, allowedTools: policy.allowedTools, disallowedTools: policy.disallowedTools,
        ...(policy.settings ? { settings: policy.settings } : {}), ...mcp,
        env: { MCP_TOOL_TIMEOUT: '900000', ...policy.env }, unsetEnv: AGENT_UNSET_ENV,
      }, forward);
      const done = run.done.then(async (r) => {
        const { record, event } = await tracker.finish(r.status);
        if (event) { try { i.onEvent(event); } catch { /* a faulty listener must not lose the outcome */ } }
        return { ...r, usage: record };
      });
      return {
        done: done.finally(release),
        // Revoked before the process is told to stop: it may keep calling the bridge until it exits.
        cancel: () => { void release(); run.cancel(); },
      };
    } catch (err) {
      await release();
      throw err;
    }
  }
}

/** Private paths for one job's MCP config and token file (same base name; the folder is 0700). */
async function prepareRunFiles(configDir: string, jobId: string): Promise<{ config: string; token: string }> {
  const dir = await ensureRunDir(configDir);
  const base = join(dir, `${jobId.replace(/[^A-Za-z0-9-]/g, '_')}-${randomBytes(8).toString('hex')}`);
  return { config: `${base}.mcp.json`, token: `${base}.token` };
}

/** A real folder (not a link) owned by this user. */
const isOwnFolder = (st: Stats) => !st.isSymbolicLink() && st.isDirectory() && (process.getuid === undefined || st.uid === process.getuid());

/** `<configDir>/run`, private (0700): a link, a file or a folder owned by someone else is replaced, never followed nor chmod-ed. */
export async function ensureRunDir(configDir: string): Promise<string> {
  const dir = join(configDir, RUN_DIR);
  await mkdir(configDir, { recursive: true });
  const st = await lstat(dir).catch(() => null);
  if (st && isOwnFolder(st)) {
    if ((st.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
    return dir;
  }
  if (st) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { mode: 0o700 });
  return dir;
}

/** Removes what a crashed run left behind (the running server's `server.json` is kept). Assumes a single running instance per configDir (a second instance booting would delete the first one's live files). The folder is never followed if it was replaced by a link or a file. */
export async function sweepRunDir(configDir: string): Promise<void> {
  const dir = join(configDir, RUN_DIR);
  const st = await lstat(dir).catch(() => null);
  if (!st) return;
  if (!isOwnFolder(st)) { await rm(dir, { recursive: true, force: true }); return; }
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.endsWith('.mcp.json') || name.endsWith('.token')) await rm(join(dir, name), { force: true }).catch(() => {});
  }
}

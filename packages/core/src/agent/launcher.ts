import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, WorkspaceSettings } from '@motion-studio/shared';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { isAllowedRule, PermissionsStore } from '../approvals/permissions-store.ts';
import type { AgentBridge, BridgeContext } from '../bridge/bridge.ts';
import { buildAgentPolicy, type AgentJobKind } from './policy.ts';
import type { AgentRun, AgentRunner, AgentTurnRequest } from './runner.ts';
import type { SandboxSupport } from './sandbox.ts';

export const MCP_SERVER = 'studio';
export const MCP_TOOLS: Record<AgentJobKind, string[]> = {
  creative: ['report_progress', 'validate_output', 'read_brand_kit', 'generate_image', 'tts', 'stock_search', 'stock_download', 'fonts_fetch'],
  console: ['report_progress', 'read_brand_kit', 'generate_image', 'tts', 'stock_search', 'stock_download', 'fonts_fetch'],
  'brand-analysis': ['report_progress', 'read_brand_kit', 'fonts_fetch'],
  describe: ['report_progress'],
};

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
}
export interface LaunchInput {
  kind: AgentJobKind; jobId: string; projectSlug: string; projectDir: string; creativeSlug?: string | null;
  codebases?: string[]; protectedFiles?: string[];
  request: Pick<AgentTurnRequest, 'prompt' | 'resumeSessionId' | 'forkSession' | 'model'>;
  onEvent(e: AgentEvent): void;
  validate?: BridgeContext['validate'];
}

/** The only place that starts the agent: applies the job's policy, the project's rules, the MCP server and the UI prompts. */
export class AgentLauncher {
  constructor(private readonly deps: LauncherDeps) {}

  async sandboxActive(): Promise<boolean> {
    const s = await this.deps.settings();
    return s.sandboxMode === 'auto' && (await this.deps.sandbox()).available;
  }

  async start(i: LaunchInput): Promise<AgentRun> {
    const settings = await this.deps.settings();
    const sandbox = await this.sandboxActive();
    const home = this.deps.home ?? homedir();
    const { configDir, bridge, mcpCommand, approvals } = this.deps;
    // The file is agent-reachable in the fallback mode: only rules that "Sempre" could have produced are honoured;
    // provider rules are checked by the core before paid calls, they are not agent permissions.
    const stored = await new PermissionsStore(i.projectDir).list().catch(() => []);
    const rules = stored.map((r) => r.rule).filter((r) => !r.startsWith('provider:') && isAllowedRule(r, { home, configDir }));
    // .studio holds the project's permissions: the agent must never be able to grant itself more.
    const realDir = await realpath(i.projectDir).catch(() => i.projectDir);
    const protectedDirs = [...new Set([i.projectDir, realDir])].map((d) => join(d, '.studio'));
    const mcpOn = Boolean(bridge.origin && mcpCommand?.length);
    const policy = buildAgentPolicy({
      kind: i.kind, sandbox, home, configDir,
      codebases: i.codebases ?? [], protectedFiles: i.protectedFiles ?? [], protectedDirs,
      extraDomains: settings.extraAllowedDomains, projectAllowRules: rules,
      mcpTools: mcpOn ? MCP_TOOLS[i.kind].map((t) => `mcp__${MCP_SERVER}__${t}`) : [],
    });
    let token: string | null = null;
    let mcp: Pick<AgentTurnRequest, 'mcpConfig' | 'permissionPromptTool'> = {};
    if (mcpOn && mcpCommand) {
      token = bridge.register({
        jobId: i.jobId, kind: i.kind, projectSlug: i.projectSlug, projectDir: i.projectDir, creativeSlug: i.creativeSlug ?? null,
        emit: i.onEvent, ...(i.validate ? { validate: i.validate } : {}),
      });
      mcp = {
        mcpConfig: {
          mcpServers: {
            [MCP_SERVER]: {
              type: 'stdio', command: mcpCommand[0], args: mcpCommand.slice(1),
              env: { MOTION_STUDIO_BRIDGE_URL: bridge.origin!, MOTION_STUDIO_BRIDGE_TOKEN: token, MOTION_STUDIO_TOOLS: MCP_TOOLS[i.kind].join(',') },
            },
          },
        },
        permissionPromptTool: `mcp__${MCP_SERVER}__approve`,
      };
    }
    const cleanup = () => { if (token) bridge.unregister(token); approvals.cancelJob(i.jobId); };
    let run: AgentRun;
    try {
      run = this.deps.runner.start({
        cwd: i.projectDir, ...i.request,
        addDirs: policy.addDirs, allowedTools: policy.allowedTools, disallowedTools: policy.disallowedTools,
        ...(policy.settings ? { settings: policy.settings } : {}), ...mcp,
        env: { MCP_TOOL_TIMEOUT: '900000' },
      }, i.onEvent);
    } catch (err) {
      cleanup();
      throw err;
    }
    return {
      done: run.done.finally(cleanup),
      cancel: () => { approvals.cancelJob(i.jobId); run.cancel(); },
    };
  }
}

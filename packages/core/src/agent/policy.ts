import { join } from 'node:path';
import { dirDenyRules, fileDenyRules, readOnlyRules } from '../codebases.ts';
import { AGENT_ALLOWED_TOOLS, BRAND_ANALYSIS_TOOLS, DESCRIBE_TOOLS } from './runner.ts';
import { DEFAULT_ALLOWED_DOMAINS, sensitiveHomeEntries, sensitiveHomePaths } from './sandbox.ts';

export type AgentJobKind = 'creative' | 'brand-analysis' | 'describe' | 'console';
export interface PolicyInput {
  kind: AgentJobKind; sandbox: boolean; projectDir?: string; home: string; configDir: string;
  codebases: string[]; protectedFiles: string[];
  /** Folders the agent must never write, whatever the job (e.g. `<project>/.studio`, where its permissions live). */
  protectedDirs: string[];
  extraDomains: string[]; projectAllowRules: string[]; mcpTools: string[];
  /** Workspace setting: sandboxed Bash runs without asking (only meaningful with `sandbox`). */
  autoApproveSandboxed: boolean;
}
export interface AgentPolicy { settings: Record<string, unknown> | null; allowedTools: string[]; disallowedTools: string[]; addDirs: string[];
  /** Extra environment of the agent process: package caches inside the project, only for sandboxed jobs. */
  env: Record<string, string>;
}

/** Where a sandboxed job's tools cache downloads: inside the project, so it is in the write allowlist (not under a protected dir), and git-ignored. */
export const CACHE_DIR = '.cache';

export function sandboxCacheEnv(projectDir: string): Record<string, string> {
  const c = (n: string) => join(projectDir, CACHE_DIR, n);
  return {
    npm_config_cache: c('npm'), PIP_CACHE_DIR: c('pip'), XDG_CACHE_HOME: c('xdg'),
    PNPM_STORE_DIR: c('pnpm-store'), npm_config_store_dir: c('pnpm-store'), YARN_CACHE_FOLDER: c('yarn'),
    PUPPETEER_SKIP_DOWNLOAD: '1', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    npm_config_update_notifier: 'false', PIP_DISABLE_PIP_VERSION_CHECK: '1',
  };
}

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const SANDBOXED_TOOLS: Record<AgentJobKind, readonly string[]> = { creative: [], console: [], 'brand-analysis': BRAND_ANALYSIS_TOOLS, describe: DESCRIBE_TOOLS };
const LEGACY_TOOLS: Record<AgentJobKind, readonly string[]> = { creative: AGENT_ALLOWED_TOOLS, console: [], 'brand-analysis': BRAND_ANALYSIS_TOOLS, describe: DESCRIBE_TOOLS };
const unique = (xs: string[]) => [...new Set(xs)];

export function buildAgentPolicy(i: PolicyInput): AgentPolicy {
  // The sandbox denyRead only covers Bash: the Read tool needs its own deny rules.
  const sensitive = sensitiveHomeEntries(i.home);
  const disallowedTools = [
    ...readOnlyRules(i.codebases),
    ...dirDenyRules(['Read'], [...sensitive.dirs, i.configDir]),
    ...fileDenyRules(['Read'], sensitive.files),
    ...(i.protectedFiles.length ? fileDenyRules(EDIT_TOOLS, i.protectedFiles) : []),
    ...dirDenyRules(EDIT_TOOLS, i.protectedDirs),
  ];
  const extra = [...i.projectAllowRules, ...i.mcpTools];
  if (!i.sandbox) {
    return { settings: null, allowedTools: unique([...LEGACY_TOOLS[i.kind], ...extra]), disallowedTools, addDirs: [...i.codebases], env: {} };
  }
  // Only creative/console jobs get sandbox network. Brand analysis reads pages with WebFetch (a tool, not Bash)
  // and downloads files through the Motion Studio `download_file` MCP tool.
  const network = i.kind === 'creative' || i.kind === 'console'
    ? { allowedDomains: unique([...DEFAULT_ALLOWED_DOMAINS, ...i.extraDomains]) }
    : undefined;
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      // Phase 8 (spec §3.2, docs/superpowers/specs/2026-10-09-motion-studio-phase8-approvals-usage-design.md): the per-kind
      // AUTO_BASH table is gone. Every kind follows the workspace setting `autoApproveSandboxed`: brand and describe jobs
      // too, since their sandbox has no network, writes stay in the project and the configuration files are protected.
      autoAllowBashIfSandboxed: i.autoApproveSandboxed,
      filesystem: { denyRead: [...sensitiveHomePaths(i.home), i.configDir], denyWrite: [...i.codebases, ...i.protectedFiles, ...i.protectedDirs] },
      ...(network ? { network } : {}),
    },
  };
  return { settings, allowedTools: unique([...SANDBOXED_TOOLS[i.kind], ...extra]), disallowedTools, addDirs: [...i.codebases], env: i.projectDir ? sandboxCacheEnv(i.projectDir) : {} };
}

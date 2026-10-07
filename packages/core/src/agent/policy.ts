import { dirDenyRules, fileDenyRules, readOnlyRules } from '../codebases.ts';
import { AGENT_ALLOWED_TOOLS, BRAND_ANALYSIS_TOOLS, DESCRIBE_TOOLS } from './runner.ts';
import { DEFAULT_ALLOWED_DOMAINS, sensitiveHomeEntries, sensitiveHomePaths } from './sandbox.ts';

export type AgentJobKind = 'creative' | 'brand-analysis' | 'describe' | 'console';
export interface PolicyInput {
  kind: AgentJobKind; sandbox: boolean; home: string; configDir: string;
  codebases: string[]; protectedFiles: string[];
  extraDomains: string[]; projectAllowRules: string[]; mcpTools: string[];
}
export interface AgentPolicy { settings: Record<string, unknown> | null; allowedTools: string[]; disallowedTools: string[]; addDirs: string[] }

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const SANDBOXED_TOOLS: Record<AgentJobKind, readonly string[]> = { creative: [], console: [], 'brand-analysis': BRAND_ANALYSIS_TOOLS, describe: DESCRIBE_TOOLS };
const LEGACY_TOOLS: Record<AgentJobKind, readonly string[]> = { creative: AGENT_ALLOWED_TOOLS, console: [], 'brand-analysis': BRAND_ANALYSIS_TOOLS, describe: DESCRIBE_TOOLS };
const AUTO_BASH: Record<AgentJobKind, boolean> = { creative: true, console: true, 'brand-analysis': false, describe: false };
const unique = (xs: string[]) => [...new Set(xs)];

export function buildAgentPolicy(i: PolicyInput): AgentPolicy {
  // The sandbox denyRead only covers Bash: the Read tool needs its own deny rules.
  const sensitive = sensitiveHomeEntries(i.home);
  const disallowedTools = [
    ...readOnlyRules(i.codebases),
    ...dirDenyRules(['Read'], [...sensitive.dirs, i.configDir]),
    ...fileDenyRules(['Read'], sensitive.files),
    ...(i.protectedFiles.length ? fileDenyRules(EDIT_TOOLS, i.protectedFiles) : []),
  ];
  const extra = [...i.projectAllowRules, ...i.mcpTools];
  if (!i.sandbox) {
    return { settings: null, allowedTools: unique([...LEGACY_TOOLS[i.kind], ...extra]), disallowedTools, addDirs: [...i.codebases] };
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
      autoAllowBashIfSandboxed: AUTO_BASH[i.kind],
      filesystem: { denyRead: [...sensitiveHomePaths(i.home), i.configDir], denyWrite: [...i.codebases, ...i.protectedFiles] },
      ...(network ? { network } : {}),
    },
  };
  return { settings, allowedTools: unique([...SANDBOXED_TOOLS[i.kind], ...extra]), disallowedTools, addDirs: [...i.codebases] };
}

import { dirDenyRules, fileDenyRules, globDenyRules, readOnlyRules } from '../../src/codebases.ts';
import { sandboxCacheEnv, sandboxPath, type AgentJobKind, type AgentPolicy, type PolicyInput } from '../../src/agent/policy.ts';
import { AGENT_ALLOWED_TOOLS, BRAND_ANALYSIS_TOOLS, DESCRIBE_TOOLS, LOCALIZE_TOOLS } from '../../src/agent/runner.ts';
import { DEFAULT_ALLOWED_DOMAINS, sensitiveHomeEntries, sensitiveHomePaths } from '../../src/agent/sandbox.ts';

/**
 * A frozen copy of `buildAgentPolicy` as it was before Phase 14 (commit 640709d), comments removed: the reference that jobs
 * without brand codebases (creatives, website-only brand analyses) must still match exactly. Never update it (the kinds
 * added later only complete its tables' type).
 */
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const SANDBOXED_TOOLS: Record<AgentJobKind, readonly string[]> = { creative: [], console: [], 'brand-analysis': BRAND_ANALYSIS_TOOLS, describe: DESCRIBE_TOOLS, localize: LOCALIZE_TOOLS, 'variant-directions': [], 'creative-group': [] };
const LEGACY_TOOLS: Record<AgentJobKind, readonly string[]> = { creative: AGENT_ALLOWED_TOOLS, console: [], 'brand-analysis': BRAND_ANALYSIS_TOOLS, describe: DESCRIBE_TOOLS, localize: LOCALIZE_TOOLS, 'variant-directions': [], 'creative-group': [] };
const unique = (xs: string[]) => [...new Set(xs)];

export function legacyPolicy(i: PolicyInput): AgentPolicy {
  const sensitive = sensitiveHomeEntries(i.home);
  const disallowedTools = [
    ...readOnlyRules(i.codebases),
    ...dirDenyRules(['Read'], [...sensitive.dirs, i.configDir]),
    ...dirDenyRules(['Grep', 'Glob'], [i.configDir]),
    ...fileDenyRules(['Read'], sensitive.files),
    ...(i.protectedFiles.length ? fileDenyRules(EDIT_TOOLS, i.protectedFiles) : []),
    ...dirDenyRules(EDIT_TOOLS, i.protectedDirs),
    ...globDenyRules(EDIT_TOOLS, i.protectedGlobs ?? []),
    ...(i.kind === 'localize' ? [...EDIT_TOOLS, 'Bash'] : []),
  ];
  const extra = [...i.projectAllowRules, ...i.mcpTools];
  if (!i.sandbox) {
    return { settings: null, allowedTools: unique([...LEGACY_TOOLS[i.kind], ...extra]), disallowedTools, addDirs: [...i.codebases], env: {} };
  }
  const network = i.kind === 'creative' || i.kind === 'console'
    ? { allowedDomains: unique([...DEFAULT_ALLOWED_DOMAINS, ...i.extraDomains]) }
    : undefined;
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: i.kind === 'localize' ? false : i.autoApproveSandboxed,
      filesystem: { denyRead: [...sensitiveHomePaths(i.home), i.configDir].map(sandboxPath), denyWrite: [...[...i.codebases, ...i.protectedFiles, ...i.protectedDirs].map(sandboxPath), ...(i.sandboxGlobs ?? [])] },
      ...(network ? { network } : {}),
    },
  };
  return { settings, allowedTools: unique([...SANDBOXED_TOOLS[i.kind], ...extra]), disallowedTools, addDirs: [...i.codebases], env: i.projectDir ? sandboxCacheEnv(i.projectDir) : {} };
}

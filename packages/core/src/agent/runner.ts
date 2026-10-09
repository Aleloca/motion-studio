import type { AgentEvent, UsageRecord } from '@motion-studio/shared';

export interface AgentTurnRequest {
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  /** With resumeSessionId: continue in a new session branched from it (used to restart from a past version). */
  forkSession?: boolean;
  addDirs?: string[];
  model?: string;
  /** Claude Code settings for this turn (e.g. the sandbox), passed as --settings <json>. */
  settings?: Record<string, unknown>;
  /** Path of a private MCP configuration file ({ mcpServers: … }), passed with --strict-mcp-config. Never inline: it holds secrets. */
  mcpConfigPath?: string;
  /** MCP tool that answers permission prompts (replaces `--permission-prompts none`). */
  permissionPromptTool?: string;
  /** Extra environment variables for the agent process. */
  env?: Record<string, string>;
  /** Variables removed from the agent's environment (applied after `env`): secrets the core reads must never reach the agent. */
  unsetEnv?: string[];
  /** Permission rules the agent may use without asking (e.g. `Bash(node:*)`); omitted = only the default policy. */
  allowedTools?: string[];
  /** Permission rules that are always denied (e.g. read-only linked codebases: `Edit(//abs/path/**)`). */
  disallowedTools?: string[];
}

/**
 * Perimeter of spec §6.3 ("package manager e interpreti in locale") for creative turns: the agent can render
 * with these commands without asking. Anything else that would prompt is denied. Real approvals arrive in phase 4.
 */
export const AGENT_ALLOWED_TOOLS: readonly string[] = [
  'Bash(ffmpeg:*)', 'Bash(ffprobe:*)', 'Bash(node:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(pnpm:*)',
  'Bash(python3:*)', 'Bash(pip:*)', 'Bash(pip3:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)',
];

/** Brand analysis: read the sites with WebFetch; files are downloaded with the `download_file` MCP tool; no interpreters or package managers. */
export const BRAND_ANALYSIS_TOOLS: readonly string[] = ['WebFetch', 'Bash(mkdir:*)', 'Bash(ffprobe:*)'];

/** Asset descriptions: read the files and inspect media; nothing else. */
export const DESCRIBE_TOOLS: readonly string[] = ['Read', 'Bash(ffmpeg:*)', 'Bash(ffprobe:*)'];

export interface AgentRunResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  sessionId?: string;
  error?: string;
  /** Set by AgentLauncher: the run's ledger record (per-run values), null when the run reported no usage at all. */
  usage?: UsageRecord | null;
}

export interface AgentRun {
  done: Promise<AgentRunResult>;
  cancel(): void;
}

/** Agent-neutral contract; ClaudeCodeRunner is the first implementation. */
export interface AgentRunner {
  start(req: AgentTurnRequest, onEvent: (e: AgentEvent) => void): AgentRun;
}

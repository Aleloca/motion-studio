import type { AgentEvent } from '@motion-studio/shared';

export interface AgentTurnRequest {
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  /** With resumeSessionId: continue in a new session branched from it (used to restart from a past version). */
  forkSession?: boolean;
  addDirs?: string[];
  model?: string;
  mcpConfigPath?: string;
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

/** Brand analysis: fetch the sites and download files into assets/ (spec §6.1); no interpreters or package managers. */
export const BRAND_ANALYSIS_TOOLS: readonly string[] = ['WebFetch', 'Bash(curl:*)', 'Bash(mkdir:*)', 'Bash(ffprobe:*)'];

/** Asset descriptions: read the files and inspect media; nothing else. */
export const DESCRIBE_TOOLS: readonly string[] = ['Read', 'Bash(ffmpeg:*)', 'Bash(ffprobe:*)'];

export interface AgentRunResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  sessionId?: string;
  error?: string;
}

export interface AgentRun {
  done: Promise<AgentRunResult>;
  cancel(): void;
}

/** Agent-neutral contract; ClaudeCodeRunner is the first implementation. */
export interface AgentRunner {
  start(req: AgentTurnRequest, onEvent: (e: AgentEvent) => void): AgentRun;
}

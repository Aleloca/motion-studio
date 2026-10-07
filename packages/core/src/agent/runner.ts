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
}

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

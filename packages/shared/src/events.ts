import type { ProjectFile } from './schemas.ts';

/** Agent-neutral event stream produced by any AgentRunner. */
export type AgentEvent =
  | { kind: 'session'; sessionId: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; content: string }
  | { kind: 'rate_limit'; status: string; resetsAt?: number }
  | { kind: 'stderr'; text: string }
  | { kind: 'parse_error'; line: string }
  | { kind: 'result'; ok: boolean; sessionId?: string; text?: string; costUsd?: number; error?: string };

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobSummary {
  id: string;
  key: string;
  label: string;
  state: JobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export type ServerMessage =
  | { type: 'snapshot'; jobs: JobSummary[] }
  | { type: 'job'; job: JobSummary }
  | { type: 'agent'; jobId: string; event: AgentEvent };

export interface DoctorCheck {
  id: 'node' | 'git' | 'ffmpeg' | 'claude' | 'claude-auth';
  label: string;
  ok: boolean;
  required: boolean;
  version?: string;
  message: string;
  fix?: string;
}

export type ProjectListItem =
  | { slug: string; ok: true; project: ProjectFile }
  | { slug: string; ok: false; error: string };

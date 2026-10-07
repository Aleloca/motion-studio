import type { ProjectFile, WorkspaceSettings } from './schemas.ts';

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
  /** Agent session to resume for the next turn, known once the agent reported it. */
  sessionId?: string;
}

export type ServerMessage =
  | { type: 'snapshot'; jobs: JobSummary[] }
  | { type: 'job'; job: JobSummary }
  | { type: 'agent'; jobId: string; event: AgentEvent }
  /** A creative's files changed (status, versions, conversation): clients refetch it. */
  | { type: 'creative'; project: string; creative: string };

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

export type WorkspaceProblemCode = 'not-found' | 'invalid' | 'not-writable';
export interface WorkspaceProblem { code: WorkspaceProblemCode; message: string }

/** GET /api/workspace: `error` explains why a configured workspace is not usable (path is then the configured one). */
export interface WorkspaceInfo {
  path: string | null;
  settings: WorkspaceSettings | null;
  error: WorkspaceProblem | null;
}

/** GET /api/projects/:slug. `jobKey` is the key of this project's agent jobs (to find an active one). */
export interface ProjectDetail { slug: string; project: ProjectFile; jobKey: string }

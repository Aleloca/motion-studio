import type { LanguageSetting, Locale } from './i18n/index.ts';
import type { Explanation } from './explain/index.ts';
import type { ModelUsage, TokenCounts } from './usage.ts';
import type { ProjectFile, WorkspaceSettings, WorkspaceSettingsView } from './schemas.ts';

/** Agent-neutral event stream produced by any AgentRunner. */
export type AgentEvent =
  | { kind: 'session'; sessionId: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; content: string }
  | { kind: 'rate_limit'; status: string; resetsAt?: number }
  | { kind: 'progress'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'parse_error'; line: string }
  | { kind: 'usage'; live: boolean; tokens: TokenCounts; costUsd: number | null; models?: ModelUsage[] }
  | { kind: 'auto_approved'; toolName: string; command: string; explanation: Explanation }
  /** `costUsd` is Claude Code's `total_cost_usd`, CUMULATIVE over a resumed session (per-run cost: the final `usage` event). */
  | { kind: 'result'; ok: boolean; sessionId?: string; text?: string; costUsd?: number; error?: string; durationMs?: number; numTurns?: number };

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** What a job does: logic and the UI branch on this, never on the (localized) label. */
export type JobKind = 'creative' | 'brand-analysis' | 'asset-description' | 'console';

export interface JobSummary {
  id: string;
  key: string;
  kind: JobKind;
  /** Display text in the language current when the job was created. */
  label: string;
  state: JobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** Agent session to resume for the next turn, known once the agent reported it. */
  sessionId?: string;
  /** Informational notes the job reported (e.g. a change by the agent that was undone). */
  notes?: string[];
}

export type ApprovalKind = 'tool' | 'provider';
export interface ApprovalRequest {
  id: string; jobId: string; projectSlug: string; creativeSlug: string | null; kind: ApprovalKind;
  /** Display title in the language current when the request was created, e.g. "Edit a file outside the project". Logic uses `kind`/`toolName`, never this text. */
  title: string;
  /** The command / path / provider summary, plain text. */
  detail: string;
  /** e.g. 'Bash', 'Write', 'provider:openai-images'. */
  toolName: string;
  /** Rule saved by "Sempre per questo progetto" (null = not offered). */
  alwaysRule: string | null;
  /** What the command does, in structured form (null = not analyzed, or an old client). */
  explanation: Explanation | null;
  /** The agent's own stated reason (e.g. the Bash description), shown only as a quote. */
  agentReason: string | null;
  createdAt: string; expiresAt: string;
}
export type ApprovalDecision = 'once' | 'always' | 'deny';

export type ServerMessage =
  | { type: 'snapshot'; jobs: JobSummary[]; approvals: ApprovalRequest[]; locale: Locale; languageSetting: LanguageSetting; /** What 'system' resolves to on the core's machine. */ systemLocale: Locale }
  /** The language setting changed: the UI switches without reloading. */
  | { type: 'locale'; locale: Locale; setting: LanguageSetting; systemLocale: Locale }
  | { type: 'approval'; approval: ApprovalRequest }
  | { type: 'approval_resolved'; id: string; decision: ApprovalDecision | 'expired' | 'cancelled' }
  | { type: 'job'; job: JobSummary }
  | { type: 'agent'; jobId: string; event: AgentEvent }
  /** A creative's files changed (status, versions, conversation): clients refetch it. */
  | { type: 'creative'; project: string; creative: string }
  /** Brand kit, guidelines, sources or proposals of a project changed. */
  | { type: 'brand'; project: string }
  /** Assets or references of a project changed. */
  | { type: 'library'; project: string }
  /** The project's metadata (name, description, linked codebases) changed. */
  | { type: 'project'; project: string };

export interface DoctorCheck {
  id: 'node' | 'git' | 'ffmpeg' | 'claude' | 'claude-auth' | 'sandbox' | 'shell-path';
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
  settings: WorkspaceSettingsView | null;
  error: WorkspaceProblem | null;
}

/** GET /api/projects/:slug. `jobKey` is the key of this project's agent jobs (to find an active one). */
export interface ProjectDetail { slug: string; project: ProjectFile; jobKey: string }

import type { LanguageSetting, Locale } from './i18n/index.ts';
import type { Explanation } from './explain/index.ts';
import type { ModelUsage, TokenCounts } from './usage.ts';
import type { BrandPhase } from './services.ts';
import type { PaidBatch } from './permissions.ts';
import type { AgentQuestion } from './questions.ts';
import type { ProjectFile, WorkspaceSettings, WorkspaceSettingsView } from './schemas.ts';

/** Agent-neutral event stream produced by any AgentRunner. */
export type AgentEvent =
  /** `sandboxed`: set by the launcher (the job's own sandbox decision); absent in older logs and for runs it did not start. */
  | { kind: 'session'; sessionId: string; model?: string; sandboxed?: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; content: string }
  | { kind: 'rate_limit'; status: string; resetsAt?: number }
  /**
   * `phase` (brand analysis, Phase 11): where the analysis is. The agent reports reading…writing with report_progress; the
   * core adds `queued` when the run starts and `done` when the proposal is written, with an empty `text` (markers only).
   */
  | { kind: 'progress'; text: string; phase?: BrandPhase }
  | { kind: 'stderr'; text: string }
  | { kind: 'parse_error'; line: string }
  | { kind: 'usage'; live: boolean; tokens: TokenCounts; costUsd: number | null; models?: ModelUsage[] }
  /** `toolUseId`: the agent's tool call this approval answered (absent in older logs or when the agent sent none). */
  | { kind: 'auto_approved'; toolName: string; command: string; explanation: Explanation; toolUseId?: string }
  /**
   * The user's (or the timer's) answer to an approval request, recorded in the job's log so a finished turn can tell
   * the commands you approved or denied from those that ran without asking. `toolUseId` links it to the `tool_use`.
   */
  | { kind: 'approval_decided'; toolName: string; decision: ApprovalDecision | 'expired' | 'cancelled'; toolUseId?: string }
  /**
   * User note 8: what became of the agent's `AskUserQuestion` (a question card, never a permission). `answered`: each item
   * has the answer the agent received; `deny` (the user chose not to answer), `expired`, `cancelled`: no answers.
   */
  | { kind: 'question_answered'; outcome: 'answered' | 'deny' | 'expired' | 'cancelled'; items: Array<{ header: string; question: string; answer?: string }>; toolUseId?: string }
  /**
   * `cumulativeCostUsd` is Claude Code's `total_cost_usd`: CUMULATIVE over a resumed session, never this run's cost
   * (that is the final `usage` event, re-emitted by the core with per-run values). Older stored events may carry it as `costUsd`.
   * `interrupted` (decision 804): the turn the user stopped (the CLI acknowledged our interrupt and ended the turn with
   * `error_during_execution`): not ok, but not a failure either, so it carries no `error`.
   */
  | { kind: 'result'; ok: boolean; sessionId?: string; text?: string; cumulativeCostUsd?: number; error?: string; durationMs?: number; numTurns?: number; interrupted?: boolean }
  /**
   * Phase 13: a message sent while the agent works was written to the running session (or given with the prompt). It
   * means "sent": the write alone does not prove the CLI read it (see `user_message_read`).
   */
  | { kind: 'user_message_delivered'; clientId: string }
  /**
   * Decision 804: evidence from the CLI that it took a message written into the session. Claude Code answers each input
   * with its own `result` (measured on 2.1.301: two messages, two results), so the message written as the k-th input
   * after the prompt is read once the k-th `result` came and the agent then produced new output (its turn started).
   * Never emitted on a guess: a message the CLI folded into a running turn stays "sent".
   */
  | { kind: 'user_message_read'; clientId: string }
  /**
   * Fix round 1 (Ruling Z, M3): a message no run took after all (its run never started, or failed before reading it, and the
   * turn ended): never delivered, whatever was announced before. Console turns (creative turns queue such words instead).
   */
  | { kind: 'user_message_not_delivered'; clientId: string }
  /** Phase 13: the CLI acknowledged an interrupt of the current step. */
  | { kind: 'interrupted' };

/**
 * Phase 13: what the running Claude Code can do while a turn runs (GET /api/agent/capabilities). Effective values: a
 * capability is on only for a version verified live (2.1.301+) with the workspace setting on (decision 804).
 */
export interface AgentCapabilities {
  cliVersion: string | null;
  liveInput: boolean;
  interrupt: boolean;
  checkedAt: string;
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** What a job does: logic and the UI branch on this, never on the (localized) label. */
/** `localize` (Phase 12): an agent turn that translates an existing version (overlays only, no new version). */
/** `variant-directions` (Phase 15): the short agent turn that proposes the missing directions of a variant group (no file written). */
export type JobKind = 'creative' | 'brand-analysis' | 'asset-description' | 'console' | 'render' | 'asset-generation' | 'localize' | 'variant-directions';

/**
 * Why a queued job waits although the queue has room (Phase 15), for the turns of a variant run: `variant-directions`, the
 * directions turn has not answered yet; `variant-confirm`, the run's paid-services card has not been answered yet;
 * `variant-slot`, its group already has `MAX_RUNNING_VARIANTS` turns running. Absent: it waits only for a free slot of the
 * queue, or it is not queued. Stable codes: the web shows them (`web.variantGroup.waitReasons`).
 */
export type JobWaitReason = 'variant-directions' | 'variant-confirm' | 'variant-slot';
export const JOB_WAIT_REASONS: readonly JobWaitReason[] = ['variant-directions', 'variant-confirm', 'variant-slot'];

/**
 * Progress of a render job (Task 5), per format: `media` while the video sources are normalised ("Preparing media…",
 * sources done out of the total), `frames` while frames are captured (frames done out of the total), `finishing` while
 * the file is muxed, checked and recorded (and followers copied).
 */
export interface JobProgress { format: string; phase: 'media' | 'frames' | 'finishing'; done: number; total: number }

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
  /**
   * The formats a creative turn targets when the request named some (spec §2.5): primaries only, followers resolved to their
   * primary (their followers are materialized from them). Absent: the turn is not targeted (every format may change).
   */
  formats?: string[];
  /** Render jobs: where the current format is (see `JobProgress`); absent before the first format starts and once done. */
  progress?: JobProgress;
  /** Queued render jobs: how many render jobs are ahead of this one in the render lane (running or queued earlier). */
  queuePosition?: number;
  /** Phase 13: messages the user sent to this running turn (live and redirect); absent: none. */
  liveMessages?: number;
  /** Phase 15: why this queued job waits (see `JobWaitReason`); absent once it runs. */
  waitReason?: JobWaitReason;
}

/** `question` (user note 8): the agent's `AskUserQuestion`, answered with the options or a text; never "Always". */
export type ApprovalKind = 'tool' | 'provider' | 'paid-batch' | 'question';
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
  /** The agent's tool call this request is about (Claude Code's `tool_use_id`), when it sent one. */
  toolUseId?: string;
  /** `paid-batch` requests only: the calls the user confirms together. */
  paidBatch?: PaidBatch;
  /** `question` requests only: the agent's questions, validated by the core (agent text: shown as plain text only). */
  questions?: AgentQuestion[];
  createdAt: string; expiresAt: string;
}
export type ApprovalDecision = 'once' | 'always' | 'deny';

export type ServerMessage =
  | { type: 'snapshot'; jobs: JobSummary[]; approvals: ApprovalRequest[]; locale: Locale; languageSetting: LanguageSetting; /** What 'system' resolves to on the core's machine. */ systemLocale: Locale }
  /** The language setting changed: the UI switches without reloading. */
  | { type: 'locale'; locale: Locale; setting: LanguageSetting; systemLocale: Locale }
  | { type: 'approval'; approval: ApprovalRequest }
  | { type: 'approval_resolved'; id: string; decision: ApprovalDecision | 'expired' | 'cancelled'; /** Same as the request's. */ toolUseId?: string }
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

/** Whether the desktop app updates itself: 'off' in a development run or an unsigned build, 'unknown' where there is no updater (browser, CLI) or before it has settled. */
export type UpdatesState = 'active' | 'off' | 'unknown';

export interface DoctorCheck {
  id: 'node' | 'git' | 'ffmpeg' | 'claude' | 'claude-auth' | 'sandbox' | 'shell-path' | 'workspace-path' | 'agent-deny-paths' | 'live-messages' | 'interrupt' | 'workspace-settings' | 'updates';
  label: string;
  ok: boolean;
  required: boolean;
  version?: string;
  message: string;
  fix?: string;
  /** Informational only: shown with a neutral mark and left out of the passed count (the updates row). */
  info?: true;
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
/** A protected project file that differs from the state Motion Studio recorded (decisions log 141). */
export interface IntegrityFileChange { path: string; change: 'changed' | 'added' | 'removed' }
/**
 * The project's integrity state: a quarantine (no agent, no git) the user may lift by accepting the listed changes as
 * their own, and a git problem that is never acceptable (a config key, an attributes driver, a commondir/gitdir layout),
 * shown with its remedy. `token` identifies the listed state: accepting refuses when the files changed since.
 */
export interface ProjectIntegrity { quarantined: boolean; files: IntegrityFileChange[]; gitProblem: string | null; token: string }

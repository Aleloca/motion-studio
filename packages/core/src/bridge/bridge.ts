import { randomBytes } from 'node:crypto';
import type { AgentEvent, BriefServices, Locale, VideoAnalysisWrite } from '@motion-studio/shared';
import type { AgentJobKind } from '../agent/policy.ts';

/** What a bridge token gives access to: the job that owns it. */
export interface BridgeContext {
  jobId: string; kind: AgentJobKind; projectSlug: string; projectDir: string; creativeSlug: string | null;
  /**
   * The job's agent runs in the sandbox: set by the launcher from the value it computed for the policy (sandboxMode
   * 'auto' and sandbox available), never from anything the agent sends. Read-only: the stored context is a frozen copy.
   */
  readonly sandboxed: boolean;
  /**
   * `autoApproveSandboxed` when the job started (the value its policy was built with). `approve` auto-allows only when
   * it was on at start AND is on now: turning it on mid-job never changes a running job, turning it off applies at once.
   */
  readonly autoApproveAtStart: boolean;
  /** Same sink as the turn's onEvent. */
  emit(e: AgentEvent): void;
  /** Aborted when the job is cancelled or ends: in-flight provider calls must stop. */
  signal: AbortSignal;
  /**
   * Phase 13, creative and console turns: the signal of the tool calls started now. It is `signal` combined with the
   * turn's tool abort, which a redirect fires (and renews) so running core tools stop while the job goes on. The bridge
   * hands it to each call as its `signal`. Absent: `signal`.
   */
  toolSignal?: () => AbortSignal;
  /** Creative turns (output contract v2): the checks of the turn's compositions, all or one format's (`validate_composition`). */
  validateComposition?: (format?: string) => Promise<unknown>;
  /** Creative turns: a few PNG frames of a composition (`preview_frames`), rate-limited per turn. */
  previewFrames?: (args: { format: unknown; times: unknown; locale?: unknown }) => Promise<unknown>;
  /** Localize turns (Phase 12): validates and merges a translation into the overlay (`submit_localization`). */
  submitLocalization?: (args: Record<string, unknown>) => Promise<unknown>;
  /** Directions turns of a variant group (Phase 15): validates and keeps the proposed directions (`submit_variant_directions`). */
  submitVariantDirections?: (args: Record<string, unknown>) => Promise<unknown>;
  /** The language the job started with (brand analysis): tool notes that end up in its proposal use it. */
  locale?: Locale;
  /** Brand analysis: notes a tool adds to the proposal (e.g. inspect_site_fonts warnings), already in `locale`. */
  addNotes?: (lines: string[]) => void;
  /**
   * Creative turns: the brief's services as read when the turn started (Task 7), which the provider tools enforce. Absent
   * (other jobs, old briefs read before Phase 11): every kind `auto`. Frozen with the context: the agent never changes it.
   */
  readonly services?: Readonly<Required<BriefServices>>;
  /**
   * Brand analysis (Phase 14): the codebase folders of the analysis, every spelling (the stored one and the real path), the
   * only places `import_codebase_file` copies from. Frozen with the context.
   */
  readonly codebases?: readonly string[];
  /**
   * Decision 917, creative turns only: what the agent's app actions (`update_brief`, `add_variant`…) act on — this turn's
   * creative (and through it its variant group and project) and the version the turn makes. Set by the turn when it launches
   * the agent, frozen with the context: no tool argument ever names a project, a creative or a job.
   */
  readonly appScope?: Readonly<AppScope>;
  /**
   * Phase 3 of the single agent, `creative-group` jobs only: the coordinator's own tools (`list_variants`, `work_on_variants`,
   * `add_variants`), bound by the group turn to its plan. Absent for every other job.
   */
  readonly groupTools?: Readonly<GroupTools>;
  /**
   * Decision 1421, `brief` jobs only: the brief session the run fills (`fill_brief`). Set by the brief service when it
   * launches the agent, frozen with the context: no tool argument ever names a project or a session.
   */
  readonly briefScope?: Readonly<BriefScope>;
  /**
   * Decision 1468, `video-analysis` jobs only: the video, the span and the frames the run describes, and where its
   * `write_video_analysis` goes. Set by the analysis service when it launches the agent, frozen with the context.
   */
  readonly videoAnalysisScope?: Readonly<VideoAnalysisScope>;
}

/**
 * Decision 1468: see `BridgeContext.videoAnalysisScope`. `pass`: `whole` (a short video, every field), `chunk` (one span's
 * timeline), `final` (summary, moments, look, tags from the whole timeline). `from`/`to`: the span (s); `frames`: the frame
 * names the run was given; `write`: keeps the validated write (the last one wins).
 */
export interface VideoAnalysisScope {
  root: string; projectSlug: string; projectDir: string; file: string; sha256: string;
  pass: 'whole' | 'chunk' | 'final'; from: number; to: number; frames: readonly string[];
  write: (w: VideoAnalysisWrite) => void;
}

/** Decision 1421: see `BridgeContext.briefScope`. */
export interface BriefScope { root: string; projectSlug: string; projectDir: string; sessionId: string }

/**
 * Decision 917: see `BridgeContext.appScope`. Phase 3 of the single agent: `group` is the coordinator's scope (the host of
 * its group, no version of its own: `version` is 0); `helper` a variant's turn run for a group turn (its group-level actions
 * are the coordinator's).
 */
export interface AppScope { root: string; projectSlug: string; projectDir: string; creativeSlug: string; version: number; group?: boolean; helper?: boolean }
/** Phase 3: see `BridgeContext.groupTools`; each handler checks its arguments (agent input). */
export interface GroupTools {
  listVariants(args: Record<string, unknown>): Promise<unknown>;
  workOnVariants(args: Record<string, unknown>): Promise<unknown>;
  addVariants(args: Record<string, unknown>): Promise<unknown>;
}

/** Per-job tokens that let the `studio` MCP server call back into the core on behalf of one agent job. */
export class AgentBridge {
  origin: string | null = null;
  private readonly contexts = new Map<string, BridgeContext>();
  setOrigin(url: string) { this.origin = url.replace(/\/+$/, ''); }
  register(ctx: BridgeContext): string {
    const t = randomBytes(32).toString('hex');
    // A frozen copy: later changes to the caller's object (or to a resolved context) can never flip the flags.
    this.contexts.set(t, Object.freeze({
      ...ctx, sandboxed: ctx.sandboxed === true, autoApproveAtStart: ctx.autoApproveAtStart === true,
      ...(ctx.services ? { services: Object.freeze({ ...ctx.services }) } : {}),
      ...(ctx.codebases ? { codebases: Object.freeze([...ctx.codebases]) } : {}),
      ...(ctx.appScope ? { appScope: Object.freeze({ ...ctx.appScope }) } : {}),
      ...(ctx.groupTools ? { groupTools: Object.freeze({ ...ctx.groupTools }) } : {}),
      ...(ctx.briefScope ? { briefScope: Object.freeze({ ...ctx.briefScope }) } : {}),
      ...(ctx.videoAnalysisScope ? { videoAnalysisScope: Object.freeze({ ...ctx.videoAnalysisScope, frames: Object.freeze([...ctx.videoAnalysisScope.frames]) }) } : {}),
    }));
    return t;
  }
  unregister(token: string) { this.contexts.delete(token); }
  resolve(token: string | undefined): BridgeContext | null {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    return this.contexts.get(token) ?? null;
  }
}

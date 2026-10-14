import { randomBytes } from 'node:crypto';
import type { AgentEvent, BriefServices, Locale } from '@motion-studio/shared';
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
  /** The language the job started with (brand analysis): tool notes that end up in its proposal use it. */
  locale?: Locale;
  /** Brand analysis: notes a tool adds to the proposal (e.g. inspect_site_fonts warnings), already in `locale`. */
  addNotes?: (lines: string[]) => void;
  /**
   * Creative turns: the brief's services as read when the turn started (Task 7), which the provider tools enforce. Absent
   * (other jobs, old briefs read before Phase 11): every kind `auto`. Frozen with the context: the agent never changes it.
   */
  readonly services?: Readonly<Required<BriefServices>>;
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
    }));
    return t;
  }
  unregister(token: string) { this.contexts.delete(token); }
  resolve(token: string | undefined): BridgeContext | null {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    return this.contexts.get(token) ?? null;
  }
}
